import { getRuntime } from '../gateway/runtime'
import { traceDebug } from '../lib/debug-trace'

/**
 * Wrap a gateway request with a consistent { ok, result } / { ok, error } shape.
 * Returns { ok: false } immediately when the adapter is not connected.
 */
export const gw = async <T>(
  method: string,
  params: unknown,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> => {
  const startedAt = Date.now()
  traceDebug('gw.request', { method, params }, 'main.gw')
  const adapter = getRuntime()
  if (!adapter) {
    const response = { ok: false as const, error: 'Gateway not connected.' }
    traceDebug(
      'gw.response',
      { method, durationMs: Date.now() - startedAt, ...response },
      'main.gw',
    )
    return response
  }
  try {
    const result = await adapter.request<T>(method, params)
    const response = { ok: true as const, result }
    traceDebug(
      'gw.response',
      { method, durationMs: Date.now() - startedAt, ok: true, result },
      'main.gw',
    )
    return response
  } catch (err) {
    const response = {
      ok: false as const,
      error: err instanceof Error ? err.message : 'Unknown error',
    }
    traceDebug(
      'gw.response',
      { method, durationMs: Date.now() - startedAt, ...response },
      'main.gw',
    )
    return response
  }
}
