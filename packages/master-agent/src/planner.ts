import { detectTaskDomain, evaluateAssignment } from "./policy"
import type {
  MasterPlanCandidate,
  MasterTaskDomain,
  MasterKickoffPlanInput,
  MasterMember,
  MasterPlanAssignment,
  MasterPlanTaskDiagnostic,
  MasterPlanResult,
  MasterRebalancePlanInput,
  MasterTaskSnapshot,
} from "./types"

function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim()
}

function buildTaskTitle(text: string, fallback: string): string {
  const normalized = normalizeText(text)
  if (!normalized) return fallback
  return normalized.slice(0, 80)
}

function memberPool(input: { members: MasterMember[]; coordinatorId?: string }): MasterMember[] {
  return input.members.filter((member) => member.id !== input.coordinatorId)
}

function rankCandidates(params: {
  taskText: string
  members: MasterMember[]
  strictRoleMatch?: boolean
  preferredMemberIds?: string[]
  excludeMemberIds?: Set<string>
}): MasterPlanCandidate[] {
  const preferred = new Set(params.preferredMemberIds ?? [])
  const exclude = params.excludeMemberIds ?? new Set<string>()

  return params.members
    .filter((member) => !exclude.has(member.id))
    .map((member) => {
      const decision = evaluateAssignment({
        taskText: params.taskText,
        member,
        strictRoleMatch: params.strictRoleMatch,
      })
      const taskDomain = decision.taskDomain
      const memberText = `${member.name} ${member.role ?? ""}`.toLowerCase()
      const likelyCoordinatorRole =
        memberText.includes("manager")
        || memberText.includes("coordinator")
        || memberText.includes("\u7ecf\u7406")
        || memberText.includes("\u534f\u8c03")
      const engineeringDomain =
        taskDomain === "frontend"
        || taskDomain === "backend"
        || taskDomain === "devops"
        || taskDomain === "qa"
      const unknownDomainPenalty = taskDomain && decision.memberDomains.length === 0 ? 45 : 0
      const coordinatorPenalty = taskDomain && engineeringDomain && likelyCoordinatorRole ? 30 : 0
      const score =
        (decision.allowed ? 100 : -1000)
        + (taskDomain && decision.memberDomains.includes(taskDomain) ? 55 : 0)
        + (preferred.has(member.id) ? 30 : 0)
        + Math.min((member.skills ?? []).length, 5)
        - unknownDomainPenalty
        - coordinatorPenalty
      return {
        memberId: member.id,
        memberName: member.name,
        score,
        allowed: decision.allowed,
        preferred: preferred.has(member.id),
        taskDomain: decision.taskDomain,
        memberDomains: decision.memberDomains,
        reason: decision.reason,
      }
    })
    .sort((a, b) => b.score - a.score)
}

function pickBestCandidate(ranked: MasterPlanCandidate[]): MasterPlanCandidate | null {
  const top = ranked[0]
  if (!top || !top.allowed) return null
  return top
}

function toAssignment(params: {
  candidate: MasterPlanCandidate
  taskTitle: string
  taskDescription: string
  reason: string
  intent?: string
  taskId?: string
}): MasterPlanAssignment {
  return {
    memberId: params.candidate.memberId,
    memberName: params.candidate.memberName,
    taskTitle: params.taskTitle,
    taskDescription: params.taskDescription,
    reason: params.reason,
    intent: params.intent,
    taskId: params.taskId,
    score: params.candidate.score,
    taskDomain: params.candidate.taskDomain,
    memberDomains: params.candidate.memberDomains,
  }
}

interface KickoffWorkItem {
  key: string
  taskTitle: string
  taskDescription: string
  taskText: string
  reason: string
  intent: string
}

function buildWorkItemForDomain(params: {
  domain: MasterTaskDomain
  baseTitle: string
  request: string
}): KickoffWorkItem {
  const { domain, baseTitle, request } = params
  if (domain === "frontend") {
    return {
      key: "frontend",
      taskTitle: `\u524d\u7aef\u5b9e\u73b0\uff1a${baseTitle}`,
      taskDescription: `\u805a\u7126\u9875\u9762\u4ea4\u4e92\u4e0e\u4e3b\u6d41\u6d4f\u89c8\u5668\u53ef\u7528\u6027\uff0c\u4ea7\u51fa\u53ef\u8fd0\u884c\u7684\u524d\u7aef\u6210\u679c\u3002\n\u539f\u59cb\u9700\u6c42\uff1a${request}`,
      taskText: `frontend ui implement ${request}`,
      reason: "\u6309\u89d2\u8272\u5339\u914d\u7684\u524d\u7aef\u5b50\u4efb\u52a1\u3002",
      intent: "delegate",
    }
  }
  if (domain === "backend") {
    return {
      key: "backend",
      taskTitle: `\u540e\u7aef\u63a5\u53e3\uff1a${baseTitle}`,
      taskDescription: `\u8bbe\u8ba1\u5e76\u5b9e\u73b0 API/\u6570\u636e\u5b58\u50a8\u80fd\u529b\uff0c\u4fdd\u8bc1\u524d\u540e\u7aef\u534f\u4f5c\u53ef\u843d\u5730\u3002\n\u539f\u59cb\u9700\u6c42\uff1a${request}`,
      taskText: `backend api database implement ${request}`,
      reason: "\u6309\u89d2\u8272\u5339\u914d\u7684\u540e\u7aef\u5b50\u4efb\u52a1\u3002",
      intent: "delegate",
    }
  }
  if (domain === "qa") {
    return {
      key: "qa",
      taskTitle: `\u6d4b\u8bd5\u9a8c\u6536\uff1a${baseTitle}`,
      taskDescription: `\u7f16\u5199\u6d4b\u8bd5\u6e05\u5355\u5e76\u5b8c\u6210\u6838\u5fc3\u573a\u666f\u9a8c\u8bc1\uff0c\u8f93\u51fa\u98ce\u9669\u4e0e\u9a8c\u6536\u7ed3\u679c\u3002\n\u539f\u59cb\u9700\u6c42\uff1a${request}`,
      taskText: `qa test verification ${request}`,
      reason: "\u8865\u5145\u6d4b\u8bd5/\u9a8c\u6536\u5b50\u4efb\u52a1\u3002",
      intent: "delegate",
    }
  }
  if (domain === "docs") {
    return {
      key: "docs",
      taskTitle: `\u9700\u6c42\u6587\u6863\uff1a${baseTitle}`,
      taskDescription: `\u6574\u7406\u9700\u6c42\u8303\u56f4\u3001\u4ea4\u4ed8\u6807\u51c6\u4e0e\u540c\u6b65\u8bf4\u660e\uff0c\u4fdd\u8bc1\u56e2\u961f\u5bf9\u9f50\u3002\n\u539f\u59cb\u9700\u6c42\uff1a${request}`,
      taskText: `docs prd specification ${request}`,
      reason: "\u8865\u5145\u6587\u6863\u4e0e\u5bf9\u9f50\u5b50\u4efb\u52a1\u3002",
      intent: "delegate",
    }
  }
  if (domain === "devops") {
    return {
      key: "devops",
      taskTitle: `\u90e8\u7f72\u8fd0\u884c\uff1a${baseTitle}`,
      taskDescription: `\u5904\u7406\u542f\u52a8/\u90e8\u7f72\u8def\u5f84\uff0c\u786e\u4fdd\u80fd\u7a33\u5b9a\u8fd0\u884c\u4e0e\u56de\u6eda\u3002\n\u539f\u59cb\u9700\u6c42\uff1a${request}`,
      taskText: `devops deployment runtime ${request}`,
      reason: "\u8865\u5145\u90e8\u7f72\u4ea4\u4ed8\u5b50\u4efb\u52a1\u3002",
      intent: "delegate",
    }
  }
  return {
    key: "research",
    taskTitle: `\u65b9\u6848\u8c03\u7814\uff1a${baseTitle}`,
    taskDescription: `\u8c03\u7814\u53ef\u884c\u65b9\u6848\u3001\u7ea6\u675f\u4e0e\u98ce\u9669\uff0c\u8f93\u51fa\u6267\u884c\u5efa\u8bae\u3002\n\u539f\u59cb\u9700\u6c42\uff1a${request}`,
    taskText: `research analysis plan ${request}`,
    reason: "\u8865\u5145\u8c03\u7814/\u5206\u6790\u5b50\u4efb\u52a1\u3002",
    intent: "delegate",
  }
}

function looksLikeBuildRequest(text: string): boolean {
  const content = text.toLowerCase()
  return [
    "web",
    "app",
    "ui",
    "frontend",
    "backend",
    "api",
    "\u524d\u7aef",
    "\u540e\u7aef",
    "\u9875\u9762",
    "\u7cfb\u7edf",
    "\u529f\u80fd",
    "\u5b9e\u73b0",
    "\u5f00\u53d1",
  ].some((token) => content.includes(token))
}

function buildKickoffWorkItems(input: MasterKickoffPlanInput, maxAssignments: number): KickoffWorkItem[] {
  const request = normalizeText(input.userRequest)
  const baseTitle = buildTaskTitle(input.userRequest, "User request")
  const requestDomain = detectTaskDomain(request)
  const items: KickoffWorkItem[] = []
  const used = new Set<string>()

  const pushDomainItem = (domain: MasterTaskDomain) => {
    const item = buildWorkItemForDomain({ domain, baseTitle, request })
    if (used.has(item.key)) return
    used.add(item.key)
    items.push(item)
  }

  if (requestDomain) {
    pushDomainItem(requestDomain)
  } else {
    items.push({
      key: "primary",
      taskTitle: baseTitle,
      taskDescription: request,
      taskText: request,
      reason: "\u4e3b\u8d23\u4efb\u4eba\u5148\u6267\u884c\u6838\u5fc3\u9700\u6c42\u3002",
      intent: "delegate",
    })
    used.add("primary")
  }

  if (maxAssignments > items.length && looksLikeBuildRequest(request)) {
    for (const domain of ["frontend", "backend", "qa", "docs"] as MasterTaskDomain[]) {
      pushDomainItem(domain)
      if (items.length >= maxAssignments) break
    }
  }

  while (items.length < maxAssignments) {
    const idx = items.length + 1
    items.push({
      key: `support-${idx}`,
      taskTitle: `\u534f\u4f5c\u652f\u63f4 ${idx}\uff1a${baseTitle}`,
      taskDescription: `${request}\n\u8bf7\u8865\u5145\u8fdb\u5ea6\u76d1\u63a7\u6216\u4ea4\u4ed8\u652f\u63f4\uff0c\u907f\u514d\u4e0e\u5df2\u5206\u914d\u5185\u5bb9\u91cd\u590d\u3002`,
      taskText: `support coordination ${request}`,
      reason: "\u5e76\u884c\u534f\u4f5c\u652f\u63f4\u4efb\u52a1\u3002",
      intent: "delegate",
    })
  }

  return items.slice(0, maxAssignments)
}

export function planKickoffAssignments(input: MasterKickoffPlanInput): MasterPlanResult {
  const candidates = memberPool(input)
  if (candidates.length === 0) {
    return {
      planType: "kickoff",
      summary: "Embedded master found no available worker members.",
      assignments: [],
      diagnostics: [],
    }
  }

  const maxAssignments = Math.max(1, Math.min(input.maxAssignments ?? 2, candidates.length))
  const workItems = buildKickoffWorkItems(input, maxAssignments)
  const picked = new Set<string>()
  const assignments: MasterPlanAssignment[] = []
  const diagnostics: MasterPlanTaskDiagnostic[] = []

  for (let i = 0; i < workItems.length; i += 1) {
    const work = workItems[i]
    const ranked = rankCandidates({
      taskText: work.taskText,
      members: candidates,
      strictRoleMatch: input.strictRoleMatch,
      preferredMemberIds: input.preferredMemberIds,
      excludeMemberIds: picked,
    })
    const selected = pickBestCandidate(ranked)
    diagnostics.push({
      taskTitle: work.taskTitle,
      selectedMemberId: selected?.memberId,
      selectedMemberName: selected?.memberName,
      selectedScore: selected?.score,
      candidates: ranked.slice(0, 5),
    })
    if (!selected) break
    picked.add(selected.memberId)
    assignments.push(
      toAssignment({
        candidate: selected,
        taskTitle: work.taskTitle,
        taskDescription: work.taskDescription,
        reason: work.reason,
        intent: work.intent,
      })
    )
  }

  if (assignments.length === 0) {
    return {
      planType: "kickoff",
      summary: "Embedded master could not find a role-matched worker for this request.",
      assignments: [],
      diagnostics,
    }
  }

  const memberNames = assignments.map((item) => item.memberName).join(", ")
  return {
    planType: "kickoff",
    summary: `Embedded master planned ${assignments.length} assignment(s): ${memberNames}.`,
    assignments,
    diagnostics,
  }
}

function isActionableTask(task: MasterTaskSnapshot): boolean {
  if (task.status === "done") return false
  if (task.status === "blocked") return true
  if (!task.assigneeId && !task.pendingAssigneeId) return true
  return false
}

function taskText(task: MasterTaskSnapshot): string {
  return `${task.title} ${task.status}`.trim()
}

export function planRebalanceAssignments(input: MasterRebalancePlanInput): MasterPlanResult {
  const candidates = memberPool(input)
  if (candidates.length === 0) {
    return {
      planType: "rebalance",
      summary: "Embedded master found no available workers for rebalancing.",
      assignments: [],
      diagnostics: [],
    }
  }

  const actionableTasks = input.tasks.filter(isActionableTask)
  if (actionableTasks.length === 0) {
    return {
      planType: "rebalance",
      summary: "Embedded master found no blocked/unassigned tasks to rebalance.",
      assignments: [],
      diagnostics: [],
    }
  }

  const maxAssignments = Math.max(1, Math.min(input.maxAssignments ?? 3, actionableTasks.length))
  const assignments: MasterPlanAssignment[] = []
  const diagnostics: MasterPlanTaskDiagnostic[] = []

  for (const task of actionableTasks.slice(0, maxAssignments)) {
    const preferred = task.pendingAssigneeId ?? task.assigneeId
    const ranked = rankCandidates({
      taskText: taskText(task),
      members: candidates,
      strictRoleMatch: input.strictRoleMatch,
      preferredMemberIds: preferred ? [preferred] : undefined,
    })
    const selected = pickBestCandidate(ranked)
    diagnostics.push({
      taskTitle: task.title,
      selectedMemberId: selected?.memberId,
      selectedMemberName: selected?.memberName,
      selectedScore: selected?.score,
      candidates: ranked.slice(0, 5),
    })
    if (!selected) continue

    assignments.push(
      toAssignment({
        candidate: selected,
        taskTitle: task.title,
        taskDescription: `Continue task "${task.title}" and report A2A STATUS updates.`,
        reason:
          task.status === "blocked"
            ? "Task is blocked and needs active unblock/reassignment."
            : "Task has no clear owner and requires assignment.",
        intent: "rebalance",
        taskId: task.id,
      })
    )
  }

  const summary =
    assignments.length > 0
      ? `Embedded master generated ${assignments.length} rebalance assignment(s).`
      : "Embedded master could not find suitable role-matched assignees for rebalance."

  return { planType: "rebalance", summary, assignments, diagnostics }
}

export function taskSnapshotsFromGroupTasks(tasks: MasterTaskSnapshot[]): MasterTaskSnapshot[] {
  return tasks.map((task) => ({ ...task }))
}
