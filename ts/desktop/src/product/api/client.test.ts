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
