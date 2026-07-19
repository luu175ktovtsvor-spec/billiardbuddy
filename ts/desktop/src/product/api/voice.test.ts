import { afterEach, describe, expect, it, vi } from 'vitest'
import { productVoiceApi } from './voice'

const runtimeMocks = vi.hoisted(() => ({
  serverUrl: 'http://127.0.0.1:3456',
}))

vi.mock('../../lib/desktopRuntime', () => ({
  getServerBaseUrl: () => runtimeMocks.serverUrl,
}))

describe('productVoiceApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    runtimeMocks.serverUrl = 'http://127.0.0.1:3456'
  })

  it('uploads a recording through the product API without exposing gateway auth', async () => {
    runtimeMocks.serverUrl = 'http://127.0.0.1:4567'
    const controller = new AbortController()
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined()
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect((form.get('file') as File).name).toMatch(/\.webm$/)
      expect(form.get('language')).toBe('zh')
      expect(init?.signal).toBe(controller.signal)
      return Response.json({ text: '九号台开台' })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(productVoiceApi.transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      { language: 'zh', signal: controller.signal },
    )).resolves.toBe('九号台开台')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:4567/api/product/voice/transcribe',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('surfaces the safe sidecar error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { detail: '语音识别服务暂不可用' },
      { status: 503 },
    )))

    await expect(productVoiceApi.transcribe(new Blob(['audio']))).rejects.toThrow(
      '语音识别服务暂不可用',
    )
  })
})
