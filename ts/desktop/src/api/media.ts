import type {
  CreateImageProjectInput,
  CreateVideoProjectInput,
  ImageCanvasSize,
  ImageGenerationModel,
  ImageWorkbenchProject,
  MediaProject,
  MediaTask,
  RenderVideoInput,
  SaveImageOutputInput,
  UpdateImageProjectInput,
  UpdateVideoTimelineInput,
  VideoStudioProject,
} from '../../../shared/contracts/media'
import { isMediaSafeErrorMessage, mediaSafeError } from '../../../shared/contracts/media'
export {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES_TOTAL_BYTES,
} from '../../../shared/contracts/media'
import { api, ApiError, getApiUrl } from './client'
import { getDesktopHost } from '../lib/desktopHost'

export type MediaToolchainStatus = {
  ffmpeg: { available: boolean }
  ffprobe: { available: boolean }
}

const MEDIA_WORKBENCH_FALLBACK_ERROR = '媒体服务暂时不可用，请稍后重试。'
export const MEDIA_RESULT_REQUEST_TIMEOUT_MS = 5 * 60_000

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
export function mediaUserFacingError(
  error: unknown,
  fallback = MEDIA_WORKBENCH_FALLBACK_ERROR,
): string {
  const code = mediaErrorCode(error)
  if (code !== undefined) return mediaSafeError(code).message
  const message = error instanceof Error ? error.message : undefined
  return isMediaSafeErrorMessage(message) ? message : fallback
}

export const mediaApi = {
  listProjects: (kind?: 'image' | 'video') =>
    api.get<{ projects: MediaProject[] }>(`/api/media/projects${kind ? `?kind=${kind}` : ''}`),
  getProject: (projectId: string) =>
    api.get<{ project: MediaProject }>(`/api/media/project/${encodeURIComponent(projectId)}`),
  deleteProject: (projectId: string) =>
    api.delete<void>(`/api/media/project/${encodeURIComponent(projectId)}`),
  getTask: (taskId: string) =>
    api.get<{ task: MediaTask }>(
      `/api/media/tasks/${encodeURIComponent(taskId)}`,
      { timeout: MEDIA_RESULT_REQUEST_TIMEOUT_MS },
    ),
  cancelTask: (taskId: string) =>
    api.post<{ task: MediaTask }>(`/api/media/tasks/${encodeURIComponent(taskId)}/cancel`),
  createImageProject: (input: CreateImageProjectInput) =>
    api.post<{ project: ImageWorkbenchProject }>('/api/media/images/projects', input),
  submitImageProject: (projectId: string, confirmUnknownRetry = false, confirmedDataEgress = false) =>
    getDesktopHost().media.submitImageProject(projectId, confirmUnknownRetry, confirmedDataEgress),
  saveImageOutput: (projectId: string, input: SaveImageOutputInput) =>
    getDesktopHost().media.saveImageOutput(projectId, input),
  updateImageProject: (projectId: string, input: UpdateImageProjectInput) =>
    input.confirm_unknown_retry
      ? getDesktopHost().media.updateUnknownImageProject(projectId, input)
      : api.put<{ project: ImageWorkbenchProject }>(
        `/api/media/images/projects/${encodeURIComponent(projectId)}`,
        input,
      ),
  createVideoProject: (input: CreateVideoProjectInput) =>
    api.post<{ project: VideoStudioProject }>('/api/media/videos/projects', input),
  addVideoSource: (projectId: string, path: string) =>
    api.post<{ project: VideoStudioProject; task: MediaTask }>(
      `/api/media/videos/projects/${encodeURIComponent(projectId)}/sources`,
      { path },
      { timeout: 180_000 },
    ),
  updateVideoTimeline: (projectId: string, input: UpdateVideoTimelineInput) =>
    api.put<{ project: VideoStudioProject }>(
      `/api/media/videos/projects/${encodeURIComponent(projectId)}/timeline`,
      input,
    ),
  renderVideo: (projectId: string, input: RenderVideoInput) =>
    getDesktopHost().media.renderVideo({
      projectId,
      revision: input.revision,
      outputPath: input.output_path,
    }),
  getToolchain: () => api.get<MediaToolchainStatus>('/api/media/videos/toolchain'),
  assetUrl: (path: string) => getApiUrl(path),
  sourceUrl: (projectId: string, sourceId: string) => getApiUrl(
    `/api/media/videos/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/content`,
  ),
}

export type {
  CreateImageProjectInput,
  CreateVideoProjectInput,
  ImageCanvasSize,
  ImageGenerationModel,
  ImageWorkbenchProject,
  MediaProject,
  MediaTask,
  VideoStudioProject,
}
