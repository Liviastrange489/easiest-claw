import type { Agent, ChatAttachment } from "@/types"

export interface ProviderSendParams {
  agentId: string
  content: string
  sessionKey?: string
  attachments?: ChatAttachment[]
}

export interface ProviderSendResult {
  ok: boolean
  error?: string
}

export interface AgentProviderAdapter {
  id: string
  send: (params: ProviderSendParams) => Promise<ProviderSendResult>
  canHandleAgent?: (agent: Agent) => boolean
}
