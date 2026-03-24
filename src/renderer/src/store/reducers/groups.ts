import type { Message } from "@/types"
import type { AppState, AppAction } from "../app-types"
import { saveGroupsToStorage, saveGroupMessagesToStorage, savePinnedToStorage } from "../app-storage"
import { uniqueId } from "../app-utils"

export function handleGroupAction(state: AppState, action: AppAction): AppState | null {
  switch (action.type) {
    case "CREATE_CONVERSATION": {
      const newConversations = [action.payload, ...state.conversations]
      saveGroupsToStorage(newConversations)
      return {
        ...state,
        conversations: newConversations,
        activeConversationId: action.payload.id,
      }
    }
    case "MARK_READ": {
      const updatedConvs = state.conversations.map((c) =>
        c.id === action.payload ? { ...c, unreadCount: 0 } : c
      )
      return { ...state, conversations: updatedConvs }
    }
    case "LOAD_GROUPS": {
      const groups = action.payload
      if (groups.length === 0) return state
      const existingIds = new Set(state.conversations.map((c) => c.id))
      const newGroups = groups.filter((g) => !existingIds.has(g.id))
      return {
        ...state,
        conversations: [...state.conversations, ...newGroups],
      }
    }
    case "LOAD_GROUP_MESSAGES": {
      const savedMessages = action.payload
      if (Object.keys(savedMessages).length === 0) return state
      const merged = { ...state.messages }
      for (const [convId, msgs] of Object.entries(savedMessages)) {
        // Only load if we don't already have messages for this conversation
        if (!merged[convId] || merged[convId].length === 0) {
          merged[convId] = msgs
        }
      }
      // Update conversation lastMessage from restored messages
      const updatedConvs = state.conversations.map((c) => {
        const msgs = merged[c.id]
        if (!msgs || msgs.length === 0) return c
        const lastMsg = msgs[msgs.length - 1]
        return {
          ...c,
          lastMessage: lastMsg.content.slice(0, 100),
          lastMessageTime: lastMsg.timestamp,
        }
      })
      return { ...state, messages: merged, conversations: updatedConvs }
    }
    case "UPDATE_GROUP_ORCHESTRATION": {
      const { conversationId, orchestration } = action.payload
      const updatedConvs = state.conversations.map((c) =>
        c.id === conversationId ? { ...c, orchestration } : c
      )
      saveGroupsToStorage(updatedConvs)
      return { ...state, conversations: updatedConvs }
    }
    case "ADD_ORCHESTRATION_MESSAGE": {
      const { conversationId, strategy, selectedAgents, reason, masterDecision } = action.payload
      const orchestrationMsg: Message = {
        id: uniqueId("orch"),
        conversationId,
        senderId: "system",
        senderName: "\u7f16\u6392\u7cfb\u7edf",
        senderAvatar: "OC",
        content: reason,
        timestamp: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
        read: true,
        type: "orchestration",
        orchestrationInfo: {
          strategy: strategy as import("@/types").OrchestrationStrategy,
          selectedAgents,
          reason,
          masterDecision,
        },
      }
      const existing = state.messages[conversationId] ?? []
      return {
        ...state,
        messages: { ...state.messages, [conversationId]: [...existing, orchestrationMsg] },
      }
    }
    case "ADVANCE_ROUND_ROBIN": {
      const { conversationId } = action.payload
      const updatedConvs = state.conversations.map((c) => {
        if (c.id !== conversationId || !c.orchestration) return c
        const agentMembers = c.members.filter((id) => id !== "user")
        const currentIdx = c.orchestration.roundRobinIndex ?? 0
        const nextIdx = (currentIdx + 1) % agentMembers.length
        return {
          ...c,
          orchestration: { ...c.orchestration, roundRobinIndex: nextIdx },
        }
      })
      saveGroupsToStorage(updatedConvs)
      return { ...state, conversations: updatedConvs }
    }
    case "DISSOLVE_GROUP": {
      const { conversationId } = action.payload
      const updatedConvs = state.conversations.filter((c) => c.id !== conversationId)
      const { [conversationId]: _removed, ...remainingMessages } = state.messages
      saveGroupsToStorage(updatedConvs)
      saveGroupMessagesToStorage(remainingMessages, updatedConvs)
      return {
        ...state,
        conversations: updatedConvs,
        messages: remainingMessages,
        activeConversationId:
          state.activeConversationId === conversationId
            ? (updatedConvs[0]?.id ?? null)
            : state.activeConversationId,
      }
    }
    case "RESET_SESSION": {
      const { conversationId } = action.payload
      const updatedConvs = state.conversations.map((c) =>
        c.id === conversationId
          ? { ...c, lastMessage: "", lastMessageTime: "" }
          : c
      )
      return {
        ...state,
        messages: { ...state.messages, [conversationId]: [] },
        conversations: updatedConvs,
      }
    }
    case "ADD_GROUP_MEMBER": {
      const { conversationId, agentId } = action.payload
      const updatedConvs = state.conversations.map((c) => {
        if (c.id !== conversationId || c.members.includes(agentId)) return c
        return { ...c, members: [...c.members, agentId] }
      })
      saveGroupsToStorage(updatedConvs)
      return { ...state, conversations: updatedConvs }
    }
    case "ADD_GROUP_TASK": {
      const { conversationId, task } = action.payload
      let changed = false
      const updatedConvs = state.conversations.map((c) => {
        if (c.id !== conversationId || c.type !== "group") return c
        const existing = c.workspaceTasks ?? []
        if (existing.some((item) => item.id === task.id)) return c
        changed = true
        return {
          ...c,
          workspaceTasks: [...existing, task],
        }
      })
      if (!changed) return state
      saveGroupsToStorage(updatedConvs)
      return { ...state, conversations: updatedConvs }
    }
    case "UPDATE_GROUP_TASK": {
      const { conversationId, taskId, patch } = action.payload
      let changed = false
      const updatedConvs = state.conversations.map((c) => {
        if (c.id !== conversationId || c.type !== "group") return c
        const existing = c.workspaceTasks ?? []
        const nextTasks = existing.map((task) => {
          if (task.id !== taskId) return task
          changed = true
          return {
            ...task,
            ...patch,
            updatedAt: patch.updatedAt ?? new Date().toISOString(),
          }
        })
        if (!changed) return c
        return { ...c, workspaceTasks: nextTasks }
      })
      if (!changed) return state
      saveGroupsToStorage(updatedConvs)
      return { ...state, conversations: updatedConvs }
    }
    case "REMOVE_GROUP_TASK": {
      const { conversationId, taskId } = action.payload
      let changed = false
      const updatedConvs = state.conversations.map((c) => {
        if (c.id !== conversationId || c.type !== "group") return c
        const existing = c.workspaceTasks ?? []
        const nextTasks = existing.filter((task) => task.id !== taskId)
        if (nextTasks.length === existing.length) return c
        changed = true
        return { ...c, workspaceTasks: nextTasks }
      })
      if (!changed) return state
      saveGroupsToStorage(updatedConvs)
      return { ...state, conversations: updatedConvs }
    }
    case "TOGGLE_PIN": {
      const { conversationId } = action.payload
      const updatedConvs = state.conversations.map((c) => {
        if (c.id !== conversationId) return c
        const isPinned = !c.pinned
        return { ...c, pinned: isPinned, pinnedAt: isPinned ? Date.now() : undefined }
      })
      savePinnedToStorage(updatedConvs)
      return { ...state, conversations: updatedConvs }
    }
    default:
      return null
  }
}
