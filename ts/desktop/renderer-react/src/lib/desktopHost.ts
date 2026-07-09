// DesktopHost 契约(对齐 cc lib/desktopHost):渲染层只经此访问原生能力,不裸用 window。
// 桌面端由 electron/preload.cjs 注入 window.desktopHost;浏览器/H5 端用 browser 兜底。
// ⚠️ 白标接入点:runtime.getServerUrl 由 main.ts 的 IPC 'runtime:getServerUrl' 提供(sidecar 地址),
//    React 通过它拿到后端地址再 fetch/WS(前端与 sidecar 彻底解耦、不再走 same-origin)。

export interface DesktopHost {
  isDesktop: boolean
  platform: string
  runtime: {
    getServerUrl: () => Promise<string>
  }
  pickWorkspace?: () => Promise<string | null>
  onMenu?: (cb: (action: string) => void) => void
  preventSleep?: {
    start: () => Promise<boolean>
    stop: () => Promise<boolean>
  }
}

/** window.desktopHost(preload 注入)的宽松形状。 */
interface InjectedDesktopHost {
  isDesktop?: boolean
  platform?: string
  runtime?: { getServerUrl?: () => Promise<string> }
  pickWorkspace?: () => Promise<string | null>
  onMenu?: (cb: (action: string) => void) => void
  preventSleep?: { start: () => Promise<boolean>; stop: () => Promise<boolean> }
}

declare global {
  interface Window {
    desktopHost?: InjectedDesktopHost
    __QF_BOOTSTRAPPED__?: boolean
    __QF_SHOW_STARTUP_ERROR__?: (reason: unknown) => void
  }
}

/** 浏览器/H5 兜底:非桌面壳时,server URL 来自 same-origin 或 ?serverUrl= query。 */
function browserServerUrl(): string {
  if (typeof window === 'undefined') return 'http://127.0.0.1:8850'
  const query = new URLSearchParams(window.location.search)
  const fromQuery = query.get('serverUrl')
  if (fromQuery) return fromQuery
  if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
    return window.location.origin
  }
  return 'http://127.0.0.1:8850'
}

const browserHost: DesktopHost = {
  isDesktop: false,
  platform: 'browser',
  runtime: {
    getServerUrl: async () => browserServerUrl(),
  },
}

let cached: DesktopHost | null = null

export function getDesktopHost(): DesktopHost {
  if (cached) return cached
  const injected = typeof window !== 'undefined' ? window.desktopHost : undefined
  if (injected && injected.isDesktop && injected.runtime?.getServerUrl) {
    const getServerUrl = injected.runtime.getServerUrl.bind(injected.runtime)
    cached = {
      isDesktop: true,
      platform: injected.platform ?? 'unknown',
      runtime: { getServerUrl },
      pickWorkspace: injected.pickWorkspace?.bind(injected),
      onMenu: injected.onMenu?.bind(injected),
      preventSleep: injected.preventSleep,
    }
    return cached
  }
  cached = browserHost
  return cached
}

export function isDesktopRuntime(): boolean {
  return getDesktopHost().isDesktop
}
