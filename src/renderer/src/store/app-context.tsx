

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import type { ChatAttachment, Conversation, GroupWorkspaceTask, MasterDecisionTrace } from "@/types"
import type { MasterPlanAssignment, MasterPlanTaskDiagnostic } from "@master-agent"
import { createMasterEngine } from "@master-agent"
import { createOpenClawAdapter, ProviderRegistry } from "@/lib/providers"
import { resolveRoutingDecision, parseMentions, resolveMentionedAgentIds } from "@/lib/orchestration/router"
import {
  buildA2ARelayPrompt,
  parseA2AClaims,
  parseA2AInstructions,
  parseA2AMentionFallbackInstructions,
  parseA2ATaskUpdates,
  resolveA2ATargetAgentId,
} from "@/lib/orchestration/a2a"
import {
  useRuntimeEventStream,
  useAgentFleet,
  useChatHistory,
  useSendMessage,
  type GatewayEvent,
  type ConnectionStatus,
} from "@/hooks/use-openclaw"
import type { AppContextValue } from "./app-types"
import { initialState } from "./app-types"
import { appReducer } from "./app-reducer"
import {
  saveGroupMessagesToStorage,
  loadGroupsFromStorage,
  loadGroupMessagesFromStorage,
} from "./app-storage"
import { uniqueId, parseViewFromHash, extractTextContent, extractImageAttachments, resolveAgentIdFromPayload } from "./app-utils"
import { saveAttachmentCacheDb, getAttachmentCacheDb } from "@/lib/db"

const CLAIM_CONFIRM_TIMEOUT_MS = 6000
const STALLED_TASK_THRESHOLD_MS = 45_000
const STALLED_TASK_THRESHOLD_IDLE_MS = 25_000
const STALLED_TASK_CHECK_INTERVAL_MS = 10_000
const masterEngine = createMasterEngine()

function parseClaimDecisionCommand(content: string): { action: "approve" | "reject"; taskId: string } | null {
  const text = content.trim()
  if (!text) return null

  const slash = text.match(/^\/claim\s+(approve|reject)\s+([^\s]+)$/i)
  if (slash) {
    return { action: slash[1].toLowerCase() as "approve" | "reject", taskId: slash[2] }
  }

  const approve = text.match(/^(?:确认认领|同意认领|approve(?:\s+claim)?)\s+([^\s]+)$/i)
  if (approve) {
    return { action: "approve", taskId: approve[1] }
  }

  const reject = text.match(/^(?:拒绝认领|驳回认领|reject(?:\s+claim)?)\s+([^\s]+)$/i)
  if (reject) {
    return { action: "reject", taskId: reject[1] }
  }

  return null
}

function extractMessageTextForAutomation(message: {
  content: string
  contentBlocks?: Array<Record<string, unknown>>
}): string {
  const plain = message.content?.trim() ?? ""
  if (plain.length > 0) return plain
  if (!Array.isArray(message.contentBlocks) || message.contentBlocks.length === 0) return ""

  const textParts: string[] = []
  for (const block of message.contentBlocks) {
    if (!block || typeof block !== "object") continue
    const rec = block as Record<string, unknown>
    if (rec.type === "text" && typeof rec.text === "string" && rec.text.trim()) {
      textParts.push(rec.text)
    }
  }
  return textParts.join("\n").trim()
}

function buildA2AStallMonitorPrompt(tasks: Array<{ task: GroupWorkspaceTask; staleForMs: number }>): string {
  return masterEngine.buildStallMonitorPrompt(tasks)
}

function buildA2AStallInvestigationPrompt(params: {
  assigneeName: string
  tasks: Array<{ task: GroupWorkspaceTask; staleForMs: number }>
}): string {
  const lines = params.tasks.map(({ task, staleForMs }, index) => {
    const stalledSec = Math.round(staleForMs / 1000)
    return `${index + 1}. taskId=${task.id}, title=${task.title}, status=${task.status}, progress=${task.progress}%, stale=${stalledSec}s`
  })

  return [
    `Master巡检：检测到你负责的任务停滞，请立即排查并继续推进（${params.assigneeName}）。`,
    "请对下列任务逐条反馈（使用 A2A STATUS 协议，便于系统自动回写）：",
    ...lines,
    "",
    "反馈格式示例：",
    "A2A STATUS -> task=<taskId> progress 60: 已定位问题，正在修复",
    "A2A STATUS -> task=<taskId> blocked: 依赖缺失，需xxx支持",
    "A2A STATUS -> task=<taskId> done: 已完成并提交结果",
    "",
    "要求：不要停滞，若遇阻塞必须明确阻塞原因和下一步解法。",
  ].join("\n")
}

function buildA2AProgressReviewPrompt(params: {
  senderAgentName: string
  terminalUpdates: Array<{ taskId: string; title: string; status: "done" | "blocked"; note?: string }>
  tasks: GroupWorkspaceTask[]
}): string {
  return masterEngine.buildProgressReviewPrompt(params)
}

function buildA2ASharedContextSnippet(params: {
  latestUserRequest?: string
  tasks: GroupWorkspaceTask[]
  recentAgentUpdates?: string[]
}): string {
  return masterEngine.buildSharedContextSnippet(params)
}

function toMasterDecisionTrace(params: {
  phase: "kickoff" | "rebalance" | "assignment"
  summary: string
  assignments?: MasterPlanAssignment[]
  diagnostics?: MasterPlanTaskDiagnostic[]
}): MasterDecisionTrace {
  return {
    engine: "embedded-master",
    phase: params.phase,
    summary: params.summary,
    assignments: params.assignments,
    diagnostics: params.diagnostics,
    createdAt: new Date().toISOString(),
  }
}

function buildWorkspacePrompt(workspacePath: string, content: string): string {
  return [
    "[Shared workspace - important]",
    "This task runs in a multi-agent shared workspace. Please follow these rules strictly:",
    `1. Your working directory is: ${workspacePath}`,
    "2. Read and write files only inside this directory. Do not use your default workspace.",
    "3. This workspace is shared by teammates. Do not overwrite others' work.",
    "4. Keep file organization clear and avoid destructive edits.",
    "---",
    content,
  ].join("\n")
}

/** Preload attachment overrides from IndexedDB before dispatching LOAD_HISTORY. */
async function prefetchAttachmentOverrides(
  convId: string,
  messages: import("@/hooks/use-openclaw").HistoryMessage[]
): Promise<ChatAttachment[][]> {
  return Promise.all(
    messages.map(async (m) => {
      if (m.role !== "user") return []
      if (extractImageAttachments(m.content).length > 0) return []
      const text = extractTextContent(m.content)
      return getAttachmentCacheDb(convId, text)
    })
  )
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState)
  const { loadFleet } = useAgentFleet()
  const { loadHistory } = useChatHistory()
  const { send } = useSendMessage()
  const providerRegistry = useMemo(() => {
    const registry = new ProviderRegistry()
    registry.register(createOpenClawAdapter(send))
    return registry
  }, [send])
  const initializedRef = useRef(false)
  const stateRef = useRef(state)
  stateRef.current = state
  // Tracks coordinator message IDs already processed in THIS session (prevents double-dispatch)
  const processedCoordinatorMsgsRef = useRef(new Set<string>())
  // Tracks agent messages already scanned by A2A parser (prevents duplicate relays)
  const processedA2AMsgIdsRef = useRef(new Set<string>())
  // Tracks user claim decision commands already processed in THIS session
  const processedA2AUserCmdMsgIdsRef = useRef(new Set<string>())
  // Pending claim auto-approval timers. key = `${conversationId}:${taskId}`
  const claimApprovalTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // Pending embedded-master kickoff plans waiting for user confirmation.
  const pendingKickoffPlansRef = useRef(
    new Map<string, { assignments: MasterPlanAssignment[]; attachments?: ChatAttachment[] }>()
  )
  // Stalled task notifications. key = `${conversationId}:${taskId}`, value = updatedAt timestamp string
  const stalledTaskNotifiedVersionRef = useRef(new Map<string, string>())
  // Tracks message IDs loaded from storage at startup (must never be re-dispatched)
  const preloadedGroupMsgIds = useRef(new Set<string>())
  // Pending delayed dispatch timers grouped by conversation ID.
  const conversationDispatchTimersRef = useRef(
    new Map<string, Set<ReturnType<typeof setTimeout>>>()
  )
  // Conversations explicitly aborted by user; automation must not continue dispatching.
  const abortedConversationIdsRef = useRef(new Set<string>())

  const compactionRunsByConversationRef = useRef(new Map<string, Set<string>>())
  const compactionDoneTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const pendingToolResultHydrationRef = useRef(new Set<string>())
  const [compactingConversationIds, setCompactingConversationIds] = useState<Set<string>>(new Set())
  const [compactedConversationIds, setCompactedConversationIds] = useState<Set<string>>(new Set())
  // 缃戝叧浜嬩欢鍘婚噸锛?  // 1) 鍩轰簬 connectionEpoch + seq 鐨勫抚绾у幓閲嶏紙閬垮厤閲嶅娑堣垂鍚屼竴甯э級
  // 2) 鍩轰簬 payload 璇箟鐨勭粓鎬佷簨浠跺幓閲嶏紙閬垮厤 final/end/error 琚噸鏀撅級
  const eventDedupeRef = useRef(new Map<string, number>())
  const DEDUP_TTL_MS = 30_000
  const MAX_DEDUP_KEYS = 4000

  const sendToAgent = useCallback(
    async (params: {
      agentId: string
      content: string
      sessionKey?: string
      attachments?: ChatAttachment[]
    }) => {
      const agent = stateRef.current.agents.find((item) => item.id === params.agentId)
      if (!agent) return { ok: false, error: `agent_not_found:${params.agentId}` }
      return providerRegistry.sendToAgent(agent, params)
    },
    [providerRegistry]
  )

  const isConversationAborted = useCallback((conversationId: string) => {
    return abortedConversationIdsRef.current.has(conversationId)
  }, [])

  const clearConversationDispatchTimers = useCallback((conversationId: string) => {
    const timers = conversationDispatchTimersRef.current.get(conversationId)
    if (!timers) return
    for (const timer of timers) clearTimeout(timer)
    conversationDispatchTimersRef.current.delete(conversationId)
  }, [])

  const clearConversationClaimTimers = useCallback((conversationId: string) => {
    const prefix = `${conversationId}:`
    for (const [key, timer] of [...claimApprovalTimersRef.current.entries()]) {
      if (!key.startsWith(prefix)) continue
      clearTimeout(timer)
      claimApprovalTimersRef.current.delete(key)
    }
  }, [])

  const scheduleConversationDispatch = useCallback((params: {
    conversationId: string
    delayMs?: number
    run: () => void
  }) => {
    const { conversationId, run } = params
    const delayMs = Math.max(0, params.delayMs ?? 0)
    if (isConversationAborted(conversationId)) return

    if (delayMs <= 0) {
      run()
      return
    }

    const timer = setTimeout(() => {
      const timers = conversationDispatchTimersRef.current.get(conversationId)
      if (timers) {
        timers.delete(timer)
        if (timers.size === 0) {
          conversationDispatchTimersRef.current.delete(conversationId)
        }
      }
      if (isConversationAborted(conversationId)) return
      run()
    }, delayMs)

    const timers = conversationDispatchTimersRef.current.get(conversationId) ?? new Set<ReturnType<typeof setTimeout>>()
    timers.add(timer)
    conversationDispatchTimersRef.current.set(conversationId, timers)
  }, [isConversationAborted])

  const sendToConversationAgent = useCallback(
    (params: {
      conversationId: string
      agentId: string
      content: string
      sessionKey?: string
      attachments?: ChatAttachment[]
    }) => {
      if (isConversationAborted(params.conversationId)) {
        return Promise.resolve({ ok: false, error: "conversation_aborted" })
      }
      return sendToAgent({
        agentId: params.agentId,
        content: params.content,
        sessionKey: params.sessionKey,
        attachments: params.attachments,
      })
    },
    [isConversationAborted, sendToAgent]
  )

  const setPendingKickoffPlanMeta = useCallback((params: {
    conversationId: string
    summary: string
    assignments: MasterPlanAssignment[]
  }) => {
    const conv = stateRef.current.conversations.find((item) => item.id === params.conversationId)
    if (!conv || conv.type !== "group" || !conv.orchestration) return
    const nextOrchestration = {
      ...conv.orchestration,
      pendingKickoffPlan: {
        createdAt: new Date().toISOString(),
        summary: params.summary,
        assignments: params.assignments.map((item) => ({
          memberId: item.memberId,
          memberName: item.memberName,
          taskTitle: item.taskTitle,
          taskDomain: item.taskDomain,
        })),
      },
    }
    dispatch({
      type: "UPDATE_GROUP_ORCHESTRATION",
      payload: {
        conversationId: params.conversationId,
        orchestration: nextOrchestration,
      },
    })
  }, [dispatch])

  const clearPendingKickoffPlan = useCallback((conversationId: string) => {
    pendingKickoffPlansRef.current.delete(conversationId)
    const conv = stateRef.current.conversations.find((item) => item.id === conversationId)
    if (!conv || conv.type !== "group" || !conv.orchestration?.pendingKickoffPlan) return
    const nextOrchestration = {
      ...conv.orchestration,
      pendingKickoffPlan: undefined,
    }
    dispatch({
      type: "UPDATE_GROUP_ORCHESTRATION",
      payload: {
        conversationId,
        orchestration: nextOrchestration,
      },
    })
  }, [dispatch])

  const buildEmbeddedKickoffPlan = useCallback((params: {
    conversationId: string
    content: string
    attachments?: ChatAttachment[]
    sourceLabel: string
  }) => {
    const { conversationId, content, attachments, sourceLabel } = params
    const conv = stateRef.current.conversations.find((item) => item.id === conversationId)
    if (!conv || conv.type !== "group") {
      return { ok: false, reason: "Conversation not found." }
    }
    const orchestration = conv.orchestration
    if (orchestration?.strategy !== "a2a" || orchestration?.masterMode === "openclaw-coordinator") {
      return { ok: false, reason: "Current group is not embedded-master A2A." }
    }
    const agentMemberIds = conv.members.filter((id) => id !== "user")
    if (agentMemberIds.length === 0) {
      return { ok: false, reason: "No available group members." }
    }

    const mentions = parseMentions(content)
    const agents = stateRef.current.agents
    const preferredIds = resolveMentionedAgentIds(mentions, agents, agentMemberIds)
    const members = agents
      .filter((agent) => agentMemberIds.includes(agent.id))
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        skills: agent.skills,
      }))

    const plan = masterEngine.planKickoff({
      userRequest: content,
      members,
      coordinatorId: orchestration?.coordinatorId,
      preferredMemberIds: preferredIds,
      strictRoleMatch: orchestration?.a2aStrictRoleMatch !== false,
      maxAssignments: 3,
    })

    if (plan.assignments.length === 0) {
      clearPendingKickoffPlan(conversationId)
      dispatch({
        type: "ADD_ORCHESTRATION_MESSAGE",
        payload: {
          conversationId,
          strategy: "a2a",
          selectedAgents: [],
          reason: `Master 未生成可执行分工草案：${plan.summary}`,
          masterDecision: toMasterDecisionTrace({
            phase: "kickoff",
            summary: plan.summary,
            assignments: plan.assignments,
            diagnostics: plan.diagnostics,
          }),
        },
      })
      return { ok: false, reason: plan.summary }
    }

    pendingKickoffPlansRef.current.set(conversationId, {
      assignments: plan.assignments,
      attachments,
    })
    setPendingKickoffPlanMeta({
      conversationId,
      summary: plan.summary,
      assignments: plan.assignments,
    })

    dispatch({
      type: "ADD_ORCHESTRATION_MESSAGE",
      payload: {
        conversationId,
        strategy: "a2a",
        selectedAgents: plan.assignments.map((item) => item.memberId),
        reason: `Master 已生成分工草案（${sourceLabel}），等待你的确认后执行。${plan.summary}`,
        masterDecision: toMasterDecisionTrace({
          phase: "kickoff",
          summary: plan.summary,
          assignments: plan.assignments,
          diagnostics: plan.diagnostics,
        }),
      },
    })
    return { ok: true, reason: plan.summary }
  }, [clearPendingKickoffPlan, dispatch, setPendingKickoffPlanMeta])

  const dispatchEmbeddedMasterAssignments = useCallback((params: {
    conversation: Conversation
    assignments: MasterPlanAssignment[]
    sourceLabel: string
    senderAgentName?: string
    attachments?: ChatAttachment[]
  }) => {
    const { conversation, assignments, sourceLabel, senderAgentName, attachments } = params
    if (assignments.length === 0) return
    if (isConversationAborted(conversation.id)) return

    const latestConversation =
      stateRef.current.conversations.find((item) => item.id === conversation.id) ?? conversation
    const messages = stateRef.current.messages[conversation.id] ?? []
    const latestUserRequest = messages
      .filter((item) => item.senderId === "user")
      .at(-1)
      ?.content
    const recentAgentUpdates = messages
      .filter(
        (item) =>
          item.senderId !== "user"
          && item.senderId !== "system"
          && item.type !== "orchestration"
          && !item.id.startsWith("streaming-")
          && (!senderAgentName || item.senderName !== senderAgentName)
      )
      .slice(-4)
      .map((item) => {
        const text = extractMessageTextForAutomation(item).replace(/\s+/g, " ").trim()
        if (!text) return null
        return `- ${item.senderName}: ${text.slice(0, 120)}`
      })
      .filter((line): line is string => !!line)

    const sharedContext = buildA2ASharedContextSnippet({
      latestUserRequest,
      tasks: latestConversation.workspaceTasks ?? [],
      recentAgentUpdates,
    })

    assignments.forEach((assignment, index) => {
      const targetAgent = stateRef.current.agents.find((item) => item.id === assignment.memberId)
      if (!targetAgent || !conversation.members.includes(assignment.memberId)) {
        dispatch({
          type: "ADD_ORCHESTRATION_MESSAGE",
          payload: {
            conversationId: conversation.id,
            strategy: "a2a",
            selectedAgents: [],
            reason: `Embedded master skipped assignment for unknown member "${assignment.memberId}".`,
          },
        })
        return
      }

      const taskId = assignment.taskId ?? `a2a-master-${Date.now()}-${index}`
      const existingTask = (latestConversation.workspaceTasks ?? []).find((task) => task.id === taskId)
      if (existingTask) {
        dispatch({
          type: "UPDATE_GROUP_TASK",
          payload: {
            conversationId: conversation.id,
            taskId,
            patch: {
              assigneeId: assignment.memberId,
              pendingAssigneeId: undefined,
              pendingClaimAt: undefined,
              claimDeadlineAt: undefined,
              status: "in-progress",
              progress: Math.max(25, existingTask.progress),
              blockedReason: undefined,
              lastNote: assignment.reason,
              updatedAt: new Date().toISOString(),
            },
          },
        })
      } else {
        dispatch({
          type: "ADD_GROUP_TASK",
          payload: {
            conversationId: conversation.id,
            task: {
              id: taskId,
              title: assignment.taskTitle,
              description: assignment.reason,
              assigneeId: assignment.memberId,
              pendingAssigneeId: undefined,
              pendingClaimAt: undefined,
              claimDeadlineAt: undefined,
              status: "in-progress",
              progress: 30,
              priority: "medium",
              blockedReason: undefined,
              lastNote: undefined,
              dueAt: undefined,
              source: "a2a",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        })
      }

      dispatch({
        type: "ADD_ORCHESTRATION_MESSAGE",
        payload: {
          conversationId: conversation.id,
          strategy: "a2a",
          selectedAgents: [assignment.memberId],
          reason: `Embedded master assigned (${sourceLabel}): ${assignment.memberName} <- ${assignment.taskTitle}`,
          masterDecision: toMasterDecisionTrace({
            phase: "assignment",
            summary: `Assigned ${assignment.memberName} to "${assignment.taskTitle}" (${sourceLabel}).`,
            assignments: [assignment],
          }),
        },
      })

      const relayPrompt = buildA2ARelayPrompt({
        fromAgentName: "Embedded Master",
        targetAgentName: targetAgent.name,
        targetAgentRole: targetAgent.role,
        targetAgentSkills: targetAgent.skills ?? [],
        intent: assignment.intent ?? "delegate",
        message: assignment.taskDescription || assignment.taskTitle,
        taskId,
      })
      const sessionKey = `agent:${assignment.memberId}:group:${conversation.id}`
      const relayWithContext = `${relayPrompt}\n\n${sharedContext}`
      const messageContent = conversation.workspacePath
        ? buildWorkspacePrompt(conversation.workspacePath, relayWithContext)
        : relayWithContext

      scheduleConversationDispatch({
        conversationId: conversation.id,
        delayMs: index * 350,
        run: () => {
          void sendToConversationAgent({
            conversationId: conversation.id,
            agentId: assignment.memberId,
            content: messageContent,
            sessionKey,
            attachments: index === 0 ? attachments : undefined,
          })
        },
      })
    })
  }, [dispatch, isConversationAborted, scheduleConversationDispatch, sendToConversationAgent])

  const appendRendererTrace = useCallback((event: string, data?: unknown) => {
    try {
      void window.ipc.debugTraceAppend({ event, data, source: 'renderer.app-context' })
    } catch {
      // ignore trace write failures
    }
  }, [])

  const hydrateMissingToolResult = useCallback((event: GatewayEvent) => {
    if (event.type !== "gateway.event" || event.event !== "agent") return
    const payload = event.payload as Record<string, unknown> | undefined
    if (!payload || payload.stream !== "tool") return
    const data = payload.data as Record<string, unknown> | undefined
    if (!data) return
    const phase = typeof data.phase === "string" ? data.phase : ""
    if (phase !== "result" && phase !== "end") return

    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : ""
    if (!toolCallId) return
    const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : ""
    if (!sessionKey) return

    const hasInlineResult =
      data.result !== undefined
      || (typeof data.text === "string" && data.text.trim().length > 0)
    if (hasInlineResult) return

    const agentId = resolveAgentIdFromPayload(payload)
    if (!agentId) return

    const pendingKey = `${sessionKey}:${toolCallId}`
    if (pendingToolResultHydrationRef.current.has(pendingKey)) return
    pendingToolResultHydrationRef.current.add(pendingKey)

    const runId = typeof payload.runId === "string" ? payload.runId : ""
    const toolName = typeof data.name === "string" ? data.name : ""
    const retryDelaysMs = [120, 360, 900]

    const attempt = async (idx: number): Promise<void> => {
      try {
        const res = await window.ipc.chatToolResult({
          agentId,
          sessionKey,
          toolCallId,
        })
        const result = (res as { ok?: boolean; result?: Record<string, unknown> })?.result
        const found = (result?.found === true)
        if (res && (res as { ok?: boolean }).ok && found) {
          const details = result?.details as Record<string, unknown> | undefined
          const aggregated = typeof details?.aggregated === "string" ? details.aggregated : ""
          const hydratedContent = result?.content ?? aggregated
          if (hydratedContent !== undefined && hydratedContent !== null) {
            const synthetic: GatewayEvent = {
              type: "gateway.event",
              event: "agent",
              payload: {
                ...payload,
                runId,
                sessionKey,
                stream: "tool",
                data: {
                  ...data,
                  phase: "result",
                  name: toolName,
                  toolCallId,
                  isError: result?.isError === true || data.isError === true,
                  result: hydratedContent,
                },
              },
            }
            appendRendererTrace("renderer.toolResult.hydrated", {
              runId,
              sessionKey,
              toolCallId,
              toolName,
              source: "jsonl",
            })
            dispatch({ type: "GATEWAY_EVENT", payload: synthetic })
            pendingToolResultHydrationRef.current.delete(pendingKey)
            return
          }
        }
      } catch {
        // retry below
      }

      if (idx < retryDelaysMs.length - 1) {
        setTimeout(() => { void attempt(idx + 1) }, retryDelaysMs[idx + 1])
      } else {
        pendingToolResultHydrationRef.current.delete(pendingKey)
      }
    }

    void attempt(0)
  }, [appendRendererTrace])

  const handleEvent = useCallback((event: GatewayEvent) => {
    appendRendererTrace('renderer.handleEvent.received', {
      type: event.type,
      event: event.event ?? null,
      seq: event.seq ?? null,
      status: event.status ?? null,
    })
    if (event.type === "gateway.event") {
      const now = Date.now()
      const map = eventDedupeRef.current

      if (map.size > MAX_DEDUP_KEYS) {
        for (const [k, ts] of map) {
          if (now - ts > DEDUP_TTL_MS) map.delete(k)
        }
        if (map.size > MAX_DEDUP_KEYS) {
          let overflow = map.size - MAX_DEDUP_KEYS
          for (const k of map.keys()) {
            map.delete(k)
            overflow -= 1
            if (overflow <= 0) break
          }
        }
      }
      // Frame-level dedupe: handle each gateway frame once.
      if (typeof event.seq === "number") {
        const rec = event as unknown as Record<string, unknown>
        const epoch = typeof rec.connectionEpoch === "string" ? rec.connectionEpoch : "no-epoch"
        const frameKey = `frame:${epoch}:${event.seq}`
        const seenAt = map.get(frameKey)
        if (typeof seenAt === "number" && (now - seenAt) < DEDUP_TTL_MS) {
          appendRendererTrace('renderer.handleEvent.dedup.frame', { frameKey })
          return
        }
        map.set(frameKey, now)
      }
      // Semantic dedupe for terminal events that may be replayed by the gateway.
      const pl = event.payload as Record<string, unknown> | undefined
      if (pl) {
        const runId = pl.runId != null ? String(pl.runId) : ""
        const sessionKey = pl.sessionKey != null ? String(pl.sessionKey) : ""
        const evtName = event.event ?? ""
        // Chat events use state (delta/final/error/aborted).
        const state = pl.state != null ? String(pl.state) : ""
        // agent 浜嬩欢浣跨敤 stream + phase
        const data = pl.data as Record<string, unknown> | undefined
        const stream = pl.stream != null ? String(pl.stream) : ""
        const phase = data?.phase != null ? String(data.phase) : ""
        // Do not dedupe deltas; dedupe terminal-only states/phases.
        const isTerminal = state === "final" || state === "error" || state === "aborted"
          || phase === "end" || phase === "error" || phase === "completed"
        if (isTerminal && runId) {
          const dedupeKey = `terminal:${[runId, sessionKey, evtName, state, stream, phase].join("|")}`
          if (map.has(dedupeKey)) {
            appendRendererTrace('renderer.handleEvent.dedup.terminal', { dedupeKey })
            return
          }
          map.set(dedupeKey, now)
        }
      }
    }
    // Track compaction lifecycle per conversation for UI state.
    if (event.type === "gateway.event" && event.event === "agent") {
      const payload = event.payload as Record<string, unknown> | undefined
      if (payload && payload.stream === "compaction") {
        const data = payload.data as Record<string, unknown> | undefined
        const phase = data?.phase != null ? String(data.phase) : ""
        const runId = payload.runId != null ? String(payload.runId) : ""
        const sessionKey = typeof payload.sessionKey === "string" ? payload.sessionKey : ""
        const groupMatch = sessionKey.match(/^agent:[^:]+:group:(.+)$/)
        const agentId = resolveAgentIdFromPayload(payload)
        const conversationId = groupMatch ? groupMatch[1] : (agentId ? `conv-${agentId}` : null)

        if (conversationId && (phase === "start" || phase === "end" || phase === "error" || phase === "completed")) {
          const runKey = runId || "__no_run__"
          const runsMap = compactionRunsByConversationRef.current
          const activeRuns = new Set(runsMap.get(conversationId) ?? [])

          if (phase === "start") {
            if (activeRuns.has(runKey)) {
              dispatch({ type: "GATEWAY_EVENT", payload: event })
              return
            }

            activeRuns.add(runKey)
            runsMap.set(conversationId, activeRuns)

            const doneTimer = compactionDoneTimersRef.current.get(conversationId)
            if (doneTimer) {
              clearTimeout(doneTimer)
              compactionDoneTimersRef.current.delete(conversationId)
            }

            setCompactedConversationIds((prev) => {
              if (!prev.has(conversationId)) return prev
              const next = new Set(prev)
              next.delete(conversationId)
              return next
            })

            setCompactingConversationIds((prev) => {
              if (prev.has(conversationId)) return prev
              const next = new Set(prev)
              next.add(conversationId)
              return next
            })
          } else {
            if (activeRuns.has(runKey)) {
              activeRuns.delete(runKey)
            } else if (!runId && activeRuns.size > 0) {
              const firstRun = activeRuns.values().next().value
              if (firstRun) activeRuns.delete(firstRun)
            } else {
              dispatch({ type: "GATEWAY_EVENT", payload: event })
              return
            }

            if (activeRuns.size > 0) {
              runsMap.set(conversationId, activeRuns)
            } else {
              runsMap.delete(conversationId)

              setCompactingConversationIds((prev) => {
                if (!prev.has(conversationId)) return prev
                const next = new Set(prev)
                next.delete(conversationId)
                return next
              })

              setCompactedConversationIds((prev) => {
                if (prev.has(conversationId)) return prev
                const next = new Set(prev)
                next.add(conversationId)
                return next
              })

              const existingTimer = compactionDoneTimersRef.current.get(conversationId)
              if (existingTimer) clearTimeout(existingTimer)
              const timer = setTimeout(() => {
                compactionDoneTimersRef.current.delete(conversationId)
                setCompactedConversationIds((prev) => {
                  if (!prev.has(conversationId)) return prev
                  const next = new Set(prev)
                  next.delete(conversationId)
                  return next
                })
              }, 5000)
              compactionDoneTimersRef.current.set(conversationId, timer)
            }
          }
        }
      }
    }

    hydrateMissingToolResult(event)

    appendRendererTrace('renderer.handleEvent.dispatch', {
      type: event.type,
      event: event.event ?? null,
      seq: event.seq ?? null,
    })
    dispatch({ type: "GATEWAY_EVENT", payload: event })
  }, [appendRendererTrace, hydrateMissingToolResult])
  // Declare refreshFleet before useRuntimeEventStream so status effect can reference it.
  const refreshFleet = useCallback(async () => {
    const result = await loadFleet()
    if (result?.seeds && result.seeds.length > 0) {
      dispatch({ type: "SET_FLEET", payload: { seeds: result.seeds, mainAgentId: result.mainAgentId ?? null } })
      for (const seed of result.seeds) {
        const convId = `conv-${seed.agentId}`
        loadHistory(seed.agentId).then(async (messages) => {
          if (messages.length === 0) return
          const attachmentOverrides = await prefetchAttachmentOverrides(convId, messages)
          dispatch({
            type: "LOAD_HISTORY",
            payload: {
              conversationId: convId,
              agentId: seed.agentId,
              messages,
              attachmentOverrides,
            },
          })
        })
      }
    }
  }, [loadFleet, loadHistory])

  const checkModelsConfigured = useCallback(async () => {
    try {
      const res = await window.ipc.openclawModelsGet()
      if (!res || !res.ok) {
        dispatch({ type: "SET_MODELS_CONFIGURED", payload: false })
        return
      }
      const result = res as { providers: Record<string, unknown>; defaults: { primary: string } }
      const hasProviders = result.providers && Object.keys(result.providers).length > 0
      const hasPrimary = !!result.defaults?.primary
      dispatch({ type: "SET_MODELS_CONFIGURED", payload: !!(hasProviders && hasPrimary) })
    } catch {
      // IPC 灏氭湭灏辩华鏃朵繚鎸侀粯璁ゅ€硷紙true锛夛紝閬垮厤鐣岄潰闂儊
    }
  }, [])

  const { status, connect } = useRuntimeEventStream(handleEvent)

  const prevStatusRef = useRef<ConnectionStatus>("disconnected")
  const fleetRetryRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    dispatch({ type: "SET_CONNECTION_STATUS", payload: status })
    // On reconnection, refresh fleet and model state.
    if (status === "connected" && prevStatusRef.current !== "connected") {
      refreshFleet()
      checkModelsConfigured()
      // Fleet can be temporarily empty right after reconnect; retry up to 20s.
      if (fleetRetryRef.current) clearInterval(fleetRetryRef.current)
      let elapsed = 0
      fleetRetryRef.current = setInterval(() => {
        elapsed += 1000
        if (stateRef.current.agents.length > 0 || elapsed >= 20000) {
          if (fleetRetryRef.current) clearInterval(fleetRetryRef.current)
          fleetRetryRef.current = null
          return
        }
        refreshFleet()
      }, 1000)
    }
    // Stop retry loop while disconnected.
    if (status !== "connected" && fleetRetryRef.current) {
      clearInterval(fleetRetryRef.current)
      fleetRetryRef.current = null
    }
    prevStatusRef.current = status

    return () => {
      if (fleetRetryRef.current) {
        clearInterval(fleetRetryRef.current)
        fleetRetryRef.current = null
      }
    }
  }, [status, refreshFleet, checkModelsConfigured])

  useEffect(() => {
    return () => {
      for (const timer of compactionDoneTimersRef.current.values()) {
        clearTimeout(timer)
      }
      for (const timer of claimApprovalTimersRef.current.values()) {
        clearTimeout(timer)
      }
      compactionDoneTimersRef.current.clear()
      compactionRunsByConversationRef.current.clear()
      claimApprovalTimersRef.current.clear()
      stalledTaskNotifiedVersionRef.current.clear()
    }
  }, [])

  // Persist group messages to localStorage whenever messages change
  // Skip until initialization is complete to avoid overwriting saved data with empty state
  useEffect(() => {
    if (!initializedRef.current) return
    saveGroupMessagesToStorage(state.messages, state.conversations)
  }, [state.messages, state.conversations])

  useEffect(() => {
    return () => {
      for (const timers of conversationDispatchTimersRef.current.values()) {
        for (const timer of timers) clearTimeout(timer)
      }
      conversationDispatchTimersRef.current.clear()
    }
  }, [])

    // Coordinator auto-routing: when coordinator message contains @mentions,
  // relay the last user request to mentioned members.
  useEffect(() => {
    for (const conv of state.conversations) {
      if (conv.type !== "group" || conv.orchestration?.strategy !== "coordinator") continue
      if (isConversationAborted(conv.id)) continue
      const coordinatorId = conv.orchestration.coordinatorId
      if (!coordinatorId) continue

      const msgs = state.messages[conv.id]
      if (!msgs || msgs.length < 2) continue

      const lastCoordinatorMsg = msgs
        .filter((m) => m.senderId === coordinatorId && !m.id.startsWith("streaming-"))
        .at(-1)
      if (!lastCoordinatorMsg) continue
      if (preloadedGroupMsgIds.current.has(lastCoordinatorMsg.id)) continue
      if (processedCoordinatorMsgsRef.current.has(lastCoordinatorMsg.id)) continue

      const coordinatorText = extractMessageTextForAutomation(lastCoordinatorMsg)
      const mentions = parseMentions(coordinatorText)
      if (mentions.length === 0) continue

      const agentMemberIds = conv.members.filter((id) => id !== "user" && id !== coordinatorId)
      const mentionedIds = resolveMentionedAgentIds(mentions, state.agents, agentMemberIds)
      if (mentionedIds.length === 0) continue

      const coordinatorMsgIdx = msgs.indexOf(lastCoordinatorMsg)
      const lastUserMsg = msgs
        .slice(0, coordinatorMsgIdx)
        .filter((m) => m.senderId === "user")
        .at(-1)
      if (!lastUserMsg) continue

      processedCoordinatorMsgsRef.current.add(lastCoordinatorMsg.id)

      const names = mentionedIds
        .map((id) => state.agents.find((a) => a.id === id)?.name ?? id)
        .join(", ")
      dispatch({
        type: "ADD_ORCHESTRATION_MESSAGE",
        payload: {
          conversationId: conv.id,
          strategy: "coordinator",
          selectedAgents: mentionedIds,
          reason: `Coordinator dispatched => ${names}`,
        },
      })

      mentionedIds.forEach((agentId, index) => {
        const sessionKey = `agent:${agentId}:group:${conv.id}`
        const baseContent = lastUserMsg.content
        const messageContent = conv.workspacePath
          ? buildWorkspacePrompt(conv.workspacePath, baseContent)
          : baseContent
        scheduleConversationDispatch({
          conversationId: conv.id,
          delayMs: index * 500,
          run: () => {
            void sendToConversationAgent({
              conversationId: conv.id,
              agentId,
              content: messageContent,
              sessionKey,
            })
          },
        })
      })
    }
  }, [state.messages, state.conversations, state.agents, isConversationAborted, scheduleConversationDispatch, sendToConversationAgent, dispatch])

  // A2A relay: when a finalized agent message contains explicit A2A instructions,
  // relay sub-tasks to target agents in the same group.
  useEffect(() => {
    for (const conv of state.conversations) {
      if (conv.type !== "group" || conv.orchestration?.strategy !== "a2a") continue
      if (isConversationAborted(conv.id)) continue

      const msgs = state.messages[conv.id]
      if (!msgs || msgs.length === 0) continue

      const lastAgentMsg = msgs
        .filter(
          (m) =>
            m.senderId !== "user"
            && m.senderId !== "system"
            && !m.id.startsWith("streaming-")
            && m.type !== "orchestration"
        )
        .at(-1)
      if (!lastAgentMsg) continue
      if (preloadedGroupMsgIds.current.has(lastAgentMsg.id)) continue
      if (processedA2AMsgIdsRef.current.has(lastAgentMsg.id)) continue

      processedA2AMsgIdsRef.current.add(lastAgentMsg.id)

      const agentText = extractMessageTextForAutomation(lastAgentMsg)
      const isCoordinatorMsg = conv.orchestration?.coordinatorId === lastAgentMsg.senderId
      let instructions = parseA2AInstructions(agentText)
      if (instructions.length === 0 && isCoordinatorMsg) {
        const fallbackInstructions = parseA2AMentionFallbackInstructions(agentText)
        if (fallbackInstructions.length > 0) {
          instructions = fallbackInstructions
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: [],
              reason: `A2A fallback: parsed ${fallbackInstructions.length} mention-based delegation(s) from coordinator.`,
            },
          })
        }
      }
      const rawStatusUpdates = parseA2ATaskUpdates(agentText)
      const rawClaims = parseA2AClaims(agentText)
      if (isCoordinatorMsg && (rawStatusUpdates.length > 0 || rawClaims.length > 0)) {
        dispatch({
          type: "ADD_ORCHESTRATION_MESSAGE",
          payload: {
            conversationId: conv.id,
            strategy: "a2a",
            selectedAgents: [lastAgentMsg.senderId],
            reason: "Coordinator is orchestrator-only: status/claim lines from coordinator were ignored.",
          },
        })
      }
      const statusUpdates = isCoordinatorMsg ? [] : rawStatusUpdates
      const claims = isCoordinatorMsg ? [] : rawClaims
      if (instructions.length === 0 && statusUpdates.length === 0 && claims.length === 0) continue

      const senderAgentName =
        state.agents.find((a) => a.id === lastAgentMsg.senderId)?.name
        ?? lastAgentMsg.senderName
        ?? lastAgentMsg.senderId
      const allowedTargetIds = conv.members.filter(
        (id) => id !== "user" && id !== lastAgentMsg.senderId
      )

      const latestUserRequest = msgs
        .filter((m) => m.senderId === "user")
        .at(-1)
        ?.content
      const recentAgentUpdates = msgs
        .filter(
          (m) =>
            m.senderId !== "user"
            && m.senderId !== "system"
            && m.senderId !== lastAgentMsg.senderId
            && !m.id.startsWith("streaming-")
            && m.type !== "orchestration"
        )
        .slice(-4)
        .map((m) => {
          const text = extractMessageTextForAutomation(m).replace(/\s+/g, " ").trim()
          if (!text) return null
          const summary = text.slice(0, 120)
          return `- ${m.senderName}: ${summary}`
        })
        .filter((line): line is string => !!line)
      const sharedContextSnippet = buildA2ASharedContextSnippet({
        latestUserRequest,
        tasks: conv.workspaceTasks ?? [],
        recentAgentUpdates,
      })

      instructions.forEach((inst, index) => {
        const targetAgentId = resolveA2ATargetAgentId(inst.to, state.agents, allowedTargetIds)
        if (!targetAgentId) {
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: [],
              reason: `A2A relay skipped: cannot resolve target "${inst.to}" from ${senderAgentName}.`,
            },
          })
          return
        }

        const targetAgent = state.agents.find((a) => a.id === targetAgentId)
        const targetName = targetAgent?.name ?? targetAgentId
        if (conv.orchestration?.coordinatorId && targetAgentId === conv.orchestration.coordinatorId) {
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: [lastAgentMsg.senderId],
              reason: `A2A relay blocked: coordinator "${targetName}" is orchestration-only.`,
            },
          })
          return
        }
        if (targetAgent) {
          const decision = masterEngine.evaluateAssignment({
            taskText: inst.message,
            strictRoleMatch: conv.orchestration?.a2aStrictRoleMatch !== false,
            member: {
              id: targetAgent.id,
              name: targetAgent.name,
              role: targetAgent.role,
              skills: targetAgent.skills,
            },
          })
          if (!decision.allowed && decision.taskDomain) {
            dispatch({
              type: "ADD_ORCHESTRATION_MESSAGE",
              payload: {
                conversationId: conv.id,
                strategy: "a2a",
                selectedAgents: [lastAgentMsg.senderId],
                reason: `A2A relay blocked: "${targetName}" is not matched for ${decision.taskDomain} scope (strict role routing enabled).`,
              },
            })
            return
          }
        }
        dispatch({
          type: "ADD_ORCHESTRATION_MESSAGE",
          payload: {
            conversationId: conv.id,
            strategy: "a2a",
            selectedAgents: [targetAgentId],
            reason: `A2A relay: ${senderAgentName} -> ${targetName}`,
          },
        })

        const taskTitle = inst.message.trim().split("\n")[0]?.slice(0, 120) || `Task from ${senderAgentName}`
        const taskId = `a2a-${lastAgentMsg.id}-${index}`
        dispatch({
          type: "ADD_GROUP_TASK",
          payload: {
            conversationId: conv.id,
            task: {
              id: taskId,
              title: taskTitle,
              description: inst.intent?.trim() || undefined,
              assigneeId: targetAgentId,
              pendingAssigneeId: undefined,
              pendingClaimAt: undefined,
              claimDeadlineAt: undefined,
              status: "in-progress",
              progress: 35,
              priority: "medium",
              blockedReason: undefined,
              lastNote: undefined,
              dueAt: undefined,
              source: "a2a",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        })

        const sessionKey = `agent:${targetAgentId}:group:${conv.id}`
        const relayTask = buildA2ARelayPrompt({
          fromAgentName: senderAgentName,
          targetAgentName: targetName,
          targetAgentRole: targetAgent?.role,
          targetAgentSkills: targetAgent?.skills ?? [],
          intent: inst.intent,
          message: inst.message,
          taskId,
        })
        const relayTaskWithContext = `${relayTask}\n\n${sharedContextSnippet}`
        const messageContent = conv.workspacePath
          ? buildWorkspacePrompt(conv.workspacePath, relayTaskWithContext)
          : relayTaskWithContext

        scheduleConversationDispatch({
          conversationId: conv.id,
          delayMs: index * 400,
          run: () => {
            void sendToConversationAgent({
              conversationId: conv.id,
              agentId: targetAgentId,
              content: messageContent,
              sessionKey,
            })
          },
        })
      })

      if (statusUpdates.length > 0) {
        const senderId = lastAgentMsg.senderId
        const a2aTasks = (conv.workspaceTasks ?? [])
          .filter((task) => task.source === "a2a")
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        const usedTaskIds = new Set<string>()
        const terminalUpdates: Array<{
          taskId: string
          title: string
          status: "done" | "blocked"
          note?: string
        }> = []

        for (const update of statusUpdates) {
          const directTask = update.taskId
            ? a2aTasks.find((task) => task.id === update.taskId)
            : undefined
          const directTaskOwner = directTask?.assigneeId ?? directTask?.pendingAssigneeId
          if (directTask && directTaskOwner && directTaskOwner !== senderId) {
            dispatch({
              type: "ADD_ORCHESTRATION_MESSAGE",
              payload: {
                conversationId: conv.id,
                strategy: "a2a",
                selectedAgents: [senderId],
                reason: `A2A update ignored: task "${directTask.title}" belongs to another agent.`,
              },
            })
            continue
          }

          const matchedTask =
            directTask
            ?? a2aTasks.find(
              (task) =>
                !usedTaskIds.has(task.id)
                && task.status !== "done"
                && (task.assigneeId === senderId || task.pendingAssigneeId === senderId)
            )
          if (!matchedTask) continue

          const pendingTimerKey = `${conv.id}:${matchedTask.id}`
          const pendingTimer = claimApprovalTimersRef.current.get(pendingTimerKey)
          if (pendingTimer) {
            clearTimeout(pendingTimer)
            claimApprovalTimersRef.current.delete(pendingTimerKey)
          }

          usedTaskIds.add(matchedTask.id)
          const nextStatus = update.status ?? (update.progress !== undefined ? "in-progress" : matchedTask.status)
          const nextProgress =
            nextStatus === "done"
              ? 100
              : nextStatus === "todo"
                ? 0
                : update.progress ?? matchedTask.progress
          const nextBlockedReason =
            nextStatus === "blocked"
              ? (update.note ?? matchedTask.blockedReason)
              : undefined

          dispatch({
            type: "UPDATE_GROUP_TASK",
            payload: {
              conversationId: conv.id,
              taskId: matchedTask.id,
              patch: {
                status: nextStatus,
                progress: nextProgress,
                pendingAssigneeId: undefined,
                pendingClaimAt: undefined,
                claimDeadlineAt: undefined,
                blockedReason: nextBlockedReason,
                lastNote: update.note ?? matchedTask.lastNote,
                updatedAt: new Date().toISOString(),
              },
            },
          })

          const statusText =
            nextStatus === "done"
              ? "done"
              : nextStatus === "blocked"
                ? "blocked"
                : nextStatus === "todo"
                  ? "todo"
                  : `in-progress (${nextProgress}%)`
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: [senderId],
              reason: `A2A update: ${senderAgentName} marked "${matchedTask.title}" as ${statusText}`,
            },
          })

          if (nextStatus === "done" || nextStatus === "blocked") {
            terminalUpdates.push({
              taskId: matchedTask.id,
              title: matchedTask.title,
              status: nextStatus,
              note: update.note ?? undefined,
            })
          }
        }

        const latestConv = stateRef.current.conversations.find((item) => item.id === conv.id)
        const latestTasks = (latestConv?.workspaceTasks ?? conv.workspaceTasks ?? []).filter(
          (task) => task.source === "a2a"
        )
        const isEmbeddedMaster = conv.orchestration?.masterMode !== "openclaw-coordinator"
        if (terminalUpdates.length > 0 && isEmbeddedMaster) {
          const members = state.agents
            .filter((agent) => conv.members.includes(agent.id) && agent.id !== "user")
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              skills: agent.skills,
            }))
          const rebalancePlan = masterEngine.planRebalance({
            tasks: latestTasks.map((task) => ({
              id: task.id,
              title: task.title,
              status: task.status,
              progress: task.progress,
              assigneeId: task.assigneeId,
              pendingAssigneeId: task.pendingAssigneeId,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            })),
            members,
            coordinatorId: conv.orchestration?.coordinatorId,
            strictRoleMatch: conv.orchestration?.a2aStrictRoleMatch !== false,
            maxAssignments: 2,
          })
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: rebalancePlan.assignments.map((item) => item.memberId),
              reason: `Embedded master follow-up after ${senderAgentName} update: ${rebalancePlan.summary}`,
              masterDecision: toMasterDecisionTrace({
                phase: "rebalance",
                summary: rebalancePlan.summary,
                assignments: rebalancePlan.assignments,
                diagnostics: rebalancePlan.diagnostics,
              }),
            },
          })
          dispatchEmbeddedMasterAssignments({
            conversation: conv,
            assignments: rebalancePlan.assignments,
            sourceLabel: "progress-follow-up",
            senderAgentName,
          })
        } else {
          const fallbackCoordinatorId = conv.members.find((id) => id !== "user" && id !== senderId)
          const coordinatorId =
            conv.orchestration?.coordinatorId && conv.members.includes(conv.orchestration.coordinatorId)
              ? conv.orchestration.coordinatorId
              : fallbackCoordinatorId
          if (terminalUpdates.length > 0 && coordinatorId && coordinatorId !== senderId) {
            const progressPrompt = buildA2AProgressReviewPrompt({
              senderAgentName,
              terminalUpdates,
              tasks: latestTasks,
            })
            const coordinatorName =
              state.agents.find((agent) => agent.id === coordinatorId)?.name ?? coordinatorId
            dispatch({
              type: "ADD_ORCHESTRATION_MESSAGE",
              payload: {
                conversationId: conv.id,
                strategy: "a2a",
                selectedAgents: [coordinatorId],
                reason: `Coordinator follow-up: ${senderAgentName} reported ${terminalUpdates.length} terminal update(s), requesting ${coordinatorName} to continue planning.`,
              },
            })

            const sessionKey = `agent:${coordinatorId}:group:${conv.id}`
            const messageContent = conv.workspacePath
              ? buildWorkspacePrompt(conv.workspacePath, progressPrompt)
              : progressPrompt
            void sendToConversationAgent({
              conversationId: conv.id,
              agentId: coordinatorId,
              content: messageContent,
              sessionKey,
            })
          }
        }
      }

      if (claims.length > 0) {
        for (const claim of claims) {
          const task = (conv.workspaceTasks ?? []).find((item) => item.id === claim.taskId)
          if (!task || task.status === "done") continue
          if (task.assigneeId && task.assigneeId !== lastAgentMsg.senderId) {
            dispatch({
              type: "ADD_ORCHESTRATION_MESSAGE",
              payload: {
                conversationId: conv.id,
                strategy: "a2a",
                selectedAgents: [lastAgentMsg.senderId],
                reason: `Claim ignored: "${task.title}" is already owned by another agent.`,
              },
            })
            continue
          }

          const timerKey = `${conv.id}:${task.id}`
          const existingTimer = claimApprovalTimersRef.current.get(timerKey)
          if (existingTimer) {
            clearTimeout(existingTimer)
            claimApprovalTimersRef.current.delete(timerKey)
          }

          const claimAt = new Date()
          const deadlineAt = new Date(claimAt.getTime() + CLAIM_CONFIRM_TIMEOUT_MS)
          dispatch({
            type: "UPDATE_GROUP_TASK",
            payload: {
              conversationId: conv.id,
              taskId: task.id,
              patch: {
                pendingAssigneeId: lastAgentMsg.senderId,
                pendingClaimAt: claimAt.toISOString(),
                claimDeadlineAt: deadlineAt.toISOString(),
                lastNote: claim.reason ?? task.lastNote,
                updatedAt: claimAt.toISOString(),
              },
            },
          })

          const claimedBy =
            state.agents.find((agent) => agent.id === lastAgentMsg.senderId)?.name
            ?? lastAgentMsg.senderName
            ?? lastAgentMsg.senderId
          const claimMeta = [
            claim.score !== undefined ? `score=${claim.score}` : null,
            claim.eta ? `eta=${claim.eta}` : null,
          ].filter((item): item is string => !!item).join(", ")
          const suffix = claimMeta ? ` (${claimMeta})` : ""
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: [lastAgentMsg.senderId],
              reason: `Claim pending: ${claimedBy} -> "${task.title}"${suffix}. Reply "确认认领 ${task.id}" or "拒绝认领 ${task.id}" within ${Math.floor(CLAIM_CONFIRM_TIMEOUT_MS / 1000)}s.`,
            },
          })

          const timeoutHandle = setTimeout(() => {
            const latestConv = stateRef.current.conversations.find((item) => item.id === conv.id)
            if (!latestConv || latestConv.type !== "group") return
            const latestTask = (latestConv.workspaceTasks ?? []).find((item) => item.id === task.id)
            if (!latestTask) return
            if (latestTask.pendingAssigneeId !== lastAgentMsg.senderId) return

            dispatch({
              type: "UPDATE_GROUP_TASK",
              payload: {
                conversationId: conv.id,
                taskId: task.id,
                patch: {
                  assigneeId: latestTask.pendingAssigneeId,
                  pendingAssigneeId: undefined,
                  pendingClaimAt: undefined,
                  claimDeadlineAt: undefined,
                  status: latestTask.status === "todo" ? "in-progress" : latestTask.status,
                  lastNote: latestTask.lastNote ?? "Auto-approved claim after timeout",
                  updatedAt: new Date().toISOString(),
                },
              },
            })
            dispatch({
              type: "ADD_ORCHESTRATION_MESSAGE",
              payload: {
                conversationId: conv.id,
                strategy: "a2a",
                selectedAgents: [lastAgentMsg.senderId],
                reason: `Claim auto-approved: "${latestTask.title}" assigned to ${claimedBy} after timeout.`,
              },
            })

            claimApprovalTimersRef.current.delete(timerKey)
          }, CLAIM_CONFIRM_TIMEOUT_MS)

          claimApprovalTimersRef.current.set(timerKey, timeoutHandle)
        }
      }
    }
  }, [state.messages, state.conversations, state.agents, isConversationAborted, scheduleConversationDispatch, sendToConversationAgent, dispatch, dispatchEmbeddedMasterAssignments])

  // Manual claim decision: user can approve/reject pending claims in chat.
  // If there is no manual reply, auto-approval timer will proceed.
  useEffect(() => {
    for (const conv of state.conversations) {
      if (conv.type !== "group" || conv.orchestration?.strategy !== "a2a") continue

      const msgs = state.messages[conv.id]
      if (!msgs || msgs.length === 0) continue

      const lastUserMsg = msgs
        .filter((msg) => msg.senderId === "user" && !msg.id.startsWith("streaming-"))
        .at(-1)
      if (!lastUserMsg) continue
      if (preloadedGroupMsgIds.current.has(lastUserMsg.id)) continue
      if (processedA2AUserCmdMsgIdsRef.current.has(lastUserMsg.id)) continue

      const cmd = parseClaimDecisionCommand(lastUserMsg.content)
      if (!cmd) continue
      processedA2AUserCmdMsgIdsRef.current.add(lastUserMsg.id)

      const task = (conv.workspaceTasks ?? []).find((item) => item.id === cmd.taskId)
      if (!task || !task.pendingAssigneeId) {
        dispatch({
          type: "ADD_ORCHESTRATION_MESSAGE",
          payload: {
            conversationId: conv.id,
            strategy: "a2a",
            selectedAgents: [],
            reason: `No pending claim found for task ${cmd.taskId}.`,
          },
        })
        continue
      }

      const timerKey = `${conv.id}:${task.id}`
      const timer = claimApprovalTimersRef.current.get(timerKey)
      if (timer) {
        clearTimeout(timer)
        claimApprovalTimersRef.current.delete(timerKey)
      }

      const claimerName = state.agents.find((agent) => agent.id === task.pendingAssigneeId)?.name ?? task.pendingAssigneeId
      if (cmd.action === "approve") {
        dispatch({
          type: "UPDATE_GROUP_TASK",
          payload: {
            conversationId: conv.id,
            taskId: task.id,
            patch: {
              assigneeId: task.pendingAssigneeId,
              pendingAssigneeId: undefined,
              pendingClaimAt: undefined,
              claimDeadlineAt: undefined,
              status: task.status === "todo" ? "in-progress" : task.status,
              lastNote: "Manually approved by user",
              updatedAt: new Date().toISOString(),
            },
          },
        })
        dispatch({
          type: "ADD_ORCHESTRATION_MESSAGE",
          payload: {
            conversationId: conv.id,
            strategy: "a2a",
            selectedAgents: [task.pendingAssigneeId],
            reason: `Claim approved manually: "${task.title}" assigned to ${claimerName}.`,
          },
        })
      } else {
        dispatch({
          type: "UPDATE_GROUP_TASK",
          payload: {
            conversationId: conv.id,
            taskId: task.id,
            patch: {
              pendingAssigneeId: undefined,
              pendingClaimAt: undefined,
              claimDeadlineAt: undefined,
              status: task.assigneeId ? task.status : "todo",
              lastNote: "Manually rejected by user",
              updatedAt: new Date().toISOString(),
            },
          },
        })
        dispatch({
          type: "ADD_ORCHESTRATION_MESSAGE",
          payload: {
            conversationId: conv.id,
            strategy: "a2a",
            selectedAgents: [task.pendingAssigneeId],
            reason: `Claim rejected manually: "${task.title}" was not assigned to ${claimerName}.`,
          },
        })
      }
    }
  }, [state.messages, state.conversations, state.agents, isConversationAborted, dispatch])

  // A2A coordinator monitor loop: detect stalled tasks and ask coordinator to re-plan.
  useEffect(() => {
    const checkStalledTasks = () => {
      const snapshot = stateRef.current
      const now = Date.now()

      for (const conv of snapshot.conversations) {
        if (conv.type !== "group" || conv.orchestration?.strategy !== "a2a") continue
        if (isConversationAborted(conv.id)) continue

        const isEmbeddedMaster = conv.orchestration?.masterMode !== "openclaw-coordinator"
        const coordinatorId = conv.orchestration?.coordinatorId
        if (!isEmbeddedMaster && (!coordinatorId || !conv.members.includes(coordinatorId))) continue
        const hasThinkingMembers = [...snapshot.thinkingAgents].some((agentId) => conv.members.includes(agentId))

        const allTasks = conv.workspaceTasks ?? []
        const existingTaskKeys = new Set(allTasks.map((task) => `${conv.id}:${task.id}`))
        for (const key of [...stalledTaskNotifiedVersionRef.current.keys()]) {
          if (key.startsWith(`${conv.id}:`) && !existingTaskKeys.has(key)) {
            stalledTaskNotifiedVersionRef.current.delete(key)
          }
        }

        const stalled: Array<{ task: GroupWorkspaceTask; staleForMs: number }> = []
        for (const task of allTasks) {
          if (task.status === "done") continue
          if (task.pendingAssigneeId && task.claimDeadlineAt) {
            const deadlineMs = Date.parse(task.claimDeadlineAt)
            if (Number.isFinite(deadlineMs) && deadlineMs > now) continue
          }
          if (task.status === "todo" && !task.assigneeId && !task.pendingAssigneeId) continue

          const taskTimestamp = task.updatedAt || task.createdAt
          const taskUpdatedMs = Date.parse(taskTimestamp)
          if (!Number.isFinite(taskUpdatedMs)) continue

          const staleForMs = now - taskUpdatedMs
          const thresholdMs = hasThinkingMembers ? STALLED_TASK_THRESHOLD_MS : STALLED_TASK_THRESHOLD_IDLE_MS
          if (staleForMs < thresholdMs) continue

          const notifiedKey = `${conv.id}:${task.id}`
          const notifiedVersion = stalledTaskNotifiedVersionRef.current.get(notifiedKey)
          if (notifiedVersion === taskTimestamp) continue

          stalled.push({ task, staleForMs })
        }

        if (stalled.length === 0) continue

        if (isEmbeddedMaster) {
          const members = snapshot.agents
            .filter((agent) => conv.members.includes(agent.id) && agent.id !== "user")
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              skills: agent.skills,
            }))
          const rebalancePlan = masterEngine.planRebalance({
            tasks: stalled.map((item) => ({
              id: item.task.id,
              title: item.task.title,
              status: item.task.status,
              progress: item.task.progress,
              assigneeId: item.task.assigneeId,
              pendingAssigneeId: item.task.pendingAssigneeId,
              createdAt: item.task.createdAt,
              updatedAt: item.task.updatedAt,
            })),
            members,
            coordinatorId: conv.orchestration?.coordinatorId,
            strictRoleMatch: conv.orchestration?.a2aStrictRoleMatch !== false,
            maxAssignments: stalled.length,
          })
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: rebalancePlan.assignments.map((item) => item.memberId),
              reason: `Embedded master monitor alert: ${stalled.length} stalled task(s). ${rebalancePlan.summary}`,
              masterDecision: toMasterDecisionTrace({
                phase: "rebalance",
                summary: rebalancePlan.summary,
                assignments: rebalancePlan.assignments,
                diagnostics: rebalancePlan.diagnostics,
              }),
            },
          })
          dispatchEmbeddedMasterAssignments({
            conversation: conv,
            assignments: rebalancePlan.assignments,
            sourceLabel: "stall-monitor",
          })

          const investigationTargets = [...new Set(
            stalled
              .map((item) => item.task.assigneeId ?? item.task.pendingAssigneeId)
              .filter((id): id is string => !!id && conv.members.includes(id))
          )]

          if (investigationTargets.length > 0) {
            dispatch({
              type: "ADD_ORCHESTRATION_MESSAGE",
              payload: {
                conversationId: conv.id,
                strategy: "a2a",
                selectedAgents: investigationTargets,
                reason: `Embedded master investigation: pinging ${investigationTargets.length} assignee(s) to unblock stalled tasks.`,
              },
            })

            for (const targetId of investigationTargets.slice(0, 6)) {
              const targetName = snapshot.agents.find((agent) => agent.id === targetId)?.name ?? targetId
              const tasksForTarget = stalled.filter(
                ({ task }) => task.assigneeId === targetId || task.pendingAssigneeId === targetId
              )
              const prompt = buildA2AStallInvestigationPrompt({
                assigneeName: targetName,
                tasks: tasksForTarget,
              })
              const sessionKey = `agent:${targetId}:group:${conv.id}`
              const messageContent = conv.workspacePath
                ? buildWorkspacePrompt(conv.workspacePath, prompt)
                : prompt
              void sendToConversationAgent({
                conversationId: conv.id,
                agentId: targetId,
                content: messageContent,
                sessionKey,
              })
            }
          }
        } else {
          if (!coordinatorId) continue
          const coordinatorName = snapshot.agents.find((agent) => agent.id === coordinatorId)?.name ?? coordinatorId
          dispatch({
            type: "ADD_ORCHESTRATION_MESSAGE",
            payload: {
              conversationId: conv.id,
              strategy: "a2a",
              selectedAgents: [coordinatorId],
              reason: `Coordinator monitor alert: ${stalled.length} stalled task(s), requesting ${coordinatorName} to unblock.`,
            },
          })

          const sessionKey = `agent:${coordinatorId}:group:${conv.id}`
          const prompt = buildA2AStallMonitorPrompt(stalled)
          const messageContent = conv.workspacePath
            ? buildWorkspacePrompt(conv.workspacePath, prompt)
            : prompt
          void sendToConversationAgent({
            conversationId: conv.id,
            agentId: coordinatorId,
            content: messageContent,
            sessionKey,
          })
        }

        for (const { task } of stalled) {
          stalledTaskNotifiedVersionRef.current.set(`${conv.id}:${task.id}`, task.updatedAt || task.createdAt)
        }
      }
    }

    const timer = setInterval(checkStalledTasks, STALLED_TASK_CHECK_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [isConversationAborted, sendToConversationAgent, dispatch, dispatchEmbeddedMasterAssignments])

  const runEmbeddedMasterRebalance = useCallback(async (conversationId: string) => {
    const conversation = stateRef.current.conversations.find((item) => item.id === conversationId)
    if (!conversation || conversation.type !== "group") {
      return { ok: false, assignmentCount: 0, reason: "Conversation is not an A2A group." }
    }
    if (conversation.orchestration?.strategy !== "a2a") {
      return { ok: false, assignmentCount: 0, reason: "Conversation is not in A2A strategy." }
    }
    if (conversation.orchestration?.masterMode === "openclaw-coordinator") {
      return { ok: false, assignmentCount: 0, reason: "Current group uses OpenClaw coordinator mode." }
    }

    const members = stateRef.current.agents
      .filter((agent) => conversation.members.includes(agent.id) && agent.id !== "user")
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        skills: agent.skills,
      }))
    const tasks = (conversation.workspaceTasks ?? []).map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      progress: task.progress,
      assigneeId: task.assigneeId,
      pendingAssigneeId: task.pendingAssigneeId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }))
    const plan = masterEngine.planRebalance({
      tasks,
      members,
      coordinatorId: conversation.orchestration?.coordinatorId,
      strictRoleMatch: conversation.orchestration?.a2aStrictRoleMatch !== false,
      maxAssignments: 4,
    })

    dispatch({
      type: "ADD_ORCHESTRATION_MESSAGE",
      payload: {
        conversationId,
        strategy: "a2a",
        selectedAgents: plan.assignments.map((item) => item.memberId),
        reason: `Manual rebalance requested from cockpit. ${plan.summary}`,
        masterDecision: toMasterDecisionTrace({
          phase: "rebalance",
          summary: plan.summary,
          assignments: plan.assignments,
          diagnostics: plan.diagnostics,
        }),
      },
    })

    if (plan.assignments.length > 0) {
      dispatchEmbeddedMasterAssignments({
        conversation,
        assignments: plan.assignments,
        sourceLabel: "manual-rebalance",
      })
      return { ok: true, assignmentCount: plan.assignments.length, reason: plan.summary }
    }
    return { ok: false, assignmentCount: 0, reason: plan.summary }
  }, [dispatch, dispatchEmbeddedMasterAssignments])

  const confirmEmbeddedMasterKickoffPlan = useCallback(async (conversationId: string) => {
    const conversation = stateRef.current.conversations.find((item) => item.id === conversationId)
    if (!conversation || conversation.type !== "group") {
      return { ok: false, reason: "Conversation not found." }
    }
    if (conversation.orchestration?.strategy !== "a2a" || conversation.orchestration?.masterMode === "openclaw-coordinator") {
      return { ok: false, reason: "Current group is not embedded-master A2A." }
    }
    const pending = pendingKickoffPlansRef.current.get(conversationId)
    const toDomain = (domain: string | null | undefined): MasterPlanAssignment["taskDomain"] => {
      if (domain === "frontend") return "frontend"
      if (domain === "backend") return "backend"
      if (domain === "qa") return "qa"
      if (domain === "docs") return "docs"
      if (domain === "devops") return "devops"
      if (domain === "research") return "research"
      return null
    }
    const fallbackAssignments: MasterPlanAssignment[] = (
      conversation.orchestration?.pendingKickoffPlan?.assignments ?? []
    ).map((item) => ({
      memberId: item.memberId,
      memberName: item.memberName,
      taskTitle: item.taskTitle,
      taskDescription: item.taskTitle,
      reason: "Recovered from pending kickoff preview metadata.",
      intent: "delegate",
      score: 0,
      taskDomain: toDomain(item.taskDomain),
      memberDomains: [],
    }))
    const assignments: MasterPlanAssignment[] =
      pending?.assignments?.length ? pending.assignments : fallbackAssignments
    if (assignments.length === 0) {
      clearPendingKickoffPlan(conversationId)
      return { ok: false, reason: "No pending kickoff plan to confirm." }
    }

    clearPendingKickoffPlan(conversationId)
    dispatch({
      type: "ADD_ORCHESTRATION_MESSAGE",
      payload: {
        conversationId,
        strategy: "a2a",
        selectedAgents: assignments.map((item) => item.memberId),
        reason: "已确认分工草案，开始执行任务。",
        masterDecision: toMasterDecisionTrace({
          phase: "assignment",
          summary: "User confirmed kickoff plan.",
          assignments,
        }),
      },
    })
    dispatchEmbeddedMasterAssignments({
      conversation,
      assignments,
      sourceLabel: "kickoff-confirmed",
      attachments: pending?.attachments,
    })
    return { ok: true, reason: "Kickoff plan confirmed and dispatched." }
  }, [clearPendingKickoffPlan, dispatch, dispatchEmbeddedMasterAssignments])

  const rejectEmbeddedMasterKickoffPlan = useCallback(async (conversationId: string) => {
    const pending = pendingKickoffPlansRef.current.get(conversationId)
    clearPendingKickoffPlan(conversationId)
    dispatch({
      type: "ADD_ORCHESTRATION_MESSAGE",
      payload: {
        conversationId,
        strategy: "a2a",
        selectedAgents: pending?.assignments.map((item) => item.memberId) ?? [],
        reason: "已拒绝本轮分工草案。",
      },
    })
    return { ok: true, reason: "Kickoff plan rejected." }
  }, [clearPendingKickoffPlan, dispatch])

  const replanEmbeddedMasterKickoffPlan = useCallback(async (conversationId: string) => {
    const conversation = stateRef.current.conversations.find((item) => item.id === conversationId)
    if (!conversation || conversation.type !== "group") {
      return { ok: false, reason: "Conversation not found." }
    }
    if (conversation.orchestration?.strategy !== "a2a" || conversation.orchestration?.masterMode === "openclaw-coordinator") {
      return { ok: false, reason: "Current group is not embedded-master A2A." }
    }

    const messages = stateRef.current.messages[conversationId] ?? []
    const lastUserMsg = [...messages].reverse().find((msg) => msg.senderId === "user" && !msg.id.startsWith("streaming-"))
    if (!lastUserMsg || !lastUserMsg.content.trim()) {
      return { ok: false, reason: "No user request available for replanning." }
    }

    clearPendingKickoffPlan(conversationId)
    const result = buildEmbeddedKickoffPlan({
      conversationId,
      content: lastUserMsg.content,
      attachments: lastUserMsg.attachments,
      sourceLabel: "replan",
    })
    return { ok: result.ok, reason: result.reason }
  }, [buildEmbeddedKickoffPlan, clearPendingKickoffPlan])

  // Connect in its own effect so React StrictMode remounts re-register the subscription.
  // (StrictMode unmounts and remounts, which clears gatewayCallbacks; without this separate
  // effect the initializedRef guard prevents connect() from running on the real mount.)
  useEffect(() => {
    connect()
  }, [connect])

  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true

    // Restore persisted group conversations and their messages from localStorage
    const savedGroups = loadGroupsFromStorage()
    if (savedGroups.length > 0) {
      dispatch({ type: "LOAD_GROUPS", payload: savedGroups })
    }
    const savedGroupMessages = loadGroupMessagesFromStorage()
    if (Object.keys(savedGroupMessages).length > 0) {
      // Record all pre-loaded IDs so coordinator routing never re-dispatches them
      for (const msgs of Object.values(savedGroupMessages)) {
        for (const msg of msgs) preloadedGroupMsgIds.current.add(msg.id)
      }
      dispatch({ type: "LOAD_GROUP_MESSAGES", payload: savedGroupMessages })
    }

    loadFleet().then((result) => {
      if (result?.seeds) {
        dispatch({ type: "SET_FLEET", payload: { seeds: result.seeds, mainAgentId: result.mainAgentId ?? null } })
        // Load chat history for each agent
        for (const seed of result.seeds) {
          const convId = `conv-${seed.agentId}`
          loadHistory(seed.agentId).then(async (messages) => {
            if (messages.length === 0) return
            const attachmentOverrides = await prefetchAttachmentOverrides(convId, messages)
            dispatch({
              type: "LOAD_HISTORY",
              payload: {
                conversationId: convId,
                agentId: seed.agentId,
                messages,
                attachmentOverrides,
              },
            })
          })
        }
      }
    })
  }, [loadFleet, loadHistory])

  // Restore view from URL hash on mount
  useEffect(() => {
    const initialView = parseViewFromHash()
    if (initialView !== "chat") {
      dispatch({ type: "SET_VIEW", payload: initialView })
    }
  }, [])

  // Sync view state -> URL hash
  useEffect(() => {
    const hash = `#${state.view}`
    if (window.location.hash !== hash) {
      window.location.hash = hash
    }
  }, [state.view])

  // Listen for browser back/forward navigation
  useEffect(() => {
    const handleHashChange = () => {
      const view = parseViewFromHash()
      if (view !== stateRef.current.view) {
        dispatch({ type: "SET_VIEW", payload: view })
      }
    }
    window.addEventListener("hashchange", handleHashChange)
    return () => window.removeEventListener("hashchange", handleHashChange)
  }, [])

  const sendMessage = useCallback(
    (conversationId: string, content: string, attachments?: ChatAttachment[]) => {
      abortedConversationIdsRef.current.delete(conversationId)
      clearConversationDispatchTimers(conversationId)
      clearPendingKickoffPlan(conversationId)
      dispatch({ type: "SEND_MESSAGE", payload: { conversationId, content, attachments } })

      const imageAtts = (attachments ?? []).filter((a) => !!a.dataUrl)
      if (imageAtts.length > 0) {
        saveAttachmentCacheDb(conversationId, content, imageAtts).catch(() => {})
      }

      const conv = stateRef.current.conversations.find((c) => c.id === conversationId)
      if (!conv) return

      const agentMemberIds = conv.members.filter((id) => id !== "user")
      if (agentMemberIds.length === 0) return

      const sendError = (error: string) => {
        dispatch({
          type: "ADD_AGENT_MESSAGE",
          payload: {
            id: uniqueId("msg-err"),
            conversationId,
            senderId: "system",
            senderName: "System",
            senderAvatar: "SY",
            content: `Send failed: ${error}`,
            timestamp: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
            read: true,
            type: "system",
          },
        })
      }

      if (conv.type !== "group") {
        // Direct conversation -- send to the single agent
        sendToAgent({ agentId: agentMemberIds[0], content, attachments }).then((result) => {
          if (!result.ok) {
            const agent = stateRef.current.agents.find((a) => a.id === agentMemberIds[0])
            sendError(`${agent?.name ?? agentMemberIds[0]}: ${(result as { error?: string }).error ?? "Unknown error"}`)
          }
        })
        return
      }

      const orchestration = conv.orchestration
      const isEmbeddedMasterA2A =
        orchestration?.strategy === "a2a"
        && orchestration?.masterMode !== "openclaw-coordinator"
      if (isEmbeddedMasterA2A) {
        const result = buildEmbeddedKickoffPlan({
          conversationId,
          content,
          attachments,
          sourceLabel: "kickoff",
        })
        if (!result.ok) sendError(result.reason)
        return
      }

      // Group conversation -- use orchestration router
      let convForDecision = conv
      const needsCoordinator =
        orchestration?.strategy === "coordinator"
        || (orchestration?.strategy === "a2a" && orchestration?.masterMode === "openclaw-coordinator")
      if (needsCoordinator) {
        const currentCoordinatorId = orchestration?.coordinatorId
        const hasValidCoordinator =
          !!currentCoordinatorId
          && currentCoordinatorId !== "user"
          && agentMemberIds.includes(currentCoordinatorId)
        if (!hasValidCoordinator) {
          const fallbackCoordinatorId =
            (stateRef.current.mainAgentId && agentMemberIds.includes(stateRef.current.mainAgentId))
              ? stateRef.current.mainAgentId
              : agentMemberIds[0]
          if (fallbackCoordinatorId) {
            const nextOrchestration = {
              ...orchestration,
              strategy: orchestration?.strategy ?? "a2a",
              coordinatorId: fallbackCoordinatorId,
            }
            dispatch({
              type: "UPDATE_GROUP_ORCHESTRATION",
              payload: {
                conversationId,
                orchestration: nextOrchestration,
              },
            })
            convForDecision = { ...conv, orchestration: nextOrchestration }
            dispatch({
              type: "ADD_ORCHESTRATION_MESSAGE",
              payload: {
                conversationId,
                strategy: nextOrchestration.strategy,
                selectedAgents: [fallbackCoordinatorId],
                reason: `Built-in coordinator selected automatically: ${fallbackCoordinatorId}`,
              },
            })
          }
        }
      }

      const mentions = parseMentions(content)
      const agents = stateRef.current.agents
      const decision = resolveRoutingDecision(content, convForDecision, agents, mentions)

      // Show orchestration decision for non-trivial routing
      if (
        decision.strategy !== "all" &&
        mentions.length === 0 &&
        decision.targetAgentIds.length < agentMemberIds.length
      ) {
        dispatch({
          type: "ADD_ORCHESTRATION_MESSAGE",
          payload: {
            conversationId,
            strategy: decision.strategy,
            selectedAgents: decision.targetAgentIds,
            reason: decision.reason,
          },
        })
      }

      // Send to selected agents
      decision.targetAgentIds.forEach((agentId, index) => {
        const delay = index * 500
        const sessionKey = `agent:${agentId}:group:${conversationId}`
        const baseContent =
          decision.coordinatorMessage && agentId === convForDecision.orchestration?.coordinatorId
            ? decision.coordinatorMessage
            : content
        const messageContent = conv.workspacePath
          ? buildWorkspacePrompt(conv.workspacePath, baseContent)
          : baseContent

        scheduleConversationDispatch({
          conversationId,
          delayMs: delay,
          run: () => {
            sendToConversationAgent({
              conversationId,
              agentId,
              content: messageContent,
              sessionKey,
              attachments,
            }).then((result) => {
              if (!result.ok && (result as { error?: string }).error !== "conversation_aborted") {
                const agent = stateRef.current.agents.find((a) => a.id === agentId)
                sendError(`${agent?.name ?? agentId}: ${(result as { error?: string }).error ?? "Unknown error"}`)
              }
            })
          },
        })
      })

      // Advance round-robin pointer
      if (decision.strategy === "round-robin") {
        dispatch({ type: "ADVANCE_ROUND_ROBIN", payload: { conversationId } })
      }
    },
    [buildEmbeddedKickoffPlan, clearConversationDispatchTimers, clearPendingKickoffPlan, scheduleConversationDispatch, sendToConversationAgent, dispatchEmbeddedMasterAssignments]
  )

  const simulateAgentReply = useCallback(
    (_conversationId: string, _agentId: string) => {
      // no-op: real replies come through SSE
    },
    []
  )

  const resetSession = useCallback(
    (conversationId: string) => {
      const conv = stateRef.current.conversations.find((c) => c.id === conversationId)
      if (!conv) return

      clearPendingKickoffPlan(conversationId)
      const agentMemberIds = conv.members.filter((id) => id !== "user")

      // Send "/new" command to each agent -- this is how OpenClaw triggers
      // a real session reset via the auto-reply system, which creates a new
      // session ID, archives the old transcript, and resets context.
      for (const agentId of agentMemberIds) {
        const sessionKey =
          conv.type === "group"
            ? `agent:${agentId}:group:${conversationId}`
            : undefined
        void sendToAgent({ agentId, content: "/new", sessionKey })
      }

      dispatch({ type: "RESET_SESSION", payload: { conversationId } })
    },
    [clearPendingKickoffPlan, sendToAgent]
  )

  const abortConversation = useCallback(
    (conversationId: string) => {
      const conv = stateRef.current.conversations.find((c) => c.id === conversationId)
      if (!conv) return

      abortedConversationIdsRef.current.add(conversationId)
      clearConversationDispatchTimers(conversationId)
      clearConversationClaimTimers(conversationId)
      clearPendingKickoffPlan(conversationId)

      const msgs = stateRef.current.messages[conversationId] ?? []
      for (const msg of msgs) {
        if (msg.id.startsWith("streaming-")) continue
        if (msg.senderId === "user") {
          processedA2AUserCmdMsgIdsRef.current.add(msg.id)
          continue
        }
        if (msg.senderId !== "system" && msg.type !== "orchestration") {
          processedA2AMsgIdsRef.current.add(msg.id)
        }
        if (conv.orchestration?.coordinatorId && msg.senderId === conv.orchestration.coordinatorId) {
          processedCoordinatorMsgsRef.current.add(msg.id)
        }
      }

      const agentMemberIds = conv.members.filter((id) => id !== "user")
      for (const agentId of agentMemberIds) {
        const sessionKey =
          conv.type === "group"
            ? `agent:${agentId}:group:${conversationId}`
            : `agent:${agentId}:main`
        void window.ipc.chatAbort({ sessionKey })
        dispatch({ type: "SET_THINKING", payload: { agentId, thinking: false } })
      }
    },
    [clearConversationClaimTimers, clearConversationDispatchTimers, clearPendingKickoffPlan, dispatch]
  )

  const value = useMemo(
    () => ({
      state,
      dispatch,
      sendMessage,
      runEmbeddedMasterRebalance,
      confirmEmbeddedMasterKickoffPlan,
      rejectEmbeddedMasterKickoffPlan,
      replanEmbeddedMasterKickoffPlan,
      simulateAgentReply,
      refreshFleet,
      resetSession,
      abortConversation,
      checkModelsConfigured,
      compactingConversationIds,
      compactedConversationIds,
    }),
    [
      state,
      sendMessage,
      runEmbeddedMasterRebalance,
      confirmEmbeddedMasterKickoffPlan,
      rejectEmbeddedMasterKickoffPlan,
      replanEmbeddedMasterKickoffPlan,
      simulateAgentReply,
      refreshFleet,
      resetSession,
      abortConversation,
      checkModelsConfigured,
      compactingConversationIds,
      compactedConversationIds,
    ]
  )

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  const ctx = useContext(AppContext)
  if (!ctx) throw new Error("useApp must be used within AppProvider")
  return ctx
}
