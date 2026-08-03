import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as path from 'node:path'
import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron'

const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024
const MAX_PAGE_ELEMENTS = 200
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024

type BrowserPolicy = { allowedHosts: string[], blockedHosts: string[] }
type BrowserTab = { id: number, window: BrowserWindow, elements: Set<string> }

export type InAppBrowserHostOptions = {
  userDataPath: string
  mainWindow: () => BrowserWindow | null
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function privateBrowserRoot(userDataPath: string) {
  return path.join(userDataPath, 'agent-runtime', 'browser-use')
}

function sanitizeRules(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const rules = new Set<string>()
  for (const entry of value.slice(0, 256)) {
    if (typeof entry !== 'string') continue
    const rule = entry.trim().toLowerCase().replace(/\.$/, '')
    const host = rule.startsWith('*.') ? rule.slice(2) : rule
    if (host && host.length <= 253 && /^[a-z0-9.-]+$/.test(host)) rules.add(rule)
  }
  return [...rules].sort((left, right) => left.localeCompare(right))
}

function hostMatchesRule(host: string, rule: string) {
  const normalized = rule.replace(/^\*\./, '')
  return rule.startsWith('*.') ? host.endsWith(`.${normalized}`) : host === normalized
}

function httpUrl(value: unknown): URL | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function safeTokenEquals(expected: string, supplied: unknown): boolean {
  if (typeof supplied !== 'string' || supplied.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))
}

/**
 * Product-owned equivalent of Codex's in-app Browser host. It owns only an
 * isolated Electron browser profile and a short-lived authenticated loopback
 * endpoint for the BilliardBuddy Browser MCP plugin. It never opens the user’s
 * Chrome profile, nor does it expose cookies, passwords, storage or raw CDP.
 */
export class InAppBrowserHost {
  private readonly tabs = new Map<number, BrowserTab>()
  private readonly approvedHosts = new Set<string>()
  private server: net.Server | undefined
  private token: string | undefined
  private policy: BrowserPolicy = { allowedHosts: [], blockedHosts: [] }

  constructor(private readonly options: InAppBrowserHostOptions) {}

  async start(): Promise<void> {
    if (this.server) return
    const root = privateBrowserRoot(this.options.userDataPath)
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    await fs.chmod(root, 0o700).catch(() => undefined)
    this.policy = await this.readPolicy()
    this.token = randomBytes(32).toString('hex')
    const server = net.createServer(socket => this.handleConnection(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen({ host: '127.0.0.1', port: 0 }, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('BILLIARDBUDDY_BROWSER_BRIDGE_ADDRESS_INVALID')
    }
    const bridge = path.join(root, 'bridge.json')
    const temporary = `${bridge}.${process.pid}.tmp`
    await fs.writeFile(temporary, `${JSON.stringify({ port: address.port, token: this.token })}\n`, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(temporary, bridge)
    await fs.chmod(bridge, 0o600).catch(() => undefined)
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.token = undefined
    for (const tab of this.tabs.values()) tab.window.destroy()
    this.tabs.clear()
    await fs.rm(path.join(privateBrowserRoot(this.options.userDataPath), 'bridge.json'), { force: true }).catch(() => undefined)
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }

  private async readPolicy(): Promise<BrowserPolicy> {
    const file = path.join(privateBrowserRoot(this.options.userDataPath), 'config.json')
    const raw = await fs.readFile(file, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    })
    if (!raw) return { allowedHosts: [], blockedHosts: [] }
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>
      return { allowedHosts: sanitizeRules(parsed.allowedHosts), blockedHosts: sanitizeRules(parsed.blockedHosts) }
    } catch {
      return { allowedHosts: [], blockedHosts: [] }
    }
  }

  private allowed(url: URL) {
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (this.policy.blockedHosts.some(rule => hostMatchesRule(host, rule))) return false
    return this.approvedHosts.has(host) || this.policy.allowedHosts.some(rule => hostMatchesRule(host, rule))
  }

  private async requireSitePermission(url: URL, action: string): Promise<void> {
    if (this.allowed(url)) return
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    if (this.policy.blockedHosts.some(rule => hostMatchesRule(host, rule))) throw new Error('BILLIARDBUDDY_BROWSER_SITE_BLOCKED')
    const options: MessageBoxOptions = {
      type: 'question',
      buttons: ['拒绝', '仅本次允许'],
      defaultId: 0,
      cancelId: 0,
      title: '允许 Browser 访问此网站？',
      message: `${action}：${host}`,
      detail: '网页内容不可信。仅允许当前 BilliardBuddy Browser 会话访问此网站；提交、支付、删除等操作仍会单独请求确认。',
      noLink: true,
    }
    const parent = BrowserWindow.getFocusedWindow() ?? this.options.mainWindow()
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) throw new Error('BILLIARDBUDDY_BROWSER_SITE_PERMISSION_DENIED')
    this.approvedHosts.add(host)
  }

  private handleConnection(socket: net.Socket) {
    let body = ''
    socket.setTimeout(50_000, () => socket.destroy())
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      body += chunk
      if (Buffer.byteLength(body) > MAX_BRIDGE_MESSAGE_BYTES) return socket.destroy()
      const newline = body.indexOf('\n')
      if (newline < 0) return
      socket.pause()
      void this.dispatch(body.slice(0, newline)).then(payload => {
        socket.end(`${JSON.stringify({ ok: true, payload })}\n`)
      }, error => {
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'BILLIARDBUDDY_BROWSER_REQUEST_FAILED' })}\n`)
      })
    })
  }

  private async dispatch(raw: string): Promise<unknown> {
    let request: unknown
    try { request = JSON.parse(raw) } catch { throw new Error('BILLIARDBUDDY_BROWSER_BRIDGE_JSON_INVALID') }
    if (!isRecord(request) || !safeTokenEquals(this.token ?? '', request.token) || typeof request.operation !== 'string' || !isRecord(request.arguments)) {
      throw new Error('BILLIARDBUDDY_BROWSER_BRIDGE_UNAUTHORIZED')
    }
    switch (request.operation) {
      case 'status':
        return { ready: true, tabs: this.tabs.size, policy: this.policy }
      case 'list_tabs':
        return { tabs: [...this.tabs.values()].map(tab => ({ id: tab.id, url: tab.window.webContents.getURL(), title: tab.window.getTitle() })) }
      case 'open_tab':
        return await this.openTab(request.arguments)
      case 'close_tab':
        return this.closeTab(request.arguments)
      case 'inspect_page':
        return await this.inspectPage(request.arguments)
      case 'capture_page':
        return await this.capturePage(request.arguments)
      case 'navigate':
        return await this.navigate(request.arguments)
      case 'click_element':
        return await this.clickElement(request.arguments)
      case 'type_text':
        return await this.typeText(request.arguments)
      case 'press_key':
        return this.pressKey(request.arguments)
      default:
        throw new Error('BILLIARDBUDDY_BROWSER_OPERATION_UNKNOWN')
    }
  }

  private tab(arguments_: Record<string, unknown>): BrowserTab {
    const id = arguments_.tabId
    if (!Number.isInteger(id) || typeof id !== 'number' || id < 1) throw new Error('BILLIARDBUDDY_BROWSER_TAB_INVALID')
    const tab = this.tabs.get(id)
    if (!tab || tab.window.isDestroyed()) throw new Error('BILLIARDBUDDY_BROWSER_TAB_NOT_FOUND')
    return tab
  }

  private async openTab(arguments_: Record<string, unknown>) {
    const url = httpUrl(arguments_.url)
    if (!url) throw new Error('BILLIARDBUDDY_BROWSER_URL_INVALID')
    await this.requireSitePermission(url, '打开网站')
    const window = new BrowserWindow({
      width: 1280,
      height: 900,
      minWidth: 640,
      minHeight: 480,
      show: true,
      title: 'BilliardBuddy Browser',
      webPreferences: {
        partition: 'persist:billiardbuddy-browser',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        webviewTag: false,
      },
    })
    const tab: BrowserTab = { id: window.webContents.id, window, elements: new Set() }
    this.tabs.set(tab.id, tab)
    window.once('closed', () => this.tabs.delete(tab.id))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: Electron.Event, destination: string) => {
      const target = httpUrl(destination)
      if (!target || !this.allowed(target)) event.preventDefault()
    }
    window.webContents.on('will-navigate', guard)
    window.webContents.on('will-redirect', guard)
    await window.loadURL(url.toString())
    window.focus()
    return { id: tab.id, url: window.webContents.getURL(), title: window.getTitle() }
  }

  private closeTab(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    tab.window.close()
    return { closed: tab.id }
  }

  private async navigate(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const url = httpUrl(arguments_.url)
    if (!url) throw new Error('BILLIARDBUDDY_BROWSER_URL_INVALID')
    await this.requireSitePermission(url, '导航到网站')
    tab.elements.clear()
    await tab.window.loadURL(url.toString())
    tab.window.focus()
    return { id: tab.id, url: tab.window.webContents.getURL(), title: tab.window.getTitle() }
  }

  private async inspectPage(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const snapshot = await tab.window.webContents.executeJavaScript(`(() => {
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')).slice(0, ${MAX_PAGE_ELEMENTS});
      return { url: location.href, title: document.title, elements: nodes.map((node, index) => {
        const id = 'bb-' + ${tab.id} + '-' + (index + 1);
        node.setAttribute('data-billiardbuddy-element', id);
        const rect = node.getBoundingClientRect();
        const input = node instanceof HTMLInputElement;
        return { id, role: node.getAttribute('role') || node.tagName.toLowerCase(), label: (node.getAttribute('aria-label') || node.textContent || node.getAttribute('placeholder') || '').trim().slice(0, 200), disabled: !!node.disabled, password: input && node.type === 'password', x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
      }) };
    })()`, true) as { url?: unknown, title?: unknown, elements?: unknown }
    if (!isRecord(snapshot) || !Array.isArray(snapshot.elements)) throw new Error('BILLIARDBUDDY_BROWSER_SNAPSHOT_INVALID')
    tab.elements.clear()
    for (const element of snapshot.elements) if (isRecord(element) && typeof element.id === 'string') tab.elements.add(element.id)
    return snapshot
  }

  private async capturePage(arguments_: Record<string, unknown>) {
    const image = await this.tab(arguments_).window.webContents.capturePage()
    const data = image.toPNG().toString('base64')
    if (!data || Buffer.byteLength(data, 'base64') > MAX_SCREENSHOT_BYTES) throw new Error('BILLIARDBUDDY_BROWSER_SCREENSHOT_TOO_LARGE')
    return { mimeType: 'image/png', data }
  }

  private element(tab: BrowserTab, arguments_: Record<string, unknown>) {
    const id = arguments_.elementId
    if (typeof id !== 'string' || !/^bb-[1-9][0-9]*-[1-9][0-9]*$/.test(id) || !tab.elements.has(id)) throw new Error('BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
    return id
  }

  private async clickElement(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const id = this.element(tab, arguments_)
    const confirmation = await dialog.showMessageBox(tab.window, {
      type: 'warning', buttons: ['取消', '点击'], defaultId: 0, cancelId: 0, noLink: true,
      title: '允许 Browser 点击页面元素？', message: '网页点击可能提交信息、跳转页面或触发其他外部操作。',
    })
    if (confirmation.response !== 1) throw new Error('BILLIARDBUDDY_BROWSER_ACTION_DENIED')
    const result = await tab.window.webContents.executeJavaScript(`(() => { const nodes = document.querySelectorAll('[data-billiardbuddy-element=${JSON.stringify(id)}]'); if (nodes.length !== 1) return { ok: false }; const node = nodes[0]; if (node instanceof HTMLInputElement && node.type === 'password') return { ok: false, secure: true }; node.click(); return { ok: true }; })()`, true) as { ok?: unknown, secure?: unknown }
    if (!isRecord(result) || result.ok !== true) throw new Error(result.secure === true ? 'BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED' : 'BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
    return { clicked: id }
  }

  private async typeText(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const id = this.element(tab, arguments_)
    const text = arguments_.text
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) throw new Error('BILLIARDBUDDY_BROWSER_TEXT_INVALID')
    const result = await tab.window.webContents.executeJavaScript(`(() => { const nodes = document.querySelectorAll('[data-billiardbuddy-element=${JSON.stringify(id)}]'); if (nodes.length !== 1) return { ok: false }; const node = nodes[0]; if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable) || (node instanceof HTMLInputElement && (node.type === 'password' || /(?:one-time-code|cc-|password)/i.test(node.autocomplete)))) return { ok: false, secure: true }; node.focus(); if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) { node.value = ${JSON.stringify(text)}; } else { node.textContent = ${JSON.stringify(text)}; } node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`, true) as { ok?: unknown, secure?: unknown }
    if (!isRecord(result) || result.ok !== true) throw new Error(result.secure === true ? 'BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED' : 'BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
    return { typed: text.length }
  }

  private pressKey(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const key = arguments_.key
    if (typeof key !== 'string' || !['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) throw new Error('BILLIARDBUDDY_BROWSER_KEY_INVALID')
    tab.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    tab.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    return { pressed: key }
  }
}
