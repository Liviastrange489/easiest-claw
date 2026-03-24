import type { Agent, GroupTaskStatus } from "@/types"

export interface A2AInstruction {
  to: string
  message: string
  intent?: string
}

export interface A2ATaskUpdate {
  taskId?: string
  status?: GroupTaskStatus
  progress?: number
  note?: string
}

export interface A2AClaim {
  taskId: string
  score?: number
  eta?: string
  reason?: string
}

function normalizeTarget(raw: string): string {
  return raw
    .trim()
    .replace(/^@/, "")
    .replace(/^[*_~`]+/, "")
    .replace(/^[("'`\[\{<\u300A\u300C\u3010]+/u, "")
    .replace(/[*_~`]+$/u, "")
    .replace(/[)"'`\]\}>.,:;!?]+$/u, "")
    .replace(/[\uFF0C\u3002\uFF1A\uFF1B\uFF01\uFF1F\u3001\u3009\u300D\u3011]+$/u, "")
}

function normalizeLookupToken(raw: string): string {
  return normalizeTarget(raw)
    .toLowerCase()
    .replace(/[\s_\-.:;!?,'"`()[\]{}<>/\\|]+/g, "")
}

function normalizeStatus(raw: string): {
  status?: GroupTaskStatus
  progress?: number
} {
  const token = raw.trim().toLowerCase()
  if (!token) return {}

  const progressWithWord = token.match(/^progress\s+(\d{1,3})$/i)
  if (progressWithWord) {
    const progress = Math.min(100, Math.max(0, Number(progressWithWord[1])))
    return { status: "in-progress", progress }
  }

  const plainPercent = token.match(/^(\d{1,3})%?$/)
  if (plainPercent) {
    const progress = Math.min(100, Math.max(0, Number(plainPercent[1])))
    return { status: progress >= 100 ? "done" : "in-progress", progress }
  }

  if (["done", "completed", "complete", "finished"].includes(token)) {
    return { status: "done", progress: 100 }
  }
  if (["blocked", "stuck"].includes(token)) {
    return { status: "blocked" }
  }
  if (["todo"].includes(token)) {
    return { status: "todo" }
  }
  if (["in-progress", "in_progress", "progress"].includes(token)) {
    return { status: "in-progress" }
  }

  return {}
}

function fromJsonPayload(payload: unknown): A2AInstruction[] {
  const list = Array.isArray(payload) ? payload : [payload]
  const instructions: A2AInstruction[] = []

  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const to = typeof rec.to === "string" ? normalizeTarget(rec.to) : ""
    const message = typeof rec.message === "string" ? rec.message.trim() : ""
    const intent = typeof rec.intent === "string" ? rec.intent.trim() : undefined
    if (!to || !message) continue
    instructions.push({ to, message, intent })
  }

  return instructions
}

function fromJsonStatusPayload(payload: unknown): A2ATaskUpdate[] {
  const list = Array.isArray(payload) ? payload : [payload]
  const updates: A2ATaskUpdate[] = []

  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const taskId = typeof rec.taskId === "string" ? rec.taskId.trim() : undefined
    const note = typeof rec.note === "string" ? rec.note.trim() : undefined
    const normalized = normalizeStatus(typeof rec.status === "string" ? rec.status : "")
    const progress =
      typeof rec.progress === "number" && Number.isFinite(rec.progress)
        ? Math.min(100, Math.max(0, Math.round(rec.progress)))
        : normalized.progress
    const status = normalized.status

    if (!taskId && !status && progress === undefined && !note) continue
    updates.push({ taskId, status, progress, note })
  }

  return updates
}

function fromJsonClaimPayload(payload: unknown): A2AClaim[] {
  const list = Array.isArray(payload) ? payload : [payload]
  const claims: A2AClaim[] = []

  for (const item of list) {
    if (!item || typeof item !== "object") continue
    const rec = item as Record<string, unknown>
    const taskId = typeof rec.taskId === "string" ? rec.taskId.trim() : ""
    if (!taskId) continue
    const score =
      typeof rec.score === "number" && Number.isFinite(rec.score)
        ? Math.min(100, Math.max(0, Math.round(rec.score)))
        : undefined
    const eta = typeof rec.eta === "string" ? rec.eta.trim() : undefined
    const reason = typeof rec.reason === "string" ? rec.reason.trim() : undefined
    claims.push({ taskId, score, eta, reason })
  }

  return claims
}

export function parseA2AInstructions(content: string): A2AInstruction[] {
  if (!content.trim()) return []

  const found: A2AInstruction[] = []

  // fenced block: ```a2a { ... }``` or ```a2a [ ... ]```
  const fenced = /```a2a\s*([\s\S]*?)```/gi
  let fencedMatch: RegExpExecArray | null
  while ((fencedMatch = fenced.exec(content)) !== null) {
    const raw = fencedMatch[1]?.trim()
    if (!raw) continue
    try {
      found.push(...fromJsonPayload(JSON.parse(raw)))
    } catch {
      // ignore malformed block
    }
  }

  // line protocol: A2A -> @AgentName: do something
  const lineProtocol = /(?:^|\n)\s*A2A\s*(?:->|=>|→)\s*@?([^\s:：]+)\s*[:：]\s*(.+?)(?=\n|$)/gim
  let lineMatch: RegExpExecArray | null
  while ((lineMatch = lineProtocol.exec(content)) !== null) {
    const to = normalizeTarget(lineMatch[1] ?? "")
    const message = (lineMatch[2] ?? "").trim()
    if (!to || !message) continue
    found.push({ to, message })
  }

  const seen = new Set<string>()
  const deduped: A2AInstruction[] = []
  for (const item of found) {
    const key = `${item.to}::${item.intent ?? ""}::${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  return deduped
}

export function parseA2AMentionFallbackInstructions(content: string): A2AInstruction[] {
  if (!content.trim()) return []

  const found: A2AInstruction[] = []
  const assignHintPattern =
    /(负责|实现|开发|编写|设计|测试|排查|处理|跟进|产出|推进|investigate|implement|build|design|test|debug|fix|review|handle|work|own|deliver|正在)/i
  const doneOnlyPattern = /(已完成|done|completed|finished)\s*$/i

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const normalizedLine = line.replace(/^[-*•\d.\)\s]+/, "").trim()
    if (!normalizedLine) continue

    const mentionMatch = normalizedLine.match(/@([^\s:：，,。;；!！?？]+)\s*(.*)$/)
    if (!mentionMatch) continue

    const to = normalizeTarget(mentionMatch[1] ?? "")
    let message = (mentionMatch[2] ?? "").trim()
    message = message.replace(/^[:：\-—]+\s*/, "").trim()
    if (!to || !message) continue

    const hasAssignHint = assignHintPattern.test(message)
    const looksDoneOnly = doneOnlyPattern.test(message) && !hasAssignHint
    if (looksDoneOnly) continue

    found.push({ to, message, intent: "delegate" })
  }

  const deduped: A2AInstruction[] = []
  const seen = new Set<string>()
  for (const item of found) {
    const key = `${item.to}|${item.message}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  return deduped
}

export function parseA2ATaskUpdates(content: string): A2ATaskUpdate[] {
  if (!content.trim()) return []

  const updates: A2ATaskUpdate[] = []

  // fenced block: ```a2a-status { ... }``` or ```a2a-status [ ... ]```
  const fenced = /```a2a-status\s*([\s\S]*?)```/gi
  let fencedMatch: RegExpExecArray | null
  while ((fencedMatch = fenced.exec(content)) !== null) {
    const raw = fencedMatch[1]?.trim()
    if (!raw) continue
    try {
      updates.push(...fromJsonStatusPayload(JSON.parse(raw)))
    } catch {
      // ignore malformed block
    }
  }

  // line protocol examples:
  // A2A STATUS -> task=<taskId> done: summary
  // A2A STATUS -> task=<taskId> blocked: reason
  // A2A STATUS -> task=<taskId> progress 70: summary
  const lineProtocol = /(?:^|\n)\s*A2A\s*STATUS\s*(?:->|=>|→)\s*(.+?)(?=\n|$)/gim
  let lineMatch: RegExpExecArray | null
  while ((lineMatch = lineProtocol.exec(content)) !== null) {
    const rawLine = (lineMatch[1] ?? "").trim()
    if (!rawLine) continue

    const taskMatch = rawLine.match(/^task(?:id)?\s*=\s*([^\s,;]+)\s*(.*)$/i)
    const taskId = taskMatch?.[1]?.trim()
    const remainder = (taskMatch?.[2] ?? rawLine).trim()
    if (!remainder) continue

    const headMatch = remainder.match(/^([^\s:：]+(?:\s+\d{1,3}%?)?)\s*[:：-]?\s*(.*)$/)
    const statusToken = headMatch?.[1]?.trim() ?? ""
    const note = headMatch?.[2]?.trim() || undefined
    const normalized = normalizeStatus(statusToken)

    if (!taskId && !normalized.status && normalized.progress === undefined && !note) continue
    updates.push({
      taskId,
      status: normalized.status,
      progress: normalized.progress,
      note,
    })
  }

  const deduped: A2ATaskUpdate[] = []
  const seen = new Set<string>()
  for (const item of updates) {
    const key = `${item.taskId ?? ""}|${item.status ?? ""}|${item.progress ?? ""}|${item.note ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  return deduped
}

export function parseA2AClaims(content: string): A2AClaim[] {
  if (!content.trim()) return []

  const claims: A2AClaim[] = []

  // fenced block: ```a2a-claim { ... }``` or ```a2a-claim [ ... ]```
  const fenced = /```a2a-claim\s*([\s\S]*?)```/gi
  let fencedMatch: RegExpExecArray | null
  while ((fencedMatch = fenced.exec(content)) !== null) {
    const raw = fencedMatch[1]?.trim()
    if (!raw) continue
    try {
      claims.push(...fromJsonClaimPayload(JSON.parse(raw)))
    } catch {
      // ignore malformed block
    }
  }

  // line protocol:
  // A2A CLAIM -> task=<taskId> score=82 eta=20m reason=...
  const lineProtocol = /(?:^|\n)\s*A2A\s*CLAIM\s*(?:->|=>|→)\s*(.+?)(?=\n|$)/gim
  let lineMatch: RegExpExecArray | null
  while ((lineMatch = lineProtocol.exec(content)) !== null) {
    const rawLine = (lineMatch[1] ?? "").trim()
    if (!rawLine) continue

    const taskIdMatch = rawLine.match(/task(?:id)?\s*=\s*([^\s,;]+)/i)
    const taskId = taskIdMatch?.[1]?.trim() ?? ""
    if (!taskId) continue

    const scoreMatch = rawLine.match(/score\s*=\s*(\d{1,3})/i)
    const etaMatch = rawLine.match(/eta\s*=\s*([^\s,;]+)/i)
    const reasonMatch = rawLine.match(/reason\s*=\s*(.+)$/i)

    const score =
      scoreMatch && Number.isFinite(Number(scoreMatch[1]))
        ? Math.min(100, Math.max(0, Number(scoreMatch[1])))
        : undefined
    const eta = etaMatch?.[1]?.trim() || undefined
    const reason = reasonMatch?.[1]?.trim() || undefined

    claims.push({ taskId, score, eta, reason })
  }

  const deduped: A2AClaim[] = []
  const seen = new Set<string>()
  for (const claim of claims) {
    const key = `${claim.taskId}|${claim.score ?? ""}|${claim.eta ?? ""}|${claim.reason ?? ""}`
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(claim)
  }

  return deduped
}

export function resolveA2ATargetAgentId(
  target: string,
  agents: Agent[],
  allowedAgentIds: string[]
): string | null {
  const normalized = normalizeTarget(target).toLowerCase()
  if (!normalized) return null

  const allowed = new Set(allowedAgentIds)
  const allowedAgents = agents.filter((agent) => allowed.has(agent.id))

  const byId = allowedAgents.find((agent) => agent.id.toLowerCase() === normalized)
  if (byId) return byId.id

  const byNameExact = allowedAgents.find((agent) => agent.name.trim().toLowerCase() === normalized)
  if (byNameExact) return byNameExact.id

  const normalizedLoose = normalizeLookupToken(normalized)
  if (!normalizedLoose) return null

  const byIdLoose = allowedAgents.find((agent) => normalizeLookupToken(agent.id) === normalizedLoose)
  if (byIdLoose) return byIdLoose.id

  const byNameLoose = allowedAgents.filter(
    (agent) => normalizeLookupToken(agent.name) === normalizedLoose
  )
  if (byNameLoose.length === 1) return byNameLoose[0].id
  if (byNameLoose.length > 1) return null

  const byContainment = allowedAgents.filter((agent) => {
    const candidate = normalizeLookupToken(agent.name)
    if (!candidate) return false
    return candidate.includes(normalizedLoose) || normalizedLoose.includes(candidate)
  })
  if (byContainment.length === 1) return byContainment[0].id

  return null
}

export function buildA2ARelayPrompt(params: {
  fromAgentName: string
  targetAgentName: string
  targetAgentRole?: string
  targetAgentSkills?: string[]
  intent?: string
  message: string
  taskId: string
}): string {
  const { fromAgentName, targetAgentName, targetAgentRole, targetAgentSkills, intent, message, taskId } = params
  const skillText =
    targetAgentSkills && targetAgentSkills.length > 0
      ? targetAgentSkills.join(", ")
      : "general"
  return [
    "[A2A relay task]",
    `From agent: ${fromAgentName}`,
    `Assigned to: ${targetAgentName}`,
    `Assignee role: ${targetAgentRole?.trim() || "agent"}`,
    `Assignee skills: ${skillText}`,
    `TaskId: ${taskId}`,
    `Intent: ${intent?.trim() ? intent.trim() : "delegate"}`,
    "",
    "Task:",
    message,
    "",
    "Execution boundary:",
    "1. Execute only this assigned scope; do not take over other agents' tasks.",
    "2. If this task is outside your role/skills, reply blocked with a short reason.",
    "3. Do not claim or update tasks assigned to other agents.",
    "",
    "If you want to self-claim before execution, include:",
    `A2A CLAIM -> task=${taskId} score=80 eta=20m reason=<short reason>`,
    "",
    "When updating result, include exactly one line:",
    `A2A STATUS -> task=${taskId} done: <summary>`,
    "Or if blocked:",
    `A2A STATUS -> task=${taskId} blocked: <reason>`,
    "Or for partial progress:",
    `A2A STATUS -> task=${taskId} progress 60: <summary>`,
  ].join("\n")
}
