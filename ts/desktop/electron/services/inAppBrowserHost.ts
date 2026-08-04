import { randomBytes, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as path from 'node:path'
import { BrowserWindow, dialog, session, type MessageBoxOptions } from 'electron'
import {
  readBrowserPolicyConfiguration,
  type BrowserPolicyConfiguration,
} from './browserPolicyConfiguration'
import {
  redactBrowserDiagnosticText,
  sanitizeBrowserDiagnosticUrl,
} from './browserDeveloperDiagnostics'

const MAX_BRIDGE_MESSAGE_BYTES = 1024 * 1024
const MAX_PAGE_ELEMENTS = 200
const MAX_SCREENSHOT_BYTES = 12 * 1024 * 1024
const MAX_CONSOLE_ENTRIES = 100
const MAX_NETWORK_ENTRIES = 200
const MAX_PERFORMANCE_ENTRIES = 100

type BrowserPolicy = BrowserPolicyConfiguration
type BrowserConsoleEntry = {
  level: 'info' | 'warning' | 'error' | 'debug'
  message: string
  source: string | null
  line: number
  timestamp: number
}
type BrowserNetworkEntry = {
  requestId: number
  method: string
  url: string
  resourceType: string
  startedAt: number
  completedAt?: number
  status?: number
  fromCache?: boolean
  error?: string
}
type BrowserTab = {
  id: number
  window: BrowserWindow
  elements: Set<string>
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  pendingNetwork: Map<number, BrowserNetworkEntry>
  documentUrl?: string
}

export type InAppBrowserHostOptions = {
  userDataPath: string
  mainWindow: () => BrowserWindow | null
  /** Used only by automated host verification; product windows stay visible. */
  showWindow?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function privateBrowserRoot(userDataPath: string) {
  return path.join(userDataPath, 'agent-runtime', 'browser-use')
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

function boundedPush<T>(items: T[], value: T, limit: number): void {
  items.push(value)
  if (items.length > limit) items.splice(0, items.length - limit)
}

function clearTabDiagnostics(tab: BrowserTab): void {
  tab.console.length = 0
  tab.network.length = 0
  tab.pendingNetwork.clear()
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
    this.installDeveloperDiagnostics()
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
    const webRequest = session.fromPartition('persist:billiardbuddy-browser').webRequest
    webRequest.onBeforeRequest(null)
    webRequest.onCompleted(null)
    webRequest.onErrorOccurred(null)
    await fs.rm(path.join(privateBrowserRoot(this.options.userDataPath), 'bridge.json'), { force: true }).catch(() => undefined)
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
  }

  async reloadPolicy(): Promise<BrowserPolicy> {
    this.policy = await this.readPolicy()
    this.approvedHosts.clear()
    for (const tab of this.tabs.values()) {
      const current = httpUrl(tab.window.webContents.getURL())
      if (!current || !this.allowed(current)) tab.window.destroy()
    }
    return structuredClone(this.policy)
  }

  private async readPolicy(): Promise<BrowserPolicy> {
    try {
      return await readBrowserPolicyConfiguration(this.options.userDataPath, 'browser-use')
    } catch {
      // A corrupt policy must not restore a previously broad allowlist. Keep
      // the Browser usable only through fresh per-site confirmation.
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
      detail: '网页内容不可信。此授权只允许当前 BilliardBuddy Browser 会话访问该网站，不代表同意提交、支付、删除或其他后续操作。',
      noLink: true,
    }
    const parent = BrowserWindow.getFocusedWindow() ?? this.options.mainWindow()
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 1) throw new Error('BILLIARDBUDDY_BROWSER_SITE_PERMISSION_DENIED')
    this.approvedHosts.add(host)
  }

  private handleConnection(socket: net.Socket) {
    let body = ''
    socket.on('error', () => undefined)
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
      case 'developer_snapshot':
        return await this.developerSnapshot(request.arguments)
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

  private currentAllowedUrl(tab: BrowserTab): URL {
    const current = httpUrl(tab.window.webContents.getURL())
    if (!current || !this.allowed(current)) throw new Error('BILLIARDBUDDY_BROWSER_SITE_BLOCKED')
    return current
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
      show: this.options.showWindow ?? true,
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
    const tab: BrowserTab = {
      id: window.webContents.id,
      window,
      elements: new Set(),
      console: [],
      network: [],
      pendingNetwork: new Map(),
    }
    this.tabs.set(tab.id, tab)
    window.once('closed', () => this.tabs.delete(tab.id))
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const guard = (event: Electron.Event, destination: string) => {
      const target = httpUrl(destination)
      if (!target || !this.allowed(target)) event.preventDefault()
    }
    window.webContents.on('will-navigate', guard)
    window.webContents.on('will-redirect', guard)
    window.webContents.on('console-message', details => {
      if (window.isDestroyed()) return
      boundedPush(tab.console, {
        level: details.level,
        message: redactBrowserDiagnosticText(details.message),
        source: sanitizeBrowserDiagnosticUrl(details.sourceId),
        line: Number.isSafeInteger(details.lineNumber) && details.lineNumber >= 0 ? details.lineNumber : 0,
        timestamp: Date.now(),
      }, MAX_CONSOLE_ENTRIES)
    })
    try {
      await window.loadURL(url.toString())
      window.focus()
      return { id: tab.id, url: window.webContents.getURL(), title: window.getTitle() }
    } catch (error) {
      if (!window.isDestroyed()) window.destroy()
      this.tabs.delete(tab.id)
      throw error
    }
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
    const current = httpUrl(snapshot.url)
    if (!current || !this.allowed(current)) throw new Error('BILLIARDBUDDY_BROWSER_SITE_BLOCKED')
    tab.elements.clear()
    for (const element of snapshot.elements) if (isRecord(element) && typeof element.id === 'string') tab.elements.add(element.id)
    return snapshot
  }

  private async capturePage(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const before = httpUrl(tab.window.webContents.getURL())
    if (!before || !this.allowed(before)) throw new Error('BILLIARDBUDDY_BROWSER_SITE_BLOCKED')
    const image = await tab.window.webContents.capturePage()
    const after = httpUrl(tab.window.webContents.getURL())
    if (!after || !this.allowed(after)) throw new Error('BILLIARDBUDDY_BROWSER_SITE_BLOCKED')
    const data = image.toPNG().toString('base64')
    if (!data || Buffer.byteLength(data, 'base64') > MAX_SCREENSHOT_BYTES) throw new Error('BILLIARDBUDDY_BROWSER_SCREENSHOT_TOO_LARGE')
    return { mimeType: 'image/png', data }
  }

  private async developerSnapshot(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const current = this.currentAllowedUrl(tab)
    const raw = await tab.window.webContents.executeJavaScript(`(() => {
      const finite = value => Number.isFinite(value) && value >= 0 ? Math.round(value * 100) / 100 : null;
      const navigation = performance.getEntriesByType('navigation')[0];
      const resources = performance.getEntriesByType('resource').slice(-${MAX_PERFORMANCE_ENTRIES});
      return {
        navigation: navigation ? {
          type: String(navigation.type || ''),
          durationMs: finite(navigation.duration),
          domContentLoadedMs: finite(navigation.domContentLoadedEventEnd),
          loadMs: finite(navigation.loadEventEnd),
          transferSize: Number.isSafeInteger(navigation.transferSize) && navigation.transferSize >= 0 ? navigation.transferSize : null,
          decodedBodySize: Number.isSafeInteger(navigation.decodedBodySize) && navigation.decodedBodySize >= 0 ? navigation.decodedBodySize : null,
        } : null,
        resources: resources.map(entry => ({
          name: String(entry.name || ''),
          initiatorType: String(entry.initiatorType || 'other').slice(0, 64),
          durationMs: finite(entry.duration),
          transferSize: Number.isSafeInteger(entry.transferSize) && entry.transferSize >= 0 ? entry.transferSize : null,
          decodedBodySize: Number.isSafeInteger(entry.decodedBodySize) && entry.decodedBodySize >= 0 ? entry.decodedBodySize : null,
        })),
      };
    })()`, true) as Record<string, unknown>
    const resources = Array.isArray(raw?.resources) ? raw.resources.flatMap(candidate => {
      if (!isRecord(candidate)) return []
      const name = sanitizeBrowserDiagnosticUrl(candidate.name)
      if (!name) return []
      return [{
        name,
        initiatorType: typeof candidate.initiatorType === 'string' ? candidate.initiatorType.slice(0, 64) : 'other',
        durationMs: typeof candidate.durationMs === 'number' ? candidate.durationMs : null,
        transferSize: Number.isSafeInteger(candidate.transferSize) ? candidate.transferSize : null,
        decodedBodySize: Number.isSafeInteger(candidate.decodedBodySize) ? candidate.decodedBodySize : null,
      }]
    }).slice(-MAX_PERFORMANCE_ENTRIES) : []
    const navigation = isRecord(raw?.navigation) ? {
      type: typeof raw.navigation.type === 'string' ? raw.navigation.type.slice(0, 64) : '',
      durationMs: typeof raw.navigation.durationMs === 'number' ? raw.navigation.durationMs : null,
      domContentLoadedMs: typeof raw.navigation.domContentLoadedMs === 'number' ? raw.navigation.domContentLoadedMs : null,
      loadMs: typeof raw.navigation.loadMs === 'number' ? raw.navigation.loadMs : null,
      transferSize: Number.isSafeInteger(raw.navigation.transferSize) ? raw.navigation.transferSize : null,
      decodedBodySize: Number.isSafeInteger(raw.navigation.decodedBodySize) ? raw.navigation.decodedBodySize : null,
    } : null
    return {
      url: sanitizeBrowserDiagnosticUrl(current.toString()),
      title: redactBrowserDiagnosticText(tab.window.getTitle()).slice(0, 500),
      console: tab.console.map(entry => ({ ...entry })),
      network: tab.network.map(({ requestId: _requestId, ...entry }) => ({ ...entry })),
      performance: { navigation, resources },
      privacy: 'Headers, cookies, storage, bodies and raw CDP access are not collected. URL credentials, query strings, fragments and sensitive path identifiers are removed; titles and console text receive bounded best-effort secret redaction.',
    }
  }

  private installDeveloperDiagnostics(): void {
    const webRequest = session.fromPartition('persist:billiardbuddy-browser').webRequest
    webRequest.onBeforeRequest((details, callback) => {
      const tab = details.webContentsId === undefined ? undefined : this.tabs.get(details.webContentsId)
      if (tab) {
        const url = sanitizeBrowserDiagnosticUrl(details.url)
        if (url) {
          if (details.resourceType === 'mainFrame' && tab.documentUrl !== url) {
            clearTabDiagnostics(tab)
            tab.documentUrl = url
          }
          const entry: BrowserNetworkEntry = {
            requestId: details.id,
            method: details.method.slice(0, 16),
            url,
            resourceType: details.resourceType,
            startedAt: details.timestamp,
          }
          tab.pendingNetwork.set(details.id, entry)
          tab.network.push(entry)
          while (tab.network.length > MAX_NETWORK_ENTRIES) {
            const removed = tab.network.shift()
            if (removed) tab.pendingNetwork.delete(removed.requestId)
          }
        }
      }
      callback({})
    })
    webRequest.onCompleted(details => {
      const tab = details.webContentsId === undefined ? undefined : this.tabs.get(details.webContentsId)
      const entry = tab?.pendingNetwork.get(details.id)
      if (!tab || !entry) return
      entry.completedAt = details.timestamp
      entry.status = details.statusCode
      entry.fromCache = details.fromCache
      tab.pendingNetwork.delete(details.id)
    })
    webRequest.onErrorOccurred(details => {
      const tab = details.webContentsId === undefined ? undefined : this.tabs.get(details.webContentsId)
      const entry = tab?.pendingNetwork.get(details.id)
      if (!tab || !entry) return
      entry.completedAt = details.timestamp
      entry.error = redactBrowserDiagnosticText(details.error)
      entry.fromCache = details.fromCache
      tab.pendingNetwork.delete(details.id)
    })
  }

  private element(tab: BrowserTab, arguments_: Record<string, unknown>) {
    const id = arguments_.elementId
    if (typeof id !== 'string' || !/^bb-[1-9][0-9]*-[1-9][0-9]*$/.test(id) || !tab.elements.has(id)) throw new Error('BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
    return id
  }

  private async clickElement(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const id = this.element(tab, arguments_)
    const result = await tab.window.webContents.executeJavaScript(`(() => { const nodes = document.querySelectorAll('[data-billiardbuddy-element=${JSON.stringify(id)}]'); if (nodes.length !== 1) return { ok: false }; const node = nodes[0]; if (node instanceof HTMLInputElement && node.type === 'password') return { ok: false, secure: true }; node.click(); return { ok: true }; })()`, true) as { ok?: unknown, secure?: unknown }
    if (!isRecord(result) || result.ok !== true) throw new Error(result.secure === true ? 'BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED' : 'BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
    return { clicked: id }
  }

  private async typeText(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const id = this.element(tab, arguments_)
    const text = arguments_.text
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) throw new Error('BILLIARDBUDDY_BROWSER_TEXT_INVALID')
    const result = await tab.window.webContents.executeJavaScript(`(() => { const nodes = document.querySelectorAll('[data-billiardbuddy-element=${JSON.stringify(id)}]'); if (nodes.length !== 1) return { ok: false }; const node = nodes[0]; if (!(node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable) || (node instanceof HTMLInputElement && (node.type === 'password' || /(?:one-time-code|cc-|password|token)/i.test(node.autocomplete)))) return { ok: false, secure: true }; node.focus(); if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) { node.value = ${JSON.stringify(text)}; } else { node.textContent = ${JSON.stringify(text)}; } node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); return { ok: true }; })()`, true) as { ok?: unknown, secure?: unknown }
    if (!isRecord(result) || result.ok !== true) throw new Error(result.secure === true ? 'BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED' : 'BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
    return { typed: text.length }
  }

  private pressKey(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const key = arguments_.key
    if (typeof key !== 'string' || !['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) throw new Error('BILLIARDBUDDY_BROWSER_KEY_INVALID')
    tab.window.webContents.sendInputEvent({ type: 'keyDown', keyCode: key })
    tab.window.webContents.sendInputEvent({ type: 'keyUp', keyCode: key })
    return { pressed: key }
  }
}
