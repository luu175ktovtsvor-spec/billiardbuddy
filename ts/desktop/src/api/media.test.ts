import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { MEDIA_RESULT_REQUEST_TIMEOUT_MS, mediaApi, mediaUserFacingError } from './media'

describe('mediaUserFacingError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('uses only the approved media error vocabulary', () => {
    const rawDetail = 'ffmpeg stderr /private/Movies/source.mp4 token=private-token'
    const projected = mediaUserFacingError(new ApiError(502, {
      error: 'MEDIA_VIDEO_EXPORT_FAILED',
      message: rawDetail,
    }))

    expect(projected).toBe('视频导出失败，请检查素材和导出位置后重试。')
    expect(projected).not.toContain(rawDetail)
    expect(mediaUserFacingError(new Error(rawDetail))).toBe('媒体服务暂时不可用，请稍后重试。')
  })

  it('keeps final image status and Base64 reads open for five minutes', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      })
    ))

    const pending = mediaApi.getTask('task-result').catch(error => error as Error)
    const signal = fetchMock.mock.calls[0]?.[1]?.signal
    await vi.advanceTimersByTimeAsync(120_000)
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(MEDIA_RESULT_REQUEST_TIMEOUT_MS - 120_000)
    const outcome = await pending
    expect(outcome).toBeInstanceOf(Error)
    if (!(outcome instanceof Error)) throw new Error('expected media request timeout')
    expect(outcome.message).toBe('Request timed out after 300s')
    expect(signal?.aborted).toBe(true)
  })
})
