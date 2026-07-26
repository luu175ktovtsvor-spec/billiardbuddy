import {
  MEDIA_UI_CAPABILITY_HEADER,
  mediaSafeError,
  type PublicMediaTask as MediaTask,
  type AnalyzeVideoProjectInput,
  type RenderVideoInput,
  type UpdateImageProjectInput,
  type PublicImageWorkbenchProject as ImageWorkbenchProject,
  type PublicVideoStudioProject as VideoStudioProject,
  type SaveImageOutputInput,
  type StartImageOperationInput,
} from '../../../shared/contracts/media'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ElectronMediaActionsOptions = {
  getServerUrl: () => Promise<string>
  capability: string
  fetchImpl?: FetchLike
}

export class ElectronMediaActions {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: ElectronMediaActionsOptions) {
    if (options.capability.length < 32) throw new Error('Media UI capability is too short')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  submitImageProject(
    projectId: string,
    confirmUnknownRetry = false,
  ): Promise<{ task: MediaTask }> {
    return this.post(`/api/media/images/projects/${encodeURIComponent(projectId)}/submit`, {
      confirm_unknown_retry: confirmUnknownRetry,
    })
  }

  startImageOperation(
    projectId: string,
    input: StartImageOperationInput,
  ): Promise<{ task: MediaTask }> {
    return this.post(`/api/media/images/projects/${encodeURIComponent(projectId)}/operations`, input)
  }

  updateUnknownImageProject(
    projectId: string,
    input: UpdateImageProjectInput,
  ): Promise<{ project: ImageWorkbenchProject }> {
    return this.request(
      `/api/media/images/projects/${encodeURIComponent(projectId)}`,
      'PUT',
      input,
    )
  }

  renderVideo(projectId: string, input: RenderVideoInput): Promise<{ task: MediaTask }> {
    return this.post(`/api/media/videos/projects/${encodeURIComponent(projectId)}/render`, input)
  }

  analyzeVideo(projectId: string, input: AnalyzeVideoProjectInput): Promise<{ task: MediaTask }> {
    return this.post(`/api/media/videos/projects/${encodeURIComponent(projectId)}/analyze`, input)
  }

  saveImageOutput(projectId: string, input: SaveImageOutputInput): Promise<{ path: string }> {
    const resultId = input.version_id ?? input.output_id
    if (!resultId) throw new Error(mediaSafeError('MEDIA_INVALID_REQUEST').message)
    return this.post(
      input.version_id
        ? `/api/media/images/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(input.version_id)}/save`
        : `/api/media/images/projects/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(resultId)}/save`,
      { output_path: input.output_path },
    )
  }

  addVideoSource(projectId: string, path: string): Promise<{ project: VideoStudioProject; task: MediaTask }> {
    return this.post(`/api/media/videos/projects/${encodeURIComponent(projectId)}/sources`, { path })
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request(path, 'POST', body)
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
    if (!response.ok) {
      throw new Error(mediaSafeError(payload.error).message)
    }
    return payload as T
  }
}
