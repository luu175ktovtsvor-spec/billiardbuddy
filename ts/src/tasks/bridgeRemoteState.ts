import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type BridgeRemoteEventKind = 'sdk_message' | 'control_request' | 'control_response' | 'control_cancel_request'
export type BridgeRemotePermissionStatus = 'pending' | 'allowed' | 'denied' | 'cancelled'
export type BridgeRemoteOutboxStatus = 'queued' | 'sent'

export interface BridgeRemoteEventRecord {
  id: string
  seq: number
  sessionId: string
  kind: BridgeRemoteEventKind
  type: string
  payload: Record<string, unknown>
  receivedAt: string
}

export interface BridgeRemotePermissionRequestRecord {
  sessionId: string
  requestId: string
  toolName: string
  toolUseId: string
  input: Record<string, unknown>
  permissionSuggestions?: unknown[]
  blockedPath?: string
  decisionReason?: string
  title?: string
  displayName?: string
  agentId?: string
  description?: string
  status: BridgeRemotePermissionStatus
  response?: BridgeRemotePermissionResponse
  createdAt: string
  updatedAt: string
}

export type BridgeRemotePermissionResponse =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }

export interface BridgeRemoteOutboxItem {
  id: string
  sessionId: string
  requestId: string
  kind: 'control_response'
  payload: {
    type: 'control_response'
    response: {
      subtype: 'success'
      request_id: string
      response: Record<string, unknown>
    }
  }
  status: BridgeRemoteOutboxStatus
  createdAt: string
  sentAt?: string
}

interface BridgeRemoteStateFile {
  version: 1
  nextSeq: number
  events: BridgeRemoteEventRecord[]
  permissions: BridgeRemotePermissionRequestRecord[]
  outbox: BridgeRemoteOutboxItem[]
}

const LOCK_RETRIES = 20
const LOCK_MIN_DELAY_MS = 5
const LOCK_MAX_DELAY_MS = 100
const STALE_LOCK_MS = 30_000
const MAX_EVENTS = 500
const MAX_OUTBOX = 500

function nowIso(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function normalizeSessionId(value: string): string {
  const raw = value.trim()
  const sessionId = raw.startsWith('bridge:') ? raw.slice('bridge:'.length) : raw
  if (!sessionId) throw new Error('sessionId is required')
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(sessionId)) throw new Error('sessionId contains unsupported characters')
  return sessionId
}

function normalizeRequestId(value: string): string {
  const requestId = value.trim()
  if (!requestId) throw new Error('requestId is required')
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId)) throw new Error('requestId contains unsupported characters')
  return requestId
}

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha1').update(value).digest('hex').slice(0, 16)}`
}

function eventKind(type: string): BridgeRemoteEventKind {
  if (type === 'control_request') return 'control_request'
  if (type === 'control_response') return 'control_response'
  if (type === 'control_cancel_request') return 'control_cancel_request'
  return 'sdk_message'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>
}

function normalizeRecordPayload(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('event payload must be an object')
  const type = typeof value.type === 'string' ? value.type.trim() : ''
  if (!type) throw new Error('event payload type is required')
  return cloneRecord(value)
}

function permissionFromControlRequest(sessionId: string, payload: Record<string, unknown>, now: string): BridgeRemotePermissionRequestRecord | null {
  const requestId = typeof payload.request_id === 'string' ? normalizeRequestId(payload.request_id) : ''
  const request = isRecord(payload.request) ? payload.request : null
  if (!request || request.subtype !== 'can_use_tool') return null
  const toolName = typeof request.tool_name === 'string' && request.tool_name.trim() ? request.tool_name.trim() : ''
  const toolUseId = typeof request.tool_use_id === 'string' && request.tool_use_id.trim() ? request.tool_use_id.trim() : ''
  if (!requestId || !toolName || !toolUseId) return null
  return {
    sessionId,
    requestId,
    toolName,
    toolUseId,
    input: isRecord(request.input) ? cloneRecord(request.input) : {},
    permissionSuggestions: Array.isArray(request.permission_suggestions) ? request.permission_suggestions : undefined,
    blockedPath: typeof request.blocked_path === 'string' ? request.blocked_path : undefined,
    decisionReason: typeof request.decision_reason === 'string' ? request.decision_reason : undefined,
    title: typeof request.title === 'string' ? request.title : undefined,
    displayName: typeof request.display_name === 'string' ? request.display_name : undefined,
    agentId: typeof request.agent_id === 'string' ? request.agent_id : undefined,
    description: typeof request.description === 'string' ? request.description : undefined,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  }
}

function normalizePermissionResponse(value: BridgeRemotePermissionResponse): BridgeRemotePermissionResponse {
  if (value.behavior === 'allow') return { behavior: 'allow', updatedInput: cloneRecord(value.updatedInput ?? {}) }
  return { behavior: 'deny', message: value.message.trim() || 'Permission denied' }
}

function outboxPayload(requestId: string, response: BridgeRemotePermissionResponse): BridgeRemoteOutboxItem['payload'] {
  return {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: requestId,
      response: response.behavior === 'allow'
        ? { behavior: 'allow', updatedInput: response.updatedInput }
        : { behavior: 'deny', message: response.message },
    },
  }
}

function normalizeEvent(raw: unknown): BridgeRemoteEventRecord | null {
  if (!isRecord(raw)) return null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const payload = isRecord(raw.payload) ? raw.payload : null
  const type = typeof raw.type === 'string' ? raw.type : typeof payload?.type === 'string' ? payload.type : ''
  const seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0
  if (!sessionId || !payload || !type || seq <= 0) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : hashId('evt', `${sessionId}:${seq}`),
    seq,
    sessionId,
    kind: eventKind(type),
    type,
    payload: cloneRecord(payload),
    receivedAt: typeof raw.receivedAt === 'string' ? raw.receivedAt : nowIso(),
  }
}

function normalizePermission(raw: unknown): BridgeRemotePermissionRequestRecord | null {
  if (!isRecord(raw)) return null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : ''
  const toolName = typeof raw.toolName === 'string' ? raw.toolName.trim() : ''
  const toolUseId = typeof raw.toolUseId === 'string' ? raw.toolUseId.trim() : ''
  if (!sessionId || !requestId || !toolName || !toolUseId) return null
  const status = raw.status === 'allowed' || raw.status === 'denied' || raw.status === 'cancelled' ? raw.status : 'pending'
  return {
    sessionId,
    requestId,
    toolName,
    toolUseId,
    input: isRecord(raw.input) ? cloneRecord(raw.input) : {},
    permissionSuggestions: Array.isArray(raw.permissionSuggestions) ? raw.permissionSuggestions : undefined,
    blockedPath: typeof raw.blockedPath === 'string' ? raw.blockedPath : undefined,
    decisionReason: typeof raw.decisionReason === 'string' ? raw.decisionReason : undefined,
    title: typeof raw.title === 'string' ? raw.title : undefined,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
    agentId: typeof raw.agentId === 'string' ? raw.agentId : undefined,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    status,
    response: isPermissionResponse(raw.response) ? normalizePermissionResponse(raw.response) : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  }
}

function isPermissionResponse(value: unknown): value is BridgeRemotePermissionResponse {
  if (!isRecord(value)) return false
  if (value.behavior === 'allow') return isRecord(value.updatedInput)
  return value.behavior === 'deny' && typeof value.message === 'string'
}

function normalizeOutbox(raw: unknown): BridgeRemoteOutboxItem | null {
  if (!isRecord(raw)) return null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const requestId = typeof raw.requestId === 'string' ? raw.requestId.trim() : ''
  const payload = isRecord(raw.payload) ? raw.payload : null
  if (!sessionId || !requestId || !payload) return null
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : hashId('out', `${sessionId}:${requestId}`),
    sessionId,
    requestId,
    kind: 'control_response',
    payload: cloneRecord(payload) as BridgeRemoteOutboxItem['payload'],
    status: raw.status === 'sent' ? 'sent' : 'queued',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : nowIso(),
    sentAt: typeof raw.sentAt === 'string' ? raw.sentAt : undefined,
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export class BridgeRemoteState {
  private readonly statePath: string
  private queue = Promise.resolve()

  constructor(private readonly stateRoot: string) {
    this.statePath = join(stateRoot, 'bridge-remote', 'state.json')
  }

  async ingestEvent(sessionIdInput: string, eventInput: unknown): Promise<{ event: BridgeRemoteEventRecord; permission?: BridgeRemotePermissionRequestRecord }> {
    return this.withMutation(file => {
      const sessionId = normalizeSessionId(sessionIdInput)
      const payload = normalizeRecordPayload(eventInput)
      const type = String(payload.type)
      const seq = Math.max(file.nextSeq, maxSeq(file.events) + 1)
      file.nextSeq = seq + 1
      const now = nowIso()
      const event: BridgeRemoteEventRecord = {
        id: hashId('evt', `${sessionId}:${seq}:${type}`),
        seq,
        sessionId,
        kind: eventKind(type),
        type,
        payload,
        receivedAt: now,
      }
      file.events.push(event)
      trimEvents(file)
      let permission: BridgeRemotePermissionRequestRecord | undefined
      if (type === 'control_request') {
        const next = permissionFromControlRequest(sessionId, payload, now)
        if (next) {
          const index = file.permissions.findIndex(item => item.sessionId === sessionId && item.requestId === next.requestId)
          if (index >= 0) {
            permission = { ...file.permissions[index]!, ...next, createdAt: file.permissions[index]!.createdAt, updatedAt: now }
            file.permissions[index] = permission
          } else {
            permission = next
            file.permissions.push(permission)
          }
        }
      } else if (type === 'control_cancel_request') {
        const requestId = typeof payload.request_id === 'string' ? normalizeRequestId(payload.request_id) : ''
        if (requestId) {
          const index = file.permissions.findIndex(item => item.sessionId === sessionId && item.requestId === requestId)
          if (index >= 0) {
            const existing = file.permissions[index]!
            permission = { ...existing, status: 'cancelled', updatedAt: now }
            file.permissions[index] = permission
          }
        }
      }
      return { event, ...(permission ? { permission } : {}) }
    })
  }

  async listEvents(sessionIdInput: string, opts: { after?: number; limit?: number } = {}): Promise<BridgeRemoteEventRecord[]> {
    const sessionId = normalizeSessionId(sessionIdInput)
    const file = await this.readFile()
    const after = opts.after ?? 0
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
    return file.events
      .filter(event => event.sessionId === sessionId && event.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
  }

  async listPermissions(sessionIdInput: string, status?: BridgeRemotePermissionStatus): Promise<BridgeRemotePermissionRequestRecord[]> {
    const sessionId = normalizeSessionId(sessionIdInput)
    const file = await this.readFile()
    return file.permissions
      .filter(item => item.sessionId === sessionId && (!status || item.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async respondToPermission(sessionIdInput: string, requestIdInput: string, responseInput: BridgeRemotePermissionResponse): Promise<{ permission: BridgeRemotePermissionRequestRecord; outbox: BridgeRemoteOutboxItem } | null> {
    return this.withMutation(file => {
      const sessionId = normalizeSessionId(sessionIdInput)
      const requestId = normalizeRequestId(requestIdInput)
      const index = file.permissions.findIndex(item => item.sessionId === sessionId && item.requestId === requestId)
      if (index === -1) return null
      const response = normalizePermissionResponse(responseInput)
      const now = nowIso()
      const permission: BridgeRemotePermissionRequestRecord = {
        ...file.permissions[index]!,
        status: response.behavior === 'allow' ? 'allowed' : 'denied',
        response,
        updatedAt: now,
      }
      file.permissions[index] = permission
      const outbox: BridgeRemoteOutboxItem = {
        id: hashId('out', `${sessionId}:${requestId}:${now}:${response.behavior}`),
        sessionId,
        requestId,
        kind: 'control_response',
        payload: outboxPayload(requestId, response),
        status: 'queued',
        createdAt: now,
      }
      file.outbox = [
        ...file.outbox.filter(item => !(item.sessionId === sessionId && item.requestId === requestId && item.status === 'queued')),
        outbox,
      ]
      trimOutbox(file)
      return { permission, outbox }
    })
  }

  async listOutbox(sessionIdInput: string, status?: BridgeRemoteOutboxStatus): Promise<BridgeRemoteOutboxItem[]> {
    const sessionId = normalizeSessionId(sessionIdInput)
    const file = await this.readFile()
    return file.outbox
      .filter(item => item.sessionId === sessionId && (!status || item.status === status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  async markOutboxSent(sessionIdInput: string, outboxId: string): Promise<BridgeRemoteOutboxItem | null> {
    return this.withMutation(file => {
      const sessionId = normalizeSessionId(sessionIdInput)
      const index = file.outbox.findIndex(item => item.sessionId === sessionId && item.id === outboxId)
      if (index === -1) return null
      const item: BridgeRemoteOutboxItem = {
        ...file.outbox[index]!,
        status: 'sent',
        sentAt: nowIso(),
      }
      file.outbox[index] = item
      return item
    })
  }

  private async readFile(): Promise<BridgeRemoteStateFile> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown
      if (!isRecord(raw)) return emptyState()
      const events = Array.isArray(raw.events)
        ? raw.events.map(normalizeEvent).filter((event): event is BridgeRemoteEventRecord => !!event)
        : []
      const permissions = Array.isArray(raw.permissions)
        ? raw.permissions.map(normalizePermission).filter((item): item is BridgeRemotePermissionRequestRecord => !!item)
        : []
      const outbox = Array.isArray(raw.outbox)
        ? raw.outbox.map(normalizeOutbox).filter((item): item is BridgeRemoteOutboxItem => !!item)
        : []
      const nextSeq = typeof raw.nextSeq === 'number' && Number.isFinite(raw.nextSeq)
        ? Math.max(raw.nextSeq, maxSeq(events) + 1)
        : maxSeq(events) + 1
      return { version: 1, nextSeq, events, permissions, outbox }
    } catch {
      return emptyState()
    }
  }

  private async withMutation<T>(fn: (file: BridgeRemoteStateFile) => Promise<T> | T): Promise<T> {
    const run = this.queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.statePath), { recursive: true })
      const lockDir = `${this.statePath}.lock`
      await acquireLockDir(lockDir)
      try {
        const file = await this.readFile()
        const result = await fn(file)
        if (file.events.length === 0 && file.permissions.length === 0 && file.outbox.length === 0) {
          await rm(this.statePath, { force: true }).catch(() => undefined)
        } else {
          await writeJson(this.statePath, file)
        }
        return result
      } finally {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }
}

function emptyState(): BridgeRemoteStateFile {
  return { version: 1, nextSeq: 1, events: [], permissions: [], outbox: [] }
}

function maxSeq(events: BridgeRemoteEventRecord[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

function trimEvents(file: BridgeRemoteStateFile): void {
  if (file.events.length <= MAX_EVENTS) return
  file.events = file.events.slice(file.events.length - MAX_EVENTS)
}

function trimOutbox(file: BridgeRemoteStateFile): void {
  if (file.outbox.length <= MAX_OUTBOX) return
  const sent = file.outbox.filter(item => item.status === 'sent')
  const queued = file.outbox.filter(item => item.status === 'queued')
  file.outbox = [...sent.slice(Math.max(0, sent.length - Math.floor(MAX_OUTBOX / 2))), ...queued].slice(-MAX_OUTBOX)
}

async function acquireLockDir(lockDir: string): Promise<void> {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockDir, { recursive: false })
      return
    } catch (err) {
      if (!isNodeErrorCode(err, 'EEXIST')) throw err
      await removeStaleLock(lockDir)
      const delay = Math.min(LOCK_MAX_DELAY_MS, LOCK_MIN_DELAY_MS * 2 ** attempt)
      await sleep(delay)
    }
  }
  throw new Error(`Timed out waiting for lock: ${lockDir}`)
}

async function removeStaleLock(lockDir: string): Promise<void> {
  try {
    const info = await stat(lockDir)
    if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
      await rm(lockDir, { recursive: true, force: true })
    }
  } catch {
    // The next mkdir attempt decides whether the lock is still present.
  }
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === code
}
