import type {
  CreateVideoProjectInput,
  ApplyVideoAlternativeInput,
  AnalyzeVideoProjectInput,
  PublicMediaJobEvent,
  PublicMediaJobEventPage,
  PublicMediaDeletionReceipt,
  PublicMediaTask,
  PublicVideoStudioProject,
  LockVideoSceneInput,
  PreviewVideoInput,
  RenderVideoInput,
  SelectVideoTimelineVersionInput,
  UpdateVideoTimelineInput,
} from '../../../shared/contracts/media'
import { isMediaSafeErrorMessage, mediaSafeError } from '../../../shared/contracts/media'
export {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES_TOTAL_BYTES,
} from '../../../shared/contracts/media'
import { api, ApiError, getApiUrl } from './client'
import { getDesktopHost } from '../lib/desktopHost'

export type VideoToolchainStatus = {
  ffmpeg: { available: boolean }
  ffprobe: { available: boolean }
}

const MEDIA_WORKBENCH_FALLBACK_ERROR = '媒体服务暂时不可用，请稍后重试。'
export const VIDEO_RESULT_REQUEST_TIMEOUT_MS = 5 * 60_000

function mediaErrorCode(error: unknown): unknown {
  if (error instanceof ApiError) {
    const body = error.body
    if (body && typeof body === 'object' && 'error' in body) return body.error
  }
  if (error && typeof error === 'object' && 'code' in error) {
    return error.code
  }
  return undefined
}

/**
 * API and IPC errors are not renderer copy. Keep only the allow-listed media
 * error vocabulary; transport errors and malformed payloads receive a stable
 * recovery message instead of exposing their raw `Error.message`.
 */
export function videoUserFacingError(
  error: unknown,
  fallback = MEDIA_WORKBENCH_FALLBACK_ERROR,
): string {
  const code = mediaErrorCode(error)
  if (code !== undefined) return mediaSafeError(code).message
  const message = error instanceof Error ? error.message : undefined
  return isMediaSafeErrorMessage(message) ? message : fallback
}

export const videoWorkbenchApi = {
  listProjects: () =>
    api.get<{ projects: PublicVideoStudioProject[] }>('/api/videos/projects'),
  getProject: (projectId: string) =>
    api.get<{ project: PublicVideoStudioProject }>(`/api/videos/projects/${encodeURIComponent(projectId)}`),
  deleteProject: (projectId: string) =>
    api.delete<void>(`/api/videos/projects/${encodeURIComponent(projectId)}`),
  listDeletions: () =>
    api.get<{ deletions: PublicMediaDeletionReceipt[] }>('/api/videos/deletions'),
  restoreProject: (projectId: string) =>
    api.post<{ deletion: PublicMediaDeletionReceipt }>(
      `/api/videos/projects/${encodeURIComponent(projectId)}/restore`,
    ),
  getTask: (taskId: string) =>
    api.get<{ task: PublicMediaTask }>(
      `/api/videos/operations/${encodeURIComponent(taskId)}`,
      { timeout: VIDEO_RESULT_REQUEST_TIMEOUT_MS },
    ),
  waitForProjectEvents: async (
    projectId: string,
    cursor: number,
    signal?: AbortSignal,
  ): Promise<PublicMediaJobEventPage> => {
    const query = new URLSearchParams({
      cursor: String(cursor),
      limit: '100',
      wait_ms: '25000',
    })
    const response = await fetch(getApiUrl(
      `/api/videos/projects/${encodeURIComponent(projectId)}/events?${query.toString()}`,
    ), { signal })
    if (!response.ok) {
      throw new ApiError(response.status, await response.json().catch(() => undefined))
    }
    return await response.json() as PublicMediaJobEventPage
  },
  cancelTask: (taskId: string) =>
    api.post<{ task: PublicMediaTask }>(`/api/videos/operations/${encodeURIComponent(taskId)}/cancel`),
  createVideoProject: (input: CreateVideoProjectInput) =>
    api.post<{ project: PublicVideoStudioProject }>('/api/videos/projects', input),
  addVideoSource: (projectId: string, path: string) =>
    getDesktopHost().videos.addSource(projectId, path),
  updateVideoTimeline: (projectId: string, input: UpdateVideoTimelineInput) =>
    api.put<{ project: PublicVideoStudioProject }>(
      `/api/videos/projects/${encodeURIComponent(projectId)}/timeline`,
      input,
    ),
  selectVideoTimelineVersion: (projectId: string, input: SelectVideoTimelineVersionInput) =>
    api.post<{ project: PublicVideoStudioProject }>(
      `/api/videos/projects/${encodeURIComponent(projectId)}/timeline/versions/${encodeURIComponent(input.version_id)}/select`,
      { revision: input.revision },
    ),
  analyzeVideo: (projectId: string, input: AnalyzeVideoProjectInput) =>
    getDesktopHost().videos.analyze({
      projectId,
      baseRevision: input.base_revision,
      userGoal: input.user_goal,
    }),
  lockVideoScene: (projectId: string, sceneId: string, input: LockVideoSceneInput) =>
    api.post<{ project: PublicVideoStudioProject }>(
      `/api/videos/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/lock`,
      input,
    ),
  applyVideoAlternative: (projectId: string, alternativeId: string, input: ApplyVideoAlternativeInput) =>
    api.post<{ project: PublicVideoStudioProject }>(
      `/api/videos/projects/${encodeURIComponent(projectId)}/alternatives/${encodeURIComponent(alternativeId)}/apply`,
      input,
    ),
  previewVideo: (projectId: string, input: PreviewVideoInput) =>
    api.post<{ task: PublicMediaTask }>(
      `/api/videos/projects/${encodeURIComponent(projectId)}/preview`,
      input,
      { timeout: VIDEO_RESULT_REQUEST_TIMEOUT_MS },
    ),
  renderVideo: (projectId: string, input: RenderVideoInput) =>
    getDesktopHost().videos.render({
      projectId,
      baseRevision: input.base_revision!,
      timelineVersionId: input.timeline_version_id!,
      outputPath: input.output_path,
    }),
  getToolchain: () => api.get<VideoToolchainStatus>('/api/videos/toolchain'),
  assetUrl: (path: string) => getApiUrl(path),
  sourceUrl: (projectId: string, sourceId: string) => getApiUrl(
    `/api/videos/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/content`,
  ),
}

export type {
  CreateVideoProjectInput,
  PublicMediaDeletionReceipt as VideoDeletionReceipt,
  PublicMediaJobEvent as VideoOperationEvent,
  PublicMediaJobEventPage as VideoOperationEventPage,
  PublicMediaTask as VideoOperation,
  PublicVideoStudioProject as VideoStudioProject,
}
