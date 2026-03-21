import type { IpcMain } from 'electron'
import { getDebugTraceStatus, setDebugTraceEnabled, traceDebug } from '../lib/debug-trace'

export const registerDebugHandlers = (ipcMain: IpcMain): void => {
  ipcMain.handle('debug:trace:status', () => getDebugTraceStatus())

  ipcMain.handle(
    'debug:trace:set-enabled',
    (_event, params: { enabled?: boolean } | boolean) => {
      const enabled =
        typeof params === 'boolean'
          ? params
          : typeof params?.enabled === 'boolean'
            ? params.enabled
            : true
      return setDebugTraceEnabled(enabled)
    },
  )

  ipcMain.handle(
    'debug:trace:append',
    (_event, params: { event?: string; data?: unknown; source?: string }) => {
      const event =
        typeof params?.event === 'string' && params.event.trim().length > 0
          ? params.event.trim()
          : 'renderer.trace'
      const source =
        typeof params?.source === 'string' && params.source.trim().length > 0
          ? params.source.trim()
          : 'renderer'
      traceDebug(event, params?.data, source)
      return { ok: true }
    },
  )
}
