import type { IpcMain } from 'electron'
import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { loadSettings, patchSettings, loadOpenclawDefaults } from '../gateway/settings'
import { restartRuntime } from '../gateway/runtime'
import { getDataDir } from '../lib/data-dir'

export const registerSettingsHandlers = (ipcMain: IpcMain): void => {
  // Load current app settings (gateway URL/token, avatars)
  ipcMain.handle('settings:get', async () => {
    const settings = loadSettings()
    // Redact token from response — renderer doesn't need to display it
    return {
      gateway: settings.gateway
        ? { url: settings.gateway.url, hasToken: Boolean(settings.gateway.token) }
        : null,
      avatars: settings.avatars
    }
  })

  // Get full settings including token (for settings form)
  ipcMain.handle('settings:get-full', async () => {
    return loadSettings()
  })

  // Save gateway connection settings and restart
  ipcMain.handle('settings:save-gateway', async (_event, params: { url: string; token: string }) => {
    try {
      patchSettings({ gateway: { url: params.url.trim(), token: params.token.trim() } })
      await restartRuntime()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Failed to save settings' }
    }
  })

  // Save avatar for an agent
  ipcMain.handle('settings:save-avatar', async (_event, params: { gatewayUrl: string; agentId: string; seed: string }) => {
    const current = loadSettings()
    const gatewayKey = params.gatewayUrl || current.gateway?.url || 'local'
    patchSettings({
      avatars: {
        ...current.avatars,
        [gatewayKey]: {
          ...(current.avatars[gatewayKey] ?? {}),
          [params.agentId]: params.seed
        }
      }
    })
    return { ok: true }
  })

  // Auto-detect local openclaw settings
  ipcMain.handle('settings:detect-local', async () => {
    const defaults = loadOpenclawDefaults()
    return defaults ?? null
  })

  // ── 数据存储目录 ───────────────────────────────────────────────────────────────

  ipcMain.handle('settings:get-data-dir', async () => {
    const current = getDataDir()
    const defaultDir = app.getPath('userData')
    return { dir: current, isCustom: current !== defaultDir, defaultDir }
  })

  ipcMain.handle('settings:set-data-dir', async (_event, params: { dir: string }) => {
    const dir = params.dir?.trim()
    if (!dir) return { ok: false, error: 'dir is required' }

    // 记录旧数据目录，重启时触发迁移
    const oldDir = getDataDir()
    const resolved = path.resolve(dir)
    if (resolved !== oldDir) {
      // 确保目标目录存在
      if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true })
      }
      // 写入 _migrateFrom 标记到 settings.json（patchSettings 不识别此字段，直接写文件）
      const settingsFile = path.join(app.getPath('userData'), 'settings.json')
      try {
        const raw = fs.existsSync(settingsFile)
          ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
          : {}
        raw._migrateFrom = oldDir
        raw.customDataDir = dir
        fs.writeFileSync(settingsFile, JSON.stringify(raw, null, 2), 'utf8')
      } catch {
        // 回退到 patchSettings
        patchSettings({ customDataDir: dir })
      }
    } else {
      patchSettings({ customDataDir: dir })
    }

    return { ok: true, needRestart: true }
  })

  ipcMain.handle('settings:reset-data-dir', async () => {
    // 记录旧数据目录，重启时触发迁移回默认位置
    const oldDir = getDataDir()
    const defaultDir = app.getPath('userData')
    if (oldDir !== defaultDir) {
      const settingsFile = path.join(defaultDir, 'settings.json')
      try {
        const raw = fs.existsSync(settingsFile)
          ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')) as Record<string, unknown>
          : {}
        raw._migrateFrom = oldDir
        delete raw.customDataDir
        fs.writeFileSync(settingsFile, JSON.stringify(raw, null, 2), 'utf8')
      } catch {
        patchSettings({ customDataDir: undefined })
      }
    } else {
      patchSettings({ customDataDir: undefined })
    }
    return { ok: true, needRestart: true }
  })
}
