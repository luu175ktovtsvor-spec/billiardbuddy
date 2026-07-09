// 顶层错误边界(对齐 cc components/ErrorBoundary):渲染崩溃时不白屏,给可读中文兜底。
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

  override render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'var(--font-body)', color: 'var(--color-text-primary)' }}>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 8px' }}>界面出了点问题</h1>
          <p style={{ color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>刷新一下通常能恢复。反馈时请附上下面的信息。</p>
          <pre style={{ whiteSpace: 'pre-wrap', background: 'var(--color-surface-container)', padding: 12, borderRadius: 8, fontSize: 12 }}>
            {this.state.error.message}
          </pre>
        </div>
      )
    }
    return this.props.children
  }
}
