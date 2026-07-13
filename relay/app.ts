// 美国 relay 上的 GPT 生图异步任务服务(A2 根治方案)。
//
// 背景:GPT Image 2 是 OpenAI 同步接口(images.generate/edit),单张 high 质量要 2.5~4.5 分钟。若从大陆客户机/大陆网关
// 直接握这条跨境长连接死等,连接会被网络在约 60 秒物理掐断——图在 OpenAI 已生成并扣费,却传不回来(图丢+白扣钱)。
//
// 本服务部署在美国服务器(与 OpenAI 同区、网络稳),把"慢调用"收到美国本地跑:
//   客户端(大陆) --短-- 大陆网关 --短-- 本服务(美国) --US→US ~80ms-- OpenAI
// 任何跨境请求都退化成"提交(短)/轮询(短)",没有任何一跳还握跨境长连接,60 秒墙彻底绕开。
//
// 契约(与 gateway /v1/images/tasks、ts 客户端 submitOpenAiImageTask 对齐):
//   POST /images/tasks   {mode:'generate'|'edit', model, prompt, n, size, response_format?, images?:string[](data-uri), mask?, input_fidelity?}
//                        → 202 {task_id, status:'queued'}   (立即返回,后台跑 OpenAI)
//   GET  /images/tasks/:id → 200 {status:'queued'|'running'|'succeeded'|'failed', data?:[{b64_json|url}], error?, created}
//                        → 404 未知/过期
//
// 鉴权:Bearer <RELAY_TOKEN>(= 网关注入的 GW_RELAY_TOKEN)。真 OpenAI key 只在本服务的 RELAY_OPENAI_KEY,绝不下发。

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type RelayConfig = {
  relayToken: string
  openaiKey: string
  openaiBase: string
  taskTtlMs: number
  imgConc: number
}

type Env = Record<string, string | undefined>

function required(env: Env, key: string): string {
  const v = env[key]
  if (!v) throw new Error(`relay: 缺少环境变量 ${key}`)
  return v
}

export function loadRelayConfig(env: Env): RelayConfig {
  return {
    relayToken: required(env, 'RELAY_TOKEN'),
    openaiKey: required(env, 'RELAY_OPENAI_KEY'),
    openaiBase: (env.RELAY_OPENAI_BASE ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
    taskTtlMs: Number(env.RELAY_TASK_TTL_MS ?? 600_000), // 结果保留 10 分钟,够客户端轮询取走
    imgConc: Math.max(1, Number(env.RELAY_IMG_CONC ?? 6)), // 本服务对 OpenAI 的在途并发上限
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

type TaskState = 'queued' | 'running' | 'succeeded' | 'failed'
type InputFidelityCapability = {
  requested: string
  status: 'accepted' | 'unsupported'
  risk?: string
}

type TaskRecord = {
  status: TaskState
  data?: unknown[]
  error?: string
  created: number
  inputFidelity?: InputFidelityCapability
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

export type RelayDeps = { env: Env; fetchImpl?: FetchLike; now?: () => number }

export function createRelayFetch(deps: RelayDeps): (req: Request) => Promise<Response> {
  const config = loadRelayConfig(deps.env)
  const fetchImpl: FetchLike = deps.fetchImpl ?? globalThis.fetch
  const now = deps.now ?? Date.now
  const tasks = new Map<string, TaskRecord>()
  const sem = new Semaphore(config.imgConc)

  function sweep(): void {
    const cutoff = now() - config.taskTtlMs
    for (const [id, rec] of tasks) if (rec.created < cutoff) tasks.delete(id)
  }

  function auth(req: Request): void {
    const header = req.headers.get('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || token !== config.relayToken) throw new HttpError(401, 'relay: 无效令牌')
  }

  /** 后台真正调 OpenAI(US→US);成功存 data,失败存 error。 */
  async function runOpenAi(id: string, body: SubmitBody): Promise<void> {
    const rec = tasks.get(id)
    if (!rec) return
    rec.status = 'running'
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

        let resp = await requestUpstream(Boolean(requestedFidelity))
        let text = await resp.text()
        if (requestedFidelity && inputFidelityRejected(resp.status, text)) {
          rec.inputFidelity = {
            requested: requestedFidelity,
            status: 'unsupported',
            risk: '当前正式端点不接受手动高保真参数，已自动降级为标准图片输入；请人工确认参考图一致性。',
          }
          resp = await requestUpstream(false)
          text = await resp.text()
        } else if (requestedFidelity && resp.ok) {
          rec.inputFidelity = { requested: requestedFidelity, status: 'accepted' }
        }
        if (!resp.ok) throw new Error(`OpenAI ${resp.status}:${text.slice(0, 300)}`)
        let parsed: unknown
        try { parsed = text ? JSON.parse(text) : {} } catch { parsed = {} }
        const data = parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).data)
          ? (parsed as { data: unknown[] }).data
          : []
        rec.status = 'succeeded'
        rec.data = data
      })
    } catch (err) {
      rec.status = 'failed'
      rec.error = err instanceof Error ? err.message : String(err)
    }
  }

  return async function relayFetch(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url)
      if (req.method === 'GET' && url.pathname === '/healthz') {
        return Response.json({ ok: true, tasks: tasks.size, img_conc: config.imgConc })
      }
      if (req.method === 'POST' && url.pathname === '/images/tasks') {
        auth(req)
        sweep()
        let body: SubmitBody
        try { body = (await req.json()) as SubmitBody } catch { throw new HttpError(400, 'relay: 请求体不是合法 JSON') }
        if (!body || typeof body !== 'object') throw new HttpError(400, 'relay: 请求体必须是对象')
        if (!String(body.prompt ?? '').trim()) throw new HttpError(400, 'relay: 缺少 prompt')
        const id = crypto.randomUUID()
        tasks.set(id, { status: 'queued', created: now() })
        // 后台跑,提交立即返回(短请求)。
        void runOpenAi(id, body)
        return Response.json({ task_id: id, status: 'queued' }, { status: 202 })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/images/tasks/')) {
        auth(req)
        sweep()
        const id = url.pathname.slice('/images/tasks/'.length)
        const rec = tasks.get(id)
        if (!rec) return Response.json({ status: 'failed', error: '任务不存在或已过期' }, { status: 404 })
        return Response.json({
          status: rec.status,
          data: rec.data,
          error: rec.error,
          created: rec.created,
          ...(rec.inputFidelity ? {
            input_fidelity_requested: rec.inputFidelity.requested,
            input_fidelity_status: rec.inputFidelity.status,
            ...(rec.inputFidelity.risk ? { input_fidelity_risk: rec.inputFidelity.risk } : {}),
          } : {}),
        })
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
