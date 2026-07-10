import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Transcript } from '../../memory/transcript'
import type { TranscriptPage } from '../../memory/transcript'
import { getDefaultWorkspaceDir } from '../../harness/desktopEnvNames'
import type { Message } from '../../types/message'
import type { AgentEvent } from '../../types/events'

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const DEFAULT_EVENT_LIMIT = 200
const MAX_EVENT_LIMIT = 1000

export type SessionStatus = 'idle' | 'running' | 'interrupted' | 'failed'
export type SessionStreamEvent = AgentEvent | { type: 'done' }

export interface SessionEventRecord {
  seq: number
  ts: string
  event: SessionStreamEvent
}

export interface SessionMeta {
  id: string
  title: string
  workspaceRoot: string
  createdAt: string
  updatedAt: string
  status?: SessionStatus
  lastEventSeq?: number
}

/** 项目(工作区)聚合摘要:多项目 App 的"最近项目"选择器用。 */
export interface ProjectSummary {
  workspaceRoot: string
  sessionCount: number
  lastUpdatedAt: string
  lastSessionId: string
  lastTitle: string
}

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isSessionMeta(value: unknown): value is SessionMeta {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.workspaceRoot === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    SESSION_ID_RE.test(value.id) &&
    (value.status === undefined || value.status === 'idle' || value.status === 'running' || value.status === 'interrupted' || value.status === 'failed') &&
    (value.lastEventSeq === undefined || typeof value.lastEventSeq === 'number')
}

function validateSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) throw new Error('非法 session id')
}

function isSessionEventRecord(value: unknown): value is SessionEventRecord {
  if (!isRecord(value)) return false
  if (typeof value.seq !== 'number' || !Number.isFinite(value.seq)) return false
  if (typeof value.ts !== 'string') return false
  const event = value.event
  return isRecord(event) && typeof event.type === 'string'
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return DEFAULT_EVENT_LIMIT
  return Math.min(Math.floor(value), MAX_EVENT_LIMIT)
}

export class SessionService {
  private readonly indexPath: string

  constructor(private readonly rootDir: string) {
    this.indexPath = join(rootDir, 'sessions.json')
  }

  async list(filter?: { workspaceRoot?: string }): Promise<SessionMeta[]> {
    const index = await this.readIndex()
    let metas = [...index.values()]
    if (filter?.workspaceRoot) metas = metas.filter(m => m.workspaceRoot === filter.workspaceRoot)
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 按项目(workspaceRoot)聚合会话 → 最近项目列表(对齐 cc 多项目 App 的项目选择器/recent-projects)。 */
  async recentProjects(limit = 20): Promise<ProjectSummary[]> {
    const index = await this.readIndex()
    const byRoot = new Map<string, ProjectSummary>()
    for (const m of index.values()) {
      const existing = byRoot.get(m.workspaceRoot)
      if (!existing) {
        byRoot.set(m.workspaceRoot, { workspaceRoot: m.workspaceRoot, sessionCount: 1, lastUpdatedAt: m.updatedAt, lastSessionId: m.id, lastTitle: m.title })
      } else {
        existing.sessionCount++
        if (m.updatedAt > existing.lastUpdatedAt) {
          existing.lastUpdatedAt = m.updatedAt
          existing.lastSessionId = m.id
          existing.lastTitle = m.title
        }
      }
    }
    return [...byRoot.values()].sort((a, b) => b.lastUpdatedAt.localeCompare(a.lastUpdatedAt)).slice(0, Math.max(1, limit))
  }

  /** 会话 fork:用新 id 拷贝源会话的 transcript 续接(对齐 cc --fork-session:SDK forkSession 未实现,属会话级拷贝)。 */
  async fork(sourceId: string, opts: { title?: string } = {}): Promise<SessionMeta> {
    validateSessionId(sourceId)
    const source = (await this.readIndex()).get(sourceId)
    if (!source) throw new Error('源会话不存在')
    const forked = await this.create({ title: opts.title?.trim() || `${source.title}(副本)`, workspaceRoot: source.workspaceRoot })
    const srcMessages = await this.transcript(sourceId).load().catch(() => [] as Message[])
    if (srcMessages.length > 0) await this.transcript(forked.id).save(srcMessages)
    return forked
  }

  async get(id: string): Promise<SessionMeta | null> {
    validateSessionId(id)
    return (await this.readIndex()).get(id) ?? null
  }

  async create(input: { id?: string; title?: string; workspaceRoot: string }): Promise<SessionMeta> {
    const id = input.id ?? crypto.randomUUID()
    validateSessionId(id)
    const timestamp = nowIso()
    const meta: SessionMeta = {
      id,
      title: input.title?.trim() || '新会话',
      workspaceRoot: input.workspaceRoot,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: 'idle',
      lastEventSeq: 0,
    }
    const index = await this.readIndex()
    index.set(id, meta)
    await this.writeIndex(index)
    return meta
  }

  async touch(id: string, patch: Partial<Pick<SessionMeta, 'title' | 'workspaceRoot' | 'status' | 'lastEventSeq'>> = {}): Promise<SessionMeta> {
    validateSessionId(id)
    const index = await this.readIndex()
    const current = index.get(id)
    const timestamp = nowIso()
    const meta: SessionMeta = current
      ? { ...current, ...patch, updatedAt: timestamp }
      : {
          id,
          title: patch.title?.trim() || '新会话',
          workspaceRoot: patch.workspaceRoot ?? getDefaultWorkspaceDir(),
          createdAt: timestamp,
          updatedAt: timestamp,
          status: patch.status ?? 'idle',
          lastEventSeq: patch.lastEventSeq ?? 0,
        }
    index.set(id, meta)
    await this.writeIndex(index)
    return meta
  }

  async remove(id: string): Promise<boolean> {
    validateSessionId(id)
    const index = await this.readIndex()
    const existed = index.delete(id)
    await this.writeIndex(index)
    await Promise.all([
      rm(this.transcript(id).path, { force: true }),
      rm(this.eventPath(id), { force: true }),
    ])
    return existed
  }

  transcript(id: string): Transcript {
    validateSessionId(id)
    return new Transcript(this.rootDir, id)
  }

  async loadTranscript(id: string): Promise<Message[]> {
    return await this.transcript(id).load()
  }

  async loadTranscriptPage(id: string, opts: { after?: number; limit?: number } = {}): Promise<TranscriptPage> {
    return await this.transcript(id).loadPage(opts)
  }

  async appendEvent(id: string, event: SessionStreamEvent): Promise<SessionEventRecord> {
    validateSessionId(id)
    const meta = await this.get(id)
    const metaSeq = meta?.lastEventSeq
    const lastSeq = typeof metaSeq === 'number' && Number.isInteger(metaSeq) && metaSeq > 0
      ? metaSeq
      : await this.readLastEventSeq(id)
    const seq = lastSeq + 1
    const record: SessionEventRecord = { seq, ts: nowIso(), event }
    const path = this.eventPath(id)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
    await this.touch(id, { lastEventSeq: seq })
    return record
  }

  async loadEvents(id: string, opts: { after?: number; limit?: number } = {}): Promise<SessionEventRecord[]> {
    validateSessionId(id)
    const after = Number.isFinite(opts.after) ? Math.max(0, Math.floor(opts.after!)) : 0
    const limit = clampLimit(opts.limit)
    const events: SessionEventRecord[] = []
    for await (const record of this.iterEventRecords(id)) {
      if (record.seq <= after) continue
      events.push(record)
      if (events.length >= limit) break
    }
    return events
  }

  private async readLastEventSeq(id: string): Promise<number> {
    let lastSeq = 0
    for await (const record of this.iterEventRecords(id)) {
      if (record.seq > lastSeq) lastSeq = record.seq
    }
    return lastSeq
  }

  private async *iterEventRecords(id: string): AsyncGenerator<SessionEventRecord> {
    const stream = createReadStream(this.eventPath(id), { encoding: 'utf8' })
    const lines = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        const record = this.parseEventLine(line)
        if (record) yield record
      }
    } catch {
      // 缺失文件或局部读取失败时退为空,事件回放不阻塞主流程。
    } finally {
      lines.close()
      stream.destroy()
    }
  }

  private parseEventLine(line: string): SessionEventRecord | null {
    if (!line.trim()) return null
    try {
      const parsed = JSON.parse(line) as unknown
      return isSessionEventRecord(parsed) ? parsed : null
    } catch {
      // 坏行跳过,事件回放不能被单行损坏拖垮。
      return null
    }
  }

  eventPath(id: string): string {
    validateSessionId(id)
    return join(this.rootDir, 'events', `${id}.jsonl`)
  }

  private async readIndex(): Promise<Map<string, SessionMeta>> {
    let raw = ''
    try {
      raw = await readFile(this.indexPath, 'utf8')
    } catch {
      return new Map()
    }
    try {
      const parsed = JSON.parse(raw) as unknown
      const arr = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions : []
      return new Map(arr.filter(isSessionMeta).map(meta => [meta.id, { status: 'idle' as const, lastEventSeq: 0, ...meta }]))
    } catch {
      return new Map()
    }
  }

  private async writeIndex(index: Map<string, SessionMeta>): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true })
    const tmp = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`
    const sessions = [...index.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    await writeFile(tmp, `${JSON.stringify({ sessions }, null, 2)}\n`, 'utf8')
    await rename(tmp, this.indexPath)
  }
}

export class TurnRegistry {
  private readonly controllers = new Map<string, AbortController>()

  start(sessionId: string): AbortController {
    validateSessionId(sessionId)
    this.interrupt(sessionId)
    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    return controller
  }

  isCurrent(sessionId: string, controller: AbortController): boolean {
    validateSessionId(sessionId)
    return this.controllers.get(sessionId) === controller
  }

  isRunning(sessionId: string): boolean {
    validateSessionId(sessionId)
    return this.controllers.has(sessionId)
  }

  finish(sessionId: string, controller: AbortController): boolean {
    if (this.controllers.get(sessionId) !== controller) return false
    this.controllers.delete(sessionId)
    return true
  }

  interrupt(sessionId: string): boolean {
    validateSessionId(sessionId)
    const controller = this.controllers.get(sessionId)
    if (!controller) return false
    controller.abort()
    this.controllers.delete(sessionId)
    return true
  }
}
