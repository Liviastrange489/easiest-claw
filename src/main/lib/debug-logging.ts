import { loadSettings } from '../gateway/settings'

let debugEnabled = process.env.EASIEST_CLAW_DEBUG !== '0'

try {
  const settings = loadSettings()
  if (typeof settings.debug?.enabled === 'boolean') {
    debugEnabled = settings.debug.enabled
  }
} catch {
  // Ignore settings read errors and use env/default value.
}

export function isDebugLoggingEnabled(): boolean {
  return debugEnabled
}

export function setDebugLoggingEnabled(nextEnabled: boolean): boolean {
  debugEnabled = nextEnabled
  return debugEnabled
}

export function debugLog(...args: unknown[]): void {
  if (!debugEnabled) return
  console.log(...args)
}

