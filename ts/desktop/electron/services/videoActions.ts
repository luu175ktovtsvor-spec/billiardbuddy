import {
  MEDIA_UI_CAPABILITY_HEADER,
  mediaSafeError,
  type PublicMediaTask as MediaTask,
  type AnalyzeVideoProjectInput,
  type RenderVideoInput,
  type PublicVideoStudioProject as VideoStudioProject,
} from '../../../shared/contracts/media'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ElectronVideoActionsOptions = {
  getServerUrl: () => Promise<string>
  capability: string
  fetchImpl?: FetchLike
}

export class ElectronVideoActions {
  private readonly fetchImpl: FetchLike

  constructor(private readonly options: ElectronVideoActionsOptions) {
    if (options.capability.length < 32) throw new Error('Media UI capability is too short')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  renderVideo(projectId: string, input: RenderVideoInput): Promise<{ task: MediaTask }> {
    return this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/render`, input)
  }

  analyzeVideo(projectId: string, input: AnalyzeVideoProjectInput): Promise<{ task: MediaTask }> {
    return this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/analyze`, input)
  }

  addVideoSource(projectId: string, path: string): Promise<{ project: VideoStudioProject; task: MediaTask }> {
    return this.post(`/api/videos/projects/${encodeURIComponent(projectId)}/sources`, { path })
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
