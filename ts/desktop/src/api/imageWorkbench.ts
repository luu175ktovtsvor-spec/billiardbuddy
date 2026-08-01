import type {
  AddImageProjectReferencesInput,
  CommitImageVersionInput,
  CreateImageProjectInput,
  ImageBriefOverrides,
  ImageCanvasSize,
  ImageLayer,
  ImageReferenceRole,
  ImageTextLayer,
  PublicImageProjectReference,
  PublicImageWorkbenchProject,
  PublicMediaDeletionReceipt,
  PublicMediaJobEvent,
  PublicMediaJobEventPage,
  PublicMediaTask,
  SaveImageOutputInput,
  SaveImageOutputResult,
  SelectImageVersionInput,
  StartImageOperationInput,
  UpdateImageProjectInput,
} from '../../../shared/contracts/media'
import {
  MAX_REFERENCE_IMAGE_BYTES,
  MAX_REFERENCE_IMAGES_TOTAL_BYTES,
  isMediaSafeErrorMessage,
  mediaSafeError,
} from '../../../shared/contracts/media'
import { api, ApiError, getApiUrl } from './client'
import { getDesktopHost } from '../lib/desktopHost'

export { MAX_REFERENCE_IMAGE_BYTES, MAX_REFERENCE_IMAGES_TOTAL_BYTES }

const IMAGE_WORKBENCH_FALLBACK_ERROR = '图片工作台暂时不可用，请稍后重试。'
export const IMAGE_RESULT_REQUEST_TIMEOUT_MS = 5 * 60_000

function imageErrorCode(error: unknown): unknown {
  if (error instanceof ApiError) {
    const body = error.body
    if (body && typeof body === 'object' && 'error' in body) return body.error
  }
  if (error && typeof error === 'object' && 'code' in error) return error.code
  return undefined
}

/** Keep image errors constrained to the product's allow-listed recovery copy. */
export function imageUserFacingError(
  error: unknown,
  fallback = IMAGE_WORKBENCH_FALLBACK_ERROR,
): string {
  const code = imageErrorCode(error)
  if (code !== undefined) return mediaSafeError(code).message
  const message = error instanceof Error ? error.message : undefined
  return isMediaSafeErrorMessage(message) ? message : fallback
}

export const imageWorkbenchApi = {
  listProjects: () => api.get<{ projects: PublicImageWorkbenchProject[] }>('/api/images/projects'),
  getProject: (projectId: string) =>
    api.get<{ project: PublicImageWorkbenchProject }>(`/api/images/projects/${encodeURIComponent(projectId)}`),
  deleteProject: (projectId: string) =>
    api.delete<void>(`/api/images/projects/${encodeURIComponent(projectId)}`),
  listDeletions: () => api.get<{ deletions: PublicMediaDeletionReceipt[] }>('/api/images/deletions'),
  restoreProject: (projectId: string) =>
    api.post<{ deletion: PublicMediaDeletionReceipt }>(
      `/api/images/projects/${encodeURIComponent(projectId)}/restore`,
    ),
  getOperation: (operationId: string) =>
    api.get<{ task: PublicMediaTask }>(
      `/api/images/operations/${encodeURIComponent(operationId)}`,
      { timeout: IMAGE_RESULT_REQUEST_TIMEOUT_MS },
    ),
  cancelOperation: (operationId: string) =>
    api.post<{ task: PublicMediaTask }>(`/api/images/operations/${encodeURIComponent(operationId)}/cancel`),
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
      `/api/images/projects/${encodeURIComponent(projectId)}/events?${query.toString()}`,
    ), { signal })
    if (!response.ok) throw new ApiError(response.status, await response.json().catch(() => undefined))
    return await response.json() as PublicMediaJobEventPage
  },
  createProject: (input: CreateImageProjectInput) =>
    api.post<{ project: PublicImageWorkbenchProject }>('/api/images/projects', input),
  submitProject: (projectId: string, confirmUnknownRetry = false) =>
    getDesktopHost().images.submitProject(projectId, confirmUnknownRetry),
  startOperation: (projectId: string, input: StartImageOperationInput) =>
    getDesktopHost().images.startOperation(projectId, input),
  commitVersion: (projectId: string, input: CommitImageVersionInput) =>
    api.post<{ project: PublicImageWorkbenchProject }>(
      `/api/images/projects/${encodeURIComponent(projectId)}/versions`,
      input,
      { timeout: IMAGE_RESULT_REQUEST_TIMEOUT_MS },
    ),
  selectVersion: (projectId: string, input: SelectImageVersionInput) =>
    api.post<{ project: PublicImageWorkbenchProject }>(
      `/api/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(input.version_id)}/select`,
      { revision: input.revision },
    ),
  saveOutput: (projectId: string, input: SaveImageOutputInput) =>
    getDesktopHost().images.saveOutput(projectId, input),
  updateProject: (projectId: string, input: UpdateImageProjectInput) =>
    input.confirm_unknown_retry
      ? getDesktopHost().images.updateUnknownProject(projectId, input)
      : api.put<{ project: PublicImageWorkbenchProject }>(
        `/api/images/projects/${encodeURIComponent(projectId)}`,
        input,
      ),
  addReferences: (projectId: string, input: AddImageProjectReferencesInput) =>
    api.post<{ project: PublicImageWorkbenchProject }>(
      `/api/images/projects/${encodeURIComponent(projectId)}/references`,
      input,
    ),
  assetUrl: (path: string) => getApiUrl(path),
}

export type {
  AddImageProjectReferencesInput,
  CommitImageVersionInput,
  CreateImageProjectInput,
  ImageBriefOverrides,
  ImageCanvasSize,
  ImageLayer,
  ImageReferenceRole,
  ImageTextLayer,
  PublicImageProjectReference as ImageProjectReference,
  PublicImageWorkbenchProject as ImageWorkbenchProject,
  PublicMediaDeletionReceipt as ImageDeletionReceipt,
  PublicMediaJobEvent as ImageOperationEvent,
  PublicMediaJobEventPage as ImageOperationEventPage,
  PublicMediaTask as ImageOperation,
  SaveImageOutputInput,
  SaveImageOutputResult,
  SelectImageVersionInput,
  StartImageOperationInput,
}
