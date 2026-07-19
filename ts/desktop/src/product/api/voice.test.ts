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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    runtimeMocks.serverUrl = 'http://127.0.0.1:3456'
  })

  it('uploads a recording through the product API without exposing gateway auth', async () => {
    runtimeMocks.serverUrl = 'http://127.0.0.1:4567'
    const controller = new AbortController()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined()
      expect(init?.body).toBeInstanceOf(FormData)
      const form = init?.body as FormData
      expect((form.get('file') as File).name).toMatch(/\.webm$/)
      expect(form.get('language')).toBe('zh')
      expect(init?.signal).toBeInstanceOf(AbortSignal)
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
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000)
  })

  it('surfaces the safe sidecar error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      {
        error: 'VOICE_TRANSCRIPTION_UNAVAILABLE',
        message: 'DeepSeek rejected a private gateway token',
      },
      { status: 503 },
    )))

    await expect(productVoiceApi.transcribe(new Blob(['audio']))).rejects.toThrow(
      '语音转写暂时不可用，请稍后重试。',
    )
  })

  it('keeps an in-flight upload cancellable through the product API client', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        requestSignal = init?.signal ?? undefined
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      },
    ))
    vi.stubGlobal('fetch', fetchMock)

    const transcription = productVoiceApi.transcribe(
      new Blob(['audio'], { type: 'audio/webm' }),
      { signal: controller.signal },
    )
    expect(fetchMock).toHaveBeenCalledOnce()

    controller.abort()

    await expect(transcription).rejects.toMatchObject({ name: 'AbortError' })
    expect(requestSignal?.aborted).toBe(true)
  })
})
