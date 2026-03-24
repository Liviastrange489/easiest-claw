import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Activity, Loader2, PanelRight, Route, WifiOff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useAvatarVersion } from "@/lib/avatar"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app-context"
import { ChatHeader } from "./chat-header"
import { MessageBubble } from "./message-bubble"
import { MessageInput } from "./message-input"
import { TypingIndicator } from "./typing-indicator"
import { GroupMembersPanel } from "./group-members-panel"
import { GroupWorkspacePanel } from "./group-workspace-panel"
import { PersonaPanel } from "@/components/persona/persona-panel"
import { WorkspacePanel } from "./workspace-panel"
import { SessionHistorySheet } from "./session-history-sheet"
import { useI18n } from "@/i18n"
import type { GroupWorkspaceTask, Message } from "@/types"

type A2ATimeWindow = "5m" | "15m" | "60m" | "all"

interface A2AAgentCard {
  id: string
  name: string
  role: string
  avatar: string
  active: boolean
  inProgressCount: number
  blockedCount: number
  doneCount: number
  pendingClaimsCount: number
  stalledCount: number
  todoCount: number
  workloadScore: number
  responsibilityText: string
  currentActivity?: string
}

interface A2ACollaborationEvent {
  id: string
  sourceId: string
  sourceName: string
  targetId: string
  targetName: string
  summary: string
  channel: "dispatch" | "mention"
  timestampMs: number | null
  displayTime: string
}

interface A2ACollaborationEdge {
  id: string
  sourceId: string
  targetId: string
  sourceName: string
  targetName: string
  count: number
  latestAt: number | null
}

interface A2AGraphNode {
  id: string
  name: string
  x: number
  y: number
  active: boolean
  isMaster?: boolean
}

type ResponsibilityTaskStatus = GroupWorkspaceTask["status"] | "pending" | "idle"

interface A2AResponsibilityBoardRow {
  id: string
  name: string
  role: string
  avatar: string
  active: boolean
  responsibilityText: string
  totalCount: number
  inProgressCount: number
  blockedCount: number
  todoCount: number
  doneCount: number
  completionRate: number
  overallProgress: number
  currentTaskTitle: string
  currentTaskStatus: ResponsibilityTaskStatus
  currentTaskProgress: number
  currentTaskNote?: string
  masterPlanTasks: string[]
}

const A2A_MASTER_NODE_ID = "__a2a_master__"
const A2A_WINDOW_MS: Record<Exclude<A2ATimeWindow, "all">, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "60m": 60 * 60 * 1000,
}
const A2A_STALLED_TASK_MS = 45_000

function formatDateSeparator(
  dateStr: string,
  t: (key: string, values?: Record<string, string | number>) => string
): string {
  const now = new Date()
  const date = new Date(dateStr)
  if (Number.isNaN(date.getTime())) return ""
  const isToday =
    date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (isToday) return t("chatWindow.today")
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate()
  if (isYesterday) return t("chatWindow.yesterday")
  return t("chatWindow.fullDate", {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  })
}

function getDateKey(timestamp: string): string {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return ""
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function DateSeparator({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center py-3">
      <span className="text-[11px] text-muted-foreground/60 bg-muted/50 px-3 py-0.5 rounded-full">
        {label}
      </span>
    </div>
  )
}

function getA2ACompactText(msg: Message): string {
  if (msg.type === "orchestration") {
    const reason = msg.orchestrationInfo?.reason
    if (typeof reason === "string" && reason.trim().length > 0) return reason
  }
  if (typeof msg.content === "string" && msg.content.trim().length > 0) return msg.content
  return "(empty)"
}

function shortText(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return "(empty)"
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}...`
}

function parseDisplayTimeToMs(input: string): number | null {
  if (!input) return null
  const direct = Date.parse(input)
  if (Number.isFinite(direct)) return direct

  const matched = input.trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (!matched) return null

  const now = new Date()
  const parsed = new Date(now)
  parsed.setHours(Number(matched[1]), Number(matched[2]), Number(matched[3] ?? 0), 0)
  if (parsed.getTime() - now.getTime() > 5 * 60 * 1000) {
    parsed.setDate(parsed.getDate() - 1)
  }
  return parsed.getTime()
}

function getEventTimestampMs(msg: Message): number | null {
  const masterCreatedAt = msg.orchestrationInfo?.masterDecision?.createdAt
  if (masterCreatedAt) {
    const parsed = Date.parse(masterCreatedAt)
    if (Number.isFinite(parsed)) return parsed
  }
  return parseDisplayTimeToMs(msg.timestamp)
}

function formatClock(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "--:--"
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function taskStatusLabel(status: GroupWorkspaceTask["status"], t: (key: string) => string): string {
  if (status === "blocked") return t("a2a.cockpit.groupBlocked")
  if (status === "in-progress") return t("a2a.cockpit.groupInProgress")
  if (status === "done") return t("a2a.cockpit.groupDone")
  return t("a2a.cockpit.groupTodo")
}

function responsibilityTaskStatusLabel(
  status: ResponsibilityTaskStatus,
  t: (key: string) => string
): string {
  if (status === "pending") return t("a2a.cockpit.statusPendingAssignment")
  if (status === "idle") return t("a2a.cockpit.statusIdle")
  return taskStatusLabel(status, t)
}
export function ChatWindow() {
  const {
    state,
    dispatch,
    sendMessage,
    resetSession,
    abortConversation,
    confirmEmbeddedMasterKickoffPlan,
    rejectEmbeddedMasterKickoffPlan,
    replanEmbeddedMasterKickoffPlan,
  } = useApp()
  const { t } = useI18n()
  useAvatarVersion()
  const [showMembers, setShowMembers] = useState(false)
  const [showGroupWorkspace, setShowGroupWorkspace] = useState(false)
  const [showWorkspace, setShowWorkspace] = useState(false)
  const [showSessionHistory, setShowSessionHistory] = useState(false)
  const [showOrchestrationFlow, setShowOrchestrationFlow] = useState(false)
  const [a2aViewMode, setA2AViewMode] = useState<"cockpit" | "deliverables">("cockpit")
  const [a2aTimeWindow, setA2ATimeWindow] = useState<A2ATimeWindow>("15m")
  const [kickoffPlanAction, setKickoffPlanAction] = useState<"confirm" | "replan" | "reject" | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const contentScrollRef = useRef<HTMLDivElement>(null)
  const [personaPanelOpen, setPersonaPanelOpen] = useState(false)
  const [personaAgentId, setPersonaAgentId] = useState("")
  const [personaAgentName, setPersonaAgentName] = useState("")

  const handleAgentAvatarClick = useCallback((agentId: string, agentName: string) => {
    setPersonaAgentId(agentId)
    setPersonaAgentName(agentName)
    setPersonaPanelOpen(true)
  }, [])

  const conversation = state.conversations.find(
    (item) => item.id === state.activeConversationId
  )

  const messages = state.activeConversationId
    ? (state.messages[state.activeConversationId] ?? [])
    : []
  const isA2AConversation =
    conversation?.type === "group" && conversation.orchestration?.strategy === "a2a"
  const orchestrationMessages = messages.filter((msg) => msg.type === "orchestration")
  const taskCount = conversation?.workspaceTasks?.length ?? 0
  const compactFlowMode = isA2AConversation && a2aViewMode === "deliverables" && showOrchestrationFlow
  const visibleMessages =
    isA2AConversation && a2aViewMode === "deliverables" && !showOrchestrationFlow
      ? messages.filter((msg) => msg.type !== "orchestration")
      : messages

  const lastMsg = visibleMessages.at(-1)
  const lastMsgBlocksVersion = (() => {
    if (!lastMsg?.contentBlocks?.length) return "0"
    return lastMsg.contentBlocks
      .map((block) => {
        if (block.type === "text") return `t:${block.text.length}`
        if (block.type === "thinking") return `h:${(block.thinking ?? "").length}:${block.redacted ? 1 : 0}`
        if (block.type === "toolCall") {
          const argsLen = JSON.stringify(block.arguments ?? {}).length
          let resultLen = 0
          if (block.result?.content !== undefined) {
            if (typeof block.result.content === "string") resultLen = block.result.content.length
            else resultLen = JSON.stringify(block.result.content).length
          }
          return `c:${block.id}:${argsLen}:${resultLen}:${block.result?.isError ? 1 : 0}`
        }
        if (block.type === "toolResult") {
          const len = block.content === undefined ? 0 : JSON.stringify(block.content).length
          return `r:${block.toolCallId}:${len}:${block.isError ? 1 : 0}`
        }
        return "x"
      })
      .join("|")
  })()
  const scrollKey = `${visibleMessages.length}:${lastMsg?.id ?? ""}:${lastMsg?.content.length ?? 0}:${lastMsgBlocksVersion}:${state.thinkingAgents.size}`

  useEffect(() => {
    if (isA2AConversation && a2aViewMode === "cockpit") return
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" })
  }, [scrollKey, isA2AConversation, a2aViewMode])

  const isMountedRef = useRef(false)
  useEffect(() => {
    if (!isMountedRef.current) {
      isMountedRef.current = true
      return
    }
    if (isA2AConversation && a2aViewMode === "cockpit") return
    messagesEndRef.current?.scrollIntoView({ behavior: "instant" })
  }, [isA2AConversation, a2aViewMode])

  useEffect(() => {
    if (!isA2AConversation) return
    const element = contentScrollRef.current
    if (!element) return
    element.scrollTop = 0
  }, [isA2AConversation, state.activeConversationId, a2aViewMode, showOrchestrationFlow])

  const isGroup = conversation?.type === "group"
  const isA2AGroup = isGroup && conversation?.orchestration?.strategy === "a2a"
  const uniqueMemberIds = Array.from(new Set(conversation?.members ?? []))
  const tasks = conversation?.workspaceTasks ?? []
  const pendingKickoffPlan =
    isA2AGroup && conversation?.orchestration?.masterMode !== "openclaw-coordinator"
      ? conversation?.orchestration?.pendingKickoffPlan
      : undefined

  const thinkingAgents = uniqueMemberIds.filter((id) => state.thinkingAgents.has(id))

  const latestAgentActivityById = useMemo(() => {
    const map = new Map<string, string>()
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const msg = messages[index]
      if (msg.type === "orchestration") continue
      if (msg.senderId === "user" || msg.senderId === "system") continue
      if (map.has(msg.senderId)) continue
      const text = shortText(getA2ACompactText(msg), 120)
      if (text && text !== "(empty)") {
        map.set(msg.senderId, text)
      }
    }
    return map
  }, [messages])

  const agentCards = useMemo<A2AAgentCard[]>(() => {
    const nowMs = Date.now()
    const cards = uniqueMemberIds
      .filter((id) => id !== "user")
      .map((id) => {
        const agent = state.agents.find((item) => item.id === id)
        const assigned = tasks.filter((task) => task.assigneeId === id)
        const sortedAssigned = [...assigned].sort(
          (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
        )
        const inProgressTask = sortedAssigned.find((task) => task.status === "in-progress")
        const blockedTask = sortedAssigned.find((task) => task.status === "blocked")
        const latestTask = sortedAssigned[0]
        const pendingClaimsCount = tasks.filter((task) => task.pendingAssigneeId === id).length
        const inProgressCount = assigned.filter((task) => task.status === "in-progress").length
        const blockedCount = assigned.filter((task) => task.status === "blocked").length
        const doneCount = assigned.filter((task) => task.status === "done").length
        const stalledCount = assigned.filter((task) => {
          if (task.status === "done" || task.status === "blocked") return false
          const updatedMs = Date.parse(task.updatedAt || task.createdAt)
          if (!Number.isFinite(updatedMs)) return false
          return nowMs - updatedMs >= A2A_STALLED_TASK_MS
        }).length
        const todoCount = assigned.filter((task) => task.status === "todo").length
        const workloadScore = inProgressCount * 3 + blockedCount * 4 + pendingClaimsCount * 2 + todoCount
        const openResponsibilities = sortedAssigned
          .filter((task) => task.status !== "done")
          .map((task) => task.title.trim())
          .filter((title) => title.length > 0)
        const roleText = agent?.role?.trim()
        const skillsText = agent?.skills?.slice(0, 2).join(" / ").trim()
        const responsibilityText =
          (openResponsibilities.length > 0 ? openResponsibilities.slice(0, 2).join(" / ") : "")
          || roleText
          || skillsText
          || t("a2a.cockpit.noResponsibility")
        const currentActivity =
          inProgressTask?.lastNote?.trim()
          || (inProgressTask ? `${t("a2a.cockpit.groupInProgress")}：${inProgressTask.progress}%` : undefined)
          || blockedTask?.blockedReason?.trim()
          || latestTask?.lastNote?.trim()
          || (state.thinkingAgents.has(id) ? t("a2a.cockpit.activityThinking") : undefined)
          || latestAgentActivityById.get(id)
          || agent?.currentTask?.trim()
          || undefined
        return {
          id,
          name: agent?.name ?? id,
          role: agent?.role ?? "",
          avatar: agent?.avatar ?? id.slice(0, 2).toUpperCase(),
          active: state.thinkingAgents.has(id),
          inProgressCount,
          blockedCount,
          doneCount,
          pendingClaimsCount,
          stalledCount,
          todoCount,
          workloadScore,
          responsibilityText,
          currentActivity,
        }
      })

    cards.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      if (a.workloadScore !== b.workloadScore) return b.workloadScore - a.workloadScore
      return a.name.localeCompare(b.name, "zh-CN")
    })
    return cards
  }, [uniqueMemberIds, state.agents, tasks, state.thinkingAgents, latestAgentActivityById, t])

  const agentNameById = useMemo(
    () => new Map(agentCards.map((agent) => [agent.id, agent.name])),
    [agentCards]
  )

  const members = uniqueMemberIds
    .map((id) => {
      if (id === "user") return { id, name: t("common.meHuman") }
      const name = agentNameById.get(id)
      return name ? { id, name } : null
    })
    .filter((member): member is NonNullable<typeof member> => member != null)

  const taskStats = useMemo(() => {
    const blocked = tasks.filter((task) => task.status === "blocked").length
    const inProgress = tasks.filter((task) => task.status === "in-progress").length
    const done = tasks.filter((task) => task.status === "done").length
    const todo = tasks.filter((task) => task.status === "todo").length
    return { blocked, inProgress, done, todo }
  }, [tasks])

  const latestMasterPlan = useMemo(() => {
    const fallback = {
      summary: "",
      createdAtMs: null as number | null,
      assignmentsByAgent: new Map<string, string[]>(),
    }
    for (let index = orchestrationMessages.length - 1; index >= 0; index -= 1) {
      const msg = orchestrationMessages[index]
      const decision = msg.orchestrationInfo?.masterDecision
      if (!decision) continue
      const assignmentCount = decision.assignments?.length ?? 0
      const diagnosticCount = decision.diagnostics?.length ?? 0
      if (assignmentCount === 0 && diagnosticCount === 0) continue

      const assignmentsByAgent = new Map<string, string[]>()
      const pushTitle = (agentId: string | undefined, taskTitle: string | undefined) => {
        if (!agentId || !taskTitle) return
        const normalized = taskTitle.trim()
        if (!normalized) return
        const list = assignmentsByAgent.get(agentId) ?? []
        if (!list.includes(normalized)) list.push(normalized)
        assignmentsByAgent.set(agentId, list)
      }

      for (const assignment of decision.assignments ?? []) {
        pushTitle(assignment.memberId, assignment.taskTitle)
      }
      for (const diagnostic of decision.diagnostics ?? []) {
        pushTitle(diagnostic.selectedMemberId, diagnostic.taskTitle)
      }

      const parsed = Date.parse(decision.createdAt)
      return {
        summary: decision.summary,
        createdAtMs: Number.isFinite(parsed) ? parsed : null,
        assignmentsByAgent,
      }
    }
    return fallback
  }, [orchestrationMessages])

  const responsibilityBoardRows = useMemo<A2AResponsibilityBoardRow[]>(() => {
    const rows = uniqueMemberIds
      .filter((id) => id !== "user")
      .map((id) => {
        const agent = state.agents.find((item) => item.id === id)
        const assigned = tasks.filter((task) => task.assigneeId === id)
        const pending = tasks.filter(
          (task) => task.pendingAssigneeId === id && task.assigneeId !== id
        )
        const scopedTasks = [...new Map([...assigned, ...pending].map((task) => [task.id, task])).values()]
        const sortedScopedTasks = [...scopedTasks].sort(
          (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
        )
        const inProgressCount = scopedTasks.filter((task) => task.status === "in-progress").length
        const blockedCount = scopedTasks.filter((task) => task.status === "blocked").length
        const doneCount = scopedTasks.filter((task) => task.status === "done").length
        const todoCount = scopedTasks.filter((task) => task.status === "todo").length
        const totalCount = scopedTasks.length
        const overallProgress = totalCount > 0
          ? Math.round(scopedTasks.reduce((sum, task) => sum + task.progress, 0) / totalCount)
          : 0
        const completionRate = totalCount > 0
          ? Math.round((doneCount / totalCount) * 100)
          : 0
        const openResponsibilities = sortedScopedTasks
          .filter((task) => task.status !== "done")
          .map((task) => task.title.trim())
          .filter((title) => title.length > 0)
        const roleText = agent?.role?.trim()
        const skillsText = agent?.skills?.slice(0, 3).join(" / ").trim()
        const responsibilityText =
          (openResponsibilities.length > 0 ? openResponsibilities.slice(0, 3).join(" / ") : "")
          || roleText
          || skillsText
          || t("a2a.cockpit.noResponsibility")

        const pendingTask = [...pending].sort(
          (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
        )[0]
        const inProgressTask = sortedScopedTasks.find((task) => task.status === "in-progress")
        const blockedTask = sortedScopedTasks.find((task) => task.status === "blocked")
        const latestTask = sortedScopedTasks[0]
        const currentTask = pendingTask ?? inProgressTask ?? blockedTask ?? latestTask
        const currentTaskStatus: ResponsibilityTaskStatus =
          pendingTask ? "pending" : currentTask?.status ?? "idle"
        const currentTaskTitle = currentTask?.title?.trim() || t("a2a.cockpit.noCurrentTask")
        const currentTaskProgress = currentTask?.progress ?? 0
        const currentTaskNote =
          pendingTask?.lastNote?.trim()
          || inProgressTask?.lastNote?.trim()
          || blockedTask?.blockedReason?.trim()
          || latestTask?.lastNote?.trim()
          || latestAgentActivityById.get(id)
          || agent?.currentTask?.trim()
          || undefined
        const masterPlanTasks = latestMasterPlan.assignmentsByAgent.get(id) ?? []

        return {
          id,
          name: agent?.name ?? id,
          role: agent?.role ?? "",
          avatar: agent?.avatar ?? id.slice(0, 2).toUpperCase(),
          active: state.thinkingAgents.has(id),
          responsibilityText,
          totalCount,
          inProgressCount,
          blockedCount,
          todoCount,
          doneCount,
          completionRate,
          overallProgress,
          currentTaskTitle,
          currentTaskStatus,
          currentTaskProgress,
          currentTaskNote,
          masterPlanTasks,
        }
      })

    rows.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1
      const aHasPlan = a.masterPlanTasks.length > 0
      const bHasPlan = b.masterPlanTasks.length > 0
      if (aHasPlan !== bHasPlan) return aHasPlan ? -1 : 1
      const aPending = a.currentTaskStatus === "pending"
      const bPending = b.currentTaskStatus === "pending"
      if (aPending !== bPending) return aPending ? -1 : 1
      if (a.inProgressCount !== b.inProgressCount) return b.inProgressCount - a.inProgressCount
      if (a.totalCount !== b.totalCount) return b.totalCount - a.totalCount
      return a.name.localeCompare(b.name, "zh-CN")
    })
    return rows
  }, [
    latestAgentActivityById,
    latestMasterPlan,
    state.agents,
    state.thinkingAgents,
    t,
    tasks,
    uniqueMemberIds,
  ])

  const masterPlannedTaskCount = useMemo(
    () =>
      responsibilityBoardRows.reduce(
        (sum, row) => sum + row.masterPlanTasks.length,
        0
      ),
    [responsibilityBoardRows]
  )

  const stalledTaskCount = useMemo(() => {
    const nowMs = Date.now()
    return tasks.filter((task) => {
      if (task.status === "done" || task.status === "blocked") return false
      const updatedMs = Date.parse(task.updatedAt || task.createdAt)
      if (!Number.isFinite(updatedMs)) return false
      return nowMs - updatedMs >= A2A_STALLED_TASK_MS
    }).length
  }, [tasks, messages.length, state.thinkingAgents.size])

  const collaboration = useMemo(() => {
    const memberIdSet = new Set(agentCards.map((agent) => agent.id))
    const nowMs = Date.now()
    const maxAgeMs = a2aTimeWindow === "all" ? null : A2A_WINDOW_MS[a2aTimeWindow]
    const masterName = t("a2a.cockpit.masterAgent")

    const events: A2ACollaborationEvent[] = []
    const pushEvent = (event: A2ACollaborationEvent) => {
      if (maxAgeMs != null) {
        if (event.timestampMs == null) return
        if (nowMs - event.timestampMs > maxAgeMs) return
      }
      events.push(event)
    }

    for (const msg of messages) {
      const timestampMs = getEventTimestampMs(msg)
      if (msg.type === "orchestration") {
        const selected = msg.orchestrationInfo?.selectedAgents ?? []
        const summary = shortText(msg.orchestrationInfo?.reason ?? msg.content, 140)
        selected.forEach((targetId, index) => {
          if (!memberIdSet.has(targetId)) return
          pushEvent({
            id: `${msg.id}-dispatch-${index}`,
            sourceId: A2A_MASTER_NODE_ID,
            sourceName: masterName,
            targetId,
            targetName: agentNameById.get(targetId) ?? targetId,
            summary,
            channel: "dispatch",
            timestampMs,
            displayTime: timestampMs != null ? formatClock(timestampMs) : msg.timestamp,
          })
        })
        continue
      }

      if (msg.senderId === "user" || msg.senderId === "system") continue
      if (!memberIdSet.has(msg.senderId)) continue

      const mentioned = (msg.mentions ?? []).filter(
        (targetId) => targetId !== msg.senderId && memberIdSet.has(targetId)
      )
      if (mentioned.length === 0) continue

      const summary = shortText(getA2ACompactText(msg), 140)
      mentioned.forEach((targetId, index) => {
        pushEvent({
          id: `${msg.id}-mention-${index}`,
          sourceId: msg.senderId,
          sourceName: agentNameById.get(msg.senderId) ?? msg.senderName,
          targetId,
          targetName: agentNameById.get(targetId) ?? targetId,
          summary,
          channel: "mention",
          timestampMs,
          displayTime: timestampMs != null ? formatClock(timestampMs) : msg.timestamp,
        })
      })
    }

    events.sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0))

    const edgeMap = new Map<string, A2ACollaborationEdge>()
    for (const event of events) {
      const key = `${event.sourceId}->${event.targetId}`
      const existing = edgeMap.get(key)
      if (existing) {
        existing.count += 1
        if ((event.timestampMs ?? 0) > (existing.latestAt ?? 0)) {
          existing.latestAt = event.timestampMs
        }
      } else {
        edgeMap.set(key, {
          id: key,
          sourceId: event.sourceId,
          targetId: event.targetId,
          sourceName: event.sourceName,
          targetName: event.targetName,
          count: 1,
          latestAt: event.timestampMs,
        })
      }
    }

    const edges = [...edgeMap.values()].sort((a, b) => b.count - a.count)
    return { events, edges }
  }, [a2aTimeWindow, agentCards, agentNameById, messages, t])

  const graphAgents = useMemo(() => agentCards.slice(0, 12), [agentCards])

  const graphNodes = useMemo<A2AGraphNode[]>(() => {
    const nodes: A2AGraphNode[] = [
      {
        id: A2A_MASTER_NODE_ID,
        name: t("a2a.cockpit.masterAgent"),
        x: 124,
        y: 160,
        active: collaboration.edges.some((edge) => edge.sourceId === A2A_MASTER_NODE_ID),
        isMaster: true,
      },
    ]

    if (graphAgents.length === 0) return nodes

    const centerX = 500
    const centerY = 160
    const radiusX = 210
    const radiusY = 108
    const total = graphAgents.length
    for (let index = 0; index < total; index += 1) {
      const agent = graphAgents[index]
      const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total
      nodes.push({
        id: agent.id,
        name: agent.name,
        x: centerX + Math.cos(angle) * radiusX,
        y: centerY + Math.sin(angle) * radiusY,
        active: agent.active,
      })
    }
    return nodes
  }, [collaboration.edges, graphAgents, t])

  const graphNodeMap = useMemo(
    () => new Map(graphNodes.map((node) => [node.id, node])),
    [graphNodes]
  )

  const graphEdges = useMemo(
    () =>
      collaboration.edges.filter(
        (edge) => graphNodeMap.has(edge.sourceId) && graphNodeMap.has(edge.targetId)
      ),
    [collaboration.edges, graphNodeMap]
  )

  const masterDispatchCount = useMemo(
    () =>
      collaboration.edges
        .filter((edge) => edge.sourceId === A2A_MASTER_NODE_ID)
        .reduce((sum, edge) => sum + edge.count, 0),
    [collaboration.edges]
  )

  const communicationCount = collaboration.events.length
  const allTasksCompleted = tasks.length > 0 && taskStats.done === tasks.length
  const masterStatus = useMemo(() => {
    if (taskStats.blocked > 0) return "exception" as const
    if (stalledTaskCount > 0) return "stalled" as const
    if (allTasksCompleted) return "completed" as const
    if (communicationCount > 0 || masterDispatchCount > 0) return "communication" as const
    return "monitoring" as const
  }, [allTasksCompleted, communicationCount, masterDispatchCount, stalledTaskCount, taskStats.blocked])

  const sortedTasks = useMemo(() => {
    const statusRank: Record<GroupWorkspaceTask["status"], number> = {
      blocked: 4,
      "in-progress": 3,
      todo: 2,
      done: 1,
    }
    return [...tasks].sort((a, b) => {
      const rankDelta = statusRank[b.status] - statusRank[a.status]
      if (rankDelta !== 0) return rankDelta
      return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)
    })
  }, [tasks])

  const items: Array<{ type: "date"; label: string; key: string } | { type: "msg"; msg: Message; key: string }> = []
  let lastDateKey = ""
  const messageKeyCount = new Map<string, number>()
  for (const msg of visibleMessages) {
    const dateKey = getDateKey(msg.timestamp)
    if (dateKey && dateKey !== lastDateKey) {
      items.push({ type: "date", label: formatDateSeparator(msg.timestamp, t), key: `sep-${dateKey}` })
      lastDateKey = dateKey
    }
    const baseKey = `msg-${msg.id}`
    const seenCount = messageKeyCount.get(baseKey) ?? 0
    messageKeyCount.set(baseKey, seenCount + 1)
    items.push({
      type: "msg",
      msg,
      key: seenCount === 0 ? baseKey : `${baseKey}-${seenCount}`,
    })
  }

  if (!conversation) {
    const isConnecting = state.connectionStatus === "connecting"
    const notConnected = state.connectionStatus === "disconnected" || state.connectionStatus === "error"
    const noAgents = state.agents.length === 0

    return (
      <div
        className="flex-1 flex items-center justify-center h-full"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <div
          className="text-center"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {isConnecting ? (
            <>
              <Loader2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3 animate-spin" />
              <p className="text-sm text-muted-foreground/60">{t("topNav.connection.connecting")}</p>
            </>
          ) : notConnected && noAgents ? (
            <>
              <WifiOff className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">{t("chatWindow.notConnectedTitle")}</p>
              <p className="text-xs text-muted-foreground/70 mt-1 mb-4">{t("chatWindow.notConnectedDesc")}</p>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => dispatch({ type: "SET_VIEW", payload: "openclaw" })}
              >
                <Activity className="h-3.5 w-3.5" />
                {t("chatWindow.goToOpenclaw")}
              </Button>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-muted-foreground">{t("chatWindow.emptyTitle")}</p>
              <p className="text-sm mt-1 text-muted-foreground/70">{t("chatWindow.emptyDescription")}</p>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex h-full overflow-hidden">
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <ChatHeader
          conversation={conversation}
          onToggleMembers={isGroup ? () => setShowMembers((prev) => !prev) : undefined}
          onToggleTeamWorkspace={isGroup ? () => setShowGroupWorkspace((prev) => !prev) : undefined}
          onToggleWorkspace={!isGroup ? () => setShowWorkspace((prev) => !prev) : undefined}
          onToggleSessionHistory={!isGroup ? () => setShowSessionHistory((prev) => !prev) : undefined}
          onAgentAvatarClick={handleAgentAvatarClick}
        />

        {isA2AGroup && (
          <div className="px-4 pt-2 pb-1">
            <div className="rounded-lg border bg-muted/25 px-3 py-2 flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Route className="h-3.5 w-3.5 text-primary shrink-0" />
                  <span className="text-xs font-medium">{t("a2a.console.modeTitle")}</span>
                  {orchestrationMessages.length > 0 && (
                    <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                      {orchestrationMessages.length}
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground truncate">
                  {a2aViewMode === "cockpit"
                    ? t("a2a.console.modeDescCockpit")
                    : showOrchestrationFlow
                      ? t("a2a.console.modeDescChatFlow")
                      : t("a2a.console.modeDescChatCollapsed")}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  variant={a2aViewMode === "cockpit" ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setA2AViewMode("cockpit")}
                >
                  {t("a2a.console.viewCockpit")}
                </Button>
                <Button
                  size="sm"
                  variant={a2aViewMode === "deliverables" ? "default" : "outline"}
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setA2AViewMode("deliverables")}
                >
                  {t("a2a.console.viewChat")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-[11px]"
                  disabled={a2aViewMode !== "deliverables"}
                  onClick={() => setShowOrchestrationFlow((prev) => !prev)}
                >
                  {showOrchestrationFlow ? t("a2a.console.hideFlow") : t("a2a.console.showFlow")}
                </Button>
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setShowGroupWorkspace(true)}
                >
                  <PanelRight className="h-3.5 w-3.5 mr-1" />
                  {t("a2a.console.workspace")}
                </Button>
              </div>
            </div>
          </div>
        )}

        <div ref={contentScrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
          {isA2AConversation && a2aViewMode === "cockpit" ? (
            <div className="mx-auto w-full max-w-6xl space-y-3 pb-2">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[10px] text-muted-foreground">{t("a2a.console.quickOverview")}</p>
                  <p className="text-sm font-semibold">{messages.length}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.orchestrationTimeline")}</p>
                  <p className="text-sm font-semibold">{orchestrationMessages.length}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.executionBoard")}</p>
                  <p className="text-sm font-semibold">{tasks.length}</p>
                </div>
                <div className="rounded-lg border bg-card px-3 py-2">
                  <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.activeAgents")}</p>
                  <p className="text-sm font-semibold">{agentCards.filter((agent) => agent.active).length}</p>
                </div>
              </div>

              {pendingKickoffPlan && (
                <section className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-3">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-amber-900">
                        {t("a2a.cockpit.pendingPlanTitle")}
                      </p>
                      <p className="text-[11px] text-amber-800/90">
                        {t("a2a.cockpit.pendingPlanHint")}
                      </p>
                    </div>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-amber-300 text-amber-800">
                      {t("a2a.cockpit.assignmentCount", { count: pendingKickoffPlan.assignments.length })}
                    </Badge>
                  </div>
                  <p className="text-[11px] text-amber-900 mt-2 leading-relaxed break-words">
                    {shortText(pendingKickoffPlan.summary, 200)}
                  </p>
                  <div className="mt-2 grid grid-cols-1 md:grid-cols-2 gap-2">
                    {pendingKickoffPlan.assignments.slice(0, 4).map((assignment, index) => (
                      <div
                        key={`${assignment.memberId}-${index}`}
                        className="rounded-md border border-amber-200 bg-white/80 px-2.5 py-2"
                      >
                        <p className="text-[11px] font-medium text-amber-900 truncate">
                          {assignment.memberName} {"<-"} {assignment.taskTitle}
                        </p>
                        <p className="text-[10px] text-amber-800/80 mt-1">
                          {t("a2a.cockpit.domainPrefix")} {assignment.taskDomain ?? t("a2a.cockpit.generalDomain")}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    <Button
                      size="sm"
                      className="h-7 px-2.5 text-[11px]"
                      disabled={kickoffPlanAction !== null}
                      onClick={async () => {
                        if (!conversation) return
                        setKickoffPlanAction("confirm")
                        try {
                          await confirmEmbeddedMasterKickoffPlan(conversation.id)
                        } finally {
                          setKickoffPlanAction(null)
                        }
                      }}
                    >
                      {kickoffPlanAction === "confirm" && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                      {t("a2a.cockpit.pendingPlanConfirm")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-[11px]"
                      disabled={kickoffPlanAction !== null}
                      onClick={async () => {
                        if (!conversation) return
                        setKickoffPlanAction("replan")
                        try {
                          await replanEmbeddedMasterKickoffPlan(conversation.id)
                        } finally {
                          setKickoffPlanAction(null)
                        }
                      }}
                    >
                      {kickoffPlanAction === "replan" && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                      {t("a2a.cockpit.pendingPlanReplan")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px] text-muted-foreground"
                      disabled={kickoffPlanAction !== null}
                      onClick={async () => {
                        if (!conversation) return
                        setKickoffPlanAction("reject")
                        try {
                          await rejectEmbeddedMasterKickoffPlan(conversation.id)
                        } finally {
                          setKickoffPlanAction(null)
                        }
                      }}
                    >
                      {kickoffPlanAction === "reject" && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
                      {t("a2a.cockpit.pendingPlanReject")}
                    </Button>
                  </div>
                </section>
              )}

              <section className="rounded-xl border bg-card px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                        <Route className="h-4 w-4" />
                      </span>
                      <div>
                        <p className="text-sm font-semibold">{t("a2a.cockpit.masterAgent")}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {t("a2a.cockpit.masterDescription")}
                        </p>
                      </div>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={cn(
                      "shrink-0 border",
                      masterStatus === "stalled" && "border-amber-200 bg-amber-50 text-amber-700",
                      masterStatus === "exception" && "border-rose-200 bg-rose-50 text-rose-700",
                      masterStatus === "completed" && "border-emerald-200 bg-emerald-50 text-emerald-700",
                      masterStatus === "communication" && "border-violet-200 bg-violet-50 text-violet-700",
                      masterStatus === "monitoring" && "border-muted-foreground/20 bg-muted/30 text-muted-foreground"
                    )}
                  >
                    {masterStatus === "stalled" && t("a2a.cockpit.masterStateStalled")}
                    {masterStatus === "exception" && t("a2a.cockpit.masterStateException")}
                    {masterStatus === "completed" && t("a2a.cockpit.masterStateCompleted")}
                    {masterStatus === "communication" && t("a2a.cockpit.masterStateCommunication")}
                    {masterStatus === "monitoring" && t("a2a.cockpit.masterStateMonitoring")}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-2">
                  <div className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2">
                    <p className="text-[10px] text-amber-700">{t("a2a.cockpit.statusStalled")}</p>
                    <p className="text-sm font-semibold text-amber-700">{stalledTaskCount}</p>
                  </div>
                  <div className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-2">
                    <p className="text-[10px] text-rose-700">{t("a2a.cockpit.statusException")}</p>
                    <p className="text-sm font-semibold text-rose-700">{taskStats.blocked}</p>
                  </div>
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-2">
                    <p className="text-[10px] text-emerald-700">{t("a2a.cockpit.statusCompleted")}</p>
                    <p className="text-sm font-semibold text-emerald-700">{taskStats.done}</p>
                  </div>
                  <div className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-2">
                    <p className="text-[10px] text-violet-700">{t("a2a.cockpit.statusCommunication")}</p>
                    <p className="text-sm font-semibold text-violet-700">{communicationCount}</p>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border bg-card px-3 py-3">
                <div className="flex items-start justify-between gap-2 mb-3 flex-wrap">
                  <div>
                    <p className="text-sm font-semibold">{t("a2a.cockpit.responsibilityBoardTitle")}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t("a2a.cockpit.responsibilityBoardHint")}
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                      {t("a2a.cockpit.agentCount", { count: responsibilityBoardRows.length })}
                    </Badge>
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                      {t("a2a.cockpit.assignmentCount", { count: masterPlannedTaskCount })}
                    </Badge>
                    {latestMasterPlan.createdAtMs != null && (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        {formatClock(latestMasterPlan.createdAtMs)}
                      </Badge>
                    )}
                  </div>
                </div>

                {latestMasterPlan.summary && (
                  <div className="mb-2.5 rounded-md border bg-muted/25 px-2.5 py-2">
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      {shortText(latestMasterPlan.summary, 180)}
                    </p>
                  </div>
                )}

                {responsibilityBoardRows.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("a2a.cockpit.noMembers")}</p>
                ) : (
                  <div className="space-y-2">
                    {responsibilityBoardRows.map((row) => (
                      <div key={row.id} className="rounded-lg border bg-muted/20 px-2.5 py-2.5">
                        <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1.2fr_1.3fr_0.95fr_1fr] gap-2.5">
                          <div className="rounded-md border bg-background px-2.5 py-2 min-w-0">
                            <p className="text-[9px] text-muted-foreground mb-1">
                              {t("a2a.cockpit.responsibilityColumnAgent")}
                            </p>
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="inline-flex h-7 w-7 items-center justify-center rounded-full border bg-muted/30 text-[11px] font-medium shrink-0">
                                {row.avatar?.slice(0, 2) || row.name.slice(0, 2)}
                              </span>
                              <div className="min-w-0">
                                <p className="text-[12px] font-medium truncate">{row.name}</p>
                                <p className="text-[10px] text-muted-foreground truncate">
                                  {row.role || t("a2a.cockpit.unknownRole")}
                                </p>
                              </div>
                              {row.active && (
                                <Badge
                                  variant="outline"
                                  className="h-4 px-1.5 text-[9px] shrink-0 border-violet-200 bg-violet-50 text-violet-700"
                                >
                                  {t("a2a.cockpit.statusCommunication")}
                                </Badge>
                              )}
                            </div>
                            <p className="text-[10px] text-muted-foreground mt-1.5 leading-relaxed break-words">
                              {t("a2a.cockpit.responsibilityPrefix")} {shortText(row.responsibilityText, 120)}
                            </p>
                          </div>

                          <div className="rounded-md border bg-background px-2.5 py-2 min-w-0">
                            <p className="text-[9px] text-muted-foreground mb-1">
                              {t("a2a.cockpit.responsibilityColumnOverall")}
                            </p>
                            <p className="text-[11px] font-medium">
                              {t("a2a.cockpit.totalTasks")} {row.totalCount}
                            </p>
                            <div className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
                              <span className="text-muted-foreground">
                                {t("a2a.cockpit.groupInProgress")} {row.inProgressCount}
                              </span>
                              <span className="text-muted-foreground">
                                {t("a2a.cockpit.groupBlocked")} {row.blockedCount}
                              </span>
                              <span className="text-muted-foreground">
                                {t("a2a.cockpit.groupTodo")} {row.todoCount}
                              </span>
                              <span className="text-muted-foreground">
                                {t("a2a.cockpit.groupDone")} {row.doneCount}
                              </span>
                            </div>
                          </div>

                          <div className="rounded-md border bg-background px-2.5 py-2 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-1">
                              <p className="text-[9px] text-muted-foreground">
                                {t("a2a.cockpit.responsibilityColumnCurrentTask")}
                              </p>
                              <Badge
                                variant="outline"
                                className={cn(
                                  "h-4 px-1.5 text-[9px]",
                                  row.currentTaskStatus === "pending" && "border-amber-200 bg-amber-50 text-amber-700",
                                  row.currentTaskStatus === "blocked" && "border-rose-200 bg-rose-50 text-rose-700",
                                  row.currentTaskStatus === "in-progress" && "border-violet-200 bg-violet-50 text-violet-700",
                                  row.currentTaskStatus === "done" && "border-emerald-200 bg-emerald-50 text-emerald-700",
                                  row.currentTaskStatus === "todo" && "border-sky-200 bg-sky-50 text-sky-700",
                                  row.currentTaskStatus === "idle" && "border-muted-foreground/20 bg-muted/30 text-muted-foreground"
                                )}
                              >
                                {responsibilityTaskStatusLabel(row.currentTaskStatus, t)}
                              </Badge>
                            </div>
                            <p className="text-[11px] font-medium truncate">{row.currentTaskTitle}</p>
                            <p className="text-[10px] text-muted-foreground mt-1 leading-relaxed break-words line-clamp-2">
                              {row.currentTaskNote || t("a2a.cockpit.noTaskDetails")}
                            </p>
                          </div>

                          <div className="rounded-md border bg-background px-2.5 py-2 min-w-0">
                            <p className="text-[9px] text-muted-foreground mb-1">
                              {t("a2a.cockpit.responsibilityColumnProgress")}
                            </p>
                            <div className="space-y-1.5">
                              <div>
                                <p className="text-[10px] text-muted-foreground">
                                  {t("a2a.cockpit.currentActivityPrefix")} {row.currentTaskProgress}%
                                </p>
                                <div className="mt-1 h-1.5 rounded bg-muted overflow-hidden">
                                  <div
                                    className="h-full bg-primary"
                                    style={{ width: `${Math.max(0, Math.min(100, row.currentTaskProgress))}%` }}
                                  />
                                </div>
                              </div>
                              <div>
                                <p className="text-[10px] text-muted-foreground">
                                  {t("a2a.cockpit.progress")} {row.overallProgress}%
                                </p>
                                <div className="mt-1 h-1.5 rounded bg-muted overflow-hidden">
                                  <div
                                    className="h-full bg-emerald-500"
                                    style={{ width: `${Math.max(0, Math.min(100, row.overallProgress))}%` }}
                                  />
                                </div>
                              </div>
                              <p className="text-[10px] text-muted-foreground">
                                {t("a2a.cockpit.completionRate")} {row.completionRate}%
                              </p>
                            </div>
                          </div>

                          <div className="rounded-md border bg-background px-2.5 py-2 min-w-0">
                            <p className="text-[9px] text-muted-foreground mb-1">
                              {t("a2a.cockpit.responsibilityColumnMasterPlan")}
                            </p>
                            {row.masterPlanTasks.length === 0 ? (
                              <p className="text-[10px] text-muted-foreground leading-relaxed">
                                {t("a2a.cockpit.noMasterPlan")}
                              </p>
                            ) : (
                              <div className="space-y-1">
                                {row.masterPlanTasks.slice(0, 3).map((taskTitle, index) => (
                                  <p key={`${row.id}-plan-${index}`} className="text-[10px] leading-relaxed break-words">
                                    • {shortText(taskTitle, 64)}
                                  </p>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border bg-card px-3 py-3">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <div>
                    <p className="text-sm font-semibold">{t("a2a.cockpit.agentBoardTitle")}</p>
                    <p className="text-[11px] text-muted-foreground">{t("a2a.cockpit.activeFirstHint")}</p>
                  </div>
                  <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
                    {agentCards.length}
                  </Badge>
                </div>
                {agentCards.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("a2a.cockpit.noMembers")}</p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
                    {agentCards.map((agent) => (
                      <div
                        key={agent.id}
                        className={cn(
                          "rounded-lg border px-2.5 py-2.5",
                          agent.blockedCount > 0 && "border-rose-200 bg-rose-50/60",
                          agent.blockedCount === 0 && agent.stalledCount > 0 && "border-amber-200 bg-amber-50/60",
                          agent.blockedCount === 0
                            && agent.stalledCount === 0
                            && agent.active
                            && "border-violet-200 bg-violet-50/60",
                          agent.blockedCount === 0
                            && agent.stalledCount === 0
                            && !agent.active
                            && agent.inProgressCount === 0
                            && agent.todoCount === 0
                            && agent.pendingClaimsCount === 0
                            && agent.doneCount > 0
                            && "border-emerald-200 bg-emerald-50/60",
                          agent.blockedCount === 0
                            && agent.stalledCount === 0
                            && !agent.active
                            && "bg-muted/20"
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-background border text-[11px] font-medium">
                              {agent.avatar?.slice(0, 2) || agent.name.slice(0, 2)}
                            </span>
                            <div className="min-w-0">
                              <p className="text-[12px] font-medium truncate">{agent.name}</p>
                              <p className="text-[10px] text-muted-foreground truncate">
                                {agent.role || t("a2a.cockpit.unknownRole")}
                              </p>
                            </div>
                          </div>
                          <Badge
                            variant="outline"
                            className={cn(
                              "h-5 text-[10px] px-1.5 shrink-0 border",
                              agent.blockedCount > 0 && "border-rose-200 bg-rose-50 text-rose-700",
                              agent.blockedCount === 0 && agent.stalledCount > 0 && "border-amber-200 bg-amber-50 text-amber-700",
                              agent.blockedCount === 0
                                && agent.stalledCount === 0
                                && agent.active
                                && "border-violet-200 bg-violet-50 text-violet-700",
                              agent.blockedCount === 0
                                && agent.stalledCount === 0
                                && !agent.active
                                && agent.inProgressCount === 0
                                && agent.todoCount === 0
                                && agent.pendingClaimsCount === 0
                                && agent.doneCount > 0
                                && "border-emerald-200 bg-emerald-50 text-emerald-700",
                              agent.blockedCount === 0
                                && agent.stalledCount === 0
                                && !agent.active
                                && "border-muted-foreground/20 bg-muted/30 text-muted-foreground"
                            )}
                          >
                            {(() => {
                              if (agent.blockedCount > 0) return t("a2a.cockpit.statusException")
                              if (agent.stalledCount > 0) return t("a2a.cockpit.statusStalled")
                              if (agent.active) return t("a2a.cockpit.statusCommunication")
                              if (
                                agent.inProgressCount === 0
                                && agent.todoCount === 0
                                && agent.pendingClaimsCount === 0
                                && agent.doneCount > 0
                              ) {
                                return t("a2a.cockpit.statusCompleted")
                              }
                              return t("a2a.cockpit.statusIdle")
                            })()}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-4 gap-1 mt-2">
                          <div className="rounded border bg-background px-1.5 py-1">
                            <p className="text-[9px] text-muted-foreground">{t("a2a.cockpit.groupInProgress")}</p>
                            <p className="text-[11px] font-semibold">{agent.inProgressCount}</p>
                          </div>
                          <div className="rounded border bg-background px-1.5 py-1">
                            <p className="text-[9px] text-muted-foreground">{t("a2a.cockpit.groupBlocked")}</p>
                            <p className="text-[11px] font-semibold">{agent.blockedCount}</p>
                          </div>
                          <div className="rounded border bg-background px-1.5 py-1">
                            <p className="text-[9px] text-muted-foreground">{t("a2a.cockpit.groupDone")}</p>
                            <p className="text-[11px] font-semibold">{agent.doneCount}</p>
                          </div>
                          <div className="rounded border bg-background px-1.5 py-1">
                            <p className="text-[9px] text-muted-foreground">{t("a2a.cockpit.pendingClaimsShort")}</p>
                            <p className="text-[11px] font-semibold">{agent.pendingClaimsCount}</p>
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] text-muted-foreground">
                          {t("a2a.cockpit.taskLoad")}: {agent.workloadScore}
                        </div>
                        <p className="mt-1 text-[10px] text-muted-foreground truncate">
                          {t("a2a.cockpit.responsibilityPrefix")} {shortText(agent.responsibilityText, 72)}
                        </p>
                        {agent.currentActivity && (
                          <p className="mt-1 text-[10px] text-muted-foreground truncate">
                            {t("a2a.cockpit.currentActivityPrefix")} {shortText(agent.currentActivity, 64)}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <div className="grid grid-cols-1 xl:grid-cols-[1.45fr_1fr] gap-3">
                <section className="rounded-xl border bg-card px-3 py-3">
                  <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                    <div>
                      <p className="text-sm font-semibold">{t("a2a.cockpit.relationGraphTitle")}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {t("a2a.cockpit.showingWindow", { window: t(`a2a.cockpit.timeWindow.${a2aTimeWindow}`) })}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      {(["5m", "15m", "60m", "all"] as A2ATimeWindow[]).map((windowKey) => (
                        <Button
                          key={windowKey}
                          size="sm"
                          variant={a2aTimeWindow === windowKey ? "default" : "outline"}
                          className="h-7 px-2 text-[11px]"
                          onClick={() => setA2ATimeWindow(windowKey)}
                        >
                          {t(`a2a.cockpit.timeWindow.${windowKey}`)}
                        </Button>
                      ))}
                    </div>
                  </div>
                  {graphEdges.length === 0 ? (
                    <p className="text-xs text-muted-foreground py-6">{t("a2a.cockpit.noCommunicationInWindow")}</p>
                  ) : (
                    <div className="rounded-lg border bg-muted/20 p-2 overflow-x-auto">
                      <svg viewBox="0 0 760 320" className="w-full min-w-[640px] h-[300px]">
                        {graphEdges.map((edge) => {
                          const source = graphNodeMap.get(edge.sourceId)
                          const target = graphNodeMap.get(edge.targetId)
                          if (!source || !target) return null
                          const midX = (source.x + target.x) / 2
                          const midY = (source.y + target.y) / 2
                          const strokeWidth = Math.min(1 + edge.count * 0.8, 6)
                          return (
                            <g key={edge.id}>
                              <title>{`${edge.sourceName} -> ${edge.targetName} x${edge.count}`}</title>
                              <line
                                x1={source.x}
                                y1={source.y}
                                x2={target.x}
                                y2={target.y}
                                stroke="#7c3aed"
                                strokeOpacity={edge.sourceId === A2A_MASTER_NODE_ID ? 0.65 : 0.45}
                                strokeWidth={strokeWidth}
                              />
                              <circle cx={midX} cy={midY} r={10} fill="#ffffff" stroke="#cbd5e1" />
                              <text
                                x={midX}
                                y={midY + 3}
                                textAnchor="middle"
                                fontSize="10"
                                fill="#334155"
                              >
                                {edge.count}
                              </text>
                            </g>
                          )
                        })}
                        {graphNodes.map((node) => (
                          <g key={node.id}>
                            <title>{node.name}</title>
                            <circle
                              cx={node.x}
                              cy={node.y}
                              r={node.isMaster ? 26 : 20}
                              fill={node.isMaster ? "#7c3aed" : node.active ? "#8b5cf6" : "#64748b"}
                              fillOpacity={node.isMaster ? 0.92 : node.active ? 0.9 : 0.78}
                              stroke="#ffffff"
                              strokeWidth={2}
                            />
                            <text
                              x={node.x}
                              y={node.y + 4}
                              textAnchor="middle"
                              fontSize={node.isMaster ? "11" : "10"}
                              fill="#ffffff"
                              fontWeight="600"
                            >
                              {node.isMaster ? "M" : node.name.slice(0, 2)}
                            </text>
                            <text
                              x={node.x}
                              y={node.y + (node.isMaster ? 39 : 33)}
                              textAnchor="middle"
                              fontSize="10"
                              fill="#475569"
                            >
                              {shortText(node.name, 10)}
                            </text>
                          </g>
                        ))}
                      </svg>
                    </div>
                  )}
                  {agentCards.length > graphAgents.length && (
                    <p className="text-[10px] text-muted-foreground mt-2">
                      {t("a2a.cockpit.graphTruncatedHint", {
                        shown: graphAgents.length,
                        total: agentCards.length,
                      })}
                    </p>
                  )}
                </section>

                <section className="rounded-xl border bg-card px-3 py-3">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-sm font-semibold">{t("a2a.cockpit.communicationTimelineTitle")}</p>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-violet-200 bg-violet-50 text-violet-700">
                      {collaboration.events.length}
                    </Badge>
                  </div>
                  {collaboration.events.length === 0 ? (
                    <p className="text-xs text-muted-foreground">{t("a2a.cockpit.noOrchestrationEvents")}</p>
                  ) : (
                    <div className="space-y-1.5 max-h-[300px] overflow-y-auto pr-0.5">
                      {collaboration.events.slice(0, 16).map((event) => (
                        <div key={event.id} className="rounded-md border bg-muted/20 px-2.5 py-2">
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="text-[11px] font-medium truncate">
                              {event.sourceName} {"->"} {event.targetName}
                            </span>
                            <Badge variant="outline" className="h-4 px-1.5 text-[9px] shrink-0 border-violet-200 bg-violet-50 text-violet-700">
                              {event.channel === "dispatch"
                                ? t("a2a.cockpit.eventDispatch")
                                : t("a2a.cockpit.eventMention")}
                            </Badge>
                          </div>
                          <p className="text-[10px] text-muted-foreground leading-relaxed">
                            {shortText(event.summary, 110)}
                          </p>
                          <p className="text-[9px] text-muted-foreground mt-1">{event.displayTime}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              </div>

              <section className="rounded-xl border bg-card px-3 py-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-semibold">{t("a2a.cockpit.executionBoard")}</p>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {taskCount}
                  </Badge>
                </div>
                {sortedTasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("a2a.cockpit.noTasks")}</p>
                ) : (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
                    {sortedTasks.slice(0, 12).map((task) => (
                      <div key={task.id} className="rounded-md border bg-muted/20 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[11px] font-medium truncate">{task.title}</p>
                          <Badge variant="outline" className="h-4 px-1.5 text-[9px] shrink-0">
                            {taskStatusLabel(task.status, t)}
                          </Badge>
                        </div>
                        <div className="mt-1.5 h-1.5 rounded bg-muted overflow-hidden">
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${Math.max(0, Math.min(100, task.progress))}%` }}
                          />
                        </div>
                        <div className="mt-1.5 text-[10px] text-muted-foreground flex items-center justify-between gap-2">
                          <span className="truncate">
                            {task.assigneeId
                              ? (agentNameById.get(task.assigneeId) ?? task.assigneeId)
                              : t("a2a.cockpit.unassignedLabel")}
                          </span>
                          <span className="shrink-0">{task.progress}%</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          ) : isA2AConversation && a2aViewMode === "deliverables" && visibleMessages.length === 0 ? (
            <div className="h-full min-h-0 flex items-center justify-center">
              <div className="max-w-md w-full rounded-xl border bg-card px-4 py-4 text-center space-y-2">
                <p className="text-sm font-medium">{t("a2a.console.noVisibleMessages")}</p>
                <p className="text-xs text-muted-foreground">{t("a2a.console.noVisibleMessagesHint")}</p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => setA2AViewMode("cockpit")}>
                    {t("a2a.console.switchToCockpit")}
                  </Button>
                  <Button size="sm" onClick={() => setShowOrchestrationFlow(true)}>
                    {t("a2a.console.showFlowAction")}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-0.5">
                {items.map((item) =>
                  item.type === "date" ? (
                    <DateSeparator key={item.key} label={item.label} />
                  ) : compactFlowMode ? (
                    <div key={item.key} className="py-1.5">
                      <div className="rounded-md border bg-card/90 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className="text-[11px] font-medium truncate">{item.msg.senderName}</span>
                          <span className="text-[10px] text-muted-foreground shrink-0">{item.msg.timestamp}</span>
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
                          {getA2ACompactText(item.msg)}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <MessageBubble
                      key={item.key}
                      message={item.msg}
                      showSenderInfo={isGroup}
                      onAgentAvatarClick={handleAgentAvatarClick}
                    />
                  )
                )}

                {thinkingAgents.map((agentId) => {
                  const agent = state.agents.find((item) => item.id === agentId)
                  if (!agent) return null
                  return (
                    <TypingIndicator
                      key={agentId}
                      agentId={agentId}
                      agentName={agent.name}
                      agentAvatar={agent.avatar}
                    />
                  )
                })}
              </div>
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <MessageInput
          onSend={(content, attachments) => {
            if (state.activeConversationId) {
              sendMessage(state.activeConversationId, content, attachments)
            }
          }}
          onNewSession={() => {
            if (state.activeConversationId) {
              resetSession(state.activeConversationId)
            }
          }}
          onAbort={() => {
            if (state.activeConversationId) {
              abortConversation(state.activeConversationId)
            }
          }}
          isGenerating={thinkingAgents.length > 0}
          showMention={isGroup}
          members={members}
        />
      </div>

      {isGroup && (
        <GroupMembersPanel
          conversation={conversation}
          open={showMembers}
          onOpenChange={setShowMembers}
        />
      )}

      {isGroup && (
        <GroupWorkspacePanel
          conversation={conversation}
          open={showGroupWorkspace}
          onOpenChange={setShowGroupWorkspace}
        />
      )}

      {!isGroup && conversation.members[0] && (
        <WorkspacePanel
          agentId={conversation.members[0]}
          open={showWorkspace}
          onOpenChange={setShowWorkspace}
        />
      )}

      <PersonaPanel
        open={personaPanelOpen}
        onOpenChange={setPersonaPanelOpen}
        agentId={personaAgentId}
        agentName={personaAgentName}
      />

      {!isGroup && conversation.members[0] && (
        <SessionHistorySheet
          open={showSessionHistory}
          onOpenChange={setShowSessionHistory}
          agentId={conversation.members[0]}
        />
      )}
    </div>
  )
}
