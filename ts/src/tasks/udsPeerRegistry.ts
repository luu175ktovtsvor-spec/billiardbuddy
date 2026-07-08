import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface UdsPeerRecord {
  id: string
  socketPath: string
  target: string
  conversationId?: string
  workspaceRoot?: string
  pid: number
  explicit: boolean
  source: string
  registeredAt: string
  updatedAt: string
}

export interface RegisterUdsPeerInput {
  socketPath: string
  conversationId?: string
  workspaceRoot?: string
  explicit?: boolean
  source?: string
}

interface UdsPeerFile {
  version: 1
  peers: UdsPeerRecord[]
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

function socketId(socketPath: string): string {
  return createHash('sha1').update(socketPath).digest('hex').slice(0, 16)
}

function normalizeRecord(raw: unknown): UdsPeerRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const item = raw as Record<string, unknown>
  const socketPath = typeof item.socketPath === 'string' ? item.socketPath.trim() : ''
  if (!socketPath) return null
  const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : socketId(socketPath)
  return {
    id,
    socketPath,
    target: `uds:${socketPath}`,
    conversationId: typeof item.conversationId === 'string' ? item.conversationId : undefined,
    workspaceRoot: typeof item.workspaceRoot === 'string' ? item.workspaceRoot : undefined,
    pid: typeof item.pid === 'number' ? item.pid : 0,
    explicit: typeof item.explicit === 'boolean' ? item.explicit : false,
    source: typeof item.source === 'string' ? item.source : 'agent_run',
    registeredAt: typeof item.registeredAt === 'string' ? item.registeredAt : nowIso(),
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : nowIso(),
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export class UdsPeerRegistry {
  private readonly registryPath: string
  private queue = Promise.resolve()

  constructor(private readonly stateRoot: string) {
    this.registryPath = join(stateRoot, 'uds-peers', 'peers.json')
  }

  defaultSocketPath(conversationId: string): string {
    const key = createHash('sha1')
      .update(`${this.stateRoot}|${conversationId}|${process.pid}`)
      .digest('hex')
      .slice(0, 20)
    return join(process.platform === 'win32' ? '\\\\.\\pipe\\billiards-agent-uds' : '/tmp/billiards-agent-uds', `${key}.sock`)
  }

  async register(input: RegisterUdsPeerInput): Promise<UdsPeerRecord> {
    return this.withMutation(async file => {
      const socketPath = input.socketPath.trim()
      if (!socketPath) throw new Error('socketPath is required')
      const id = socketId(socketPath)
      const previous = file.peers.find(peer => peer.id === id)
      const record: UdsPeerRecord = {
        id,
        socketPath,
        target: `uds:${socketPath}`,
        conversationId: input.conversationId,
        workspaceRoot: input.workspaceRoot,
        pid: process.pid,
        explicit: input.explicit === true,
        source: input.source ?? 'agent_run',
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

  async unregister(idOrSocketPath: string): Promise<void> {
    await this.withMutation(async file => {
      const key = idOrSocketPath.trim()
      const id = key.startsWith('/') || key.startsWith('\\\\') ? socketId(key) : key
      file.peers = file.peers.filter(peer => peer.id !== id && peer.socketPath !== key)
    })
  }

  async list(): Promise<UdsPeerRecord[]> {
    return this.withMutation(async file => {
      const live: UdsPeerRecord[] = []
      for (const peer of file.peers) {
        if (await socketExists(peer.socketPath)) live.push(peer)
      }
      file.peers = live
      return [...live].sort((a, b) => a.registeredAt.localeCompare(b.registeredAt))
    })
  }

  private async readFile(): Promise<UdsPeerFile> {
    try {
      const raw = JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { version: 1, peers: [] }
      const peers = Array.isArray((raw as { peers?: unknown }).peers)
        ? (raw as { peers: unknown[] }).peers.map(normalizeRecord).filter((peer): peer is UdsPeerRecord => !!peer)
        : []
      return { version: 1, peers }
    } catch {
      return { version: 1, peers: [] }
    }
  }

  private async withMutation<T>(fn: (file: UdsPeerFile) => Promise<T> | T): Promise<T> {
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

async function socketExists(socketPath: string): Promise<boolean> {
  try {
    await stat(socketPath)
    return true
  } catch {
    return false
  }
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code?: unknown }).code === code
}
