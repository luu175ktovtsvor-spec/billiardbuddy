import { describe, expect, test } from 'bun:test'
import type {
  ComputerExecutor,
  ComputerUseHostAdapter,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ScreenshotResult,
} from './vendor/index'
import { bindSessionContext } from './vendor/index'
import { createComputerUseSession } from './sessionContext'
import { createComputerUseTools } from './computerUseTools'
import { isComputerUseSupportedPlatform } from './common'

// ── 假 executor:实现 ComputerExecutor 全部方法,不起 Python,验证 vendor 安全内核 ──

function fakeScreenshot(): ScreenshotResult {
  return {
    base64: 'A'.repeat(4000), // decodedByteLength ≈ 3000 > MIN_SCREENSHOT_BYTES(1024)
    width: 100,
    height: 100,
    displayWidth: 100,
    displayHeight: 100,
    displayId: 0,
    originX: 0,
    originY: 0,
  }
}

function fakeDisplay(): DisplayGeometry {
  return { id: 0, displayId: 0, width: 100, height: 100, scaleFactor: 1, originX: 0, originY: 0, isPrimary: true }
}

interface FakeCalls {
  clicks: Array<{ x: number; y: number; button: string; count: number }>
  types: string[]
}

function makeFakeExecutor(calls: FakeCalls): ComputerExecutor {
  const installed: InstalledApp[] = [
    { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit', path: '/System/Applications/TextEdit.app' },
  ]
  let frontmost: FrontmostApp = { bundleId: 'com.apple.TextEdit', displayName: 'TextEdit' }
  return {
    capabilities: { screenshotFiltering: 'native', platform: 'darwin', hostBundleId: 'com.test.host' },
    async prepareForAction() {
      return []
    },
    async previewHideSet() {
      return []
    },
    async getDisplaySize() {
      return fakeDisplay()
    },
    async listDisplays() {
      return [fakeDisplay()]
    },
    async findWindowDisplays() {
      return []
    },
    async resolvePrepareCapture() {
      return { ...fakeScreenshot(), hidden: [], display: fakeDisplay(), resolvedDisplayId: 0 }
    },
    async screenshot() {
      return fakeScreenshot()
    },
    async zoom() {
      return { base64: 'B'.repeat(4000), width: 50, height: 50 }
    },
    async key() {},
    async holdKey() {},
    async type(text) {
      calls.types.push(text)
    },
    async readClipboard() {
      return ''
    },
    async writeClipboard() {},
    async click(x, y, button, count) {
      calls.clicks.push({ x, y, button, count })
    },
    async drag() {},
    async moveMouse() {},
    async scroll() {},
    async mouseDown() {},
    async mouseUp() {},
    async getCursorPosition() {
      return { x: 0, y: 0 }
    },
    async getFrontmostApp() {
      return frontmost
    },
    async appUnderPoint() {
      return null
    },
    async listInstalledApps() {
      return installed
    },
    async listRunningApps() {
      return []
    },
    async openApp(bundleId) {
      frontmost = { bundleId, displayName: 'TextEdit' }
    },
  }
}

function makeFakeAdapter(calls: FakeCalls): ComputerUseHostAdapter {
  return {
    serverName: 'computer-use',
    logger: { info() {}, error() {}, warn() {}, debug() {}, silly() {} },
    executor: makeFakeExecutor(calls),
    async ensureOsPermissions() {
      return { granted: true }
    },
    isDisabled: () => false,
    getAutoUnhideEnabled: () => true,
    // 关掉所有子闸,走简单路径(不测显示器解析/hide 序列,专测授权+分级+前台闸)。
    getSubGates: () => ({
      pixelValidation: false,
      clipboardPasteMultiline: false,
      mouseAnimation: false,
      hideBeforeAction: false,
      autoTargetDisplay: false,
      clipboardGuard: false,
    }),
    cropRawPatch: () => null,
  }
}

describe('computer-use 工具层(schema + 白标)', () => {
  test('平台支持时构建出工具集;teach 工具被排除', () => {
    if (!isComputerUseSupportedPlatform()) {
      expect(createComputerUseTools()).toEqual([])
      return
    }
    const tools = createComputerUseTools()
    const names = new Set(tools.map(t => t.name))
    for (const expected of ['screenshot', 'left_click', 'type', 'key', 'scroll', 'request_access', 'computer_batch', 'zoom']) {
      expect(names.has(expected)).toBe(true)
    }
    // teachMode=false → 三个 teach 工具不出现
    expect(names.has('request_teach_access')).toBe(false)
    expect(names.has('teach_step')).toBe(false)
    expect(names.has('teach_batch')).toBe(false)
  })

  test('只读标志:cursor_position 只读,left_click/screenshot 非只读', () => {
    if (!isComputerUseSupportedPlatform()) return
    const byName = new Map(createComputerUseTools().map(t => [t.name, t]))
    expect(byName.get('cursor_position')?.isReadOnly).toBe(true)
    expect(byName.get('list_granted_applications')?.isReadOnly).toBe(true)
    expect(byName.get('left_click')?.isReadOnly).toBe(false)
    // screenshot/zoom 产图 → 必须串行 → 非只读
    expect(byName.get('screenshot')?.isReadOnly).toBe(false)
    expect(byName.get('zoom')?.isReadOnly).toBe(false)
  })

  test('白标:任何工具描述不得泄露 Claude/Anthropic/CiC', () => {
    if (!isComputerUseSupportedPlatform()) return
    for (const tool of createComputerUseTools()) {
      expect(tool.description).not.toMatch(/claude|anthropic/i)
      expect(tool.description).not.toContain('mcp__Claude')
    }
  })
})

describe('computer-use 安全内核派发(假 executor,无 Python)', () => {
  function harness() {
    const calls: FakeCalls = { clicks: [], types: [] }
    const adapter = makeFakeAdapter(calls)
    const session = createComputerUseSession()
    const dispatch = bindSessionContext(adapter, 'pixels', session.context)
    return { calls, dispatch }
  }

  test('空白名单截图 → 报错并提示 request_access', async () => {
    const { dispatch } = harness()
    const res = await dispatch('screenshot', {})
    expect(res.isError).toBe(true)
    const text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    expect(text).toContain('request_access')
  })

  test('request_access 自动放行 → 授予 TextEdit', async () => {
    const { dispatch } = harness()
    const res = await dispatch('request_access', { apps: ['TextEdit'], reason: '测试' })
    expect(res.isError).toBeFalsy()
    const text = res.content.map(b => (b.type === 'text' ? b.text : '')).join('')
    const parsed = JSON.parse(text) as { granted: Array<{ bundleId: string; tier?: string }> }
    expect(parsed.granted.some(g => g.bundleId === 'com.apple.TextEdit')).toBe(true)
  })

  test('授权后:截图返回图像,左键点击落到缩放坐标', async () => {
    const { calls, dispatch } = harness()
    await dispatch('request_access', { apps: ['TextEdit'], reason: '测试' })

    const shot = await dispatch('screenshot', {})
    expect(shot.isError).toBeFalsy()
    expect(shot.content.some(b => b.type === 'image')).toBe(true)

    const click = await dispatch('left_click', { coordinate: [10, 20] })
    expect(click.isError).toBeFalsy()
    expect(calls.clicks).toHaveLength(1)
    // pixels 模式 + 100x100 截图=100x100 显示 → 坐标 1:1
    expect(calls.clicks[0]).toMatchObject({ x: 10, y: 20, button: 'left', count: 1 })
  })

  test('系统热键黑名单:未授 systemKeyCombos 时 cmd+q 被拦', async () => {
    const { dispatch } = harness()
    await dispatch('request_access', { apps: ['TextEdit'], reason: '测试' })
    const res = await dispatch('key', { text: 'cmd+q' })
    expect(res.isError).toBe(true)
  })
})
