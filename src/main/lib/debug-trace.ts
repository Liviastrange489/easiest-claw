import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 20 * 1024 * 1024
const MAX_DEPTH = 5
const MAX_STRING = 4000
const MAX_ARRAY = 80
const MAX_KEYS = 120

let tracePath: string | null = null
let enabled = process.env.EASIEST_CLAW_TRACE !== '0'
let writeCount = 0
let dropCount = 0

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

const REDACT_KEYS = new Set([
  'token',
  'apikey',
  'api_key',
  'authorization',
  'password',
  'secret',
  'signature',
  'privatekey',
  'private_key',
])

function ensureTracePath(): string {
  if (tracePath) return tracePath
  let dir: string
  try {
    dir = app.getPath('logs')
  } catch {
    dir = path.join(process.cwd(), 'logs')
  }
  fs.mkdirSync(dir, { recursive: true })
  tracePath = path.join(dir, 'debug-trace.jsonl')
  return tracePath
}

function rotateIfNeeded(filePath: string): void {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_BYTES) {
      const oldPath = `${filePath}.old`
      try {
        fs.rmSync(oldPath, { force: true })
      } catch {
        // ignore
      }
      fs.renameSync(filePath, oldPath)
    }
  } catch {
    // file not exists yet
  }
}

function truncateString(input: string): string {
  if (input.length <= MAX_STRING) return input
  return `${input.slice(0, MAX_STRING)}...[truncated:${input.length - MAX_STRING}]`
}

function normalizeForJson(value: unknown, depth = 0, seen?: WeakSet<object>): JsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return truncateString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return '[max_depth]' as JsonValue
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'function') return '[function]'
  if (typeof value === 'symbol') return String(value)
  if (value instanceof Error) {
    return {
      name: value.name,
      message: truncateString(value.message),
      stack: truncateString(value.stack ?? ''),
    }
  }
  if (value instanceof Date) return value.toISOString()

  if (Array.isArray(value)) {
    const arr = value.slice(0, MAX_ARRAY).map((v) => normalizeForJson(v, depth + 1, seen))
    if (value.length > MAX_ARRAY) {
      arr.push(`[truncated:${value.length - MAX_ARRAY}]`)
    }
    return arr
  }

  if (typeof value === 'object') {
    const ref = value as object
    const refs = seen ?? new WeakSet<object>()
    if (refs.has(ref)) return '[circular]'
    refs.add(ref)
    const out: Record<string, JsonValue> = {}
    const entries = Object.entries(value as Record<string, unknown>).slice(0, MAX_KEYS)
    for (const [k, v] of entries) {
      const key = k.toLowerCase()
      if (REDACT_KEYS.has(key)) {
        out[k] = '[redacted]'
      } else {
        out[k] = normalizeForJson(v, depth + 1, refs)
      }
    }
    if (Object.keys(value as Record<string, unknown>).length > MAX_KEYS) {
      out.__truncatedKeys = `[truncated:${Object.keys(value as Record<string, unknown>).length - MAX_KEYS}]`
    }
    return out
  }

  return String(value)
}

export function traceDebug(event: string, data?: unknown, source = 'main'): void {
  if (!enabled) {
    dropCount += 1
    return
  }
  try {
    const filePath = ensureTracePath()
    rotateIfNeeded(filePath)
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      source,
      event,
      data: normalizeForJson(data),
    })
    fs.appendFileSync(filePath, `${line}\n`, 'utf8')
    writeCount += 1
  } catch {
    dropCount += 1
  }
}

export function setDebugTraceEnabled(nextEnabled: boolean): {
  enabled: boolean
  path: string
  writes: number
  dropped: number
} {
  enabled = nextEnabled
  return getDebugTraceStatus()
}

export function getDebugTraceStatus(): {
  enabled: boolean
  path: string
  writes: number
  dropped: number
} {
  return {
    enabled,
    path: ensureTracePath(),
    writes: writeCount,
    dropped: dropCount,
  }
}


