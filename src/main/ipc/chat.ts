import type { IpcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { gw } from './gw'
import { getOpenclawStateDir } from '../lib/openclaw-config'
import { traceDebug } from '../lib/debug-trace'

/** Parse messages from a JSONL transcript file */
async function parseJsonlMessages(
  filePath: string,
): Promise<Array<{ role: string; content: unknown; timestamp?: number }>> {
  const messages: Array<{ role: string; content: unknown; timestamp?: number }> = []
  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.type !== 'message') continue

      const msg = parsed.message as Record<string, unknown> | undefined
      if (!msg || typeof msg !== 'object') continue

      const role = msg.role as string | undefined
      if (!role) continue
      if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'toolResult') continue

      messages.push({
        role,
        content: msg.content,
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
      })
    } catch {
      // Skip malformed lines
    }
  }

  return messages
}

async function resolveSessionId(
  agentId: string,
  sessionKey?: string,
  sessionId?: string,
): Promise<{ ok: true; sessionId: string } | { ok: false; error: string }> {
  if (sessionId) return { ok: true, sessionId }
  if (!sessionKey) return { ok: false, error: 'No sessionId or sessionKey provided' }

  const listRes = await gw<{ sessions: Array<{ key: string; sessionId: string }> }>('sessions.list', {
    agentId,
  })
  if (!listRes.ok) return { ok: false, error: listRes.error ?? 'Failed to list sessions' }

  const sessions = listRes.result?.sessions ?? []
  const entry = sessions.find((s) => s.key === sessionKey)
  if (!entry?.sessionId) return { ok: false, error: 'Session not found' }

  return { ok: true, sessionId: entry.sessionId }
}

async function resolveSessionJsonlPath(
  agentId: string,
  sessionId: string,
): Promise<{ ok: true; filePath: string } | { ok: false; error: string }> {
  const stateDir = getOpenclawStateDir()
  const sessionsDir = path.join(stateDir, 'agents', agentId, 'sessions')
  const jsonlPath = path.join(sessionsDir, `${sessionId}.jsonl`)

  try {
    await fs.promises.access(jsonlPath)
    return { ok: true, filePath: jsonlPath }
  } catch {
    try {
      const files = await fs.promises.readdir(sessionsDir)
      const resetFile = files.find((f) => f.startsWith(`${sessionId}.jsonl.reset.`))
      if (!resetFile) return { ok: false, error: 'JSONL file not found' }
      return { ok: true, filePath: path.join(sessionsDir, resetFile) }
    } catch {
      return { ok: false, error: 'Sessions directory not found' }
    }
  }
}

async function findToolResultByToolCallId(
  filePath: string,
  toolCallId: string,
): Promise<{
  found: boolean
  content?: unknown
  details?: unknown
  isError?: boolean
  timestamp?: number
}> {
  let latestMatch:
    | {
        found: boolean
        content?: unknown
        details?: unknown
        isError?: boolean
        timestamp?: number
      }
    | null = null

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity })

  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      if (parsed.type !== 'message') continue
      const msg = parsed.message as Record<string, unknown> | undefined
      if (!msg || typeof msg !== 'object') continue
      if (msg.role !== 'toolResult') continue
      if (msg.toolCallId !== toolCallId) continue

      latestMatch = {
        found: true,
        content: msg.content,
        details: msg.details,
        isError: msg.isError === true,
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : undefined,
      }
    } catch {
      // Skip malformed lines
    }
  }

  return latestMatch ?? { found: false }
}

export const registerChatHandlers = (ipcMain: IpcMain): void => {
  // Send a message to an agent
  ipcMain.handle('chat:send', async (_event, params: {
    agentId: string
    message: string
    sessionKey: string
    idempotencyKey: string
    attachments?: Array<{ type: string; mimeType: string; content: string }>
  }) => {
    // Strip agentId — gateway chat.send only accepts: sessionKey, message, idempotencyKey, attachments
    const { sessionKey, message, idempotencyKey, attachments } = params
    traceDebug(
      'ipc.chat.send.received',
      {
        agentId: params.agentId,
        sessionKey,
        idempotencyKey,
        hasAttachments: Array.isArray(attachments) && attachments.length > 0,
        messageLength: typeof message === 'string' ? message.length : 0,
      },
      'main.ipc.chat',
    )
    // Keep reasoning output in stream mode so renderer can show real-time thinking.
    // Ignore patch errors for compatibility with older gateway versions.
    const patchRes = await gw('sessions.patch', { key: sessionKey, reasoningLevel: 'stream' })
    if (!patchRes.ok) {
      console.warn(`[chat:send] sessions.patch failed for ${sessionKey}: ${patchRes.error}`)
      traceDebug('ipc.chat.send.patch.failed', { sessionKey, error: patchRes.error }, 'main.ipc.chat')
    } else {
      traceDebug('ipc.chat.send.patch.ok', { sessionKey }, 'main.ipc.chat')
    }
    const payload: Record<string, unknown> = { sessionKey, message, idempotencyKey }
    if (attachments && attachments.length > 0) payload.attachments = attachments
    const sendRes = await gw('chat.send', payload)
    traceDebug(
      'ipc.chat.send.result',
      { sessionKey, ok: sendRes.ok, error: sendRes.ok ? null : sendRes.error },
      'main.ipc.chat',
    )
    return sendRes
  })

  // Abort an in-flight run
  ipcMain.handle('chat:abort', async (_event, params: { sessionKey?: string; runId?: string }) => {
    return gw('chat.abort', params)
  })

  // Load chat history for a session
  ipcMain.handle('chat:history', async (_event, params: { agentId: string; sessionKey?: string }) => {
    const sessionKey = params.sessionKey ?? `agent:${params.agentId}:main`
    return gw('chat.history', { sessionKey })
  })

  // List sessions
  ipcMain.handle('sessions:list', async (_event, params?: Record<string, unknown>) => {
    return gw('sessions.list', params ?? {})
  })

  // Reset a session
  ipcMain.handle('sessions:reset', async (_event, params: { sessionKey: string }) => {
    return gw('sessions.reset', { key: params.sessionKey })
  })

  // Patch session settings (e.g. thinking/verbose toggles)
  ipcMain.handle('sessions:patch', async (_event, params: { sessionKey: string; patch: Record<string, unknown> }) => {
    return gw('sessions.patch', {
      ...(params.patch ?? {}),
      key: params.sessionKey,
    })
  })

  // Read full history from JSONL transcript (includes pre-compaction messages)
  // Accepts either sessionKey (resolved via sessions.list) or sessionId (direct file access)
  ipcMain.handle('chat:history:full', async (_event, params: { agentId: string; sessionKey?: string; sessionId?: string }) => {
    try {
      const sessionResolve = await resolveSessionId(params.agentId, params.sessionKey, params.sessionId)
      if (!sessionResolve.ok) return { ok: false, error: sessionResolve.error }

      const pathResolve = await resolveSessionJsonlPath(params.agentId, sessionResolve.sessionId)
      if (!pathResolve.ok) {
        // No JSONL on disk, fall back to gateway API when sessionKey is available
        if (params.sessionKey) {
          return gw('chat.history', { sessionKey: params.sessionKey })
        }
        return { ok: false, error: pathResolve.error }
      }

      // Parse JSONL line by line
      const messages = await parseJsonlMessages(pathResolve.filePath)
      return { ok: true, result: { messages } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })

  // Read a specific toolResult from JSONL by toolCallId.
  // Useful when runtime tool stream omits result content in incremental events.
  ipcMain.handle(
    'chat:tool-result',
    async (
      _event,
      params: { agentId: string; sessionKey?: string; sessionId?: string; toolCallId: string },
    ) => {
      try {
        const toolCallId = typeof params.toolCallId === 'string' ? params.toolCallId.trim() : ''
        if (!toolCallId) return { ok: false, error: 'toolCallId is required' }

        const sessionResolve = await resolveSessionId(params.agentId, params.sessionKey, params.sessionId)
        if (!sessionResolve.ok) return { ok: false, error: sessionResolve.error }

        const pathResolve = await resolveSessionJsonlPath(params.agentId, sessionResolve.sessionId)
        if (!pathResolve.ok) return { ok: false, error: pathResolve.error }

        const match = await findToolResultByToolCallId(pathResolve.filePath, toolCallId)
        return { ok: true, result: match }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
      }
    },
  )

  // Scan filesystem for all sessions of an agent (includes orphaned/reset sessions)
  ipcMain.handle('sessions:list:all', async (_event, params: { agentId: string }) => {
    try {
      const stateDir = getOpenclawStateDir()
      const sessionsDir = path.join(stateDir, 'agents', params.agentId, 'sessions')

      let files: string[]
      try {
        files = await fs.promises.readdir(sessionsDir)
      } catch {
        return { ok: true, result: { sessions: [] } }
      }

      // Get tracked sessions from sessions.json for metadata
      const sessionsJsonPath = path.join(sessionsDir, 'sessions.json')
      let trackedSessions: Record<string, { sessionId?: string; updatedAt?: number; displayName?: string }> = {}
      try {
        const raw = await fs.promises.readFile(sessionsJsonPath, 'utf8')
        trackedSessions = JSON.parse(raw) as typeof trackedSessions
      } catch {
        // No sessions.json
      }

      // Build reverse map: sessionId → sessionKey
      const sessionIdToKey: Record<string, string> = {}
      for (const [key, val] of Object.entries(trackedSessions)) {
        if (val?.sessionId) sessionIdToKey[val.sessionId] = key
      }

      // Collect all JSONL files
      const sessions: Array<{
        sessionId: string
        sessionKey: string | null
        updatedAt: number | null
        displayName: string | null
        isReset: boolean
        resetTimestamp: string | null
        isTracked: boolean
      }> = []

      const jsonlFiles = files.filter((f) => f.endsWith('.jsonl') || f.includes('.jsonl.reset.'))

      for (const file of jsonlFiles) {
        const isReset = file.includes('.jsonl.reset.')
        let sessionId: string
        let resetTimestamp: string | null = null

        if (isReset) {
          // Format: <sessionId>.jsonl.reset.<timestamp>
          const match = /^([^.]+)\.jsonl\.reset\.(.+)$/.exec(file)
          if (!match) continue
          sessionId = match[1]
          resetTimestamp = match[2]
        } else {
          // Format: <sessionId>.jsonl
          sessionId = file.replace('.jsonl', '')
        }

        // Skip non-UUID-looking names (like sessions.json parsed wrong)
        if (sessionId.length < 8) continue

        const trackedKey = sessionIdToKey[sessionId] ?? null
        const trackedMeta = trackedKey ? trackedSessions[trackedKey] : null

        // Get file modification time as fallback for updatedAt
        let updatedAt = trackedMeta?.updatedAt ?? null
        if (!updatedAt) {
          try {
            const stat = await fs.promises.stat(path.join(sessionsDir, file))
            updatedAt = stat.mtimeMs
          } catch {
            // ignore
          }
        }

        // Parse reset timestamp for sorting
        if (isReset && resetTimestamp && !updatedAt) {
          // resetTimestamp format: 2026-03-14T10-01-13.144Z
          const isoStr = resetTimestamp.replace(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/, '$1T$2:$3:$4')
          const parsed = Date.parse(isoStr)
          if (!isNaN(parsed)) updatedAt = parsed
        }

        // Read first user message as preview
        let firstUserMessage: string | null = null
        try {
          const filePath = path.join(sessionsDir, file)
          const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
          const rlInner = readline.createInterface({ input: stream, crlfDelay: Infinity })
          for await (const line of rlInner) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line) as Record<string, unknown>
              if (parsed.type !== 'message') continue
              const msg = parsed.message as Record<string, unknown> | undefined
              if (msg?.role === 'user') {
                const content = msg.content
                if (typeof content === 'string') {
                  firstUserMessage = content.slice(0, 100)
                } else if (Array.isArray(content)) {
                  const textBlock = (content as Array<Record<string, unknown>>).find((b) => b.type === 'text')
                  if (textBlock && typeof textBlock.text === 'string') {
                    // Strip the "Sender (untrusted metadata)" prefix
                    let text = textBlock.text
                    const senderEnd = text.indexOf('\n```\n')
                    if (senderEnd !== -1 && text.startsWith('Sender')) {
                      text = text.slice(senderEnd + 5).trim()
                    }
                    firstUserMessage = text.slice(0, 100)
                  }
                }
                break
              }
            } catch {
              // skip
            }
          }
          rlInner.close()
        } catch {
          // ignore
        }

        sessions.push({
          sessionId,
          sessionKey: trackedKey,
          updatedAt,
          displayName: trackedMeta?.displayName ?? firstUserMessage,
          isReset,
          resetTimestamp,
          isTracked: !!trackedKey,
        })
      }

      // Sort by updatedAt descending
      sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))

      return { ok: true, result: { sessions } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
    }
  })
}
