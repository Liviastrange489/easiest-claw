import type { IpcMain } from 'electron'
import { readOpenclawConfig, writeOpenclawConfig, isRecord } from '../lib/openclaw-config'

export const registerChannelHandlers = (ipcMain: IpcMain): void => {
  // Read all channel configs from openclaw.json
  ipcMain.handle('openclaw:channels:get', () => {
    try {
      const config = readOpenclawConfig()
      const channels = isRecord(config.channels) ? config.channels : {}
      return { ok: true, channels }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  // Write a specific channel config to openclaw.json
  ipcMain.handle(
    'openclaw:channels:set',
    (_event, params: { channelId: string; config: Record<string, unknown> }) => {
      try {
        const root = readOpenclawConfig()
        const channels = isRecord(root.channels) ? { ...root.channels } : {}
        channels[params.channelId] = params.config
        writeOpenclawConfig({ ...root, channels })
        return { ok: true }
      } catch (err) {
        return { ok: false, error: String(err) }
      }
    },
  )
}
