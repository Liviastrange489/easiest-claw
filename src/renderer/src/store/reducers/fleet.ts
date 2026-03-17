import type { Agent, Conversation } from "@/types"
import type { AppState, AppAction } from "../app-types"
import { saveAgentDisplayName, removeAgentDisplayName, loadPinnedFromStorage } from "../app-storage"
import { agentSeedToAgent, agentSeedToConversation } from "../app-utils"

export function handleFleetAction(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case "SET_VIEW":
      return { ...state, view: action.payload }
    case "SET_ACTIVE_CONVERSATION": {
      const convId = action.payload
      if (!convId) return { ...state, activeConversationId: null }
      const updatedConvs = state.conversations.map((c) =>
        c.id === convId ? { ...c, unreadCount: 0 } : c
      )
      return { ...state, activeConversationId: convId, conversations: updatedConvs }
    }
    case "UPDATE_AGENT_STATUS": {
      const updatedAgents = state.agents.map((a) =>
        a.id === action.payload.agentId
          ? { ...a, status: action.payload.status }
          : a
      )
      return { ...state, agents: updatedAgents }
    }
    case "SET_CONNECTION_STATUS":
      return { ...state, connectionStatus: action.payload, gatewayConnected: action.payload === "connected" }
    case "SET_FLEET": {
      const { seeds, mainAgentId } = action.payload
      const agents = seeds.map(agentSeedToAgent)
      const directConversations = seeds.map(agentSeedToConversation)
      // Preserve existing group conversations that aren't from fleet
      const existingGroups = state.conversations.filter((c) => c.type === "group")
      // Restore pinned state from localStorage
      const pinnedMap = typeof window !== "undefined" ? loadPinnedFromStorage() : {}
      const conversations = [...directConversations, ...existingGroups].map((c) => {
        const pinnedAt = pinnedMap[c.id]
        if (pinnedAt) return { ...c, pinned: true, pinnedAt }
        return c
      })
      const firstConvId = conversations[0]?.id ?? null

      // Re-resolve agent names/avatars in existing messages (e.g. restored from localStorage)
      const agentMap = new Map(agents.map((a) => [a.id, a]))
      const updatedMessages = { ...state.messages }
      let messagesChanged = false
      for (const [convId, msgs] of Object.entries(updatedMessages)) {
        const updated = msgs.map((m) => {
          if (m.senderId === "user" || m.senderId === "system") return m
          const agent = agentMap.get(m.senderId)
          if (!agent) return m
          if (m.senderName === agent.name && m.senderAvatar === agent.avatar) return m
          return { ...m, senderName: agent.name, senderAvatar: agent.avatar, senderRole: agent.role }
        })
        if (updated !== msgs) {
          updatedMessages[convId] = updated
          messagesChanged = true
        }
      }

      return {
        ...state,
        agents,
        conversations,
        messages: messagesChanged ? updatedMessages : state.messages,
        activeConversationId: state.activeConversationId ?? firstConvId,
        mainAgentId,
      }
    }
    case "RENAME_AGENT": {
      const { agentId, name, emoji } = action.payload
      saveAgentDisplayName(agentId, name)
      const currentAgent = state.agents.find((a) => a.id === agentId)
      const resolvedEmoji = emoji ?? currentAgent?.emoji
      const avatar = resolvedEmoji || name.slice(0, 2).toUpperCase()
      const conversationId = `conv-${agentId}`
      const updatedAgents = state.agents.map((a) =>
        a.id === agentId ? { ...a, name, avatar, emoji: resolvedEmoji } : a
      )
      const updatedConvs = state.conversations.map((c) =>
        c.id === conversationId ? { ...c, name, avatar } : c
      )
      return { ...state, agents: updatedAgents, conversations: updatedConvs }
    }
    case "ADD_AGENT": {
      const { agentId, name, emoji } = action.payload
      if (state.agents.some((a) => a.id === agentId)) return state
      saveAgentDisplayName(agentId, name)
      const avatar = emoji || name.slice(0, 2).toUpperCase()
      const newAgent: Agent = {
        id: agentId,
        name,
        role: "Agent",
        avatar,
        emoji,
        skills: [],
        category: "OpenClaw",
        status: "idle",
        lastActiveAt: "",
      }
      const newConv: Conversation = {
        id: `conv-${agentId}`,
        type: "direct",
        name,
        avatar,
        members: [agentId],
        lastMessage: "",
        lastMessageTime: "",
        unreadCount: 0,
      }
      return {
        ...state,
        agents: [...state.agents, newAgent],
        conversations: [...state.conversations, newConv],
      }
    }
    case "REMOVE_AGENT": {
      const { agentId } = action.payload
      const conversationId = `conv-${agentId}`
      removeAgentDisplayName(agentId)
      const updatedAgents = state.agents.filter((a) => a.id !== agentId)
      const updatedConvs = state.conversations.filter((c) => c.id !== conversationId)
      const { [conversationId]: _removed, ...remainingMessages } = state.messages
      const next = new Set(state.thinkingAgents)
      next.delete(agentId)
      return {
        ...state,
        agents: updatedAgents,
        conversations: updatedConvs,
        messages: remainingMessages,
        thinkingAgents: next,
        activeConversationId:
          state.activeConversationId === conversationId
            ? (updatedConvs[0]?.id ?? null)
            : state.activeConversationId,
      }
    }
    case "SET_MODELS_CONFIGURED":
      return { ...state, modelsConfigured: action.payload }
    default:
      return null
  }
}
