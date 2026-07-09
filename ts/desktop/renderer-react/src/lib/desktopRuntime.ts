// 后端地址发现(对齐 cc lib/desktopRuntime.initializeDesktopServerUrl):
//  桌面端 → IPC host.runtime.getServerUrl() 拿 sidecar 地址 → setBaseUrl → 轮询 /health。
//  浏览器端(Playwright/H5)→ 同上但 URL 来自 same-origin 或 ?serverUrl=。
// ⚠️ 我们 /health 返回 { ok: true, service, ts }(不是 cc 的 { status:'ok' }),waitForHealth 按我们的形状判定。
import { getBaseUrl, setBaseUrl, setAuthToken, getDefaultBaseUrl } from '../api/client'
import { getDesktopHost } from './desktopHost'

let resolveServerReady: (() => void) | null = null
let serverReadyPromise: Promise<void> | null = null

export function whenDesktopServerReady(): Promise<void> {
  if (!serverReadyPromise) {
    serverReadyPromise = new Promise<void>((resolve) => {
      resolveServerReady = resolve
    })
  }
  return serverReadyPromise
}

function markReady() {
  whenDesktopServerReady()
  resolveServerReady?.()
}

export function getServerBaseUrl(): string {
  return getBaseUrl()
}

/** 拿到并确认 sidecar 地址。返回最终 baseUrl。失败抛错(由启动看门狗/ErrorBoundary 呈现)。 */
export async function initializeDesktopServerUrl(): Promise<string> {
  const host = getDesktopHost()
  const fallback = getDefaultBaseUrl()
  try {
    const serverUrl = await host.runtime.getServerUrl()
    setBaseUrl(serverUrl || fallback)
    setAuthToken(null)
    await waitForHealth(getBaseUrl())
    markReady()
    return getBaseUrl()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[desktop] 初始化 server URL 失败', error)
    throw new Error(message || `后端未就绪(fallback ${fallback})`)
  }
}

/** 轮询 /health,直到返回我们的 { ok: true } JSON。最多 ~7.5s(30 × 250ms)。 */
async function waitForHealth(serverUrl: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, '')}/health`, { cache: 'no-store' })
      if (response.ok) {
        const body = await response.json().catch(() => null)
        if (body && typeof body === 'object' && (body.ok === true || body.status === 'ok')) return
        lastError = new Error(`/health 返回了预期外的内容`)
      } else {
        lastError = new Error(`/health 返回 ${response.status}`)
      }
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(lastError instanceof Error ? `后端健康检查失败:${lastError.message}` : '后端健康检查失败')
}
