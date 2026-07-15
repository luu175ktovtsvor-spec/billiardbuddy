import { describe, expect, test } from 'bun:test'
import { installMainWindowNavigationGuards } from './navigationGuards'

function fakeWebContents(currentUrl = 'file:///app/index.html') {
  let openHandler: ((details: { url: string }) => { action: 'deny' } | { action: 'allow' }) | undefined
  let navigateHandler: ((event: { preventDefault: () => void }, url: string) => void) | undefined
  return {
    webContents: {
      getURL: () => currentUrl,
      setWindowOpenHandler(handler: typeof openHandler) { openHandler = handler },
      on(_event: 'will-navigate', handler: typeof navigateHandler) { navigateHandler = handler },
    },
    open(url: string) { return openHandler?.({ url }) },
    navigate(url: string) {
      let prevented = false
      navigateHandler?.({ preventDefault: () => { prevented = true } }, url)
      return prevented
    },
  }
}

describe('主窗口导航守卫', () => {
  test('普通 Markdown 外链不能替换应用页面，并交给系统浏览器', () => {
    const fake = fakeWebContents()
    const opened: string[] = []
    installMainWindowNavigationGuards(fake.webContents, { openExternal: url => opened.push(url) })

    expect(fake.navigate('https://example.com/task')).toBe(true)
    expect(opened).toEqual(['https://example.com/task'])
  })

  test('同一开发服务器内的导航不被误拦', () => {
    const fake = fakeWebContents('http://127.0.0.1:5173/index.html')
    installMainWindowNavigationGuards(fake.webContents, { openExternal: () => undefined })
    expect(fake.navigate('http://127.0.0.1:5173/settings')).toBe(false)
  })

  test('file 和自定义协议跳转直接拦截且不外开', () => {
    const fake = fakeWebContents()
    const opened: string[] = []
    installMainWindowNavigationGuards(fake.webContents, { openExternal: url => opened.push(url) })
    expect(fake.navigate('file:///tmp/hostile.html')).toBe(true)
    expect(fake.navigate('javascript:alert(1)')).toBe(true)
    expect(opened).toEqual([])
  })
})
