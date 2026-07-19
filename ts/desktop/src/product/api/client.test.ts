import { describe, expect, it } from 'vitest'
import { ProductApiError, productApiUserFacingError } from './client'

describe('ProductApiError', () => {
  it('uses approved user-facing copy for known product API error codes', () => {
    const error = new ProductApiError(404, {
      error: 'NOT_FOUND',
      message: '任务 task-private-42 does not exist in /private/.claude',
    })

    expect(error.status).toBe(404)
    expect(error.code).toBe('NOT_FOUND')
    expect(error.message).toBe('请求的任务或资源已不可用。')
    expect(error.message).not.toContain('task-private-42')
    expect(error.message).not.toContain('.claude')

    expect(new ProductApiError(503, {
      error: 'PRODUCT_TASK_REVIEW_UNAVAILABLE',
      message: 'task review backend is unavailable',
    }).message).toBe('当前任务审阅暂时不可用，请稍后重试。')

    expect(new ProductApiError(413, {
      error: 'VOICE_TRANSCRIPTION_TOO_LARGE',
      message: 'the upload reached an internal private limit',
    }).message).toBe('录音文件过大，请缩短后重试。')

    expect(new ProductApiError(503, {
      error: 'PRODUCT_TASK_COMMANDS_UNAVAILABLE',
      message: 'plugin at /private/workspace could not be read',
    }).message).toBe('暂时无法读取可用命令，请稍后重试。')

    expect(new ProductApiError(409, {
      error: 'PRODUCT_TASK_ACTIVE_RUN',
      message: 'private runtime state',
    }).message).toBe('任务仍在运行或等待确认，请先停止任务后再归档。')
  })

  it('replaces unknown and transport errors with a recoverable generic message', () => {
    const error = new ProductApiError(502, {
      error: 'UPSTREAM_PROVIDER_FAILURE',
      message: 'DeepSeek rejected token from /private/.claude/settings.json',
    })

    expect(error.status).toBe(502)
    expect(error.code).toBe('UPSTREAM_PROVIDER_FAILURE')
    expect(error.message).toBe('BilliardBuddy 服务暂时不可用，请稍后重试。')
    expect(productApiUserFacingError(new Error('raw gateway error')))
      .toBe('BilliardBuddy 服务暂时不可用，请稍后重试。')
  })
})
