import type { IpcMain } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { getOpenclawStateDir, getOpenclawConfigPath } from '../lib/openclaw-config'

// ── Types ────────────────────────────────────────────────────────────────────

interface PluginInfo {
  id: string
  name?: string
  version?: string
  description?: string
  kind?: string
  origin: 'bundled' | 'installed' | 'load-path'
  enabled: boolean
  source?: string
  installPath?: string
}

interface PluginManifest {
  id: string
  name?: string
  version?: string
  description?: string
  kind?: string
  configSchema?: Record<string, unknown>
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v && typeof v === 'object' && !Array.isArray(v))

async function readConfigAsync(): Promise<Record<string, unknown>> {
  const p = getOpenclawConfigPath()
  try {
    const raw = await fs.readFile(p, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeConfigAsync(config: Record<string, unknown>): Promise<void> {
  const p = getOpenclawConfigPath()
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, JSON.stringify(config, null, 2), 'utf8')
}

async function readManifest(dir: string): Promise<PluginManifest | null> {
  try {
    const raw = await fs.readFile(path.join(dir, 'openclaw.plugin.json'), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && typeof parsed.id === 'string') {
      return parsed as unknown as PluginManifest
    }
    return null
  } catch {
    return null
  }
}

async function scanExtensionsDir(dir: string): Promise<Map<string, { manifest: PluginManifest; dir: string }>> {
  const result = new Map<string, { manifest: PluginManifest; dir: string }>()
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const tasks = entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const pluginDir = path.join(dir, e.name)
        const manifest = await readManifest(pluginDir)
        if (manifest) result.set(manifest.id, { manifest, dir: pluginDir })
      })
    await Promise.all(tasks)
  } catch {
    // directory doesn't exist — fine
  }
  return result
}

const BUNDLED_ENABLED_BY_DEFAULT = new Set([
  'device-pair', 'ollama', 'phone-control', 'sglang', 'talk-voice', 'vllm',
])

function resolveEnabled(
  pluginId: string,
  origin: 'bundled' | 'installed' | 'load-path',
  pluginsConfig: Record<string, unknown>,
): boolean {
  const entries = isRecord(pluginsConfig.entries) ? pluginsConfig.entries : {}
  const entry = isRecord(entries[pluginId]) ? entries[pluginId] : null

  // Explicit enabled/disabled in entries
  if (entry && typeof entry.enabled === 'boolean') return entry.enabled

  // allow/deny lists
  const allow = Array.isArray(pluginsConfig.allow) ? pluginsConfig.allow as string[] : []
  const deny = Array.isArray(pluginsConfig.deny) ? pluginsConfig.deny as string[] : []
  if (deny.includes(pluginId)) return false
  if (allow.length > 0 && !allow.includes(pluginId)) {
    // If allow list exists and plugin not in it, only bundled defaults are enabled
    return origin === 'bundled' && BUNDLED_ENABLED_BY_DEFAULT.has(pluginId)
  }

  // Bundled defaults
  if (origin === 'bundled') return BUNDLED_ENABLED_BY_DEFAULT.has(pluginId)

  // Installed plugins default to enabled
  return true
}

// ── List ─────────────────────────────────────────────────────────────────────

async function listPlugins(): Promise<PluginInfo[]> {
  const config = await readConfigAsync()
  const pluginsConfig = isRecord(config.plugins) ? config.plugins : {}
  const installs = isRecord(pluginsConfig.installs)
    ? pluginsConfig.installs as Record<string, Record<string, unknown>>
    : {}

  const stateDir = getOpenclawStateDir()
  const globalExtDir = path.join(stateDir, 'extensions')

  // Scan bundled extensions (inside app resources, if exists)
  let bundledExtDir: string | undefined
  try {
    // In packaged app: process.resourcesPath; in dev: resources/openclaw/extensions
    const candidates = [
      path.join(process.resourcesPath ?? '', 'openclaw', 'extensions'),
      path.join(process.cwd(), 'resources', 'openclaw', 'extensions'),
    ]
    for (const c of candidates) {
      try {
        await fs.access(c)
        bundledExtDir = c
        break
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  const [globalPlugins, bundledPlugins] = await Promise.all([
    scanExtensionsDir(globalExtDir),
    bundledExtDir ? scanExtensionsDir(bundledExtDir) : Promise.resolve(new Map()),
  ])

  const plugins: PluginInfo[] = []
  const seen = new Set<string>()

  // Bundled plugins
  for (const [id, { manifest, dir }] of bundledPlugins) {
    seen.add(id)
    plugins.push({
      id,
      name: manifest.name ?? id,
      version: manifest.version,
      description: manifest.description,
      kind: manifest.kind,
      origin: 'bundled',
      enabled: resolveEnabled(id, 'bundled', pluginsConfig),
      installPath: dir,
    })
  }

  // Global installed plugins
  for (const [id, { manifest, dir }] of globalPlugins) {
    if (seen.has(id)) continue
    seen.add(id)
    const installRecord = isRecord(installs[id]) ? installs[id] : null
    plugins.push({
      id,
      name: manifest.name ?? id,
      version: manifest.version,
      description: manifest.description,
      kind: manifest.kind,
      origin: installRecord?.source === 'path' ? 'load-path' : 'installed',
      enabled: resolveEnabled(id, 'installed', pluginsConfig),
      source: typeof installRecord?.spec === 'string' ? installRecord.spec : undefined,
      installPath: dir,
    })
  }

  // Plugins in config.installs but not found on disk (orphaned records)
  for (const [id, record] of Object.entries(installs)) {
    if (seen.has(id) || !isRecord(record)) continue
    seen.add(id)
    plugins.push({
      id,
      name: id,
      origin: record.source === 'path' ? 'load-path' : 'installed',
      enabled: resolveEnabled(id, 'installed', pluginsConfig),
      source: typeof record.spec === 'string' ? record.spec : undefined,
      installPath: typeof record.installPath === 'string' ? record.installPath : undefined,
    })
  }

  // Plugins only in entries (no install record, no manifest on disk)
  const entries = isRecord(pluginsConfig.entries) ? pluginsConfig.entries : {}
  for (const id of Object.keys(entries)) {
    if (seen.has(id)) continue
    seen.add(id)
    plugins.push({
      id,
      name: id,
      origin: 'installed',
      enabled: resolveEnabled(id, 'installed', pluginsConfig),
    })
  }

  return plugins.sort((a, b) => a.id.localeCompare(b.id))
}

// ── Uninstall ────────────────────────────────────────────────────────────────

async function uninstallPlugin(pluginId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const config = await readConfigAsync()
  const pluginsConfig = isRecord(config.plugins) ? config.plugins : {}

  // 1. Remove from entries
  if (isRecord(pluginsConfig.entries)) {
    const { [pluginId]: _, ...rest } = pluginsConfig.entries
    pluginsConfig.entries = rest
  }

  // 2. Remove from installs, capture install record for directory deletion
  let installRecord: Record<string, unknown> | null = null
  let isLinked = false
  if (isRecord(pluginsConfig.installs)) {
    const rec = pluginsConfig.installs[pluginId]
    if (isRecord(rec)) {
      installRecord = rec
      isLinked = rec.source === 'path'
    }
    const { [pluginId]: _, ...rest } = pluginsConfig.installs
    pluginsConfig.installs = rest
  }

  // 3. Remove from allow list
  if (Array.isArray(pluginsConfig.allow)) {
    pluginsConfig.allow = (pluginsConfig.allow as string[]).filter((id) => id !== pluginId)
  }

  // 4. Remove from load.paths
  if (isRecord(pluginsConfig.load) && Array.isArray(pluginsConfig.load.paths)) {
    const sourcePath = typeof installRecord?.installPath === 'string' ? installRecord.installPath : null
    if (sourcePath) {
      pluginsConfig.load.paths = (pluginsConfig.load.paths as string[]).filter(
        (p) => path.resolve(p) !== path.resolve(sourcePath),
      )
    }
  }

  // 5. Reset memory slot if it points to this plugin
  if (isRecord(pluginsConfig.slots) && pluginsConfig.slots.memory === pluginId) {
    pluginsConfig.slots.memory = 'memory-lancedb' // default
  }

  config.plugins = pluginsConfig
  await writeConfigAsync(config)

  // 6. Delete extension directory (non-linked only)
  if (!isLinked) {
    const stateDir = getOpenclawStateDir()
    const extDir = path.join(stateDir, 'extensions', pluginId)
    try {
      await fs.rm(extDir, { recursive: true, force: true })
    } catch {
      // Directory deletion failure is not fatal
    }
  }

  return { ok: true }
}

// ── Register ─────────────────────────────────────────────────────────────────

export function registerPluginHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('openclaw:plugins:list', async () => {
    try {
      const plugins = await listPlugins()
      return { ok: true, plugins }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  ipcMain.handle('openclaw:plugins:uninstall', async (_event, params: { pluginId: string }) => {
    try {
      return await uninstallPlugin(params.pluginId)
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })
}
