import { createHash } from 'node:crypto'
import { mediaSafeError } from '../../../shared/contracts/media.js'
import type { VideoWorkbenchIpcResponse } from '../../../shared/contracts/videoWorkbenchPreload.js'
import { ElectronVideoWorkbenchActionError } from '../services/videoWorkbenchActions.js'

/**
 * Electron strips custom Error fields at the renderer boundary.  Video
 * commands therefore resolve expected failures as the same typed safe envelope
 * used by the renderer state machine.
 */
export async function videoWorkbenchIpcResponse<Value>(
  action: () => Value | Promise<Value>,
): Promise<VideoWorkbenchIpcResponse<Value>> {
  try {
    return { ok: true, value: await action() }
  } catch (error) {
    const code = error instanceof ElectronVideoWorkbenchActionError
      ? error.code
      : 'MEDIA_TEMPORARILY_UNAVAILABLE'
    return { ok: false, error: mediaSafeError(code) }
  }
}

type ReplayEntry<Value> = Readonly<{
  requestHash: string
  expiresAt: number
  value: Promise<Value>
}>

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * Main-only replay receipt for paths that the Sidecar cannot yet make
 * idempotent (notably a consumed native source or save grant). Replaying the
 * same key with different public input fails closed. The cache is deliberately
 * volatile: after an app restart an expired/unknown local grant requires a new
 * explicit native selection instead of recovering a path from disk.
 */
export class VideoWorkbenchReplayCache {
  private readonly entries = new Map<string, ReplayEntry<unknown>>()

  constructor(private readonly ttlMs = 10 * 60_000) {}

  async execute<Value>(
    scope: string,
    idempotencyKey: string,
    request: unknown,
    action: () => Promise<Value>,
    now = Date.now(),
  ): Promise<Value> {
    const key = `${scope}\0${idempotencyKey}`
    const requestHash = `sha256:${createHash('sha256').update(canonicalJson(request)).digest('hex')}`
    const existing = this.entries.get(key)
    if (existing && existing.expiresAt > now) {
      if (existing.requestHash !== requestHash) throw new ElectronVideoWorkbenchActionError('MEDIA_INVALID_REQUEST')
      return await existing.value as Value
    }
    if (existing) this.entries.delete(key)
    const value = action()
    this.entries.set(key, { requestHash, expiresAt: now + this.ttlMs, value })
    return await value
  }

  revokeAll(): void {
    this.entries.clear()
  }
}
