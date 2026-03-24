let debugEnabled = true

export function setRendererDebugEnabled(nextEnabled: boolean): void {
  debugEnabled = nextEnabled
}

export function isRendererDebugEnabled(): boolean {
  return debugEnabled
}

export function rendererDebugLog(...args: unknown[]): void {
  if (!debugEnabled) return
  console.log(...args)
}

