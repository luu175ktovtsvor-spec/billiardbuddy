import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type BridgePeerStatus = 'connected' | 'connecting' | 'disconnected' | 'outbound_only' | 'error'

export interface BridgePeerRecord {
  id: string
  sessionId: string
  target: string
  label?: string
  workspaceRoot?: string
  machineName?: string
  status: BridgePeerStatus
  inboundEnabled: boolean
  lastError?: string
  registeredAt: string
  updatedAt: string
}

export interface RegisterBridgePeerInput {
  sessionId: string
  label?: string
  workspaceRoot?: string
  machineName?: string
  status?: BridgePeerStatus
  inboundEnabled?: boolean
  lastError?: string
}

interface BridgePeerFile {
  version: 1
  peers: BridgePeerRecord[]
}

const LOCK_RETRIES = 20
const LOCK_MIN_DELAY_MS = 5
const LOCK_MAX_DELAY_MS = 100
const STALE_LOCK_MS = 30_000

function nowIso(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function peerId(sessionId: string): string {
  return createHash('sha1').update(sessionId).digest('hex').slice(0, 16)
}

function normalizeSessionId(value: string): string {
  const raw = value.trim()
  const sessionId = raw.startsWith('bridge:') ? raw.slice('bridge:'.length) : raw
  if (!sessionId) throw new Error('sessionId is required')
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(sessionId)) throw new Error('sessionId contains unsupported characters')
  return sessionId
}

function normalizeRecord(raw: unknown): BridgePeerRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
  if (!sessionId) return null
  const status = normalizeStatus(item.status)
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : peerId(sessionId)
  return {
    id,
    sessionId,
    target: `bridge:${sessionId}`,
    label: typeof item.label === 'string' ? item.label : undefined,
    workspaceRoot: typeof item.workspaceRoot === 'string' ? item.workspaceRoot : undefined,
    machineName: typeof item.machineName === 'string' ? item.machineName : undefined,
    status,
    inboundEnabled: typeof item.inboundEnabled === 'boolean' ? item.inboundEnabled : status === 'connected',
    lastError: typeof item.lastError === 'string' ? item.lastError : undefined,
    registeredAt: typeof item.registeredAt === 'string' ? item.registeredAt : nowIso(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
  }
}

function normalizeStatus(value: unknown): BridgePeerStatus {
  return value === 'connected' || value === 'connecting' || value === 'disconnected' || value === 'outbound_only' || value === 'error'
    ? value
    : 'disconnected'
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export class BridgePeerRegistry {
  private readonly registryPath: string
  private queue = Promise.resolve()

  constructor(private readonly stateRoot: string) {
    this.registryPath = join(stateRoot, 'bridge-peers', 'peers.json')
  }

  async register(input: RegisterBridgePeerInput): Promise<BridgePeerRecord> {
    return this.withMutation(async file => {
      const sessionId = normalizeSessionId(input.sessionId)
      const id = peerId(sessionId)
      const previous = file.peers.find(peer => peer.id === id)
      const status = input.status ?? previous?.status ?? 'connected'
      const inboundEnabled = input.inboundEnabled ?? previous?.inboundEnabled ?? status === 'connected'
      const record: BridgePeerRecord = {
        id,
        sessionId,
        target: `bridge:${sessionId}`,
        label: input.label ?? previous?.label,
        workspaceRoot: input.workspaceRoot ?? previous?.workspaceRoot,
        machineName: input.machineName ?? previous?.machineName,
        status,
        inboundEnabled,
        lastError: input.lastError ?? previous?.lastError,
        registeredAt: previous?.registeredAt ?? nowIso(),
        updatedAt: nowIso(),
      }
      file.peers = [
        ...file.peers.filter(peer => peer.id !== id),
        record,
      ]
      return record
    })
  }

  async updateStatus(sessionId: string, status: BridgePeerStatus, lastError?: string): Promise<BridgePeerRecord | null> {
    return this.withMutation(async file => {
      const normalized = normalizeSessionId(sessionId)
      const id = peerId(normalized)
      const index = file.peers.findIndex(peer => peer.id === id)
      if (index === -1) return null
      const previous = file.peers[index]!
      const next: BridgePeerRecord = {
        ...previous,
        status,
        inboundEnabled: status === 'connected' ? previous.inboundEnabled : false,
        lastError,
        updatedAt: nowIso(),
      }
      file.peers[index] = next
      return next
    })
  }

  async unregister(sessionId: string): Promise<void> {
    await this.withMutation(async file => {
      const normalized = normalizeSessionId(sessionId)
      const id = peerId(normalized)
      file.peers = file.peers.filter(peer => peer.id !== id && peer.sessionId !== normalized)
    })
  }

  async get(sessionId: string): Promise<BridgePeerRecord | null> {
    const normalized = normalizeSessionId(sessionId)
    const id = peerId(normalized)
    return (await this.list()).find(peer => peer.id === id || peer.sessionId === normalized) ?? null
  }

  async list(): Promise<BridgePeerRecord[]> {
    await this.queue.catch(() => undefined)
    const file = await this.readFile()
    return [...file.peers].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
  }

  private async readFile(): Promise<BridgePeerFile> {
    try {
      const raw = JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, peers: [] }
      const peers = Array.isArray((raw as { peers?: unknown }).peers)
        ? (raw as { peers: unknown[] }).peers.map(normalizeRecord).filter((peer): peer is BridgePeerRecord => !!peer)
        : []
      return { version: 1, peers }
    } catch {
      return { version: 1, peers: [] }
    }
  }

  private async withMutation<T>(fn: (file: BridgePeerFile) => Promise<T> | T): Promise<T> {
    const run = this.queue.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.registryPath), { recursive: true })
      const lockDir = `${this.registryPath}.lock`
      await acquireLockDir(lockDir)
      try {
        const file = await this.readFile()
        const result = await fn(file)
        if (file.peers.length === 0) {
          await rm(this.registryPath, { force: true }).catch(() => undefined)
        } else {
          await writeJson(this.registryPath, file)
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
