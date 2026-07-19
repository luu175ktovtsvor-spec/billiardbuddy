import { describe, expect, it } from 'vitest'
import { ApiError } from './client'
import { mediaUserFacingError } from './media'

describe('mediaUserFacingError', () => {
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
})
