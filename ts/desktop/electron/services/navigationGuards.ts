// 导航守卫(安全):渲染进程是从固定入口加载的单页应用,不该自己弹出不受控的子窗口、也不该被诱导跳到外站。
// 拦掉 window.open / target=_blank:http(s) 链接交给系统浏览器打开,Electron 弹窗一律 deny。
// 移植自 cc-haha desktop/electron/services/navigationGuards.ts。
export type WindowOpenHandlerResult = { action: 'deny' } | { action: 'allow' }

export type NavigationGuardWebContents = {
  getURL?(): string
  setWindowOpenHandler(handler: (details: { url: string }) => WindowOpenHandlerResult): void
  on(
    event: 'will-navigate',
    handler: (event: { preventDefault: () => void }, url: string) => void,
  ): unknown
}

function sameApplicationLocation(current: string, target: string): boolean {
  try {
    const currentUrl = new URL(current)
    const targetUrl = new URL(target)
    if (currentUrl.protocol === 'http:' || currentUrl.protocol === 'https:') {
      return targetUrl.origin === currentUrl.origin
    }
    return currentUrl.protocol === 'file:' && targetUrl.href === currentUrl.href
  } catch {
    return false
  }
}

export type NavigationGuardOptions = {
  openExternal: (url: string) => void
}

export function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

// 主窗口守卫:外链交系统浏览器，普通 <a href> 也不能把受信 renderer 替换成远程页面。
export function installMainWindowNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal }: NavigationGuardOptions,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    const current = webContents.getURL?.() ?? ''
    if (sameApplicationLocation(current, url)) return
    event.preventDefault()
    if (isHttpUrl(url)) openExternal(url)
  })
}

// 预览容器守卫(留给将来的 WebContentsView 预览用):它渲染的是不可信远程页,需要像浏览器一样能页内 http(s) 跳转;
// 弹窗仍一律拒(http(s) 交系统浏览器),非 http(s) 协议(file:/自定义协议)的跳转直接拦掉。
export function installPreviewNavigationGuards(
  webContents: NavigationGuardWebContents,
  { openExternal }: NavigationGuardOptions,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  webContents.on('will-navigate', (event, url) => {
    if (!isHttpUrl(url)) event.preventDefault()
  })
}
