import {
  MEDIA_UI_CAPABILITY_HEADER,
  mediaSafeError,
  type PublicImageWorkbenchProject as ImageWorkbenchProject,
  type PublicMediaTask as ImageOperation,
  type SaveImageOutputInput,
  type SaveImageOutputResult,
  type StartImageOperationInput,
  type UpdateImageProjectInput,
} from '../../../shared/contracts/media'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ElectronImageActionsOptions = {
  getServerUrl: () => Promise<string>
  capability: string
  fetchImpl?: FetchLike
}

/** Main-process-only bridge for image operations that need the desktop nonce. */
export class ElectronImageActions {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: ElectronImageActionsOptions) {
    if (options.capability.length < 32) throw new Error('Image UI capability is too short')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  submitProject(projectId: string, confirmUnknownRetry = false): Promise<{ task: ImageOperation }> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/submit`, {
      confirm_unknown_retry: confirmUnknownRetry,
    })
  }

  startOperation(projectId: string, input: StartImageOperationInput): Promise<{ task: ImageOperation }> {
    return this.post(`/api/images/projects/${encodeURIComponent(projectId)}/operations`, input)
  }

  updateUnknownProject(
    projectId: string,
    input: UpdateImageProjectInput,
  ): Promise<{ project: ImageWorkbenchProject }> {
    return this.request(`/api/images/projects/${encodeURIComponent(projectId)}`, 'PUT', input)
  }

  saveOutput(projectId: string, input: SaveImageOutputInput): Promise<SaveImageOutputResult> {
    const resultId = input.version_id ?? input.output_id
    if (!resultId) throw new Error(mediaSafeError('MEDIA_INVALID_REQUEST').message)
    return this.post(
      input.version_id
        ? `/api/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(input.version_id)}/save`
        : `/api/images/projects/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(resultId)}/save`,
      { output_path: input.output_path },
    )
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return await this.request(path, 'POST', body)
  }

  private async request<T>(path: string, method: 'POST' | 'PUT', body?: unknown): Promise<T> {
    const baseUrl = (await this.options.getServerUrl()).replace(/\/+$/, '')
    let response: Response
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          [MEDIA_UI_CAPABILITY_HEADER]: this.options.capability,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch {
      throw new Error(mediaSafeError('MEDIA_TEMPORARILY_UNAVAILABLE').message)
    }
    const payload = await response.json().catch(() => ({})) as { error?: unknown }
    if (!response.ok) throw new Error(mediaSafeError(payload.error).message)
    return payload as T
  }
}
