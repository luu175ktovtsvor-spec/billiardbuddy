// 生图/媒体 job api(接后端 /api/v1/studio/* + /api/v1/agent/media-jobs/:id)。
// 生图看板用它:提交生图 → 轮询 job → 拿回图列表(poster_url)展示挑选。
import { api, getBaseUrl } from './client'

export interface StudioImage {
  generation_id: string
  poster_url: string
  source_url?: string
  revised_prompt?: string
  width?: number
  height?: number
  ratio?: string
}

export interface GenerateResult {
  urls?: string[]
  generation_ids?: string[]
  images?: StudioImage[]
  count?: number
  ratio?: string
  /** 反逻辑保护:资产未就绪时后端返回 blocked + message("正在准备组件 x%")。 */
  blocked?: boolean
  message?: string
  local_preview?: boolean
}

export interface GenerateInput {
  prompt: string
  ratio?: string
  count?: number
  /** 白标:前端不显模型名。默认走豆包 Seedream(主力),这里只是内部路由标识。 */
  image_provider?: 'seedream' | 'openai'
}

export interface MediaJob {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'error' | 'failed' | string
  progress?: number
  stage?: string
  result?: GenerateResult & Record<string, unknown>
  error?: string | null
}

export const studioApi = {
  /** 提交生图(异步 job)。返回 job_id,再轮询 job()。 */
  generate: (input: GenerateInput) =>
    api.post<{ job_id: string }>('/api/v1/studio/generate', {
      prompt: input.prompt,
      image_prompt: input.prompt,
      ratio: input.ratio ?? '3:4',
      count: input.count ?? 2,
      image_provider: input.image_provider ?? 'seedream',
    }),
  /** 查媒体 job 进度/结果。 */
  job: (id: string) => api.get<MediaJob>(`/api/v1/agent/media-jobs/${encodeURIComponent(id)}`),
  /** 超分放大(本机 Real-ESRGAN,印刷不糊)。异步 job,轮询拿放大后的 poster_url。 */
  upscale: (input: { source_generation_id?: string; source_image_path?: string; scale?: number }) =>
    api.post<{ job_id: string }>('/api/v1/studio/upscale', input),
  /** 改图(基于某张图 + 指令做整图调整;局部重绘另传 mask)。异步 job。 */
  edit: (input: { source_generation_id?: string; source_image_path?: string; description: string; ratio?: string; mask_path?: string }) =>
    api.post<{ job_id: string }>('/api/v1/studio/edit', {
      source_generation_id: input.source_generation_id,
      source_image_path: input.source_image_path,
      prompt: input.description,
      image_prompt: input.description,
      ratio: input.ratio,
      mask_path: input.mask_path,
    }),
}

/** 超分/改图结果里挑成图 url(后端字段 poster_url / url)。 */
export function pickImageUrl(result: Record<string, unknown> | undefined): string | undefined {
  const r = result ?? {}
  const poster = typeof r.poster_url === 'string' ? r.poster_url : undefined
  const url = typeof r.url === 'string' ? r.url : undefined
  return poster ?? url
}

/** 轮询 job 到 done/error;每次 progress 回调给 UI 显示"正在生成 x%"。 */
export async function pollJob(
  id: string,
  opts: { onProgress?: (p: number, stage?: string) => void; signal?: AbortSignal; intervalMs?: number } = {},
): Promise<MediaJob> {
  const interval = opts.intervalMs ?? 1500
  for (;;) {
    if (opts.signal?.aborted) throw new Error('已取消')
    const job = await studioApi.job(id)
    if (opts.onProgress && typeof job.progress === 'number') opts.onProgress(job.progress, job.stage)
    if (job.status === 'done' || job.status === 'error' || job.status === 'failed') return job
    await new Promise((r) => setTimeout(r, interval))
  }
}

/** /uploads/.. 相对 url → 可直接 <img src> 的绝对 url(接 sidecar baseUrl)。 */
export function assetUrl(url: string): string {
  if (/^(https?|data):/i.test(url)) return url
  return `${getBaseUrl()}${url.startsWith('/') ? url : `/${url}`}`
}
