import type {
  CreateImageProjectInput,
  CreateVideoProjectInput,
  ApplyVideoAlternativeInput,
  AnalyzeVideoProjectInput,
  CommitImageVersionInput,
  ImageCanvasSize,
  ImageReferenceRole,
  ImageTextLayer,
  PublicImageWorkbenchProject,
  PublicMediaDeletionReceipt,
  PublicMediaProject,
  PublicMediaTask,
  PublicVideoStudioProject,
  LockVideoSceneInput,
  RenderVideoInput,
  SaveImageOutputInput,
  SelectImageVersionInput,
  StartImageOperationInput,
  UpdateImageProjectInput,
  UpdateVideoTimelineInput,
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
    api.get<{ projects: PublicMediaProject[] }>(`/api/media/projects${kind ? `?kind=${kind}` : ''}`),
  getProject: (projectId: string) =>
    api.get<{ project: PublicMediaProject }>(`/api/media/project/${encodeURIComponent(projectId)}`),
  deleteProject: (projectId: string) =>
    api.delete<void>(`/api/media/project/${encodeURIComponent(projectId)}`),
  listDeletions: () =>
    api.get<{ deletions: PublicMediaDeletionReceipt[] }>('/api/media/deletions'),
  restoreProject: (projectId: string) =>
    api.post<{ deletion: PublicMediaDeletionReceipt }>(
      `/api/media/project/${encodeURIComponent(projectId)}/restore`,
    ),
  getTask: (taskId: string) =>
    api.get<{ task: PublicMediaTask }>(
      `/api/media/tasks/${encodeURIComponent(taskId)}`,
      { timeout: MEDIA_RESULT_REQUEST_TIMEOUT_MS },
    ),
  cancelTask: (taskId: string) =>
    api.post<{ task: PublicMediaTask }>(`/api/media/tasks/${encodeURIComponent(taskId)}/cancel`),
  createImageProject: (input: CreateImageProjectInput) =>
    api.post<{ project: PublicImageWorkbenchProject }>('/api/media/images/projects', input),
  submitImageProject: (projectId: string, confirmUnknownRetry = false, confirmedDataEgress = false) =>
    getDesktopHost().media.submitImageProject(projectId, confirmUnknownRetry, confirmedDataEgress),
  startImageOperation: (
    projectId: string,
    input: Omit<StartImageOperationInput, 'data_egress_consent'>,
    confirmedDataEgress = false,
  ) => getDesktopHost().media.startImageOperation(projectId, input, confirmedDataEgress),
  commitImageVersion: (projectId: string, input: CommitImageVersionInput) =>
    api.post<{ project: PublicImageWorkbenchProject }>(
      `/api/media/images/projects/${encodeURIComponent(projectId)}/versions`,
      input,
      { timeout: MEDIA_RESULT_REQUEST_TIMEOUT_MS },
    ),
  selectImageVersion: (projectId: string, input: SelectImageVersionInput) =>
    api.post<{ project: PublicImageWorkbenchProject }>(
      `/api/media/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(input.version_id)}/select`,
      { revision: input.revision },
    ),
  saveImageOutput: (projectId: string, input: SaveImageOutputInput) =>
    getDesktopHost().media.saveImageOutput(projectId, input),
  updateImageProject: (projectId: string, input: UpdateImageProjectInput) =>
    input.confirm_unknown_retry
      ? getDesktopHost().media.updateUnknownImageProject(projectId, input)
      : api.put<{ project: PublicImageWorkbenchProject }>(
        `/api/media/images/projects/${encodeURIComponent(projectId)}`,
        input,
      ),
  createVideoProject: (input: CreateVideoProjectInput) =>
    api.post<{ project: PublicVideoStudioProject }>('/api/media/videos/projects', input),
  addVideoSource: (projectId: string, path: string) =>
    api.post<{ project: PublicVideoStudioProject; task: PublicMediaTask }>(
      `/api/media/videos/projects/${encodeURIComponent(projectId)}/sources`,
      { path },
      { timeout: 180_000 },
    ),
  updateVideoTimeline: (projectId: string, input: UpdateVideoTimelineInput) =>
    api.put<{ project: PublicVideoStudioProject }>(
      `/api/media/videos/projects/${encodeURIComponent(projectId)}/timeline`,
      input,
    ),
  analyzeVideo: (projectId: string, input: AnalyzeVideoProjectInput) =>
    getDesktopHost().media.analyzeVideo({
      projectId,
      baseRevision: input.base_revision,
      userGoal: input.user_goal,
    }),
  lockVideoScene: (projectId: string, sceneId: string, input: LockVideoSceneInput) =>
    api.post<{ project: PublicVideoStudioProject }>(
      `/api/media/videos/projects/${encodeURIComponent(projectId)}/scenes/${encodeURIComponent(sceneId)}/lock`,
      input,
    ),
  applyVideoAlternative: (projectId: string, alternativeId: string, input: ApplyVideoAlternativeInput) =>
    api.post<{ project: PublicVideoStudioProject }>(
      `/api/media/videos/projects/${encodeURIComponent(projectId)}/alternatives/${encodeURIComponent(alternativeId)}/apply`,
      input,
    ),
  renderVideo: (projectId: string, input: RenderVideoInput) =>
    getDesktopHost().media.renderVideo({
      projectId,
      baseRevision: input.base_revision!,
      timelineVersionId: input.timeline_version_id!,
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
  ImageReferenceRole,
  ImageTextLayer,
  CommitImageVersionInput,
  PublicImageWorkbenchProject as ImageWorkbenchProject,
  PublicMediaProject as MediaProject,
  PublicMediaDeletionReceipt as MediaDeletionReceipt,
  PublicMediaTask as MediaTask,
  PublicVideoStudioProject as VideoStudioProject,
  SelectImageVersionInput,
  StartImageOperationInput,
}
