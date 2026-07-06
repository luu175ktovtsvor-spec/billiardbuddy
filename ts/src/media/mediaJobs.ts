import { mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { FetchLike } from '../proxy/ProxyModel'
import type { TaskMeta, TaskRunnerContext, TaskService, TaskStatus } from '../tasks/taskService'

export type MediaJobKind =
  | 'generate'
  | 'edit'
  | 'variations'
  | 'i2v'
  | 'compose'
  | 'video_inventory'
  | 'video_render'
  | 'video_auto_plan'
  | 'video'

export interface MediaJobStatus {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  stage: string | null
  result: Record<string, unknown> | null
  error: string | null
}

export interface MediaJobStartResult {
  job_id: string
  project?: string
}

export interface MediaJobServiceOptions {
  tasks: TaskService
  stateRoot: string
  backendUrl?: string
  fetchImpl?: FetchLike
  pollIntervalMs?: number
}

interface StartMediaJobInput {
  kind: MediaJobKind
  title: string
  body: Record<string, unknown>
  conversationId?: string
  workspaceRoot?: string
  proxyPath?: string
  project?: string
  fallback?: (ctx: TaskRunnerContext, task: TaskMeta) => Promise<Record<string, unknown>>
}

const POLL_LIMIT = 1800
const DEFAULT_POLL_MS = 1000

function normalizeBackendUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, '')
  return trimmed || undefined
}

export function resolveMediaBackendUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return normalizeBackendUrl(
    env.MEDIA_BACKEND_URL ??
    env.PYTHON_BACKEND_URL ??
    env.LEGACY_BACKEND_URL ??
    env.QF_MEDIA_BACKEND_URL,
  )
}

function statusFromTask(status: TaskStatus): MediaJobStatus['status'] {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'completed') return 'done'
  return 'error'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { text: value }
  } catch {
    return { text: value }
  }
}

function numberFrom(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

function upstreamStatusFrom(value: Record<string, unknown>): MediaJobStatus {
  const rawStatus = value.status
  const status: MediaJobStatus['status'] = rawStatus === 'done' || rawStatus === 'completed'
    ? 'done'
    : rawStatus === 'error' || rawStatus === 'failed' || rawStatus === 'cancelled'
      ? 'error'
      : rawStatus === 'queued'
        ? 'queued'
        : 'running'
  return {
    id: String(value.id ?? value.job_id ?? ''),
    kind: String(value.kind ?? 'media'),
    status,
    progress: numberFrom(value.progress, status === 'done' ? 100 : 0),
    stage: typeof value.stage === 'string' ? value.stage : null,
    result: asRecord(value.result),
    error: typeof value.error === 'string' ? value.error : typeof value.detail === 'string' ? value.detail : null,
  }
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function clampCount(value: unknown): number {
  const n = numberFrom(value, 1)
  return Math.max(1, Math.min(4, n))
}

function ratioSize(ratio: unknown): { ratio: string; width: number; height: number } {
  const r = typeof ratio === 'string' ? ratio : ''
  if (r === '1:1') return { ratio: r, width: 1024, height: 1024 }
  if (r === '9:16') return { ratio: r, width: 1152, height: 2048 }
  if (r === '16:9') return { ratio: r, width: 2048, height: 1152 }
  if (r === '2:5') return { ratio: r, width: 1216, height: 3040 }
  if (r === '5:2') return { ratio: r, width: 3040, height: 1216 }
  return { ratio: '3:4', width: 1152, height: 1536 }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function shortText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return text.length > 88 ? `${text.slice(0, 88)}...` : text
}

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function ensureProjectName(value: unknown): string {
  const raw = typeof value === 'string' ? basename(value).replace(/[^A-Za-z0-9_-]/g, '') : ''
  return raw || crypto.randomUUID().replaceAll('-', '').slice(0, 10)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class MediaJobService {
  private readonly backendUrl?: string
  private readonly uploadsRoot: string
  private readonly fetchImpl: FetchLike
  private readonly pollIntervalMs: number

  constructor(private readonly opts: MediaJobServiceOptions) {
    this.backendUrl = normalizeBackendUrl(opts.backendUrl)
    this.uploadsRoot = join(opts.stateRoot, 'uploads')
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
  }

  get hasBackend(): boolean {
    return !!this.backendUrl
  }

  async status(id: string): Promise<MediaJobStatus | null> {
    const task = await this.opts.tasks.get(id)
    return task ? this.statusFromMeta(task) : null
  }

  async startJob(input: StartMediaJobInput): Promise<MediaJobStartResult> {
    const task = await this.opts.tasks.create({
      title: input.title,
      kind: input.kind,
      conversationId: input.conversationId,
      workspaceRoot: input.workspaceRoot,
      params: { ...input.body, ...(input.project ? { project: input.project } : {}) },
    })
    this.opts.tasks.start(task.id, async ctx => {
      if (this.backendUrl && input.proxyPath) {
        return await this.runProxyJob(ctx, input.proxyPath, input.body)
      }
      if (input.fallback) return await input.fallback(ctx, task)
      throw new Error('媒体后端未配置:请设置 MEDIA_BACKEND_URL 或 PYTHON_BACKEND_URL 后再生成。')
    })
    return { job_id: task.id, ...(input.project ? { project: input.project } : {}) }
  }

  startStudioGenerate(body: Record<string, unknown>, opts: { conversationId?: string; workspaceRoot?: string } = {}): Promise<MediaJobStartResult> {
    const normalized = {
      ...body,
      count: clampCount(body.count),
      conversation_id: stringFrom(body.conversation_id) ?? opts.conversationId,
    }
    return this.startJob({
      kind: 'generate',
      title: `生图:${shortText(body.prompt ?? body.description, '图片')}`,
      body: normalized,
      conversationId: stringFrom(normalized.conversation_id),
      workspaceRoot: opts.workspaceRoot,
      proxyPath: '/api/v1/studio/generate',
      fallback: ctx => this.localImageFallback(ctx, normalized, 'generate'),
    })
  }

  startStudioEdit(body: Record<string, unknown>, opts: { conversationId?: string; workspaceRoot?: string } = {}): Promise<MediaJobStartResult> {
    const normalized = {
      ...body,
      count: clampCount(body.count),
      conversation_id: stringFrom(body.conversation_id) ?? opts.conversationId,
    }
    return this.startJob({
      kind: 'edit',
      title: `改图:${shortText(body.prompt, '图片调整')}`,
      body: normalized,
      conversationId: stringFrom(normalized.conversation_id),
      workspaceRoot: opts.workspaceRoot,
      proxyPath: '/api/v1/studio/edit',
      fallback: ctx => this.localImageFallback(ctx, normalized, 'edit'),
    })
  }

  startStudioI2v(body: Record<string, unknown>, opts: { conversationId?: string; workspaceRoot?: string } = {}): Promise<MediaJobStartResult> {
    const normalized = { ...body, conversation_id: stringFrom(body.conversation_id) ?? opts.conversationId }
    return this.startJob({
      kind: 'i2v',
      title: `图生视频:${shortText(body.prompt, '让图片动起来')}`,
      body: normalized,
      conversationId: stringFrom(normalized.conversation_id),
      workspaceRoot: opts.workspaceRoot,
      proxyPath: '/api/v1/studio/i2v',
      fallback: ctx => this.unavailableFallback(ctx, '视频生成需要媒体后端或视频模型网关。'),
    })
  }

  startVideoJob(kind: MediaJobKind, proxyPath: string, body: Record<string, unknown>, opts: { conversationId?: string; workspaceRoot?: string; project?: string; title?: string } = {}): Promise<MediaJobStartResult> {
    const project = opts.project ?? ensureProjectName(body.project)
    const normalized = { ...body, project, conversation_id: stringFrom(body.conversation_id) ?? opts.conversationId }
    return this.startJob({
      kind,
      title: opts.title ?? `视频任务:${project}`,
      body: normalized,
      conversationId: stringFrom(normalized.conversation_id),
      workspaceRoot: opts.workspaceRoot,
      proxyPath,
      project,
      fallback: ctx => this.unavailableFallback(ctx, '视频剪辑需要媒体后端。'),
    })
  }

  async proxyJson(path: string, body?: Record<string, unknown>, method = 'POST'): Promise<Record<string, unknown>> {
    if (!this.backendUrl) throw new Error('媒体后端未配置')
    const res = await this.fetchImpl(`${this.backendUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
    return await this.readJson(res, path)
  }

  serveUpload(pathname: string): Response | null {
    if (!pathname.startsWith('/uploads/')) return null
    const rel = pathname.slice('/uploads/'.length)
    if (!rel || rel.includes('\0')) return new Response('Not found', { status: 404 })
    const abs = resolve(this.uploadsRoot, rel)
    const root = resolve(this.uploadsRoot)
    if (abs !== root && !abs.startsWith(`${root}/`)) return new Response('Not found', { status: 404 })
    if (!existsSync(abs)) return new Response('Not found', { status: 404 })
    return new Response(Bun.file(abs), { headers: { 'Content-Type': contentTypeFor(abs) } })
  }

  localGeneration(generationId: string): Record<string, unknown> | null {
    const id = generationId.trim()
    if (!id.startsWith('local-')) return null
    const stem = id.slice('local-'.length)
    if (!stem || /[\\/]/.test(stem) || stem.includes('..')) return null
    const posterPath = resolve(this.uploadsRoot, 'posters', `${stem}.svg`)
    const postersRoot = resolve(this.uploadsRoot, 'posters')
    if (posterPath !== postersRoot && !posterPath.startsWith(`${postersRoot}/`)) return null
    if (!existsSync(posterPath)) return null
    return {
      url: `/uploads/posters/${stem}.svg`,
      ratio: null,
      is_video: false,
      local_preview: true,
    }
  }

  private statusFromMeta(task: TaskMeta): MediaJobStatus {
    return {
      id: task.id,
      kind: task.kind ?? 'task',
      status: statusFromTask(task.status),
      progress: Math.max(0, Math.min(100, numberFrom(task.progress, task.status === 'completed' ? 100 : 0))),
      stage: task.stage ?? null,
      result: asRecord(task.result),
      error: task.error ?? (task.status === 'cancelled' ? '任务已取消' : null),
    }
  }

  private async readJson(res: Response, label: string): Promise<Record<string, unknown>> {
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = { detail: text }
    }
    if (!res.ok) {
      const detail = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? String((parsed as Record<string, unknown>).detail ?? (parsed as Record<string, unknown>).error ?? text)
        : text
      throw new Error(`${label} failed ${res.status}:${detail.slice(0, 500)}`)
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }

  private async runProxyJob(ctx: TaskRunnerContext, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await ctx.progress(3, '已收到媒体任务，正在提交给生成服务。')
    const started = await this.proxyJson(path, body)
    const upstreamId = stringFrom(started.job_id)
    if (!upstreamId) return started
    await ctx.progress(8, '媒体任务已提交，正在排队处理。')
    let lastProgress = -1
    let lastStage = ''
    for (let i = 0; i < POLL_LIMIT; i++) {
      if (ctx.signal.aborted) throw new Error('任务已取消')
      const status = upstreamStatusFrom(await this.proxyJson(`/api/v1/agent/media-jobs/${encodeURIComponent(upstreamId)}`, undefined, 'GET'))
      const progress = numberFrom(status.progress, lastProgress < 0 ? 8 : lastProgress)
      const stage = typeof status.stage === 'string' ? status.stage : ''
      if (progress !== lastProgress || (stage && stage !== lastStage)) {
        lastProgress = progress
        lastStage = stage
        await ctx.progress(progress, stage || '媒体任务处理中。')
      }
      if (status.status === 'done') return status.result ?? {}
      if (status.status === 'error') throw new Error(status.error || '媒体任务失败')
      await delay(this.pollIntervalMs)
    }
    throw new Error('媒体任务超时')
  }

  private async localImageFallback(ctx: TaskRunnerContext, body: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    await ctx.progress(10, '媒体后端未配置，先生成本地预览占位图。')
    const { ratio, width, height } = ratioSize(body.ratio)
    const count = clampCount(body.count)
    const prompt = String(body.image_prompt ?? body.prompt ?? body.description ?? '图片预览')
    const dir = join(this.uploadsRoot, 'posters')
    await mkdir(dir, { recursive: true })
    const images: Record<string, unknown>[] = []
    for (let i = 0; i < count; i++) {
      const filename = `preview_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${i + 1}.svg`
      const path = join(dir, filename)
      const subtitle = mode === 'edit' ? 'TS edit preview' : 'TS image preview'
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f5f7f2"/>
  <rect x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.06)}" width="${Math.round(width * 0.88)}" height="${Math.round(height * 0.88)}" rx="24" fill="#ffffff" stroke="#1f7a57" stroke-width="8"/>
  <text x="50%" y="42%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(34, Math.round(width / 24))}" fill="#0f5132">${xmlEscape(subtitle)}</text>
  <text x="50%" y="51%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(24, Math.round(width / 36))}" fill="#234236">${xmlEscape(shortText(prompt, 'preview'))}</text>
  <text x="50%" y="59%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(20, Math.round(width / 48))}" fill="#5f6f68">ratio ${xmlEscape(ratio)} · backend not configured</text>
</svg>
`
      await writeFile(path, svg, 'utf8')
      images.push({
        generation_id: `local-${filename.replace(/\.svg$/, '')}`,
        poster_url: `/uploads/posters/${filename}`,
        width,
        height,
        ratio,
        local_preview: true,
      })
    }
    await ctx.progress(100, '本地预览占位图已生成；配置媒体后端后会调用真实生图模型。')
    return {
      urls: images.map(img => img.poster_url),
      images,
      count: images.length,
      ratio,
      local_preview: true,
      message: '媒体后端未配置，当前结果是占位预览，不是模型生成图。',
    }
  }

  private async unavailableFallback(ctx: TaskRunnerContext, message: string): Promise<Record<string, unknown>> {
    await ctx.progress(5, message)
    throw new Error(message)
  }
}
