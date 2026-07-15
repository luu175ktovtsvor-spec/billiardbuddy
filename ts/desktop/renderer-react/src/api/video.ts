import {
  videoAlternativeApplyResponseSchema,
  videoBriefCompileResponseSchema,
  videoCreateProjectResponseSchema,
  videoJobResponseSchema,
  videoJobStartResponseSchema,
  videoMutationResponseSchema,
  videoOpsResponseSchema,
  videoProjectListResponseSchema,
  videoProjectResponseSchema,
  type VideoAlternative,
  type VideoBriefCompileInput,
  type VideoBriefCompileResponse,
  type VideoContentType,
  type VideoCreateProjectInput,
  type VideoJob,
  type VideoOperation,
  type VideoProject,
  type VideoRenderInput,
  type VideoScene,
  type VideoSource,
  type VideoSourceRole,
} from '../../../../shared/contracts/video-edit'
import { api, getBaseUrl } from './client'

export type {
  VideoAlternative,
  VideoBriefCompileInput,
  VideoBriefCompileResponse,
  VideoContentType,
  VideoCreateProjectInput,
  VideoJob,
  VideoOperation,
  VideoProject,
  VideoRenderInput,
  VideoScene,
  VideoSource,
  VideoSourceRole,
}

function projectPath(projectId: string, suffix = ''): string {
  return `/api/v1/video-edit/projects/${encodeURIComponent(projectId)}${suffix}`
}

export const videoApi = {
  async listProjects(workingDir?: string | null): Promise<VideoProject[]> {
    const query = workingDir ? `?working_dir=${encodeURIComponent(workingDir)}` : ''
    return videoProjectListResponseSchema.parse(await api.get(`/api/v1/video-edit/projects${query}`)).projects
  },
  async getProject(projectId: string): Promise<VideoProject> {
    return videoProjectResponseSchema.parse(await api.get(projectPath(projectId))).project
  },
  async createProject(input: VideoCreateProjectInput) {
    return videoCreateProjectResponseSchema.parse(await api.post('/api/v1/video-edit/projects', input))
  },
  async compileBrief(projectId: string, input: VideoBriefCompileInput): Promise<VideoBriefCompileResponse> {
    return videoBriefCompileResponseSchema.parse(await api.post(projectPath(projectId, '/brief/compile'), input))
  },
  async analyze(projectId: string, sourceIds?: string[]) {
    return videoJobStartResponseSchema.parse(await api.post(projectPath(projectId, '/analyze'), { source_ids: sourceIds }))
  },
  async drafts(projectId: string) {
    return videoJobStartResponseSchema.parse(await api.post(projectPath(projectId, '/drafts'), {}))
  },
  async applyOperations(projectId: string, baseRevision: number, operations: VideoOperation[]) {
    return videoOpsResponseSchema.parse(await api.post(projectPath(projectId, '/ops'), { base_revision: baseRevision, operations }))
  },
  async undo(projectId: string, baseRevision: number): Promise<VideoProject> {
    return videoMutationResponseSchema.parse(await api.post(projectPath(projectId, '/undo'), { base_revision: baseRevision })).project
  },
  async redo(projectId: string, baseRevision: number): Promise<VideoProject> {
    return videoMutationResponseSchema.parse(await api.post(projectPath(projectId, '/redo'), { base_revision: baseRevision })).project
  },
  async applyAlternative(projectId: string, alternativeId: string, baseRevision: number, scope: 'whole' | 'scene', sceneId?: string): Promise<VideoProject> {
    return videoAlternativeApplyResponseSchema.parse(await api.post(projectPath(projectId, `/alternatives/${encodeURIComponent(alternativeId)}/apply`), {
      base_revision: baseRevision,
      scope,
      scene_id: sceneId,
    })).project
  },
  async render(projectId: string, input: VideoRenderInput) {
    return videoJobStartResponseSchema.parse(await api.post(projectPath(projectId, '/render'), input))
  },
  async getJob(jobId: string): Promise<VideoJob> {
    return videoJobResponseSchema.parse(await api.get(`/api/v1/video-edit/jobs/${encodeURIComponent(jobId)}`)).job
  },
  async cancelJob(jobId: string): Promise<VideoJob> {
    return videoJobResponseSchema.parse(await api.post(`/api/v1/video-edit/jobs/${encodeURIComponent(jobId)}/cancel`, {})).job
  },
  async retryJob(jobId: string) {
    return videoJobStartResponseSchema.parse(await api.post(`/api/v1/video-edit/jobs/${encodeURIComponent(jobId)}/retry`, {}))
  },
  sourceUrl(projectId: string, sourceId: string): string {
    return `${getBaseUrl()}${projectPath(projectId, `/sources/${encodeURIComponent(sourceId)}`)}`
  },
  brandLogoUrl(projectId: string): string {
    return `${getBaseUrl()}${projectPath(projectId, '/brand/logo')}`
  },
  assetUrl(path: string): string {
    return path.startsWith('http://') || path.startsWith('https://') ? path : `${getBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`
  },
}

export async function pollVideoJob(
  jobId: string,
  options: { signal?: AbortSignal; onChange?: (job: VideoJob) => void; intervalMs?: number } = {},
): Promise<VideoJob> {
  for (;;) {
    if (options.signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
    const job = await videoApi.getJob(jobId)
    options.onChange?.(job)
    if (['done', 'done_with_warnings', 'cancelled', 'interrupted', 'error'].includes(job.status)) return job
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, options.intervalMs ?? 500)
      options.signal?.addEventListener('abort', () => {
        window.clearTimeout(timer)
        reject(new DOMException('任务已取消', 'AbortError'))
      }, { once: true })
    })
  }
}
