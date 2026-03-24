import { BrainCircuit, CalendarClock, CheckCircle2, FolderOpen, Plus, Search, TriangleAlert, User } from "lucide-react"
import { useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { cn } from "@/lib/utils"
import { useApp } from "@/store/app-context"
import type {
  Conversation,
  GroupTaskPriority,
  GroupTaskStatus,
  GroupWorkspaceTask,
  MasterDecisionTrace,
  Message,
} from "@/types"

interface GroupWorkspacePanelProps {
  conversation: Conversation
  open: boolean
  onOpenChange: (open: boolean) => void
}

const STATUS_OPTIONS: Array<{ value: GroupTaskStatus; label: string }> = [
  { value: "todo", label: "Todo" },
  { value: "in-progress", label: "In Progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
]

const PRIORITY_OPTIONS: Array<{ value: GroupTaskPriority; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
]

const priorityBadgeClass: Record<GroupTaskPriority, string> = {
  low: "bg-slate-100 text-slate-700 dark:bg-slate-900/60 dark:text-slate-300",
  medium: "bg-blue-100 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300",
  high: "bg-orange-100 text-orange-700 dark:bg-orange-900/60 dark:text-orange-300",
  urgent: "bg-rose-100 text-rose-700 dark:bg-rose-900/60 dark:text-rose-300",
}

function statusLabel(status: GroupTaskStatus): string {
  return STATUS_OPTIONS.find((item) => item.value === status)?.label ?? status
}

function priorityLabel(priority: GroupTaskPriority): string {
  return PRIORITY_OPTIONS.find((item) => item.value === priority)?.label ?? priority
}

function isOverdue(task: GroupWorkspaceTask): boolean {
  if (!task.dueAt || task.status === "done") return false
  const dueAt = new Date(`${task.dueAt}T23:59:59`)
  if (Number.isNaN(dueAt.getTime())) return false
  return dueAt.getTime() < Date.now()
}

function sortTasks(tasks: GroupWorkspaceTask[]): GroupWorkspaceTask[] {
  return [...tasks].sort((a, b) => {
    const priorityRank: Record<GroupTaskPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1 }
    const rankDelta = priorityRank[b.priority ?? "medium"] - priorityRank[a.priority ?? "medium"]
    if (rankDelta !== 0) return rankDelta
    if (a.status !== b.status) {
      const statusRank: Record<GroupTaskStatus, number> = { blocked: 4, "in-progress": 3, todo: 2, done: 1 }
      return statusRank[b.status] - statusRank[a.status]
    }
    return b.updatedAt.localeCompare(a.updatedAt)
  })
}

export function GroupWorkspacePanel({ conversation, open, onOpenChange }: GroupWorkspacePanelProps) {
  const { dispatch, state } = useApp()

  const [title, setTitle] = useState("")
  const [assigneeId, setAssigneeId] = useState<string>("__unassigned__")
  const [newPriority, setNewPriority] = useState<GroupTaskPriority>("medium")
  const [newDueAt, setNewDueAt] = useState("")

  const [query, setQuery] = useState("")
  const [filterStatus, setFilterStatus] = useState<string>("__all__")
  const [filterPriority, setFilterPriority] = useState<string>("__all__")
  const [filterAssignee, setFilterAssignee] = useState<string>("__all__")
  const [viewMode, setViewMode] = useState<"list" | "board" | "master">("list")

  const tasks = conversation.workspaceTasks ?? []
  const memberIds = conversation.members.filter((id) => id !== "user")
  const members = memberIds
    .map((id) => state.agents.find((agent) => agent.id === id))
    .filter((agent): agent is NonNullable<typeof agent> => agent != null)
  const coordinator = conversation.orchestration?.coordinatorId
    ? state.agents.find((agent) => agent.id === conversation.orchestration?.coordinatorId)
    : null

  const filteredTasks = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sortTasks(tasks).filter((task) => {
      if (filterStatus !== "__all__" && task.status !== filterStatus) return false
      if (filterPriority !== "__all__" && (task.priority ?? "medium") !== filterPriority) return false
      if (filterAssignee !== "__all__" && (task.assigneeId ?? "__unassigned__") !== filterAssignee) return false
      if (!q) return true
      const assignee = task.assigneeId
        ? (state.agents.find((agent) => agent.id === task.assigneeId)?.name ?? "")
        : ""
      return (
        task.title.toLowerCase().includes(q)
        || (task.description ?? "").toLowerCase().includes(q)
        || (task.lastNote ?? "").toLowerCase().includes(q)
        || assignee.toLowerCase().includes(q)
      )
    })
  }, [filterAssignee, filterPriority, filterStatus, query, state.agents, tasks])

  const total = tasks.length
  const done = tasks.filter((task) => task.status === "done").length
  const blocked = tasks.filter((task) => task.status === "blocked").length
  const overdue = tasks.filter((task) => isOverdue(task)).length
  const avgProgress = total > 0 ? Math.round(tasks.reduce((sum, task) => sum + task.progress, 0) / total) : 0

  const handleAddTask = () => {
    const trimmed = title.trim()
    if (!trimmed) return
    const now = new Date().toISOString()
    const task: GroupWorkspaceTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: trimmed,
      assigneeId: assigneeId === "__unassigned__" ? undefined : assigneeId,
      status: "todo",
      progress: 0,
      priority: newPriority,
      dueAt: newDueAt || undefined,
      blockedReason: undefined,
      lastNote: undefined,
      source: "manual",
      createdAt: now,
      updatedAt: now,
    }
    dispatch({
      type: "ADD_GROUP_TASK",
      payload: { conversationId: conversation.id, task },
    })
    setTitle("")
    setAssigneeId("__unassigned__")
    setNewPriority("medium")
    setNewDueAt("")
  }

  const patchTask = (
    taskId: string,
    patch: Partial<
      Pick<GroupWorkspaceTask, "status" | "progress" | "assigneeId" | "pendingAssigneeId" | "pendingClaimAt" | "claimDeadlineAt" | "title" | "priority" | "dueAt" | "blockedReason" | "lastNote">
    >
  ) => {
    dispatch({
      type: "UPDATE_GROUP_TASK",
      payload: {
        conversationId: conversation.id,
        taskId,
        patch: {
          ...patch,
          updatedAt: new Date().toISOString(),
        },
      },
    })
  }

  const boardGroups = useMemo(
    () => [
      { id: "__unassigned__", name: "Unassigned" },
      ...members.map((member) => ({ id: member.id, name: member.name })),
    ],
    [members]
  )

  const masterDecisionMessages = useMemo(
    () =>
      (state.messages[conversation.id] ?? [])
        .filter(
          (message): message is Message =>
            message.type === "orchestration"
            && message.orchestrationInfo?.masterDecision?.engine === "embedded-master"
        )
        .slice(-12)
        .reverse(),
    [state.messages, conversation.id]
  )

  const formatMasterPhase = (decision: MasterDecisionTrace): string => {
    if (decision.phase === "kickoff") return "Kickoff"
    if (decision.phase === "rebalance") return "Rebalance"
    return "Assignment"
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[440px] sm:w-[520px] p-0 flex flex-col gap-0">
        <SheetHeader className="px-4 pt-5 pb-4 border-b shrink-0 space-y-2">
          <SheetTitle className="text-base">Team Workspace</SheetTitle>
          {conversation.orchestration?.strategy === "a2a" && (
            <p className="text-[11px] text-muted-foreground">
              Master mode: {conversation.orchestration?.masterMode === "openclaw-coordinator" ? "OpenClaw Coordinator" : "Embedded Master"}
              {conversation.orchestration?.masterMode === "openclaw-coordinator" && (
                <> | Coordinator: {coordinator?.name ?? conversation.orchestration?.coordinatorId ?? "not set"}</>
              )}
            </p>
          )}
          {conversation.workspacePath && (
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-mono">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate" title={conversation.workspacePath}>{conversation.workspacePath}</span>
            </div>
          )}
          <div className="grid grid-cols-5 gap-2 pt-1">
            <div className="rounded-lg border bg-muted/30 p-2">
              <p className="text-[10px] text-muted-foreground">Tasks</p>
              <p className="text-sm font-semibold">{total}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <p className="text-[10px] text-muted-foreground">Done</p>
              <p className="text-sm font-semibold">{done}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <p className="text-[10px] text-muted-foreground">Blocked</p>
              <p className="text-sm font-semibold">{blocked}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <p className="text-[10px] text-muted-foreground">Overdue</p>
              <p className="text-sm font-semibold">{overdue}</p>
            </div>
            <div className="rounded-lg border bg-muted/30 p-2">
              <p className="text-[10px] text-muted-foreground">Progress</p>
              <p className="text-sm font-semibold">{avgProgress}%</p>
            </div>
          </div>
        </SheetHeader>

        <div className="p-3 border-b space-y-2 shrink-0">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Add a shared task..."
          />
          <div className="grid grid-cols-4 gap-2">
            <Select value={assigneeId} onValueChange={setAssigneeId}>
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue placeholder="Assign" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassigned__">Unassigned</SelectItem>
                {members.map((member) => (
                  <SelectItem key={member.id} value={member.id}>
                    {member.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={newPriority} onValueChange={(value) => setNewPriority(value as GroupTaskPriority)}>
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRIORITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="date"
              value={newDueAt}
              onChange={(event) => setNewDueAt(event.target.value)}
              className="h-8 text-xs"
            />
            <Button size="sm" onClick={handleAddTask} disabled={!title.trim()}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Claim commands in chat: `确认认领 taskId` / `拒绝认领 taskId` (or `/claim approve|reject taskId`).
          </p>
        </div>

        <div className="p-3 border-b space-y-2 shrink-0">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search task / assignee / note..."
              className="pl-8"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Select value={filterStatus} onValueChange={setFilterStatus}>
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All status</SelectItem>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterPriority} onValueChange={setFilterPriority}>
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All priority</SelectItem>
                {PRIORITY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterAssignee} onValueChange={setFilterAssignee}>
              <SelectTrigger size="sm" className="text-xs">
                <SelectValue placeholder="Assignee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All assignees</SelectItem>
                <SelectItem value="__unassigned__">Unassigned</SelectItem>
                {members.map((member) => (
                  <SelectItem key={member.id} value={member.id}>{member.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden p-3">
          <Tabs value={viewMode} onValueChange={(value) => setViewMode(value as "list" | "board" | "master")} className="h-full min-h-0">
            <TabsList className="w-full grid grid-cols-3">
              <TabsTrigger value="list">Task List</TabsTrigger>
              <TabsTrigger value="board">By Agent Board</TabsTrigger>
              <TabsTrigger value="master">Master Decisions</TabsTrigger>
            </TabsList>

            <TabsContent value="list" className="h-[calc(100%-2.5rem)] mt-2 overflow-y-auto pr-1 space-y-2">
              {filteredTasks.length === 0 ? (
                <div className="h-full min-h-[160px] rounded-lg border border-dashed text-center flex items-center justify-center p-4">
                  <p className="text-xs text-muted-foreground">No matching tasks.</p>
                </div>
              ) : (
                filteredTasks.map((task) => {
                  const assignee = task.assigneeId
                    ? state.agents.find((agent) => agent.id === task.assigneeId)
                    : null
                  const pendingAssignee = task.pendingAssigneeId
                    ? state.agents.find((agent) => agent.id === task.pendingAssigneeId)
                    : null
                  const overdueState = isOverdue(task)
                  return (
                    <div key={task.id} className="rounded-lg border p-2.5 space-y-2 bg-card">
                      <div className="flex items-center gap-2">
                        <Input
                          value={task.title}
                          onChange={(event) => patchTask(task.id, { title: event.target.value })}
                          className="h-8 text-sm"
                        />
                      </div>

                      <div className="grid grid-cols-4 gap-2">
                        <Select
                          value={task.assigneeId ?? "__unassigned__"}
                          onValueChange={(value) =>
                            patchTask(task.id, { assigneeId: value === "__unassigned__" ? undefined : value })
                          }
                        >
                          <SelectTrigger size="sm" className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__unassigned__">Unassigned</SelectItem>
                            {members.map((member) => (
                              <SelectItem key={member.id} value={member.id}>
                                {member.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          value={task.status}
                          onValueChange={(value) => {
                            const status = value as GroupTaskStatus
                            const progress = status === "done" ? 100 : task.progress
                            patchTask(task.id, {
                              status,
                              progress,
                              blockedReason: status === "blocked" ? task.blockedReason : undefined,
                            })
                          }}
                        >
                          <SelectTrigger size="sm" className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          value={task.priority ?? "medium"}
                          onValueChange={(value) => patchTask(task.id, { priority: value as GroupTaskPriority })}
                        >
                          <SelectTrigger size="sm" className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PRIORITY_OPTIONS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Input
                          type="date"
                          value={task.dueAt ?? ""}
                          onChange={(event) => patchTask(task.id, { dueAt: event.target.value || undefined })}
                          className="h-7 text-xs"
                        />
                      </div>

                      <div className="flex items-center gap-2">
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={task.progress}
                          onChange={(event) => {
                            const numeric = Number(event.target.value)
                            const progress = Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0
                            patchTask(task.id, { progress, status: progress >= 100 ? "done" : task.status })
                          }}
                          className="h-7 text-xs w-20"
                        />
                        <div className="h-1.5 rounded-full bg-muted flex-1 overflow-hidden">
                          <div className="h-full bg-primary transition-all" style={{ width: `${task.progress}%` }} />
                        </div>
                        <span className="text-[11px] text-muted-foreground tabular-nums w-10 text-right">
                          {task.progress}%
                        </span>
                      </div>

                      {task.status === "blocked" && (
                        <Input
                          value={task.blockedReason ?? ""}
                          onChange={(event) => patchTask(task.id, { blockedReason: event.target.value || undefined })}
                          placeholder="Blocked reason..."
                          className="h-7 text-xs"
                        />
                      )}

                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <div className="flex items-center gap-1.5">
                          <Badge variant="secondary" className="h-5 text-[10px] px-1.5">
                            {statusLabel(task.status)}
                          </Badge>
                          <Badge
                            variant="secondary"
                            className={cn("h-5 text-[10px] px-1.5", priorityBadgeClass[task.priority ?? "medium"])}
                          >
                            {priorityLabel(task.priority ?? "medium")}
                          </Badge>
                          {task.source === "a2a" && (
                            <Badge variant="outline" className="h-5 text-[10px] px-1.5">
                              <CheckCircle2 className="h-3 w-3 mr-1" />
                              A2A
                            </Badge>
                          )}
                          {task.pendingAssigneeId && (
                            <Badge variant="outline" className="h-5 text-[10px] px-1.5 border-amber-300 text-amber-700">
                              Pending claim
                            </Badge>
                          )}
                          {assignee && (
                            <span className="truncate max-w-[90px]" title={assignee.name}>{assignee.name}</span>
                          )}
                          {!assignee && (
                            <span className="inline-flex items-center gap-1">
                              <User className="h-3 w-3" />
                              Unassigned
                            </span>
                          )}
                        </div>
                        <div className="inline-flex items-center gap-2">
                          {pendingAssignee && (
                            <span className="inline-flex items-center gap-1 text-amber-700">
                              <User className="h-3 w-3" />
                              {`Pending: ${pendingAssignee.name}`}
                            </span>
                          )}
                          {task.claimDeadlineAt && (
                            <span className="inline-flex items-center gap-1 text-amber-700">
                              <CalendarClock className="h-3 w-3" />
                              {`Auto in ${new Date(task.claimDeadlineAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`}
                            </span>
                          )}
                          {overdueState && (
                            <span className="inline-flex items-center gap-1 text-rose-600">
                              <TriangleAlert className="h-3 w-3" />
                              Overdue
                            </span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="h-3 w-3" />
                            {task.dueAt ?? "No deadline"}
                          </span>
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </TabsContent>

            <TabsContent value="board" className="h-[calc(100%-2.5rem)] mt-2 overflow-x-auto overflow-y-hidden">
              <div className="flex gap-3 min-w-max h-full pb-1">
                {boardGroups.map((group) => {
                  const groupTasks = sortTasks(
                    filteredTasks.filter((task) => (task.assigneeId ?? "__unassigned__") === group.id)
                  )
                  return (
                    <div key={group.id} className="w-[220px] h-full rounded-lg border bg-muted/20 p-2 flex flex-col">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-xs font-medium truncate">{group.name}</p>
                        <Badge variant="secondary" className="text-[10px] h-5 px-1.5">{groupTasks.length}</Badge>
                      </div>
                      <div className="space-y-2 overflow-y-auto pr-1">
                        {groupTasks.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground px-1 py-2">No tasks</p>
                        ) : (
                          groupTasks.map((task) => (
                            <div key={task.id} className="rounded-md border bg-background p-2 space-y-1.5">
                              <p className="text-xs font-medium line-clamp-2">{task.title}</p>
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <Badge variant="secondary" className="h-4 text-[9px] px-1.5">
                                  {statusLabel(task.status)}
                                </Badge>
                                <Badge
                                  variant="secondary"
                                  className={cn("h-4 text-[9px] px-1.5", priorityBadgeClass[task.priority ?? "medium"])}
                                >
                                  {priorityLabel(task.priority ?? "medium")}
                                </Badge>
                                {task.source === "a2a" && (
                                  <Badge variant="outline" className="h-4 text-[9px] px-1.5">A2A</Badge>
                                )}
                                {task.pendingAssigneeId && (
                                  <Badge variant="outline" className="h-4 text-[9px] px-1.5 border-amber-300 text-amber-700">
                                    Pending
                                  </Badge>
                                )}
                              </div>
                              <div className="h-1 rounded-full bg-muted overflow-hidden">
                                <div className="h-full bg-primary" style={{ width: `${task.progress}%` }} />
                              </div>
                              <p className="text-[10px] text-muted-foreground">
                                {task.dueAt ? `Due ${task.dueAt}` : "No deadline"}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </TabsContent>

            <TabsContent value="master" className="h-[calc(100%-2.5rem)] mt-2 overflow-y-auto pr-1 space-y-2">
              {masterDecisionMessages.length === 0 ? (
                <div className="h-full min-h-[160px] rounded-lg border border-dashed text-center flex items-center justify-center p-4">
                  <p className="text-xs text-muted-foreground">No embedded master decisions yet.</p>
                </div>
              ) : (
                masterDecisionMessages.map((message) => {
                  const decision = message.orchestrationInfo?.masterDecision
                  if (!decision) return null
                  return (
                    <div key={message.id} className="rounded-lg border bg-card p-2.5 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="inline-flex items-center gap-1.5 min-w-0">
                          <BrainCircuit className="h-3.5 w-3.5 text-primary shrink-0" />
                          <span className="text-xs font-medium truncate">
                            {formatMasterPhase(decision)}
                          </span>
                        </div>
                        <span className="text-[10px] text-muted-foreground">{message.timestamp}</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed">{decision.summary}</p>

                      {decision.assignments && decision.assignments.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[11px] font-medium">Assignments</p>
                          <div className="space-y-1">
                            {decision.assignments.map((assignment, idx) => (
                              <div key={`${message.id}-${assignment.memberId}-${idx}`} className="rounded-md border bg-muted/30 px-2 py-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-[11px] font-medium truncate">
                                    {assignment.memberName} {"<-"} {assignment.taskTitle}
                                  </span>
                                  <span className="text-[10px] text-muted-foreground shrink-0">
                                    score {assignment.score}
                                  </span>
                                </div>
                                <p className="text-[10px] text-muted-foreground truncate">
                                  domain={assignment.taskDomain ?? "general"} | skills={assignment.memberDomains.join(", ") || "general"}
                                </p>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {decision.diagnostics && decision.diagnostics.length > 0 && (
                        <div className="space-y-1.5">
                          <p className="text-[11px] font-medium">Candidate Scores</p>
                          <div className="space-y-1">
                            {decision.diagnostics.slice(0, 3).map((diag, idx) => (
                              <div key={`${message.id}-diag-${idx}`} className="rounded-md border bg-muted/20 px-2 py-1.5 space-y-1">
                                <p className="text-[10px] font-medium truncate">{diag.taskTitle}</p>
                                <div className="flex flex-wrap gap-1">
                                  {diag.candidates.slice(0, 3).map((candidate) => (
                                    <Badge
                                      key={`${message.id}-${idx}-${candidate.memberId}`}
                                      variant={candidate.allowed ? "secondary" : "outline"}
                                      className="h-5 text-[10px] px-1.5"
                                    >
                                      {candidate.memberName}:{candidate.score}
                                    </Badge>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  )
}
