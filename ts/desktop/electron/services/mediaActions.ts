import {
  IMAGE_DATA_EGRESS_POLICY_REVISION,
  MEDIA_UI_CAPABILITY_HEADER,
  mediaSafeError,
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
    confirmedDataEgress = false,
  ): Promise<{ task: MediaTask }> {
    return this.post(`/api/media/images/projects/${encodeURIComponent(projectId)}/submit`, {
      confirm_unknown_retry: confirmUnknownRetry,
      ...(confirmedDataEgress ? {
        data_egress_consent: {
          policy_revision: IMAGE_DATA_EGRESS_POLICY_REVISION,
          acknowledged: true,
          acknowledged_at: new Date().toISOString(),
        },
      } : {}),
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
