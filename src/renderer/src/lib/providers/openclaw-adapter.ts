import type { ChatAttachment } from "@/types"
import type { AgentProviderAdapter, ProviderSendResult } from "./types"

type OpenClawSendFn = (
  agentId: string,
  content: string,
  sessionKey?: string,
  attachments?: ChatAttachment[]
) => Promise<{ ok?: boolean; error?: string } | ProviderSendResult>

export function createOpenClawAdapter(sendFn: OpenClawSendFn): AgentProviderAdapter {
  return {
    id: "openclaw",
    send: async ({ agentId, content, sessionKey, attachments }) => {
      const result = await sendFn(agentId, content, sessionKey, attachments)
      if (result && result.ok === true) return { ok: true }
      return { ok: false, error: result?.error ?? "openclaw_send_failed" }
    },
  }
}
