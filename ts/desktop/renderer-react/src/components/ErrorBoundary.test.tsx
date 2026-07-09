// ErrorBoundary 降级渲染断言:抛错时进入错误态 → 渲染中文兜底页 + 重试/重载按钮 + 错误信息。
// 不依赖 DOM/RTL:用 getDerivedStateFromError 验状态转移,用 renderToStaticMarkup 验兜底页文本
//(兜底页无抛错子节点,SSR 可直接渲染)。
import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ErrorBoundary } from './ErrorBoundary'

/** 绕过 Component.state 的 Readonly 约束,注入错误态用于渲染兜底 UI。 */
function withErrorState(boundary: ErrorBoundary, error: Error | null): void {
  ;(boundary as unknown as { state: { error: Error | null } }).state = { error }
}

test('getDerivedStateFromError 把异常收进 error 态', () => {
  const err = new Error('boom-xyz')
  expect(ErrorBoundary.getDerivedStateFromError(err)).toEqual({ error: err })
})

test('错误态下渲染中文兜底页 + 重试/重载按钮 + 错误信息', () => {
  const boundary = new ErrorBoundary({ children: null })
  withErrorState(boundary, new Error('boom-xyz'))
  const html = renderToStaticMarkup(boundary.render() as ReactElement)

  expect(html).toContain('界面出了点问题')
  expect(html).toContain('boom-xyz')
  expect(html).toContain('重试')
  expect(html).toContain('重新加载')
  expect(html).toContain('data-testid="error-boundary-fallback"')
})

test('无错误时透传 children、不渲染兜底页', () => {
  const boundary = new ErrorBoundary({ children: '正常内容' })
  withErrorState(boundary, null)
  expect(boundary.render()).toBe('正常内容')
})
