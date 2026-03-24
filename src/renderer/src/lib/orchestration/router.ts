import type { Agent, Conversation, OrchestrationStrategy } from "@/types"
import { createMasterEngine } from "@master-agent"
import { selectRespondingAgents } from "./skill-matcher"

export interface RoutingDecision {
  targetAgentIds: string[]
  strategy: OrchestrationStrategy
  reason: string
  coordinatorMessage?: string
}

const masterEngine = createMasterEngine()

function normalizeMentionToken(raw: string): string {
  return raw
    .trim()
    .replace(/^@/, "")
    .replace(/^[("'`\[\{<\u300A\u300C\u3010]+/u, "")
    .replace(/[)"'`\]\}>.,:;!?]+$/u, "")
    .replace(/[\uFF0C\u3002\uFF1A\uFF1B\uFF01\uFF1F\u3001\u3009\u300D\u3011]+$/u, "")
}

function normalizeMentionLookup(raw: string): string {
  return normalizeMentionToken(raw)
    .toLowerCase()
    .replace(/[\s_\-.:;!?,'"`()[\]{}<>/\\|]+/g, "")
}

export function parseMentions(content: string): string[] {
  const pattern = /@(\S+)/g
  const mentions: string[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(content)) !== null) {
    const token = normalizeMentionToken(match[1] ?? "")
    if (!token) continue
    mentions.push(token)
  }
  return mentions
}

export function resolveMentionedAgentIds(
  mentions: string[],
  agents: Agent[],
  memberIds: string[]
): string[] {
  const memberSet = new Set(memberIds)
  const members = agents.filter((agent) => memberSet.has(agent.id))
  const selected = new Set<string>()

  for (const mention of mentions) {
    const normalized = normalizeMentionToken(mention)
    if (!normalized) continue
    const normalizedLower = normalized.toLowerCase()

    const byId = members.find((agent) => agent.id.toLowerCase() === normalizedLower)
    if (byId) {
      selected.add(byId.id)
      continue
    }

    const byNameExact = members.find((agent) => agent.name.trim().toLowerCase() === normalizedLower)
    if (byNameExact) {
      selected.add(byNameExact.id)
      continue
    }

    const normalizedLoose = normalizeMentionLookup(normalized)
    if (!normalizedLoose) continue

    const byNameLoose = members.filter(
      (agent) => normalizeMentionLookup(agent.name) === normalizedLoose
    )
    if (byNameLoose.length === 1) {
      selected.add(byNameLoose[0].id)
    }
  }

  return Array.from(selected)
}

function buildCoordinatorMessage(
  content: string,
  agents: Agent[],
  memberIds: string[],
  coordinatorId: string
): string {
  const teamMembers = agents
    .filter((a) => memberIds.includes(a.id) && a.id !== coordinatorId)
    .map((a) => {
      const skills = a.skills.length > 0 ? a.skills.join(" | ") : "general"
      return `- ${a.name} (${a.role}): strong at ${skills}`
    })
    .join("\n")

  return [
    `[Group request] User asked: "${content}"`,
    "",
    "You are the coordinator for this group.",
    "Members:",
    teamMembers,
    "",
    "Please provide a brief response to the user first, then assign sub-tasks using @memberName mentions.",
  ].join("\n")
}

function resolveA2ASeedAgentId(
  conversation: Conversation,
  agents: Agent[],
  memberIds: string[]
): string | null {
  const coordinatorId = conversation.orchestration?.coordinatorId
  if (coordinatorId && memberIds.includes(coordinatorId)) return coordinatorId

  const memberAgents = agents.filter((a) => memberIds.includes(a.id))
  if (memberAgents.length === 0) return null

  const preferred =
    memberAgents.find((a) => a.status === "working" || a.status === "thinking")
    ?? memberAgents[0]

  return preferred?.id ?? null
}

export function resolveRoutingDecision(
  content: string,
  conversation: Conversation,
  agents: Agent[],
  mentions: string[]
): RoutingDecision {
  const agentMemberIds = conversation.members.filter((id) => id !== "user")
  const strategy = conversation.orchestration?.strategy ?? "all"

  if (agentMemberIds.length === 0) {
    return { targetAgentIds: [], strategy, reason: "No agent members in this group" }
  }

  // @mentions always take priority
  if (mentions.length > 0) {
    const mentionedIds = resolveMentionedAgentIds(mentions, agents, agentMemberIds)
    if (mentionedIds.length > 0) {
      const names = mentionedIds
        .map((id) => agents.find((a) => a.id === id)?.name ?? id)
        .join(", ")
      return {
        targetAgentIds: mentionedIds,
        strategy,
        reason: `Explicit mention routing: @${names}`,
      }
    }
  }

  switch (strategy) {
    case "skill-match": {
      const memberAgents = agents.filter((a) => agentMemberIds.includes(a.id))
      const maxResponders = conversation.orchestration?.maxResponders ?? 2
      const results = selectRespondingAgents(
        content,
        memberAgents,
        maxResponders,
        conversation.purpose
      )

      const hasMatch = results.some((r) => r.score > 0)
      if (!hasMatch) {
        return {
          targetAgentIds: agentMemberIds,
          strategy: "skill-match",
          reason: "No strong skill match found, fallback to all members",
        }
      }

      const selectedIds = results.map((r) => r.agentId)
      const details = results
        .map((r) => {
          const agent = agents.find((a) => a.id === r.agentId)
          const skillInfo = r.matchedSkills.length > 0 ? r.matchedSkills.join(", ") : agent?.role ?? ""
          return `${agent?.name ?? r.agentId}(${skillInfo})`
        })
        .join(" | ")

      return {
        targetAgentIds: selectedIds,
        strategy: "skill-match",
        reason: `Smart match => ${details}`,
      }
    }

    case "coordinator": {
      const coordinatorId = conversation.orchestration?.coordinatorId
      if (!coordinatorId || !agentMemberIds.includes(coordinatorId)) {
        return {
          targetAgentIds: agentMemberIds,
          strategy: "coordinator",
          reason: "Coordinator not configured, fallback to all members",
        }
      }

      const coordinator = agents.find((a) => a.id === coordinatorId)
      return {
        targetAgentIds: [coordinatorId],
        strategy: "coordinator",
        reason: `Coordinator ${coordinator?.name ?? coordinatorId} is planning`,
        coordinatorMessage: buildCoordinatorMessage(content, agents, agentMemberIds, coordinatorId),
      }
    }

    case "a2a": {
      const seedAgentId = resolveA2ASeedAgentId(conversation, agents, agentMemberIds)
      if (!seedAgentId) {
        return {
          targetAgentIds: agentMemberIds,
          strategy: "a2a",
          reason: "A2A seed agent missing, fallback to all members",
        }
      }
      const seedAgent = agents.find((a) => a.id === seedAgentId)
      return {
        targetAgentIds: [seedAgentId],
        strategy: "a2a",
        reason: `A2A coordinator ${seedAgent?.name ?? seedAgentId} is planning`,
        coordinatorMessage: masterEngine.buildKickoffMessage({
          userRequest: content,
          coordinatorId: seedAgentId,
          members: agents
            .filter((agent) => agentMemberIds.includes(agent.id))
            .map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              skills: agent.skills,
            })),
        }),
      }
    }

    case "round-robin": {
      const idx = conversation.orchestration?.roundRobinIndex ?? 0
      const targetId = agentMemberIds[idx % agentMemberIds.length]
      const agent = agents.find((a) => a.id === targetId)
      return {
        targetAgentIds: [targetId],
        strategy: "round-robin",
        reason: `Round-robin turn: ${agent?.name ?? targetId}`,
      }
    }

    case "all":
    default:
      return {
        targetAgentIds: agentMemberIds,
        strategy: "all",
        reason: "Broadcast to all members",
      }
  }
}
