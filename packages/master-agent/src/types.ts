export type MasterTaskDomain = "frontend" | "backend" | "qa" | "docs" | "devops" | "research"

export interface MasterMember {
  id: string
  name: string
  role?: string
  skills?: string[]
}

export interface MasterTaskSnapshot {
  id: string
  title: string
  status: "todo" | "in-progress" | "blocked" | "done"
  progress: number
  assigneeId?: string
  pendingAssigneeId?: string
  createdAt?: string
  updatedAt?: string
}

export interface MasterTerminalUpdate {
  taskId: string
  title: string
  status: "done" | "blocked"
  note?: string
}

export interface MasterStalledTaskInput {
  task: MasterTaskSnapshot
  staleForMs: number
}

export interface AssignmentDecision {
  allowed: boolean
  taskDomain: MasterTaskDomain | null
  memberDomains: MasterTaskDomain[]
  reason?: string
}

export interface MasterPlanAssignment {
  memberId: string
  memberName: string
  taskTitle: string
  taskDescription: string
  reason: string
  intent?: string
  taskId?: string
  score: number
  taskDomain: MasterTaskDomain | null
  memberDomains: MasterTaskDomain[]
}

export interface MasterPlanCandidate {
  memberId: string
  memberName: string
  score: number
  allowed: boolean
  preferred: boolean
  taskDomain: MasterTaskDomain | null
  memberDomains: MasterTaskDomain[]
  reason?: string
}

export interface MasterPlanTaskDiagnostic {
  taskTitle: string
  selectedMemberId?: string
  selectedMemberName?: string
  selectedScore?: number
  candidates: MasterPlanCandidate[]
}

export interface MasterKickoffPlanInput {
  userRequest: string
  members: MasterMember[]
  coordinatorId?: string
  preferredMemberIds?: string[]
  strictRoleMatch?: boolean
  maxAssignments?: number
}

export interface MasterRebalancePlanInput {
  tasks: MasterTaskSnapshot[]
  members: MasterMember[]
  coordinatorId?: string
  strictRoleMatch?: boolean
  maxAssignments?: number
}

export interface MasterPlanResult {
  planType: "kickoff" | "rebalance"
  summary: string
  assignments: MasterPlanAssignment[]
  diagnostics: MasterPlanTaskDiagnostic[]
}
