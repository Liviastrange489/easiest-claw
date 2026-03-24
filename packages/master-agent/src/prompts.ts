import type { MasterMember, MasterStalledTaskInput, MasterTaskSnapshot, MasterTerminalUpdate } from "./types"

function formatElapsedMs(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.floor((ms % 60_000) / 1_000)
  if (minutes <= 0) return `${seconds}s`
  return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`
}

export function buildA2AKickoffMessage(params: {
  userRequest: string
  members: MasterMember[]
  coordinatorId: string
}): string {
  const memberLines = params.members
    .filter((member) => member.id !== params.coordinatorId)
    .map((member) => {
      const skills = member.skills && member.skills.length > 0 ? member.skills.join(" | ") : "general"
      return `- ${member.name} (${member.role?.trim() || "agent"}): ${skills}`
    })
    .join("\n")

  return [
    `[A2A coordinator kickoff] User asked: "${params.userRequest}"`,
    "",
    "You are the lead coordinator for this multi-agent group.",
    "You are an orchestrator-only agent: plan, delegate, monitor, unblock.",
    "Do not execute implementation tasks, do not call tools, do not write files.",
    "Team members:",
    memberLines || "- (none)",
    "",
    "Execution policy:",
    "1. Break work into sub-tasks and delegate with: A2A -> @AgentName: task",
    "2. Assign only by role/skills; never ask one agent to do another role's work",
    "3. Let members claim/execute tasks; do not do everything yourself",
    "4. Track task progress and actively unblock stalled tasks",
    "5. If a task stalls, re-plan and re-delegate immediately",
    "",
    "Response format:",
    "- Always include at least one A2A delegation line when work remains",
    "- Use plain summary lines, but task assignment must use A2A -> syntax",
  ].join("\n")
}

export function buildSharedContextSnippet(params: {
  latestUserRequest?: string
  tasks: MasterTaskSnapshot[]
  recentAgentUpdates?: string[]
}): string {
  const taskLines = params.tasks
    .slice(0, 8)
    .map((task) => {
      const owner = task.assigneeId ?? task.pendingAssigneeId ?? "unassigned"
      return `- [${task.id}] ${task.title} | status=${task.status} | owner=${owner} | progress=${task.progress}%`
    })
    .join("\n")

  return [
    "[Team shared context]",
    params.latestUserRequest?.trim()
      ? `Latest user request: ${params.latestUserRequest.trim()}`
      : "Latest user request: (not available)",
    "Recent team updates:",
    ...(params.recentAgentUpdates && params.recentAgentUpdates.length > 0 ? params.recentAgentUpdates : ["- (none)"]),
    "Workspace board snapshot:",
    taskLines || "- (no tasks yet)",
  ].join("\n")
}

export function buildProgressReviewPrompt(params: {
  senderAgentName: string
  terminalUpdates: MasterTerminalUpdate[]
  tasks: MasterTaskSnapshot[]
}): string {
  const updateLines = params.terminalUpdates
    .slice(0, 6)
    .map((item) => {
      const note = item.note?.trim() ? ` | note=${item.note.trim()}` : ""
      return `- [${item.taskId}] ${item.title} | status=${item.status}${note}`
    })
    .join("\n")

  const pending = params.tasks.filter((task) => task.status !== "done")
  const pendingLines = pending
    .slice(0, 8)
    .map((task) => {
      const owner = task.assigneeId ?? task.pendingAssigneeId ?? "unassigned"
      const progress = `${Math.max(0, Math.min(100, task.progress))}%`
      return `- [${task.id}] ${task.title} | status=${task.status} | owner=${owner} | progress=${progress}`
    })
    .join("\n")

  return [
    "[A2A progress sync]",
    `${params.senderAgentName} reported terminal updates. Continue orchestration now.`,
    "",
    "Latest terminal updates:",
    updateLines || "- (none)",
    "",
    `Remaining tasks: ${pending.length}`,
    pendingLines || "- All tasks are done",
    "",
    "Coordinator actions:",
    "1. If tasks remain, delegate next steps with: A2A -> @AgentName: task",
    "2. Reassign blocked items immediately",
    "3. If all tasks are complete, send final summary to user",
  ].join("\n")
}

export function buildStallMonitorPrompt(tasks: MasterStalledTaskInput[]): string {
  const lines = tasks
    .slice(0, 5)
    .map(({ task, staleForMs }) => {
      const assignee = task.assigneeId ?? task.pendingAssigneeId ?? "unassigned"
      const staleFor = formatElapsedMs(staleForMs)
      return `- [${task.id}] ${task.title} | status=${task.status} | owner=${assignee} | no update for ${staleFor}`
    })
    .join("\n")

  return [
    "[A2A monitor alert]",
    "Some tasks appear stalled. Please coordinate immediately.",
    "",
    "Stalled tasks:",
    lines || "- (none)",
    "",
    "Coordinator actions:",
    "1. Ping or reassign owner",
    "2. Split blocked tasks into smaller tasks",
    "3. Use A2A delegation lines to continue execution",
  ].join("\n")
}
