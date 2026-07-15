import { createReadStream } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Transcript } from '../../memory/transcript'
import type { TranscriptPage } from '../../memory/transcript'
import { getDefaultWorkspaceDir } from '../../harness/desktopEnvNames'
import { sanitizePath } from '../../harness/memoryNames'
import type { Message } from '../../types/message'
import type { AgentEvent } from '../../types/events'

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const DEFAULT_EVENT_LIMIT = 200
const MAX_EVENT_LIMIT = 1000

export type SessionStatus = 'idle' | 'running' | 'interrupted' | 'failed'
// user_prompt:用户这句话本身(回合流第一条)。事件日志是回放的唯一真相源,少了它,
// 切会话/重启/rewind 后重放只有 agent 侧事件、用户气泡整段消失。
export type SessionStreamEvent = AgentEvent | { type: 'done' } | { type: 'user_prompt'; text: string }

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
  /**
   * 会话已进入的领域包 id(如 ['billiards'])。owner 设计:用户敲 /台球 等入口斜杠命令进入台球运营管家后,
   * 主循环把它持久化到这里,后续回合即便前端不回传 enabled_packs 也保持在该模式(自动注入 pack 知识/工具)。
   */
  enabledPacks?: string[]
  /** 置顶(侧栏排序靠前)。 */
  pinned?: boolean
  /** 归档(侧栏折叠到"已归档"区)。 */
  archived?: boolean
}

/** 项目(工作区)聚合摘要:多项目 App 的"最近项目"选择器用。 */
export interface ProjectSummary {
  workspaceRoot: string
  sessionCount: number
  lastUpdatedAt: string
  lastSessionId: string
  lastTitle: string
  /** 默认工作目录(没选目录的会话都落这):前端把它归「对话」组、不当项目显示(对齐 Codex 无项目任务)。 */
  isDefault: boolean
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
    (value.lastEventSeq === undefined || typeof value.lastEventSeq === 'number') &&
    (value.enabledPacks === undefined || (Array.isArray(value.enabledPacks) && value.enabledPacks.every(p => typeof p === 'string')))
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

/** 从一份 transcript 事件日志里刨出 SessionMeta(缓存重建用):cwd/timestamp 走 provenance 戳,标题取首条 user 文本。 */
function metaFromTranscript(id: string, text: string): SessionMeta | null {
  let cwd = ''
  let createdAt = ''
  let updatedAt = ''
  let title = ''
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: Record<string, unknown>
    try {
      const parsed = JSON.parse(line) as unknown
      if (!isRecord(parsed)) continue
      entry = parsed
    } catch {
      continue
    }
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd
    if (typeof entry.timestamp === 'string') {
      if (!createdAt) createdAt = entry.timestamp
      updatedAt = entry.timestamp
    }
    if (!title && entry.role === 'user' && Array.isArray(entry.content)) {
      const firstText = entry.content.find((b): b is { type: 'text'; text: string } =>
        isRecord(b) && b.type === 'text' && typeof b.text === 'string')
      if (firstText) title = firstText.text.trim().slice(0, 40)
    }
  }
  if (!createdAt && !updatedAt && !title && !cwd) return null
  const ts = createdAt || updatedAt || nowIso()
  return {
    id,
    title: title || '恢复的会话',
    workspaceRoot: cwd,
    createdAt: ts,
    updatedAt: updatedAt || ts,
    status: 'idle',
    lastEventSeq: 0,
  }
}

export class SessionService {
  /**
   * sessions.json = **可从事件日志扫描重建的缓存**,不是唯一真相源(对齐 cc:元数据主真相内嵌各 transcript 的
   * provenance 戳 —— sessionId/cwd/timestamp)。丢失/损坏时 list() 会从 `projects/<slug>/*.jsonl` 重建
   * (见 rebuildIndexFromDisk)。这里只当"最近会话"选择器的快取。
   */
  private readonly indexPath: string

  constructor(private readonly rootDir: string) {
    this.indexPath = join(rootDir, 'sessions.json')
  }

  async list(filter?: { workspaceRoot?: string }): Promise<SessionMeta[]> {
    let index = await this.readIndex()
    // 缓存空(丢失/损坏/首次)但盘上有事件日志 → 从内嵌 provenance 重建缓存并回写。
    if (index.size === 0) {
      const rebuilt = await this.rebuildIndexFromDisk()
      if (rebuilt.size > 0) {
        index = rebuilt
        await this.writeIndex(index).catch(() => undefined)
      }
    }
    let metas = [...index.values()]
    if (filter?.workspaceRoot) metas = metas.filter(m => m.workspaceRoot === filter.workspaceRoot)
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** 按项目(workspaceRoot)聚合会话 → 最近项目列表(对齐 cc 多项目 App 的项目选择器/recent-projects)。 */
  async recentProjects(limit = 20): Promise<ProjectSummary[]> {
    const index = await this.readIndex()
    const defaultRoot = getDefaultWorkspaceDir()
    const byRoot = new Map<string, ProjectSummary>()
    for (const m of index.values()) {
      const existing = byRoot.get(m.workspaceRoot)
      if (!existing) {
        byRoot.set(m.workspaceRoot, { workspaceRoot: m.workspaceRoot, sessionCount: 1, lastUpdatedAt: m.updatedAt, lastSessionId: m.id, lastTitle: m.title, isDefault: m.workspaceRoot === defaultRoot })
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
    // fork 拷贝**完整历史**(含压缩边界前原文),而非 load() 的裁窗视图——否则被压缩过的会话 fork 后会丢掉压缩前历史。
    const srcMessages = await this.transcript(sourceId, source.workspaceRoot).loadFullHistory().catch(() => [] as Message[])
    if (srcMessages.length > 0) await this.transcript(forked.id, forked.workspaceRoot).save(srcMessages)
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

  async touch(id: string, patch: Partial<Pick<SessionMeta, 'title' | 'workspaceRoot' | 'status' | 'lastEventSeq' | 'enabledPacks' | 'pinned' | 'archived'>> = {}): Promise<SessionMeta> {
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
    const meta = index.get(id)
    const existed = index.delete(id)
    await this.writeIndex(index)
    const tr = this.transcript(id, meta?.workspaceRoot ?? getDefaultWorkspaceDir())
    const archiveRoot = join(this.rootDir, 'transcript-archives')
    const archiveFiles = await readdir(archiveRoot).catch(() => [] as string[])
    const archivedTranscripts = archiveFiles
      .filter(file => file.match(/^(.*)-\d+\.jsonl$/)?.[1] === id)
      .map(file => rm(join(archiveRoot, file), { force: true }))
    await Promise.all([
      rm(tr.path, { force: true }),
      rm(tr.contentReplacementPath, { force: true }),
      rm(this.eventPath(id), { force: true }),
      ...archivedTranscripts,
    ])
    return existed
  }

  /**
   * 会话事件日志(对齐 cc `projects/<slug>/<sessionId>.jsonl` 白标布局:`<stateRoot>/projects/<workspaceRoot slug>/`,
   * slug 复用 memoryNames.sanitizePath —— 与已对齐的 AutoMem 同一套分区)。workspaceRoot 必传:内嵌进 provenance 戳(cwd),
   * 让缓存丢失后能从日志重建索引;也保证读写锚同一目录、绝不因缺省而错位。
   */
  transcript(id: string, workspaceRoot: string): Transcript {
    validateSessionId(id)
    const projectDir = join(this.rootDir, 'projects', sanitizePath(workspaceRoot))
    return new Transcript(projectDir, id, { subdir: '', provenance: { sessionId: id, cwd: workspaceRoot } })
  }

  async loadTranscript(id: string): Promise<Message[]> {
    const meta = await this.get(id)
    return await this.transcript(id, meta?.workspaceRoot ?? getDefaultWorkspaceDir()).load()
  }

  async loadTranscriptPage(id: string, opts: { after?: number; limit?: number } = {}): Promise<TranscriptPage> {
    const meta = await this.get(id)
    return await this.transcript(id, meta?.workspaceRoot ?? getDefaultWorkspaceDir()).loadPage(opts)
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

  /**
   * 从 `projects/<slug>/*.jsonl` 事件日志重建会话索引缓存(元数据真相内嵌各 transcript 的 provenance 戳:
   * sessionId/cwd/timestamp + 首条 user 文本当标题)。sessions.json 丢失/损坏时 list() 据此自愈,证明中央索引
   * 只是缓存、不是唯一真相源。尽力而为:坏目录/坏行跳过。
   */
  async rebuildIndexFromDisk(): Promise<Map<string, SessionMeta>> {
    const projectsRoot = join(this.rootDir, 'projects')
    const rebuilt = new Map<string, SessionMeta>()
    let slugs: string[] = []
    try {
      slugs = (await readdir(projectsRoot, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
    } catch {
      return rebuilt
    }
    for (const slug of slugs) {
      const dir = join(projectsRoot, slug)
      let files: string[] = []
      try {
        files = (await readdir(dir)).filter(f => f.endsWith('.jsonl') && !f.endsWith('.content-replacements.jsonl'))
      } catch {
        continue
      }
      for (const file of files) {
        const id = file.slice(0, -'.jsonl'.length)
        if (!SESSION_ID_RE.test(id)) continue
        try {
          const meta = metaFromTranscript(id, await readFile(join(dir, file), 'utf8'))
          if (meta) rebuilt.set(id, meta)
        } catch {
          // 坏文件跳过。
        }
      }
    }
    return rebuilt
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
  private readonly pendingApprovals = new Map<string, {
    tool: string
    token: string
    settle: (resolution: TurnApprovalResolution) => void
  }>()

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
    this.pendingApprovals.get(sessionId)?.settle({ behavior: 'deny', message: '当前回合已结束,审批请求已取消。' })
    this.controllers.delete(sessionId)
    return true
  }

  interrupt(sessionId: string): boolean {
    validateSessionId(sessionId)
    const controller = this.controllers.get(sessionId)
    if (!controller) return false
    controller.abort()
    this.pendingApprovals.get(sessionId)?.settle({ behavior: 'deny', message: '任务已中断,审批请求已取消。' })
    this.controllers.delete(sessionId)
    return true
  }

  waitForApproval(
    sessionId: string,
    request: { tool: string; token: string },
    signal?: AbortSignal,
  ): Promise<TurnApprovalResolution> {
    validateSessionId(sessionId)
    if (signal?.aborted) return Promise.resolve({ behavior: 'deny', message: '任务已中断,未执行待审批工具。' })

    return new Promise(resolve => {
      let settled = false
      const onAbort = () => settle({ behavior: 'deny', message: '任务已中断,未执行待审批工具。' })
      const settle = (resolution: TurnApprovalResolution) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (this.pendingApprovals.get(sessionId)?.settle === settle) this.pendingApprovals.delete(sessionId)
        resolve(resolution)
      }

      this.pendingApprovals.get(sessionId)?.settle({ behavior: 'deny', message: '新的审批请求已替换上一个未决请求。' })
      this.pendingApprovals.set(sessionId, { tool: request.tool, token: request.token, settle })
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  resolveApproval(
    sessionId: string,
    input: { behavior: 'allow'; tool: string; token?: string; remember?: boolean } | { behavior: 'deny'; tool: string; message?: string },
  ): boolean {
    validateSessionId(sessionId)
    const pending = this.pendingApprovals.get(sessionId)
    if (!pending || pending.tool !== input.tool) return false
    if (input.behavior === 'allow') {
      if (!input.token || input.token !== pending.token) return false
      pending.settle({ behavior: 'allow', remember: input.remember === true })
    } else {
      pending.settle({ behavior: 'deny', message: input.message })
    }
    return true
  }
}

export type TurnApprovalResolution =
  | { behavior: 'allow'; remember: boolean }
  | { behavior: 'deny'; message?: string }
