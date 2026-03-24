import { useMemo, useState } from "react"
import { Activity, FolderOpen, MessagesSquare, Trash2, Users, Zap } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/i18n"
import { getAgentAvatarUrl } from "@/lib/avatar"
import { getStrategyLabel } from "@/lib/orchestration/labels"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app-context"
import type { Agent, Conversation, Message } from "@/types"

const strategyColors: Record<string, string> = {
  coordinator: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-400",
  "skill-match": "bg-purple-100 text-purple-700 dark:bg-purple-950/50 dark:text-purple-400",
  a2a: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950/50 dark:text-cyan-400",
  "round-robin": "bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400",
  all: "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400",
}

const statusColors: Record<Agent["status"], string> = {
  idle: "bg-emerald-500",
  working: "bg-amber-500",
  busy: "bg-rose-500",
  chatting: "bg-blue-500",
  thinking: "bg-amber-500",
  completed: "bg-emerald-500",
}

interface GroupCardProps {
  group: Conversation
  agentMap: Record<string, Agent>
  messages: Message[]
  thinkingAgentIds: Set<string>
  onOpen: (id: string) => void
  onDissolve: (id: string) => void
}

function normalizeProgress(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

function deriveMemberProgress(agent: Agent, messageCount: number, isThinking: boolean): number {
  if (typeof agent.taskProgress === "number") return normalizeProgress(agent.taskProgress)
  if (agent.status === "completed") return 100
  if (isThinking || agent.status === "working" || agent.status === "busy") return 60
  if (messageCount > 0) return normalizeProgress(30 + messageCount * 15)
  return 8
}

function parseA2ARelayReason(reason: string): { from: string; to: string } | null {
  const match = reason.match(/^A2A relay:\s*(.+?)\s*->\s*(.+)$/i)
  if (!match) return null
  return { from: match[1].trim(), to: match[2].trim() }
}

function parseIsoTime(value?: string): number | null {
  if (!value) return null
  const ts = Date.parse(value)
  return Number.isFinite(ts) ? ts : null
}

function GroupCard({
  group,
  agentMap,
  messages,
  thinkingAgentIds,
  onOpen,
  onDissolve,
}: GroupCardProps) {
  const { t } = useI18n()
  const strategy = group.orchestration?.strategy ?? "all"
  const strategyLabel = getStrategyLabel(strategy, t)
  const strategyColor = strategyColors[strategy] ?? strategyColors.all

  const agentMembers = group.members.filter((memberId) => memberId !== "user")
  const coordinatorId = group.orchestration?.coordinatorId

  const messageCountByAgent = useMemo(() => {
    const counter = new Map<string, number>()
    for (const msg of messages) {
      if (!agentMembers.includes(msg.senderId)) continue
      counter.set(msg.senderId, (counter.get(msg.senderId) ?? 0) + 1)
    }
    return counter
  }, [messages, agentMembers])

  const memberRows = agentMembers
    .map((memberId) => {
      const agent = agentMap[memberId]
      if (!agent) return null
      const messageCount = messageCountByAgent.get(memberId) ?? 0
      const isThinking = thinkingAgentIds.has(memberId)
      const progress = deriveMemberProgress(agent, messageCount, isThinking)
      const isActive = isThinking || agent.status === "working" || agent.status === "busy"
      return {
        id: memberId,
        name: agent.name,
        status: agent.status,
        progress,
        isActive,
      }
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)

  const activeCount = memberRows.filter((row) => row.isActive).length
  const avgProgress =
    memberRows.length > 0
      ? Math.round(memberRows.reduce((sum, row) => sum + row.progress, 0) / memberRows.length)
      : 0

  const workspaceTasks = group.workspaceTasks ?? []
  const doneTaskCount = workspaceTasks.filter((task) => task.status === "done").length
  const blockedTaskCount = workspaceTasks.filter((task) => task.status === "blocked").length
  const pendingTaskCount = workspaceTasks.filter((task) => task.status !== "done").length
  const taskProgress =
    workspaceTasks.length > 0
      ? Math.round(workspaceTasks.reduce((sum, task) => sum + task.progress, 0) / workspaceTasks.length)
      : 0
  const overallProgress = workspaceTasks.length > 0
    ? Math.round((avgProgress + taskProgress) / 2)
    : avgProgress

  const a2aEvents = messages.filter(
    (msg) => msg.type === "orchestration" && msg.orchestrationInfo?.strategy === "a2a"
  )
  const a2aRelayCount = a2aEvents.filter((event) => event.content.startsWith("A2A relay:")).length
  const a2aTimeline = a2aEvents.slice(-6).reverse()
  const relayEdges = useMemo(() => {
    const edgeMap = new Map<string, { from: string; to: string; count: number }>()
    for (const event of a2aEvents) {
      const parsed = parseA2ARelayReason(event.content)
      if (!parsed) continue
      const key = `${parsed.from} -> ${parsed.to}`
      const prev = edgeMap.get(key)
      if (prev) {
        prev.count += 1
      } else {
        edgeMap.set(key, { ...parsed, count: 1 })
      }
    }
    return [...edgeMap.values()].sort((a, b) => b.count - a.count).slice(0, 6)
  }, [a2aEvents])

  const blockedTasks = workspaceTasks.filter((task) => task.status === "blocked")
  const stalledThresholdMs = 90_000
  const now = Date.now()
  const stalledTasks = workspaceTasks.filter((task) => {
    if (task.status === "done") return false
    const updatedAtMs = parseIsoTime(task.updatedAt)
    if (updatedAtMs == null) return false
    return now - updatedAtMs >= stalledThresholdMs
  })

  const coordinatorAgent = coordinatorId ? agentMap[coordinatorId] : undefined
  const lastCoordinatorMsg = coordinatorId
    ? [...messages]
      .reverse()
      .find((msg) => msg.senderId === coordinatorId && !msg.id.startsWith("streaming-"))
    : undefined
  const heartbeatStatus: "healthy" | "warning" | "alert" | "idle" = !coordinatorId
    ? "alert"
    : pendingTaskCount === 0
      ? "idle"
      : stalledTasks.length > 0
        ? "alert"
        : activeCount === 0
          ? "warning"
          : "healthy"
  const heartbeatClass: Record<typeof heartbeatStatus, string> = {
    healthy: "bg-emerald-100 text-emerald-700 border-emerald-300",
    warning: "bg-amber-100 text-amber-700 border-amber-300",
    alert: "bg-rose-100 text-rose-700 border-rose-300",
    idle: "bg-slate-100 text-slate-700 border-slate-300",
  }

  const displayMembers = agentMembers.slice(0, 5)
  const extraCount = agentMembers.length - displayMembers.length

  const latestAgentMessage = [...messages]
    .reverse()
    .find((msg) => agentMembers.includes(msg.senderId) && !msg.id.startsWith("streaming-"))

  return (
    <Card
      className="p-5 flex flex-col gap-4 hover:shadow-md transition-shadow cursor-pointer group"
      onClick={() => onOpen(group.id)}
    >
      <div className="flex items-start gap-3">
        <div className="h-11 w-11 rounded-xl bg-primary/10 flex items-center justify-center text-lg shrink-0 select-none">
          {group.avatar || "GR"}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-semibold text-sm truncate">{group.name}</p>
            {group.unreadCount > 0 && (
              <span className="shrink-0 h-4.5 min-w-4.5 px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                {group.unreadCount > 99 ? "99+" : group.unreadCount}
              </span>
            )}
          </div>
          {group.purpose && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{group.purpose}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex -space-x-1.5">
          {displayMembers.map((memberId) => {
            const agent = agentMap[memberId]
            return (
              <Tooltip key={memberId}>
                <TooltipTrigger>
                  <Avatar className={cn("h-6 w-6 ring-2 ring-background", coordinatorId === memberId && "ring-primary")}>
                    <AvatarImage src={getAgentAvatarUrl(memberId)} />
                    <AvatarFallback className="text-[9px] bg-muted">
                      {agent?.name?.slice(0, 1) ?? "?"}
                    </AvatarFallback>
                  </Avatar>
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {agent?.name ?? memberId}
                  {coordinatorId === memberId ? " (coordinator)" : ""}
                </TooltipContent>
              </Tooltip>
            )
          })}
          {extraCount > 0 && (
            <div className="h-6 w-6 ring-2 ring-background rounded-full bg-muted flex items-center justify-center text-[9px] font-medium text-muted-foreground">
              +{extraCount}
            </div>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {agentMembers.length} members · {activeCount} active
        </span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="secondary" className={cn("text-[11px] font-normal px-2 py-0.5", strategyColor)}>
          <Zap className="h-2.5 w-2.5 mr-1" />
          {strategyLabel}
        </Badge>
        {a2aRelayCount > 0 && (
          <Badge variant="secondary" className="text-[11px] font-normal px-2 py-0.5">
            A2A relays: {a2aRelayCount}
          </Badge>
        )}
        <Badge variant="outline" className="text-[11px] font-normal px-2 py-0.5">
          Tasks: {workspaceTasks.length}
        </Badge>
        {strategy === "a2a" && group.orchestration?.a2aStrictRoleMatch !== false && (
          <Badge variant="outline" className="text-[11px] font-normal px-2 py-0.5 border-indigo-300 text-indigo-700">
            Strict Role Routing
          </Badge>
        )}
        {blockedTaskCount > 0 && (
          <Badge variant="outline" className="text-[11px] font-normal px-2 py-0.5 border-rose-300 text-rose-700">
            Blocked: {blockedTaskCount}
          </Badge>
        )}
      </div>

      {(strategy === "a2a" || strategy === "coordinator") && (
        <div className="rounded-lg border bg-muted/20 p-2.5 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium flex items-center gap-1.5">
              <Activity className="h-3 w-3" />
              Coordinator Heartbeat
            </p>
            <Badge variant="outline" className={cn("text-[10px] px-1.5 py-0", heartbeatClass[heartbeatStatus])}>
              {heartbeatStatus}
            </Badge>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            <div className="rounded border bg-background/70 px-2 py-1">
              <p className="text-[9px] text-muted-foreground">Pending</p>
              <p className="text-[11px] font-semibold">{pendingTaskCount}</p>
            </div>
            <div className="rounded border bg-background/70 px-2 py-1">
              <p className="text-[9px] text-muted-foreground">Blocked</p>
              <p className="text-[11px] font-semibold">{blockedTaskCount}</p>
            </div>
            <div className="rounded border bg-background/70 px-2 py-1">
              <p className="text-[9px] text-muted-foreground">Stalled</p>
              <p className="text-[11px] font-semibold">{stalledTasks.length}</p>
            </div>
            <div className="rounded border bg-background/70 px-2 py-1">
              <p className="text-[9px] text-muted-foreground">Claims</p>
              <p className="text-[11px] font-semibold">
                {workspaceTasks.filter((task) => !!task.pendingAssigneeId).length}
              </p>
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Coordinator: {coordinatorAgent?.name ?? coordinatorId ?? "not set"}
            {" | "}
            Last activity: {lastCoordinatorMsg?.timestamp ?? "--"}
          </p>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Team Progress</span>
          <span>{overallProgress}%</span>
        </div>
        <Progress value={overallProgress} className="h-1.5" />
        {workspaceTasks.length > 0 && (
          <p className="text-[10px] text-muted-foreground">
            Shared tasks: {doneTaskCount}/{workspaceTasks.length} done
          </p>
        )}

        <div className="space-y-1.5">
          {memberRows.slice(0, 3).map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full shrink-0", statusColors[row.status] ?? "bg-gray-400")} />
              <span className="text-[11px] text-foreground/85 w-20 truncate">{row.name}</span>
              <div className="flex-1">
                <Progress value={row.progress} className="h-1" />
              </div>
              <span className="text-[10px] text-muted-foreground tabular-nums w-8 text-right">
                {row.progress}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {(a2aTimeline.length > 0 || relayEdges.length > 0 || blockedTasks.length > 0) && (
        <div className="rounded-lg border bg-muted/20 p-2.5 space-y-2">
          <div>
            <p className="text-[11px] font-medium">A2A Timeline</p>
            {a2aTimeline.length === 0 ? (
              <p className="text-[10px] text-muted-foreground mt-1">No A2A events yet.</p>
            ) : (
              <div className="mt-1 space-y-1.5">
                {a2aTimeline.map((event) => (
                  <div key={event.id} className="text-[10px] text-muted-foreground flex items-start gap-1.5">
                    <span className="shrink-0 text-muted-foreground/70">{event.timestamp || "--:--"}</span>
                    <span className="line-clamp-1">{event.content}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-[11px] font-medium">A2A Collaboration Links</p>
            {relayEdges.length === 0 ? (
              <p className="text-[10px] text-muted-foreground mt-1">No relay links yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5 mt-1">
                {relayEdges.map((edge) => (
                  <Badge key={`${edge.from}-${edge.to}`} variant="outline" className="text-[10px] px-1.5 py-0">
                    {edge.from} → {edge.to} · {edge.count}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {blockedTasks.length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-rose-700 dark:text-rose-300">Current Blockers</p>
              <div className="mt-1 space-y-1">
                {blockedTasks.slice(0, 3).map((task) => (
                  <p key={task.id} className="text-[10px] text-rose-700/90 dark:text-rose-300/90 line-clamp-1">
                    {task.title}
                    {task.blockedReason ? `: ${task.blockedReason}` : ""}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {group.workspacePath && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/70 font-mono">
          <FolderOpen className="h-3 w-3 shrink-0" />
          <span className="truncate">{group.workspacePath}</span>
        </div>
      )}

      {latestAgentMessage && (
        <div className="flex items-center justify-between gap-2 border-t pt-3 mt-auto">
          <p className="text-xs text-muted-foreground truncate">
            <span className="font-medium text-foreground/70">{latestAgentMessage.senderName}: </span>
            {latestAgentMessage.content}
          </p>
          {latestAgentMessage.timestamp && (
            <span className="text-[10px] text-muted-foreground/60 shrink-0">{latestAgentMessage.timestamp}</span>
          )}
        </div>
      )}

      <div className="flex gap-2 mt-auto" onClick={(event) => event.stopPropagation()}>
        <Button
          size="sm"
          className="flex-1 h-8 text-xs"
          onClick={() => onOpen(group.id)}
        >
          <MessagesSquare className="h-3.5 w-3.5 mr-1.5" />
          Open Chat
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={(
              <Button
                size="sm"
                variant="outline"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:border-destructive"
                onClick={() => onDissolve(group.id)}
              />
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </TooltipTrigger>
          <TooltipContent>Dissolve Group</TooltipContent>
        </Tooltip>
      </div>
    </Card>
  )
}

export function VirtualTeamView() {
  const { state, dispatch } = useApp()
  const [dissolveTarget, setDissolveTarget] = useState<string | null>(null)
  const { t } = useI18n()

  const groups = state.conversations.filter((conversation) => conversation.type === "group")
  const agentMap = useMemo(
    () => Object.fromEntries(state.agents.map((agent) => [agent.id, agent])),
    [state.agents]
  )

  const handleOpen = (groupId: string) => {
    dispatch({ type: "SET_ACTIVE_CONVERSATION", payload: groupId })
    dispatch({ type: "SET_VIEW", payload: "chat" })
  }

  const handleDissolveConfirm = () => {
    if (!dissolveTarget) return
    dispatch({ type: "DISSOLVE_GROUP", payload: { conversationId: dissolveTarget } })
    setDissolveTarget(null)
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-muted/20">
      <div
        className="shrink-0 flex items-center px-8 py-5 border-b bg-background"
        style={{
          WebkitAppRegion: "drag",
          ...(window.ipc.platform !== "darwin" ? { paddingRight: "154px" } : {}),
        } as React.CSSProperties}
      >
        <div
          className="flex items-center justify-center h-9 w-9 rounded-lg bg-primary/10 shrink-0"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <Users className="h-5 w-5 text-primary" />
        </div>
        <div className="ml-3" style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
          <h1 className="text-lg font-semibold">{t("nav.virtualTeam")}</h1>
          <p className="text-xs text-muted-foreground">
            {groups.length > 0 ? `${groups.length} teams · live collaboration status` : "Manage your multi-agent teams"}
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        {groups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-4 text-center">
            <div className="h-20 w-20 rounded-2xl bg-muted flex items-center justify-center text-2xl font-semibold">
              GR
            </div>
            <div>
              <p className="font-semibold text-foreground">No teams yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create a group from the conversation panel to start multi-agent collaboration.
              </p>
            </div>
          </div>
        ) : (
          <div className="max-w-6xl mx-auto grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {groups.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                agentMap={agentMap}
                messages={state.messages[group.id] ?? []}
                thinkingAgentIds={state.thinkingAgents}
                onOpen={handleOpen}
                onDissolve={setDissolveTarget}
              />
            ))}
          </div>
        )}
      </div>

      <AlertDialog open={!!dissolveTarget} onOpenChange={(open) => !open && setDissolveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Dissolve Group</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove the group and all related message history. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDissolveConfirm}
              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
            >
              Dissolve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
