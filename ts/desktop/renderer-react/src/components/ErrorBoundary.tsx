// 顶层错误边界(对齐 cc components/ErrorBoundary):渲染崩溃时不白屏,给可读中文兜底 + 重试/重载入口。
import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error) {
    console.error('[ui] 渲染崩溃', error)
  }

  /** 重试:清掉错误态重新渲染子树(适合瞬时错误);仍崩会再次被兜住。 */
  private handleRetry = () => {
    this.setState({ error: null })
  }

  /** 重载:整页刷新(适合状态已脏、重试无效时)。 */
  private handleReload = () => {
    if (typeof window !== 'undefined') window.location.reload()
  }

  override render() {
    if (this.state.error) {
      return (
        <div
          data-testid="error-boundary-fallback"
          style={{ padding: 32, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)' }}
        >
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>界面出了点问题</h1>
          <p style={{ color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>
            先点「重试」通常就好了;不行就「重新加载」。反馈时请附上下面的信息。
          </p>
          <div style={{ display: 'flex', gap: 8, margin: '0 0 12px' }}>
            <button
              type="button"
              data-testid="error-boundary-retry"
              onClick={this.handleRetry}
              style={{
                padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: 'var(--color-primary, #00C885)', color: '#fff', fontSize: 13, fontWeight: 600,
              }}
            >
              重试
            </button>
            <button
              type="button"
              data-testid="error-boundary-reload"
              onClick={this.handleReload}
              style={{
                padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
                background: 'var(--color-surface-container)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)',
              }}
            >
              重新加载
            </button>
          </div>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--color-surface-container)', padding: 12, borderRadius: 8, fontSize: 12 }}>
            {this.state.error.message}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
