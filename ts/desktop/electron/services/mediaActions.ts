import {
  MEDIA_UI_CAPABILITY_HEADER,
  type MediaTask,
  type RenderVideoInput,
  type UpdateImageProjectInput,
  type ImageWorkbenchProject,
  type SaveImageOutputInput,
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

  saveImageOutput(projectId: string, input: SaveImageOutputInput): Promise<{ path: string }> {
    return this.post(
      `/api/media/images/projects/${encodeURIComponent(projectId)}/outputs/${encodeURIComponent(input.output_id)}/save`,
      { output_path: input.output_path },
    )
  }

  private async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request(path, 'POST', body)
  }

  private async request<T>(path: string, method: 'POST' | 'PUT', body?: unknown): Promise<T> {
    const baseUrl = (await this.options.getServerUrl()).replace(/\/+$/, '')
    const response = await this.fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        [MEDIA_UI_CAPABILITY_HEADER]: this.options.capability,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({})) as { message?: string }
    if (!response.ok) {
      throw new Error(payload.message ?? `媒体服务返回 HTTP ${response.status}`)
    }
    return payload as T
  }
}
