import { buildA2AKickoffMessage, buildProgressReviewPrompt, buildSharedContextSnippet, buildStallMonitorPrompt } from "./prompts"
import { detectMemberDomains, detectTaskDomain, evaluateAssignment } from "./policy"
import { planKickoffAssignments, planRebalanceAssignments } from "./planner"
import type {
  AssignmentDecision,
  MasterKickoffPlanInput,
  MasterMember,
  MasterPlanResult,
  MasterRebalancePlanInput,
  MasterStalledTaskInput,
  MasterTaskDomain,
  MasterTaskSnapshot,
  MasterTerminalUpdate,
} from "./types"

export class MasterEngine {
  detectTaskDomain(text: string): MasterTaskDomain | null {
    return detectTaskDomain(text)
  }

  detectMemberDomains(member: MasterMember): MasterTaskDomain[] {
    return detectMemberDomains(member)
  }

  evaluateAssignment(params: {
    taskText: string
    member: MasterMember
    strictRoleMatch?: boolean
  }): AssignmentDecision {
    return evaluateAssignment(params)
  }

  buildKickoffMessage(params: {
    userRequest: string
    coordinatorId: string
    members: MasterMember[]
  }): string {
    return buildA2AKickoffMessage(params)
  }

  buildSharedContextSnippet(params: {
    latestUserRequest?: string
    tasks: MasterTaskSnapshot[]
    recentAgentUpdates?: string[]
  }): string {
    return buildSharedContextSnippet(params)
  }

  buildProgressReviewPrompt(params: {
    senderAgentName: string
    terminalUpdates: MasterTerminalUpdate[]
    tasks: MasterTaskSnapshot[]
  }): string {
    return buildProgressReviewPrompt(params)
  }

  buildStallMonitorPrompt(tasks: MasterStalledTaskInput[]): string {
    return buildStallMonitorPrompt(tasks)
  }

  planKickoff(input: MasterKickoffPlanInput): MasterPlanResult {
    return planKickoffAssignments(input)
  }

  planRebalance(input: MasterRebalancePlanInput): MasterPlanResult {
    return planRebalanceAssignments(input)
  }
}

export function createMasterEngine(): MasterEngine {
  return new MasterEngine()
}
