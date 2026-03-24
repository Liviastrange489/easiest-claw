export type AgentStatus = "idle" | "working" | "busy" | "chatting" | "thinking" | "completed"

export type OrchestrationStrategy = "all" | "skill-match" | "coordinator" | "round-robin" | "a2a"
export type A2AMasterMode = "embedded-master" | "openclaw-coordinator"

export interface GroupOrchestration {
  strategy: OrchestrationStrategy
  coordinatorId?: string
  maxResponders?: number
  roundRobinIndex?: number
  a2aStrictRoleMatch?: boolean
  masterMode?: A2AMasterMode
  pendingKickoffPlan?: PendingKickoffPlanMeta
}

export interface PendingKickoffPlanAssignment {
  memberId: string
  memberName: string
  taskTitle: string
  taskDomain: string | null
}

export interface PendingKickoffPlanMeta {
  createdAt: string
  summary: string
  assignments: PendingKickoffPlanAssignment[]
}

export type GroupTaskStatus = "todo" | "in-progress" | "blocked" | "done"
export type GroupTaskPriority = "low" | "medium" | "high" | "urgent"

export interface GroupWorkspaceTask {
  id: string
  title: string
  description?: string
  assigneeId?: string
  pendingAssigneeId?: string
  pendingClaimAt?: string
  claimDeadlineAt?: string
  status: GroupTaskStatus
  progress: number
  priority?: GroupTaskPriority
  dueAt?: string
  blockedReason?: string
  lastNote?: string
  source: "manual" | "a2a"
  createdAt: string
  updatedAt: string
}

export interface OrchestrationInfo {
  strategy: OrchestrationStrategy
  selectedAgents: string[]
  reason: string
  masterDecision?: MasterDecisionTrace
}

export interface MasterDecisionCandidate {
  memberId: string
  memberName: string
  score: number
  allowed: boolean
  preferred: boolean
  taskDomain: string | null
  memberDomains: string[]
  reason?: string
}

export interface MasterDecisionTaskDiagnostic {
  taskTitle: string
  selectedMemberId?: string
  selectedMemberName?: string
  selectedScore?: number
  candidates: MasterDecisionCandidate[]
}

export interface MasterDecisionAssignment {
  memberId: string
  memberName: string
  taskId?: string
  taskTitle: string
  taskDescription: string
  reason: string
  intent?: string
  score: number
  taskDomain: string | null
  memberDomains: string[]
}

export interface MasterDecisionTrace {
  engine: "embedded-master"
  phase: "kickoff" | "rebalance" | "assignment"
  summary: string
  assignments?: MasterDecisionAssignment[]
  diagnostics?: MasterDecisionTaskDiagnostic[]
  createdAt: string
}

export interface Agent {
  id: string
  name: string
  role: string
  avatar: string
  emoji?: string
  providerId?: string
  skills: string[]
  category: string
  status: AgentStatus
  currentTask?: string
  taskProgress?: number
  lastActiveAt: string
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; result?: ToolResultBlock }
  | { type: "toolResult"; toolCallId: string; toolName: string; content: unknown; isError: boolean }

export interface ToolResultBlock {
  toolCallId: string
  toolName: string
  content: unknown
  isError: boolean
}

export interface Message {
  id: string
  conversationId: string
  senderId: string | "user"
  senderName: string
  senderAvatar: string
  senderRole?: string
  content: string
  timestamp: string
  read: boolean
  type: "text" | "system" | "task-card" | "file" | "orchestration"
  taskCard?: TaskCard
  fileAttachment?: FileAttachment
  attachments?: ChatAttachment[]
  contentBlocks?: ContentBlock[]
  mentions?: string[]
  orchestrationInfo?: OrchestrationInfo
}

export interface TaskCard {
  title: string
  progress: number
  scope: string
  status: "in-progress" | "completed" | "failed"
}

export interface FileAttachment {
  name: string
  size: string
  type: string
}

export interface Conversation {
  id: string
  type: "direct" | "group"
  name: string
  avatar: string
  purpose?: string
  members: string[]
  orchestration?: GroupOrchestration
  workspacePath?: string
  workspaceTasks?: GroupWorkspaceTask[]
  lastMessage?: string
  lastMessageSender?: string
  lastMessageTime: string
  unreadCount: number
  pinned?: boolean
  pinnedAt?: number
}

export interface ChatAttachment {
  id: string
  dataUrl?: string
  filePath?: string
  mimeType: string
  fileName?: string
}

export type ViewType = "chat" | "virtual-team" | "cron" | "openclaw" | "skills" | "agent-config" | "channels" | "plugins"
