import type { Agent } from "@/types"
import type { AgentProviderAdapter, ProviderSendParams, ProviderSendResult } from "./types"

const OPENCLAW_PROVIDER_ID = "openclaw"

function normalizeProviderId(agent: Agent): string | null {
  if (agent.providerId?.trim()) return agent.providerId.trim().toLowerCase()
  const category = (agent.category ?? "").trim().toLowerCase()
  if (!category) return null
  if (category.includes("openclaw")) return OPENCLAW_PROVIDER_ID
  return null
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, AgentProviderAdapter>()

  register(adapter: AgentProviderAdapter): void {
    this.adapters.set(adapter.id.toLowerCase(), adapter)
  }

  get(providerId: string): AgentProviderAdapter | null {
    return this.adapters.get(providerId.toLowerCase()) ?? null
  }

  resolveForAgent(agent: Agent): AgentProviderAdapter | null {
    const providerId = normalizeProviderId(agent)
    if (providerId) {
      const byId = this.get(providerId)
      if (byId) return byId
    }

    for (const adapter of this.adapters.values()) {
      if (!adapter.canHandleAgent || adapter.canHandleAgent(agent)) {
        return adapter
      }
    }

    return this.get(OPENCLAW_PROVIDER_ID)
  }

  async sendToAgent(agent: Agent, payload: ProviderSendParams): Promise<ProviderSendResult> {
    const adapter = this.resolveForAgent(agent)
    if (!adapter) return { ok: false, error: `no_provider_for_agent:${agent.id}` }
    return adapter.send(payload)
  }
}
