import { useMemo, useState } from "react"
import { toast } from "sonner"
import { createMasterEngine } from "@master-agent"
import {
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Loader2,
  MessageSquare,
  Route,
  ShieldAlert,
  TriangleAlert,
  User,
  Users,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useApp } from "@/store/app-context"
import { cn } from "@/lib/utils"
import { useI18n } from "@/i18n"
import type { Conversation, GroupWorkspaceTask, Message } from "@/types"

interface A2ACockpitPanelProps {
  conversation: Conversation
  messages: Message[]
  onOpenWorkspace: () => void
}

const previewMasterEngine = createMasterEngine()
const STALE_TASK_MS = 180_000

function shortText(text: string, max = 120): string {
  const normalized = text.replace(/\s+/g, " ").trim()
  if (!normalized) return "(empty)"
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}...`
}

export function A2ACockpitPanel({ conversation, messages, onOpenWorkspace }: A2ACockpitPanelProps) {
  const { state, runEmbeddedMasterRebalance } = useApp()
  const { t } = useI18n()
  const [rebalancing, setRebalancing] = useState(false)
  const tasks = conversation.workspaceTasks ?? []
  const orchestration = messages.filter((msg) => msg.type === "orchestration").slice(-20).reverse()
  const orchestrationEvents = messages.filter((msg) => msg.type === "orchestration").slice(-120)
  const deliverables = messages
    .filter((msg) => msg.type !== "orchestration" && msg.senderId !== "system")
    .slice(-30)
    .reverse()

  const done = tasks.filter((task) => task.status === "done").length
  const blocked = tasks.filter((task) => task.status === "blocked").length
  const inProgress = tasks.filter((task) => task.status === "in-progress").length
  const activeMembers = conversation.members
    .filter((id) => id !== "user")
    .filter((id) => state.thinkingAgents.has(id))
    .length
  const avgProgress = tasks.length > 0
    ? Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / tasks.length)
    : 0

  const members = useMemo(
    () =>
      conversation.members
        .filter((id) => id !== "user")
        .map((id) => state.agents.find((agent) => agent.id === id))
        .filter((agent): agent is NonNullable<typeof agent> => !!agent),
    [conversation.members, state.agents]
  )

  const heatmap = useMemo(() => {
    return members
      .map((member) => {
        const assigned = tasks.filter((task) => task.assigneeId === member.id)
        const assignedInProgress = assigned.filter((task) => task.status === "in-progress").length
        const assignedBlocked = assigned.filter((task) => task.status === "blocked").length
        const assignedDone = assigned.filter((task) => task.status === "done").length
        const loadScore = assignedInProgress * 2 + assignedBlocked * 3 + Math.max(0, assigned.length - assignedDone)
        return {
          memberId: member.id,
          memberName: member.name,
          total: assigned.length,
          inProgress: assignedInProgress,
          blocked: assignedBlocked,
          done: assignedDone,
          loadScore,
        }
      })
      .sort((a, b) => b.loadScore - a.loadScore)
  }, [members, tasks])

  const maxLoad = Math.max(1, ...heatmap.map((item) => item.loadScore))
  const now = Date.now()
  const staleTasks = tasks.filter((task) => {
    if (task.status === "done") return false
    const updatedAt = Date.parse(task.updatedAt || task.createdAt)
    if (!Number.isFinite(updatedAt)) return false
    return now - updatedAt >= STALE_TASK_MS
  })
  const unassigned = tasks.filter((task) => task.status !== "done" && !task.assigneeId && !task.pendingAssigneeId)
  const heavyLoaded = heatmap.filter((item) => item.loadScore >= 5)

  const bottlenecks = [
    {
      key: "blocked",
      level: blocked > 0 ? "high" : "normal",
      title: t("a2a.cockpit.blockedTasks"),
      detail:
        blocked > 0
          ? t("a2a.cockpit.blockedTasksCount", { count: blocked })
          : t("a2a.cockpit.noBlockedTasks"),
    },
    {
      key: "stale",
      level: staleTasks.length > 0 ? "high" : "normal",
      title: t("a2a.cockpit.staleTasks"),
      detail:
        staleTasks.length > 0
          ? t("a2a.cockpit.staleTasksCount", { count: staleTasks.length })
          : t("a2a.cockpit.noStaleTasks"),
    },
    {
      key: "unassigned",
      level: unassigned.length > 0 ? "medium" : "normal",
      title: t("a2a.cockpit.unassignedTasks"),
      detail:
        unassigned.length > 0
          ? t("a2a.cockpit.unassignedTasksCount", { count: unassigned.length })
          : t("a2a.cockpit.allTasksAssigned"),
    },
    {
      key: "load",
      level: heavyLoaded.length > 0 ? "medium" : "normal",
      title: t("a2a.cockpit.loadSkew"),
      detail:
        heavyLoaded.length > 0
          ? t("a2a.cockpit.overloadedMembers", { count: heavyLoaded.length })
          : t("a2a.cockpit.loadHealthy"),
    },
  ]

  const isEmbeddedMaster = conversation.orchestration?.masterMode !== "openclaw-coordinator"
  const collaborationLinks = useMemo(() => {
    const links = new Map<
      string,
      {
        source: string
        targetId: string
        targetName: string
        count: number
        lastAt?: string
        phases: Set<string>
      }
    >()
    for (const msg of orchestrationEvents) {
      const selected = msg.orchestrationInfo?.selectedAgents ?? []
      if (selected.length === 0) continue
      const decision = msg.orchestrationInfo?.masterDecision
      const source =
        decision?.engine === "embedded-master"
          ? "Embedded Master"
          : (msg.senderName || "Coordinator")
      const phase =
        decision?.phase === "kickoff"
          ? "kickoff"
          : decision?.phase === "rebalance"
            ? "rebalance"
            : decision?.phase === "assignment"
              ? "assignment"
              : "routing"

      for (const targetId of selected) {
        if (!targetId || targetId === "user") continue
        const targetName = state.agents.find((agent) => agent.id === targetId)?.name ?? targetId
        const key = `${source}->${targetId}`
        const prev = links.get(key)
        if (prev) {
          prev.count += 1
          prev.lastAt = msg.timestamp
          prev.phases.add(phase)
        } else {
          links.set(key, {
            source,
            targetId,
            targetName,
            count: 1,
            lastAt: msg.timestamp,
            phases: new Set([phase]),
          })
        }
      }
    }
    return [...links.values()].sort((a, b) => b.count - a.count)
  }, [orchestrationEvents, state.agents])

  const agentSwimlanes = useMemo(() => {
    const memberLanes = members.map((member) => {
      const assigned = tasks.filter((task) => task.assigneeId === member.id)
      const inProgressCount = assigned.filter((task) => task.status === "in-progress").length
      const blockedCount = assigned.filter((task) => task.status === "blocked").length
      const pendingClaims = tasks.filter((task) => task.pendingAssigneeId === member.id).length
      const load = inProgressCount * 2 + blockedCount * 3 + pendingClaims
      return {
        memberId: member.id,
        memberName: member.name,
        tasks: assigned,
        inProgressCount,
        blockedCount,
        pendingClaims,
        load,
      }
    })
    const unassignedTasks = tasks.filter((task) => !task.assigneeId && task.status !== "done")
    if (unassignedTasks.length > 0) {
      memberLanes.push({
        memberId: "__unassigned__",
        memberName: "Unassigned",
        tasks: unassignedTasks,
        inProgressCount: unassignedTasks.filter((task) => task.status === "in-progress").length,
        blockedCount: unassignedTasks.filter((task) => task.status === "blocked").length,
        pendingClaims: 0,
        load: unassignedTasks.length,
      })
    }
    return memberLanes.sort((a, b) => b.load - a.load)
  }, [members, tasks])

  const previewPlan = useMemo(() => {
    if (!isEmbeddedMaster) return null
    return previewMasterEngine.planRebalance({
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        progress: task.progress,
        assigneeId: task.assigneeId,
        pendingAssigneeId: task.pendingAssigneeId,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })),
      members: members.map((member) => ({
        id: member.id,
        name: member.name,
        role: member.role,
        skills: member.skills,
      })),
      coordinatorId: conversation.orchestration?.coordinatorId,
      strictRoleMatch: conversation.orchestration?.a2aStrictRoleMatch !== false,
      maxAssignments: 4,
    })
  }, [conversation.orchestration, isEmbeddedMaster, members, tasks])

  const taskGroups: Array<{ title: string; status: GroupWorkspaceTask["status"] }> = [
    { title: t("a2a.cockpit.groupBlocked"), status: "blocked" },
    { title: t("a2a.cockpit.groupInProgress"), status: "in-progress" },
    { title: t("a2a.cockpit.groupTodo"), status: "todo" },
    { title: t("a2a.cockpit.groupDone"), status: "done" },
  ]

  const statusLabel = (status: GroupWorkspaceTask["status"]): string => {
    if (status === "in-progress") return t("a2a.cockpit.groupInProgress")
    if (status === "blocked") return t("a2a.cockpit.groupBlocked")
    if (status === "done") return t("a2a.cockpit.groupDone")
    return t("a2a.cockpit.groupTodo")
  }

  return (
    <div className="w-full space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 shrink-0">
        <div className="rounded-lg border bg-card px-2.5 py-2">
          <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.totalTasks")}</p>
          <p className="text-sm font-semibold">{tasks.length}</p>
        </div>
        <div className="rounded-lg border bg-card px-2.5 py-2">
          <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.groupInProgress")}</p>
          <p className="text-sm font-semibold">{inProgress}</p>
        </div>
        <div className="rounded-lg border bg-card px-2.5 py-2">
          <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.groupBlocked")}</p>
          <p className="text-sm font-semibold">{blocked}</p>
        </div>
        <div className="rounded-lg border bg-card px-2.5 py-2">
          <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.groupDone")}</p>
          <p className="text-sm font-semibold">{done}</p>
        </div>
        <div className="rounded-lg border bg-card px-2.5 py-2">
          <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.progress")}</p>
          <p className="text-sm font-semibold">{avgProgress}%</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        <section className="lg:col-span-7 rounded-xl border bg-card overflow-hidden">
          <div className="px-3 py-2 border-b flex items-center justify-between gap-2">
            <div className="inline-flex items-center gap-1.5 min-w-0">
              <MessageSquare className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium truncate">{t("a2a.cockpit.deliverablesFeed")}</span>
            </div>
            <Badge variant="secondary" className="h-5 text-[10px] px-1.5 shrink-0">
              {deliverables.length}
            </Badge>
          </div>
          <div className="max-h-[360px] overflow-y-auto p-2.5 space-y-2">
            {deliverables.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("a2a.cockpit.noDeliverables")}</p>
            ) : (
              deliverables.map((msg) => (
                <div key={msg.id} className="rounded-md border bg-muted/20 px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11px] font-medium truncate">{msg.senderName}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0">{msg.timestamp}</span>
                  </div>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {shortText(msg.content)}
                  </p>
                </div>
              ))
            )}
          </div>
        </section>

        <div className="lg:col-span-5 grid grid-cols-1 gap-3">
          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-3 py-2 border-b flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5 min-w-0">
              <BrainCircuit className="h-4 w-4 text-primary shrink-0" />
              <span className="text-sm font-medium truncate">{t("a2a.cockpit.orchestrationTimeline")}</span>
            </div>
              <Badge variant="secondary" className="h-5 text-[10px] px-1.5 shrink-0">
                {orchestration.length}
              </Badge>
            </div>
            <div className="max-h-[220px] overflow-y-auto p-2.5 space-y-2">
              {orchestration.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("a2a.cockpit.noOrchestrationEvents")}</p>
              ) : (
                orchestration.map((msg) => {
                  const decision = msg.orchestrationInfo?.masterDecision
                  const phase =
                    decision?.phase === "kickoff"
                      ? t("a2a.cockpit.phaseKickoff")
                      : decision?.phase === "rebalance"
                        ? t("a2a.cockpit.phaseRebalance")
                        : decision?.phase === "assignment"
                          ? t("a2a.cockpit.phaseAssignment")
                          : t("a2a.cockpit.phaseFlow")
                  return (
                    <div key={msg.id} className="rounded-md border bg-muted/20 px-2.5 py-2">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <div className="inline-flex items-center gap-1.5 min-w-0">
                          <Badge variant="outline" className="h-4 text-[9px] px-1.5 shrink-0">
                            {phase}
                          </Badge>
                          <span className="text-[10px] text-muted-foreground truncate">
                            {decision?.assignments?.length
                              ? t("a2a.cockpit.assignmentCount", { count: decision.assignments.length })
                              : t("a2a.cockpit.event")}
                          </span>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">{msg.timestamp}</span>
                      </div>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {shortText(msg.orchestrationInfo?.reason ?? msg.content, 140)}
                      </p>
                    </div>
                  )
                })
              )}
            </div>
          </section>

          <section className="rounded-xl border bg-card overflow-hidden">
            <div className="px-3 py-2 border-b flex items-center justify-between gap-2">
              <div className="inline-flex items-center gap-1.5 min-w-0">
                <Clock3 className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm font-medium truncate">{t("a2a.cockpit.executionBoard")}</span>
              </div>
              <div className="inline-flex items-center gap-1.5">
                <Badge variant="secondary" className="h-5 text-[10px] px-1.5">
                  <User className="h-3 w-3 mr-1" />
                  {activeMembers}
                </Badge>
                <Button size="sm" className="h-6 px-2 text-[10px]" onClick={onOpenWorkspace}>
                  {t("a2a.console.workspace")}
                </Button>
              </div>
            </div>
            <div className="max-h-[420px] overflow-y-auto p-2.5 space-y-2">
              <div className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium inline-flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    {t("a2a.cockpit.responsibilityHeatmap")}
                  </span>
                  <Badge variant="outline" className="h-4 text-[9px] px-1.5">
                    {t("a2a.cockpit.agentCount", { count: heatmap.length })}
                  </Badge>
                </div>
                {heatmap.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.noMembers")}</p>
                ) : (
                  heatmap.map((item) => (
                    <div key={item.memberId} className="rounded border bg-background px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-[10px] font-medium truncate">{item.memberName}</span>
                        <span className="text-[9px] text-muted-foreground shrink-0">
                          {t("a2a.cockpit.loadPrefix")} {item.loadScore}
                        </span>
                      </div>
                      <Progress value={(item.loadScore / maxLoad) * 100} className="h-1.5" />
                      <p className="text-[9px] text-muted-foreground mt-1">
                        {t("a2a.cockpit.groupInProgress")} {item.inProgress}
                        {" | "}
                        {t("a2a.cockpit.groupBlocked")} {item.blocked}
                        {" | "}
                        {t("a2a.cockpit.groupDone")} {item.done}
                      </p>
                    </div>
                  ))
                )}
              </div>

              <div className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium inline-flex items-center gap-1">
                    <ShieldAlert className="h-3.5 w-3.5" />
                    {t("a2a.cockpit.bottleneckRadar")}
                  </span>
                </div>
                {bottlenecks.map((item) => (
                  <div key={item.key} className="rounded border bg-background px-2 py-1.5 flex items-center justify-between gap-2">
                    <span className="text-[10px] truncate">{item.title}</span>
                    <span
                      className={cn(
                        "text-[9px] px-1.5 py-0.5 rounded shrink-0",
                        item.level === "high" && "bg-rose-100 text-rose-700",
                        item.level === "medium" && "bg-amber-100 text-amber-700",
                        item.level === "normal" && "bg-emerald-100 text-emerald-700"
                      )}
                    >
                      {item.detail}
                    </span>
                  </div>
                ))}
              </div>

              <div className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium inline-flex items-center gap-1">
                    <Users className="h-3.5 w-3.5" />
                    {t("a2a.cockpit.agentSwimlanes")}
                  </span>
                  <Badge variant="outline" className="h-4 text-[9px] px-1.5">
                    {agentSwimlanes.length}
                  </Badge>
                </div>
                {agentSwimlanes.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.noActiveLanes")}</p>
                ) : (
                  <div className="space-y-1.5">
                    {agentSwimlanes.slice(0, 5).map((lane) => (
                      <div key={lane.memberId} className="rounded border bg-background px-2 py-1.5 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[10px] font-medium truncate">{lane.memberName}</span>
                          <span className="text-[9px] text-muted-foreground shrink-0">
                            {t("a2a.cockpit.groupInProgress")} {lane.inProgressCount}
                            {" | "}
                            {t("a2a.cockpit.groupBlocked")} {lane.blockedCount}
                          </span>
                        </div>
                        <p className="text-[9px] text-muted-foreground truncate">
                          {lane.tasks.slice(0, 2).map((task) => task.title).join(" | ") || t("a2a.cockpit.noTaskDetails")}
                        </p>
                        {lane.pendingClaims > 0 && (
                          <p className="text-[9px] text-amber-700">
                            {t("a2a.cockpit.pendingClaims", { count: lane.pendingClaims })}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium inline-flex items-center gap-1">
                    <Route className="h-3.5 w-3.5" />
                    {t("a2a.cockpit.collaborationLinks")}
                  </span>
                  <Badge variant="outline" className="h-4 text-[9px] px-1.5">
                    {collaborationLinks.length}
                  </Badge>
                </div>
                {collaborationLinks.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.noRoutingLinks")}</p>
                ) : (
                  <div className="space-y-1.5">
                    {collaborationLinks.slice(0, 6).map((link, idx) => (
                      <div key={`${link.source}-${link.targetId}-${idx}`} className="rounded border bg-background px-2 py-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-[10px] font-medium truncate">
                            {link.source} {"->"} {link.targetName}
                          </p>
                          <Badge variant="secondary" className="h-4 text-[9px] px-1.5">
                            x{link.count}
                          </Badge>
                        </div>
                        <p className="text-[9px] text-muted-foreground truncate">
                          {t("a2a.cockpit.phases")} {[...link.phases]
                            .map((phase) => {
                              if (phase === "kickoff") return t("a2a.cockpit.phaseKickoff")
                              if (phase === "rebalance") return t("a2a.cockpit.phaseRebalance")
                              if (phase === "assignment") return t("a2a.cockpit.phaseAssignment")
                              return t("a2a.cockpit.phaseFlow")
                            })
                            .join(", ")}
                          {link.lastAt ? ` | ${t("a2a.cockpit.lastAt")} ${link.lastAt}` : ""}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {previewPlan && (
                <div className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-medium inline-flex items-center gap-1">
                      <BrainCircuit className="h-3.5 w-3.5" />
                      {t("a2a.cockpit.autoRebalanceSuggestions")}
                    </span>
                    <Badge variant="outline" className="h-4 text-[9px] px-1.5">
                      {previewPlan.assignments.length}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{previewPlan.summary}</p>
                  <div className="space-y-1">
                    {previewPlan.assignments.slice(0, 3).map((assignment, idx) => (
                      <div key={`${assignment.memberId}-${idx}`} className="rounded border bg-background px-2 py-1">
                        <p className="text-[10px] font-medium truncate">
                          {assignment.memberName} {"<-"} {assignment.taskTitle}
                        </p>
                        <p className="text-[9px] text-muted-foreground">
                          {t("a2a.cockpit.scorePrefix")} {assignment.score}
                          {" | "}
                          {t("a2a.cockpit.domainPrefix")} {assignment.taskDomain ?? t("a2a.cockpit.generalDomain")}
                        </p>
                      </div>
                    ))}
                  </div>
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    disabled={rebalancing || previewPlan.assignments.length === 0}
                    onClick={async () => {
                      setRebalancing(true)
                      try {
                        const result = await runEmbeddedMasterRebalance(conversation.id)
                        if (result.ok) {
                          toast.success(t("a2a.cockpit.rebalanceApplied", { count: result.assignmentCount }))
                        } else {
                          toast.info(result.reason)
                        }
                      } finally {
                        setRebalancing(false)
                      }
                    }}
                  >
                    {rebalancing && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
                    {t("a2a.cockpit.applySuggestions")}
                  </Button>
                </div>
              )}

              {taskGroups.map((group) => {
                const groupTasks = tasks.filter((task) => task.status === group.status).slice(0, 3)
                return (
                  <div key={group.status} className="rounded-md border bg-muted/20 px-2.5 py-2 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-medium">{group.title}</span>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "h-4 text-[9px] px-1.5",
                          group.status === "blocked" && "bg-rose-100 text-rose-700",
                          group.status === "done" && "bg-emerald-100 text-emerald-700"
                        )}
                      >
                        {tasks.filter((task) => task.status === group.status).length}
                      </Badge>
                    </div>
                    {groupTasks.length === 0 ? (
                      <p className="text-[10px] text-muted-foreground">{t("a2a.cockpit.noTasks")}</p>
                    ) : (
                      groupTasks.map((task) => (
                        <div key={task.id} className="rounded border bg-background px-2 py-1.5">
                          <p className="text-[10px] font-medium truncate">{task.title}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <Progress value={task.progress} className="h-1.5 flex-1" />
                            <span className="text-[9px] text-muted-foreground w-12 text-right">
                              {statusLabel(task.status)} {task.progress}%
                            </span>
                            {task.status === "blocked" && <TriangleAlert className="h-3 w-3 text-rose-500 shrink-0" />}
                            {task.status === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
