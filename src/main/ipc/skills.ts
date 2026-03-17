import type { IpcMain } from 'electron'
import { net } from 'electron'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { gw } from './gw'
import { isRecord, readOpenclawConfig as readConfig, writeOpenclawConfig as writeConfig } from '../lib/openclaw-config'
import { getBundledNpmBin } from '../lib/openclaw-paths'

const CLAWHUB_REGISTRY = process.env.CLAWHUB_REGISTRY || 'https://clawhub.ai'

// ── In-memory cache to avoid 429 rate limits ─────────────────────────────────
interface CacheEntry<T> { data: T; expiresAt: number }
const apiCache = new Map<string, CacheEntry<unknown>>()

function getCached<T>(key: string): T | undefined {
  const entry = apiCache.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    apiCache.delete(key)
    return undefined
  }
  return entry.data as T
}

function setCache<T>(key: string, data: T, ttlMs: number): void {
  apiCache.set(key, { data, expiresAt: Date.now() + ttlMs })
}

const CACHE_TTL_EXPLORE = 15 * 60_000  // 15 min for explore/browse
const CACHE_TTL_SEARCH  = 5 * 60_000   // 5 min for search

/** Helper: make a JSON GET request to the ClawHub API */
async function clawHubGet<T>(path: string): Promise<T> {
  const url = `${CLAWHUB_REGISTRY}${path}`
  console.log(`[ClawHub] GET ${url}`)
  return new Promise<T>((resolve, reject) => {
    const request = net.request({ url, method: 'GET' })
    request.setHeader('Accept', 'application/json')
    request.setHeader('User-Agent', 'EasiestClaw-Desktop')

    let body = ''
    request.on('response', (response) => {
      console.log(`[ClawHub] ${response.statusCode} ${url}`)
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.on('data', (chunk) => { body += chunk.toString() })
        response.on('end', () => reject(new Error(`HTTP ${response.statusCode}: ${body}`)))
        return
      }
      response.on('data', (chunk) => { body += chunk.toString() })
      response.on('end', () => {
        try { resolve(JSON.parse(body) as T) }
        catch { reject(new Error('Invalid JSON response')) }
      })
    })
    request.on('error', (err) => {
      console.error(`[ClawHub] Error ${url}:`, err.message)
      reject(err)
    })
    request.end()
  })
}

export const registerSkillsHandlers = (ipcMain: IpcMain): void => {
  // Clear API cache (used by marketplace refresh button)
  ipcMain.handle('clawhub:cache-clear', () => {
    apiCache.clear()
    return { ok: true }
  })

  // Get global skills list from gateway
  ipcMain.handle('skills:list', async () => {
    return gw('skills.status', {})
  })

  // Toggle a skill globally via gateway
  ipcMain.handle('skills:toggle', async (_event, params: { name: string; enabled: boolean }) => {
    return gw('skills.update', { name: params.name, enabled: params.enabled })
  })

  // Search ClawHub marketplace
  ipcMain.handle('clawhub:search', async (_event, params: { query: string; limit?: number }) => {
    try {
      const q = encodeURIComponent(params.query)
      const limit = params.limit ?? 20
      const cacheKey = `search:${q}:${limit}`
      const cached = getCached<{ ok: true; results: unknown[] }>(cacheKey)
      if (cached) return cached
      const data = await clawHubGet<{ results?: unknown[] }>(`/api/v1/search?q=${q}&limit=${limit}`)
      const result = { ok: true as const, results: Array.isArray(data.results) ? data.results : [] }
      setCache(cacheKey, result, CACHE_TTL_SEARCH)
      return result
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Search failed' }
    }
  })

  // Browse / explore ClawHub skills
  // NOTE: /api/v1/skills browse endpoint returns empty results, so we use
  // the search endpoint with a broad query as a workaround.
  ipcMain.handle('clawhub:explore', async (_event, params: { limit?: number; cursor?: string }) => {
    try {
      const limit = params.limit ?? 30
      const cacheKey = `explore:${limit}:${params.cursor ?? ''}`
      const cached = getCached<{ ok: true; items: unknown[]; nextCursor: string | null }>(cacheKey)
      if (cached) {
        console.log(`[ClawHub] explore cache hit (${cached.items.length} items)`)
        return cached
      }
      // Use search with broad queries to populate the "explore" view
      const queries = ['skill', 'agent', 'code', 'web', 'data']
      const allItems = new Map<string, unknown>()
      for (const q of queries) {
        if (allItems.size >= limit) break
        try {
          const data = await clawHubGet<{ results?: unknown[] }>(`/api/v1/search?q=${q}&limit=${limit}`)
          if (Array.isArray(data.results)) {
            for (const item of data.results) {
              const slug = (item as Record<string, unknown>).slug as string
              if (slug && !allItems.has(slug)) allItems.set(slug, item)
            }
          }
        } catch { /* skip failed queries */ }
      }
      console.log(`[ClawHub] explore fetched ${allItems.size} unique items via search`)
      const result = {
        ok: true as const,
        items: [...allItems.values()].slice(0, limit),
        nextCursor: null,
      }
      setCache(cacheKey, result, CACHE_TTL_EXPLORE)
      return result
    } catch (err) {
      console.error(`[ClawHub] explore error:`, err instanceof Error ? err.message : err)
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to fetch skills' }
    }
  })

  // Install a skill from ClawHub via `npx clawhub install <slug>`
  // Includes automatic retry on rate-limit (429) errors
  ipcMain.handle('clawhub:install', async (_event, params: { name: string; installId: string; timeoutMs?: number }) => {
    const slug = params.name
    const timeoutMs = params.timeoutMs ?? 120_000
    const maxRetries = 3
    const retryDelayMs = 5_000 // wait 5s between retries

    // Resolve the openclaw state dir (~/.openclaw) as CLAWHUB_WORKDIR
    const stateDir = process.env.OPENCLAW_STATE_DIR?.trim()
      ? path.resolve(process.env.OPENCLAW_STATE_DIR.trim().replace(/^~(?=$|[\\/])/, os.homedir()))
      : path.join(os.homedir(), '.openclaw')

    // Use bundled npm to run `npx --yes clawhub install <slug>`
    const npmBin = getBundledNpmBin()
    const npxBin = npmBin.replace(/npm(\.cmd)?$/, 'npx$1')

    const runInstall = (): Promise<{ ok: boolean; error?: string }> =>
      new Promise((resolve) => {
        const child = spawn(npxBin, ['--yes', 'clawhub', 'install', slug], {
          cwd: stateDir,
          env: {
            ...process.env,
            CLAWHUB_WORKDIR: stateDir,
            CI: 'true',
            FORCE_COLOR: '0',
          },
          windowsHide: true,
          shell: process.platform === 'win32',
        })

        let stdout = ''
        let stderr = ''

        child.stdout?.on('data', (d) => { stdout += d.toString() })
        child.stderr?.on('data', (d) => { stderr += d.toString() })

        const timer = setTimeout(() => {
          child.kill()
          resolve({ ok: false, error: `Install timed out after ${timeoutMs / 1000}s` })
        }, timeoutMs)

        child.on('error', (err) => {
          clearTimeout(timer)
          resolve({ ok: false, error: err.message })
        })

        child.on('close', (code) => {
          clearTimeout(timer)
          if (code === 0) {
            resolve({ ok: true })
          } else {
            const errMsg = stderr.trim() || stdout.trim() || `Exit code ${code}`
            resolve({ ok: false, error: errMsg })
          }
        })
      })

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await runInstall()
      if (result.ok) return result

      // Retry on rate-limit errors
      const isRateLimit = result.error?.toLowerCase().includes('rate limit')
      if (!isRateLimit || attempt >= maxRetries) return result

      // Wait before retrying
      await new Promise((r) => setTimeout(r, retryDelayMs))
    }

    return { ok: false, error: 'Install failed after retries' }
  })

  // Get per-agent skill allowlist from openclaw.json
  // Returns: { ok: true, skills: string[] | null }
  // null = all skills enabled (no custom allowlist)
  // string[] = only these skills are allowed ([] = none)
  ipcMain.handle('openclaw:agent-skills:get', (_event, agentId: string) => {
    try {
      const config = readConfig()
      const agents = isRecord(config.agents) ? config.agents : {}
      const list = Array.isArray(agents.list) ? (agents.list as unknown[]) : []
      const agent = list.find(
        (a): a is Record<string, unknown> => isRecord(a) && a.id === agentId
      )
      if (!agent) return { ok: true, skills: null }
      const skills = Array.isArray(agent.skills) ? (agent.skills as string[]) : null
      return { ok: true, skills }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Set per-agent skill allowlist in openclaw.json
  // params.skills = null → remove field (all enabled)
  // params.skills = [] → no skills
  // params.skills = ['a','b'] → only those skills
  ipcMain.handle('openclaw:agent-skills:set', (
    _event,
    params: { agentId: string; skills: string[] | null }
  ) => {
    try {
      const config = readConfig()
      if (!isRecord(config.agents)) config.agents = {}
      const agentsObj = config.agents as Record<string, unknown>
      if (!Array.isArray(agentsObj.list)) agentsObj.list = []
      const list = agentsObj.list as Record<string, unknown>[]
      const idx = list.findIndex((a) => isRecord(a) && a.id === params.agentId)

      if (idx === -1) {
        // Agent not in config file yet — add minimal entry
        const entry: Record<string, unknown> = { id: params.agentId }
        if (params.skills !== null) entry.skills = params.skills
        list.push(entry)
      } else {
        if (params.skills === null) {
          delete list[idx].skills
        } else {
          list[idx] = { ...list[idx], skills: params.skills }
        }
      }

      writeConfig(config)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
}
