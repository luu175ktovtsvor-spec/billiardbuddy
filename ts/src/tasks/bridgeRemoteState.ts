import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { BridgeInboundContent, BridgeResolvedInboundMessage, InboundAttachment } from './bridgeInboundMessages'

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

export interface BridgeRemoteCredentialRecord {
  sessionId: string
  workerJwt: string
  apiBaseUrl: string
  expiresIn: number
  workerEpoch: number
  fetchedAt: string
  expiresAt: string
}

export interface BridgeRemoteInboundMessageRecord {
  id: string
  seq: number
  sessionId: string
  eventSeq?: number
  uuid?: string
  content: BridgeInboundContent
  attachments: InboundAttachment[]
  resolvedPaths: string[]
  prefix: string
  bridgeOrigin: true
  skipSlashCommands: true
  receivedAt: string
}

interface BridgeRemoteStateFile {
  version: 1
  nextSeq: number
  nextInboundSeq: number
  events: BridgeRemoteEventRecord[]
  permissions: BridgeRemotePermissionRequestRecord[]
  outbox: BridgeRemoteOutboxItem[]
  credentials: BridgeRemoteCredentialRecord[]
  inboundMessages: BridgeRemoteInboundMessageRecord[]
}

const LOCK_RETRIES = 20
const LOCK_MIN_DELAY_MS = 5
const LOCK_MAX_DELAY_MS = 100
const STALE_LOCK_MS = 30_000
const MAX_EVENTS = 500
const MAX_OUTBOX = 500
const MAX_INBOUND_MESSAGES = 500

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

function normalizeCredential(raw: unknown): BridgeRemoteCredentialRecord | null {
  if (!isRecord(raw)) return null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const workerJwt = typeof raw.workerJwt === 'string' ? raw.workerJwt : ''
  const apiBaseUrl = typeof raw.apiBaseUrl === 'string' ? raw.apiBaseUrl : ''
  const expiresIn = typeof raw.expiresIn === 'number' && Number.isFinite(raw.expiresIn) ? raw.expiresIn : 0
  const workerEpoch = typeof raw.workerEpoch === 'number' && Number.isSafeInteger(raw.workerEpoch) ? raw.workerEpoch : -1
  if (!sessionId || !workerJwt || !apiBaseUrl || expiresIn <= 0 || workerEpoch < 0) return null
  return {
    sessionId,
    workerJwt,
    apiBaseUrl,
    expiresIn,
    workerEpoch,
    fetchedAt: typeof raw.fetchedAt === 'string' ? raw.fetchedAt : nowIso(),
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : nowIso(),
  }
}

function isInboundContentBlock(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  if (value.type === 'text') return typeof value.text === 'string'
  if (value.type === 'thinking') return typeof value.thinking === 'string'
  if (value.type === 'tool_use') return typeof value.id === 'string' && typeof value.name === 'string'
  if (value.type === 'tool_result') return typeof value.tool_use_id === 'string' && typeof value.content === 'string'
  if (value.type !== 'image' || !isRecord(value.source)) return false
  return value.source.type === 'base64' && typeof value.source.media_type === 'string' && typeof value.source.data === 'string'
}

function normalizeInboundContent(value: unknown): BridgeInboundContent | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value) || !value.every(isInboundContentBlock)) return null
  return JSON.parse(JSON.stringify(value)) as BridgeInboundContent
}

function normalizeInboundAttachment(raw: unknown): InboundAttachment | null {
  if (!isRecord(raw) || typeof raw.file_uuid !== 'string' || typeof raw.file_name !== 'string') return null
  return { file_uuid: raw.file_uuid, file_name: raw.file_name }
}

function normalizeInboundMessage(raw: unknown): BridgeRemoteInboundMessageRecord | null {
  if (!isRecord(raw)) return null
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : ''
  const seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : 0
  const content = normalizeInboundContent(raw.content)
  if (!sessionId || seq <= 0 || content === null) return null
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments.map(normalizeInboundAttachment).filter((item): item is InboundAttachment => !!item)
    : []
  const resolvedPaths = Array.isArray(raw.resolvedPaths)
    ? raw.resolvedPaths.filter((item): item is string => typeof item === 'string')
    : []
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : hashId('inbound', `${sessionId}:${seq}`),
    seq,
    sessionId,
    eventSeq: typeof raw.eventSeq === 'number' && Number.isFinite(raw.eventSeq) ? raw.eventSeq : undefined,
    uuid: typeof raw.uuid === 'string' ? raw.uuid : undefined,
    content,
    attachments,
    resolvedPaths,
    prefix: typeof raw.prefix === 'string' ? raw.prefix : '',
    bridgeOrigin: true,
    skipSlashCommands: true,
    receivedAt: typeof raw.receivedAt === 'string' ? raw.receivedAt : nowIso(),
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

  async storeCredentials(sessionIdInput: string, credentialsInput: {
    workerJwt: string
    apiBaseUrl: string
    expiresIn: number
    workerEpoch: number
  }): Promise<BridgeRemoteCredentialRecord> {
    return this.withMutation(file => {
      const sessionId = normalizeSessionId(sessionIdInput)
      const workerJwt = credentialsInput.workerJwt.trim()
      const apiBaseUrl = credentialsInput.apiBaseUrl.trim()
      const expiresIn = credentialsInput.expiresIn
      const workerEpoch = credentialsInput.workerEpoch
      if (!workerJwt) throw new Error('workerJwt is required')
      if (!apiBaseUrl) throw new Error('apiBaseUrl is required')
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new Error('expiresIn must be positive')
      if (!Number.isSafeInteger(workerEpoch) || workerEpoch < 0) throw new Error('workerEpoch must be a non-negative safe integer')
      const fetchedAt = nowIso()
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString()
      const record: BridgeRemoteCredentialRecord = {
        sessionId,
        workerJwt,
        apiBaseUrl,
        expiresIn,
        workerEpoch,
        fetchedAt,
        expiresAt,
      }
      file.credentials = [
        ...file.credentials.filter(item => item.sessionId !== sessionId),
        record,
      ]
      return record
    })
  }

  async getCredentials(sessionIdInput: string): Promise<BridgeRemoteCredentialRecord | null> {
    const sessionId = normalizeSessionId(sessionIdInput)
    const file = await this.readFile()
    return file.credentials.find(item => item.sessionId === sessionId) ?? null
  }

  async storeInboundMessage(sessionIdInput: string, inboundInput: BridgeResolvedInboundMessage, opts: { eventSeq?: number } = {}): Promise<BridgeRemoteInboundMessageRecord> {
    return this.withMutation(file => {
      const sessionId = normalizeSessionId(sessionIdInput)
      const content = normalizeInboundContent(inboundInput.content)
      if (content === null) throw new Error('inbound message content is invalid')
      const seq = Math.max(file.nextInboundSeq, maxInboundSeq(file.inboundMessages) + 1)
      file.nextInboundSeq = seq + 1
      const now = nowIso()
      const record: BridgeRemoteInboundMessageRecord = {
        id: hashId('inbound', `${sessionId}:${seq}:${inboundInput.uuid ?? ''}`),
        seq,
        sessionId,
        eventSeq: opts.eventSeq,
        uuid: inboundInput.uuid,
        content,
        attachments: inboundInput.attachments.map(att => ({ file_uuid: att.file_uuid, file_name: att.file_name })),
        resolvedPaths: inboundInput.resolvedPaths.slice(),
        prefix: inboundInput.prefix,
        bridgeOrigin: true,
        skipSlashCommands: true,
        receivedAt: now,
      }
      if (record.uuid) {
        file.inboundMessages = file.inboundMessages.filter(item => !(item.sessionId === sessionId && item.uuid === record.uuid))
      }
      file.inboundMessages.push(record)
      trimInboundMessages(file)
      return record
    })
  }

  async listInboundMessages(sessionIdInput: string, opts: { after?: number; limit?: number } = {}): Promise<BridgeRemoteInboundMessageRecord[]> {
    const sessionId = normalizeSessionId(sessionIdInput)
    const file = await this.readFile()
    const after = opts.after ?? 0
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100))
    return file.inboundMessages
      .filter(message => message.sessionId === sessionId && message.seq > after)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit)
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
      const credentials = Array.isArray(raw.credentials)
        ? raw.credentials.map(normalizeCredential).filter((item): item is BridgeRemoteCredentialRecord => !!item)
        : []
      const inboundMessages = Array.isArray(raw.inboundMessages)
        ? raw.inboundMessages.map(normalizeInboundMessage).filter((item): item is BridgeRemoteInboundMessageRecord => !!item)
        : []
      const nextSeq = typeof raw.nextSeq === 'number' && Number.isFinite(raw.nextSeq)
        ? Math.max(raw.nextSeq, maxSeq(events) + 1)
        : maxSeq(events) + 1
      const nextInboundSeq = typeof raw.nextInboundSeq === 'number' && Number.isFinite(raw.nextInboundSeq)
        ? Math.max(raw.nextInboundSeq, maxInboundSeq(inboundMessages) + 1)
        : maxInboundSeq(inboundMessages) + 1
      return { version: 1, nextSeq, nextInboundSeq, events, permissions, outbox, credentials, inboundMessages }
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
        if (file.events.length === 0 && file.permissions.length === 0 && file.outbox.length === 0 && file.credentials.length === 0 && file.inboundMessages.length === 0) {
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
  return { version: 1, nextSeq: 1, nextInboundSeq: 1, events: [], permissions: [], outbox: [], credentials: [], inboundMessages: [] }
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

function maxInboundSeq(messages: BridgeRemoteInboundMessageRecord[]): number {
  return messages.reduce((max, message) => Math.max(max, message.seq), 0)
}

function trimInboundMessages(file: BridgeRemoteStateFile): void {
  if (file.inboundMessages.length <= MAX_INBOUND_MESSAGES) return
  file.inboundMessages = file.inboundMessages.slice(file.inboundMessages.length - MAX_INBOUND_MESSAGES)
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
