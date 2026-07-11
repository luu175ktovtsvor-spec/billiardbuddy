// 入口(对齐 cc main.tsx:动态 import + 初始化主题 + createRoot,失败走启动看门狗兜底)。
import React from 'react'
import ReactDOM from 'react-dom/client'
import './theme/globals.css'
import { initializeTheme } from './stores/uiStore'

async function bootstrap() {
  const root = document.getElementById('root')
  try {
    initializeTheme()
    const [{ App }, { ErrorBoundary }] = await Promise.all([import('./App'), import('./components/ErrorBoundary')])
    if (!root) throw new Error('找不到 #root 挂载点')
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    )
    window.__QF_BOOTSTRAPPED__ = true
    // dev-only:把关键 store 挂到 window,便于 E2E/调试(仅开发构建注入,生产 build 不含此分支)。
    if (import.meta.env.DEV) {
      const [settings, chat, filePreview, conversations] = await Promise.all([
        import('./stores/settingsStore'),
        import('./stores/chatStore'),
        import('./stores/filePreviewStore'),
        import('./lib/conversations'),
      ])
      ;(window as unknown as { __QF?: Record<string, unknown> }).__QF = {
        settings: settings.useSettingsStore,
        chat: chat.useChatStore,
        filePreview: filePreview.useFilePreviewStore,
        conversations,
      }
    }
  } catch (error) {
    console.error('[desktop] 启动失败', error)
    if (window.__QF_SHOW_STARTUP_ERROR__) window.__QF_SHOW_STARTUP_ERROR__(error)
    else if (root) root.textContent = error instanceof Error ? error.message : String(error)
  }
}

void bootstrap()
