// 美国 relay 上的 GPT 生图异步任务服务(50~100 用户私测版加固)。
//
// 背景:GPT Image 2 是 OpenAI 同步接口(images.generate/edit),单张 high 质量要 2.5~4.5 分钟。若从大陆客户机/大陆网关
// 直接握这条跨境长连接死等,连接会被网络在约 60 秒物理掐断——图在 OpenAI 已生成并扣费,却传不回来(图丢+白扣钱)。
//
// 本服务部署在美国服务器(与 OpenAI 同区、网络稳),把"慢调用"收到美国本地跑:
//   客户端(大陆) --短-- 大陆网关 --短-- 本服务(美国) --US→US ~80ms-- OpenAI
// 任何跨境请求都退化成"提交(短)/轮询(短)",没有任何一跳还握跨境长连接,60 秒墙彻底绕开。
//
// 私测版加固(向后兼容,旧网关无 owner/无幂等键仍可工作):
//   - 幂等键:同 (owner, Idempotency-Key) 的重复提交返回原 task_id,只跑一次真实上游、只扣一次费。
//   - 归属绑定:任务绑定提交者 owner(网关注入的受信身份);带 owner 的任务只有同 owner 能轮询,否则 403。
//   - SQLite 持久化任务元数据;大体积输入/结果放 700 目录的 blob 文件,不长期堆在内存/SQLite。
//   - 队列上限:总量、单用户、并发、请求体大小、TTL,全部有界。
//   - 重启恢复:queued 续跑;running 无法确认结果 → failed_unknown,禁止自动重提(避免重复扣费)。
//
// 契约(与 gateway /v1/images/tasks、ts 客户端 submitOpenAiImageTask 对齐):
//   POST /images/tasks   {mode:'generate'|'edit', model, prompt, n, size, response_format?, images?:string[](data-uri), mask?, input_fidelity?}
//     headers: Authorization: Bearer <RELAY_TOKEN>; X-Relay-Owner?: <opaque>; Idempotency-Key?: <key>
//                        → 202 {task_id, status:'queued', reused?}   (立即返回,后台跑 OpenAI)
//   GET  /images/tasks/:id  headers: Authorization + X-Relay-Owner?
//                        → 200 {status:'queued'|'running'|'succeeded'|'failed'|'failed_unknown', data?, error?, created}
//                        → 403 owner 不匹配 / 404 未知或过期
//
// 鉴权:Bearer <RELAY_TOKEN>(= 网关注入的 GW_RELAY_TOKEN)。真 OpenAI key 只在本服务的 RELAY_OPENAI_KEY,绝不下发。

import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type RelayConfig = {
  relayToken: string
  openaiKey: string
  openaiBase: string
  taskTtlMs: number
  imgConc: number
  dbPath: string
  blobDir: string | null
  queueMax: number
  userMax: number
  maxBodyBytes: number
}

type Env = Record<string, string | undefined>

function required(env: Env, key: string): string {
  const v = env[key]
  if (!v) throw new Error(`relay: 缺少环境变量 ${key}`)
  return v
}

function intEnv(env: Env, key: string, fallback: number): number {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function loadRelayConfig(env: Env): RelayConfig {
  return {
    relayToken: required(env, 'RELAY_TOKEN'),
    openaiKey: required(env, 'RELAY_OPENAI_KEY'),
    openaiBase: (env.RELAY_OPENAI_BASE ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    taskTtlMs: Number(env.RELAY_TASK_TTL_MS ?? 600_000), // 结果保留 10 分钟,够客户端轮询取走
    imgConc: Math.max(1, Number(env.RELAY_IMG_CONC ?? 6)), // 本服务对 OpenAI 的在途并发上限
    // 持久化:默认内存 SQLite(测试用);生产设 RELAY_DB=/opt/qfrelay/relay.db 以支持重启恢复。
    dbPath: env.RELAY_DB ?? ':memory:',
    // 大体积 blob:设了 RELAY_BLOB_DIR 就落 700 目录的磁盘文件;没设(测试)就放进程内存。
    blobDir: env.RELAY_BLOB_DIR && env.RELAY_BLOB_DIR.trim() ? env.RELAY_BLOB_DIR.trim() : null,
    queueMax: Math.max(1, intEnv(env, 'RELAY_QUEUE_MAX', 200)), // 全局在途(queued+running)总上限
    userMax: Math.max(1, intEnv(env, 'RELAY_USER_MAX', 8)), // 单 owner 在途上限
    maxBodyBytes: Math.max(1, intEnv(env, 'RELAY_MAX_BODY_BYTES', 24 * 1024 * 1024)), // 提交请求体大小上限
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

/** 并发闸:限制同时在跑的 OpenAI 调用数(护住 OpenAI IPM/账号并发)。 */
class Semaphore {
  private active = 0
  private queue: Array<() => void> = []
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>(resolve => this.queue.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }
}

type TaskState = 'queued' | 'running' | 'succeeded' | 'failed' | 'failed_unknown'
type InputFidelityCapability = {
  requested: string
  status: 'accepted' | 'unsupported'
  risk?: string
}

type SubmitBody = {
  mode?: 'generate' | 'edit'
  model?: string
  prompt?: string
  n?: number
  size?: string
  response_format?: string
  images?: string[]
  mask?: string
  input_fidelity?: string
}

/** 大体积输入/结果的存储:磁盘(生产,700 目录)或进程内存(测试)。SQLite 只存元数据+引用。 */
interface BlobStore {
  put(id: string, kind: 'in' | 'out', value: unknown): void
  get(id: string, kind: 'in' | 'out'): unknown | null
  del(id: string): void
}

class MemoryBlobStore implements BlobStore {
  private map = new Map<string, unknown>()
  put(id: string, kind: 'in' | 'out', value: unknown): void { this.map.set(`${id}.${kind}`, value) }
  get(id: string, kind: 'in' | 'out'): unknown | null {
    return this.map.has(`${id}.${kind}`) ? this.map.get(`${id}.${kind}`) : null
  }
  del(id: string): void { this.map.delete(`${id}.in`); this.map.delete(`${id}.out`) }
}

class DiskBlobStore implements BlobStore {
  constructor(private readonly dir: string) { mkdirSync(dir, { recursive: true, mode: 0o700 }) }
  private file(id: string, kind: 'in' | 'out'): string { return join(this.dir, `${id}.${kind}.json`) }
  put(id: string, kind: 'in' | 'out', value: unknown): void {
    writeFileSync(this.file(id, kind), JSON.stringify(value), { mode: 0o600 })
  }
  get(id: string, kind: 'in' | 'out'): unknown | null {
    const path = this.file(id, kind)
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
  }
  del(id: string): void {
    for (const kind of ['in', 'out'] as const) rmSync(this.file(id, kind), { force: true })
  }
}

type TaskRow = {
  id: string
  owner: string | null
  idempotency_key: string | null
  status: TaskState
  error: string | null
  input_fidelity: string | null // JSON of InputFidelityCapability, or null
  created: number
  updated: number
}

/** SQLite 任务元数据存储 + 幂等映射。大体积 base64 不进这里,只进 BlobStore。 */
class TaskStore {
  private db: Database
  constructor(path: string, private readonly now: () => number) {
    this.db = new Database(path)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS tasks(' +
      'id TEXT PRIMARY KEY, owner TEXT, idempotency_key TEXT, status TEXT NOT NULL, ' +
      'error TEXT, input_fidelity TEXT, created INTEGER NOT NULL, updated INTEGER NOT NULL)'
    )
    // (owner, key) 唯一 —— 幂等去重;key 为 NULL 的行不参与(旧请求无幂等键,不去重)。
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idem ON tasks(owner, idempotency_key) WHERE idempotency_key IS NOT NULL')
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)')
  }

  insert(id: string, owner: string | null, key: string | null): void {
    const ts = this.now()
    this.db.query('INSERT INTO tasks(id,owner,idempotency_key,status,error,input_fidelity,created,updated) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, key, 'queued', null, null, ts, ts)
  }

  get(id: string): TaskRow | null {
    return (this.db.query('SELECT * FROM tasks WHERE id=?').get(id) as TaskRow | null) ?? null
  }

  findByIdempotency(owner: string | null, key: string): TaskRow | null {
    return (this.db.query('SELECT * FROM tasks WHERE idempotency_key=? AND owner IS ?').get(key, owner) as TaskRow | null) ?? null
  }

  setStatus(id: string, status: TaskState, error?: string, inputFidelity?: InputFidelityCapability): void {
    this.db.query('UPDATE tasks SET status=?, error=?, input_fidelity=?, updated=? WHERE id=?')
      .run(status, error ?? null, inputFidelity ? JSON.stringify(inputFidelity) : null, this.now(), id)
  }

  markRunning(id: string): void {
    this.db.query('UPDATE tasks SET status=?, updated=? WHERE id=?').run('running', this.now(), id)
  }

  countActive(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('queued','running')").get() as { c: number }
    return Number(row.c ?? 0)
  }

  countActiveByOwner(owner: string): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('queued','running') AND owner IS ?").get(owner) as { c: number }
    return Number(row.c ?? 0)
  }

  /** 删除过期任务,返回被删的 id(用于同步删 blob)。 */
  sweepExpired(cutoff: number): string[] {
    const rows = this.db.query('SELECT id FROM tasks WHERE created < ?').all(cutoff) as Array<{ id: string }>
    if (rows.length) this.db.query('DELETE FROM tasks WHERE created < ?').run(cutoff)
    return rows.map(r => r.id)
  }

  /**
   * 重启恢复:queued 需要续跑;running 无法确认上游是否已完成/扣费 → 标 failed_unknown 且禁止自动重提。
   * 返回待续跑的 queued id 列表(由调用方读 blob 重新入队跑)。
   */
  recover(): string[] {
    const running = this.db.query("SELECT id FROM tasks WHERE status='running'").all() as Array<{ id: string }>
    if (running.length) {
      this.db.query("UPDATE tasks SET status='failed_unknown', error='服务重启前任务在跑,无法确认结果(不自动重提,避免重复扣费)', updated=? WHERE status='running'")
        .run(this.now())
    }
    const queued = this.db.query("SELECT id FROM tasks WHERE status='queued'").all() as Array<{ id: string }>
    return queued.map(r => r.id)
  }
}

/** data:<ct>;base64,<b64> → File(用于 multipart /images/edits)。 */
function dataUriToFile(uri: string, name: string): File | null {
  const m = /^data:([^;,]*)?(;base64)?,(.*)$/s.exec(uri)
  if (!m) return null
  const contentType = m[1] || 'image/png'
  const bytes = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  return new File([bytes], name, { type: contentType })
}

function clampCount(n: unknown): number {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) ? Math.max(1, Math.min(4, v)) : 1
}

function inputFidelityRejected(status: number, detail: string): boolean {
  return status >= 400 && status < 500 && /input[_ -]?fidelity|unsupported parameter|unknown parameter/i.test(detail)
}

function readOwner(req: Request): string | null {
  const raw = (req.headers.get('x-relay-owner') ?? '').trim()
  return raw ? raw.slice(0, 256) : null
}

export type RelayDeps = { env: Env; fetchImpl?: FetchLike; now?: () => number }

export function createRelayFetch(deps: RelayDeps): (req: Request) => Promise<Response> {
  const config = loadRelayConfig(deps.env)
  const fetchImpl: FetchLike = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const store = new TaskStore(config.dbPath, now)
  const blobs: BlobStore = config.blobDir ? new DiskBlobStore(config.blobDir) : new MemoryBlobStore()
  const sem = new Semaphore(config.imgConc)

  function sweep(): void {
    const cutoff = now() - config.taskTtlMs
    for (const id of store.sweepExpired(cutoff)) blobs.del(id)
  }

  function auth(req: Request): void {
    const header = req.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || token !== config.relayToken) throw new HttpError(401, 'relay: 无效令牌')
  }

  /** 后台真正调 OpenAI(US→US);成功把 data 存 blob,失败/未知存状态。 */
  async function runOpenAi(id: string, body: SubmitBody): Promise<void> {
    store.markRunning(id)
    try {
      await sem.run(async () => {
        const model = String(body.model ?? 'gpt-image-2')
        const prompt = String(body.prompt ?? '')
        const n = clampCount(body.n)
        const size = body.size ? String(body.size) : undefined
        const requestedFidelity = typeof body.input_fidelity === 'string' && body.input_fidelity.trim()
          ? body.input_fidelity.trim()
          : undefined
        const requestUpstream = async (includeInputFidelity: boolean): Promise<Response> => {
          if (body.mode === 'edit') {
            const form = new FormData()
            form.set('model', model)
            form.set('prompt', prompt)
            form.set('n', String(n))
            if (size) form.set('size', size)
            if (includeInputFidelity && requestedFidelity) form.set('input_fidelity', requestedFidelity)
            const images = Array.isArray(body.images) ? body.images : []
            let attached = 0
            for (const uri of images) {
              const file = dataUriToFile(String(uri), `image-${attached}.png`)
              if (file) { form.append('image', file); attached++ }
            }
            if (attached === 0) throw new Error('改图任务缺少可用底图(images 为空或非法 data-uri)')
            if (body.mask) {
              const mask = dataUriToFile(String(body.mask), 'mask.png')
              if (mask) form.set('mask', mask)
            }
            return await fetchImpl(`${config.openaiBase}/images/edits`, {
              method: 'POST',
              headers: { authorization: `Bearer ${config.openaiKey}` },
              body: form,
            })
          }
          const payload: Record<string, unknown> = { model, prompt, n }
          if (size) payload.size = size
          if (body.response_format) payload.response_format = body.response_format
          if (includeInputFidelity && requestedFidelity) payload.input_fidelity = requestedFidelity
          return await fetchImpl(`${config.openaiBase}/images/generations`, {
            method: 'POST',
            headers: { authorization: `Bearer ${config.openaiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
        }

        let inputFidelity: InputFidelityCapability | undefined
        let resp = await requestUpstream(Boolean(requestedFidelity))
        let text = await resp.text()
        if (requestedFidelity && inputFidelityRejected(resp.status, text)) {
          inputFidelity = {
            requested: requestedFidelity,
            status: 'unsupported',
            risk: '当前正式端点不接受手动高保真参数，已自动降级为标准图片输入；请人工确认参考图一致性。',
          }
          resp = await requestUpstream(false)
          text = await resp.text()
        } else if (requestedFidelity && resp.ok) {
          inputFidelity = { requested: requestedFidelity, status: 'accepted' }
        }
        if (!resp.ok) throw new Error(`OpenAI ${resp.status}:${text.slice(0, 300)}`)
        let parsed: unknown
        try { parsed = text ? JSON.parse(text) : {} } catch { parsed = {} }
        const data = parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data)
          ? (parsed as { data: unknown[] }).data
          : []
        blobs.put(id, 'out', { data })
        store.setStatus(id, 'succeeded', undefined, inputFidelity)
      })
    } catch (err) {
      store.setStatus(id, 'failed', err instanceof Error ? err.message : String(err))
    }
  }

  // 重启恢复:queued 续跑(读 blob 里的原始输入重新入队);running → failed_unknown(store.recover 已改状态)。
  for (const id of store.recover()) {
    const body = blobs.get(id, 'in') as SubmitBody | null
    if (body) void runOpenAi(id, body)
    else store.setStatus(id, 'failed_unknown', '重启后找不到原始输入,无法续跑')
  }

  function pollResponse(rec: TaskRow): Response {
    const out = rec.status === 'succeeded' ? (blobs.get(rec.id, 'out') as { data?: unknown[] } | null) : null
    let fidelity: InputFidelityCapability | null = null
    if (rec.input_fidelity) { try { fidelity = JSON.parse(rec.input_fidelity) } catch { fidelity = null } }
    return Response.json({
      status: rec.status,
      data: out?.data,
      error: rec.error ?? undefined,
      created: rec.created,
      ...(fidelity ? {
        input_fidelity_requested: fidelity.requested,
        input_fidelity_status: fidelity.status,
        ...(fidelity.risk ? { input_fidelity_risk: fidelity.risk } : {}),
      } : {}),
    })
  }

  return async function relayFetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return Response.json({ ok: true, active: store.countActive(), img_conc: config.imgConc, queue_max: config.queueMax, user_max: config.userMax })
      }
      if (req.method === 'POST' && url.pathname === '/images/tasks') {
        auth(req)
        sweep()
        const owner = readOwner(req)
        const idempotencyKey = (req.headers.get('idempotency-key') ?? '').trim() || null
        // 请求体大小上限:先看 content-length 快速拒,再按实际字节校验。
        const declared = Number(req.headers.get('content-length') ?? '')
        if (Number.isFinite(declared) && declared > config.maxBodyBytes) throw new HttpError(413, 'relay: 请求体过大')
        const raw = await req.arrayBuffer()
        if (raw.byteLength > config.maxBodyBytes) throw new HttpError(413, 'relay: 请求体过大')
        let body: SubmitBody
        try { body = JSON.parse(Buffer.from(raw).toString('utf8')) as SubmitBody } catch { throw new HttpError(400, 'relay: 请求体不是合法 JSON') }
        if (!body || typeof body !== 'object') throw new HttpError(400, 'relay: 请求体必须是对象')
        if (!String(body.prompt ?? '').trim()) throw new HttpError(400, 'relay: 缺少 prompt')

        // 幂等:同 (owner, key) 已存在 → 返回原 task_id,不再跑第二次真实上游。
        if (idempotencyKey) {
          const existing = store.findByIdempotency(owner, idempotencyKey)
          if (existing) return Response.json({ task_id: existing.id, status: existing.status, reused: true }, { status: 202 })
        }
        // 队列上限:全局在途 + 单 owner 在途。
        if (store.countActive() >= config.queueMax) throw new HttpError(429, 'relay: 生图队列已满,请稍后重试')
        if (owner && store.countActiveByOwner(owner) >= config.userMax) throw new HttpError(429, 'relay: 你的生图任务已达上限,请等待前面的完成')

        const id = crypto.randomUUID()
        try {
          store.insert(id, owner, idempotencyKey)
        } catch (err) {
          // 唯一索引撞车(并发同 owner+key):取回已存在的那条,保证幂等只一个真实任务。
          if (idempotencyKey) {
            const existing = store.findByIdempotency(owner, idempotencyKey)
            if (existing) return Response.json({ task_id: existing.id, status: existing.status, reused: true }, { status: 202 })
          }
          throw err
        }
        blobs.put(id, 'in', body) // 持久化原始输入,供重启后续跑
        void runOpenAi(id, body)
        return Response.json({ task_id: id, status: 'queued' }, { status: 202 })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/images/tasks/')) {
        auth(req)
        sweep()
        const id = url.pathname.slice('/images/tasks/'.length)
        const rec = store.get(id)
        if (!rec) return Response.json({ status: 'failed', error: '任务不存在或已过期' }, { status: 404 })
        // 归属绑定:带 owner 的任务只有同 owner 能轮询(越权 403)。旧任务(owner 为空)不设防,兼容期可轮询。
        const requester = readOwner(req)
        if (rec.owner !== null && rec.owner !== requester) throw new HttpError(403, 'relay: 无权访问该任务')
        return pollResponse(rec)
      }
      return new Response('Not found', { status: 404 })
    } catch (err) {
      if (err instanceof HttpError) return Response.json({ error: err.message }, { status: err.status })
      return Response.json({ error: `relay 内部错误:${String(err).slice(0, 200)}` }, { status: 500 })
    }
  }
}

if (import.meta.main) {
  const port = Number(process.env.RELAY_PORT ?? 8790)
  const handler = createRelayFetch({ env: process.env }) // 配置非法(缺 RELAY_TOKEN/RELAY_OPENAI_KEY)会在此抛错
  Bun.serve({ port, fetch: handler })
  console.log(`[relay] GPT 生图异步任务服务监听 :${port}`)
}
