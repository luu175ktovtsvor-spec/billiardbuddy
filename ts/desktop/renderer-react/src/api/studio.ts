// 生图/工作台 API:renderer 只提交能力意图;真实 provider/model 留在 sidecar。
import { api, getBaseUrl } from './client'
import {
  imageWorkbenchAssetResponseSchema,
  imageWorkbenchExportResponseSchema,
  imageWorkbenchLibraryResponseSchema,
  imageWorkbenchProjectListResponseSchema,
  imageWorkbenchProjectResponseSchema,
  mediaJobSchema,
  mediaJobStartResponseSchema,
  type ImageIntent,
  type ImageQuality,
  type ImageWorkbenchAddVersionRequest,
  type ImageWorkbenchAsset,
  type ImageWorkbenchCreateProjectRequest,
  type ImageWorkbenchLibraryItem,
  type ImageWorkbenchProject,
  type ImageWorkbenchReview,
  type ImageWorkbenchTextLayer,
  type ImageWorkbenchVersion,
  type MediaJob as ContractMediaJob,
  type StudioImage,
} from '../../../../shared/contracts/image-workbench'

export type { ImageIntent, ImageQuality, ImageWorkbenchAsset, ImageWorkbenchLibraryItem, ImageWorkbenchProject, ImageWorkbenchReview, ImageWorkbenchTextLayer, ImageWorkbenchVersion, StudioImage }

export interface GenerateResult {
  urls?: string[]
  generation_ids?: string[]
  images?: StudioImage[]
  count?: number
  ratio?: string
  blocked?: boolean
  message?: string
  local_preview?: boolean
  [key: string]: unknown
}

export interface MediaJob extends Omit<ContractMediaJob, 'result'> {
  result?: GenerateResult & Record<string, unknown>
}

export interface GenerateInput {
  prompt: string
  scene_template_id?: string
  ratio?: string
  count?: number
  intent?: ImageIntent
  quality?: ImageQuality
  reference_image_paths?: string[]
  reference_generation_ids?: string[]
}

export interface EditInput {
  source_generation_id?: string
  source_image_path?: string
  description: string
  ratio?: string
  mask_path?: string
  intent?: Extract<ImageIntent, 'edit_content' | 'inpaint'>
  quality?: ImageQuality
}

function parseJob(raw: unknown): MediaJob {
  return mediaJobSchema.parse(raw) as MediaJob
}

export async function pollJob(
  id: string,
  opts: { onProgress?: (p: number, stage?: string) => void; signal?: AbortSignal; intervalMs?: number } = {},
): Promise<MediaJob> {
  const interval = opts.intervalMs ?? 1500
  for (;;) {
    if (opts.signal?.aborted) throw new Error('已取消')
    const job = await studioApi.job(id)
    if (opts.onProgress && typeof job.progress === 'number') opts.onProgress(job.progress, job.stage ?? undefined)
    if (job.status === 'done' || job.status === 'error' || job.status === 'failed') return job
    await new Promise((resolve) => setTimeout(resolve, interval))
  }
}

export const studioApi = {
  generate: async (input: GenerateInput) => mediaJobStartResponseSchema.parse(await api.post<unknown>('/api/v1/studio/generate', {
    prompt: input.prompt,
    image_prompt: input.prompt,
    scene_template_id: input.scene_template_id,
    ratio: input.ratio ?? '3:4',
    count: input.count ?? 3,
    intent: input.intent ?? 'poster_text',
    quality: input.quality ?? 'standard',
    reference_image_paths: input.reference_image_paths,
    reference_generation_ids: input.reference_generation_ids,
  })),

  job: async (id: string) => parseJob(await api.get<unknown>(`/api/v1/agent/media-jobs/${encodeURIComponent(id)}`)),

  cancelJob: async (id: string) => api.post<unknown>(`/api/v1/agent/tasks/${encodeURIComponent(id)}/cancel`, {}),

  upscale: async (input: { source_generation_id?: string; source_image_path?: string; scale?: 2 | 3 | 4 }) =>
    mediaJobStartResponseSchema.parse(await api.post<unknown>('/api/v1/studio/upscale', input)),

  edit: async (input: EditInput) => mediaJobStartResponseSchema.parse(await api.post<unknown>('/api/v1/studio/edit', {
    source_generation_id: input.source_generation_id,
    source_image_path: input.source_image_path,
    prompt: input.description,
    image_prompt: input.description,
    ratio: input.ratio,
    mask_path: input.mask_path,
    intent: input.intent ?? (input.mask_path ? 'inpaint' : 'edit_content'),
    quality: input.quality ?? 'standard',
  })),
}

export const workbenchApi = {
  listProjects: async () => imageWorkbenchProjectListResponseSchema.parse(await api.get<unknown>('/api/v1/studio/workbench/projects')).projects,

  createProject: async (input: ImageWorkbenchCreateProjectRequest) =>
    imageWorkbenchProjectResponseSchema.parse(await api.post<unknown>('/api/v1/studio/workbench/projects', input)).project,

  getProject: async (projectId: string) =>
    imageWorkbenchProjectResponseSchema.parse(await api.get<unknown>(`/api/v1/studio/workbench/projects/${encodeURIComponent(projectId)}`)).project,

  saveCanvas: async (projectId: string, input: { current_version_id?: string; width: number; height: number; text_layers: ImageWorkbenchTextLayer[] }) =>
    imageWorkbenchProjectResponseSchema.parse(await api.patch<unknown>(`/api/v1/studio/workbench/projects/${encodeURIComponent(projectId)}/canvas`, input)).project,

  addVersion: async (projectId: string, input: ImageWorkbenchAddVersionRequest) =>
    imageWorkbenchProjectResponseSchema.parse(await api.post<unknown>(`/api/v1/studio/workbench/projects/${encodeURIComponent(projectId)}/versions`, input)).project,

  rollback: async (projectId: string, version_id: string) =>
    imageWorkbenchProjectResponseSchema.parse(await api.post<unknown>(`/api/v1/studio/workbench/projects/${encodeURIComponent(projectId)}/rollback`, { version_id })).project,

  uploadAsset: async (input: { kind: 'reference' | 'mask' | 'export' | 'library'; data_url: string; filename?: string; width: number; height: number }) =>
    imageWorkbenchAssetResponseSchema.parse(await api.post<unknown>('/api/v1/studio/workbench/assets', input)).asset,

  exportPng: async (projectId: string, input: { version_id?: string; data_url: string; width: number; height: number; text_layers?: ImageWorkbenchTextLayer[] }) =>
    imageWorkbenchExportResponseSchema.parse(await api.post<unknown>(`/api/v1/studio/workbench/projects/${encodeURIComponent(projectId)}/export`, input)),

  saveToLibrary: async (projectId: string, input: { version_id?: string; export_asset_id?: string; title?: string }) =>
    imageWorkbenchLibraryResponseSchema.parse(await api.post<unknown>(`/api/v1/studio/workbench/projects/${encodeURIComponent(projectId)}/library`, input)).item,
}

export async function uploadLocalImage(file: File): Promise<{ url: string }> {
  const form = new FormData()
  form.set('file', file)
  const response = await fetch(`${getBaseUrl()}/api/v1/uploads/image`, { method: 'POST', body: form })
  if (!response.ok) throw new Error(`上传图片失败(${response.status})`)
  const body = await response.json() as { url?: unknown }
  if (typeof body.url !== 'string') throw new Error('上传图片没有返回 url')
  return { url: body.url }
}

export function pickImageUrl(result: Record<string, unknown> | undefined): string | undefined {
  const r = result ?? {}
  const poster = typeof r.poster_url === 'string' ? r.poster_url : undefined
  const url = typeof r.url === 'string' ? r.url : undefined
  return poster ?? url
}

export function assetUrl(url: string): string {
  if (/^(https?|data):/i.test(url)) return url
  return `${getBaseUrl()}${url.startsWith('/') ? url : `/${url}`}`
}
