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
const MAX_DEVELOPER_EVENTS = 300
const MAX_CDP_DOM_NODES = 400
const MAX_CDP_DOM_DEPTH = 12
const MAX_CDP_DOM_ATTRIBUTES = 16
const ELEMENT_WORLD_ID = 999

const ELEMENT_WORLD_PRELUDE = String.raw`
  const bbStateKey = '__billiardBuddyElementSnapshots';
  const bbNormalize = value => String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const bbSensitivePattern = /(?:^| )(?:password|passwd|passcode|passphrase|pin|otp|totp|hotp|secret|credential|token|authentication|authorization|webauthn|api key|access key|private key|access token|refresh token|auth token|auth code|authorization code|security code|verification code|recovery code|mfa code|2fa code|one time code|credit card|debit card|card number|cardholder|cvv|cvc)(?: |$)/;
  const bbSensitiveAutocomplete = /(?:^| )(?:current password|new password|one time code|username|webauthn|cc name|cc given name|cc additional name|cc family name|cc number|cc exp|cc exp month|cc exp year|cc csc|cc type)(?: |$)/;
  const bbAttribute = (node, name) => node.getAttribute(name) || '';
  const bbEditable = node => node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node.isContentEditable;
  const bbFileUpload = node => node instanceof HTMLInputElement && node.type.toLowerCase() === 'file';
  const bbSensitive = node => {
    if (!bbEditable(node)) return false;
    const autocomplete = bbNormalize(bbAttribute(node, 'autocomplete'));
    if (bbSensitiveAutocomplete.test(autocomplete)) return true;
    return ['type', 'name', 'id', 'aria-label', 'placeholder', 'title'].some(name => bbSensitivePattern.test(bbNormalize(bbAttribute(node, name))));
  };
  const bbLabel = node => String(bbAttribute(node, 'aria-label') || node.innerText || bbAttribute(node, 'placeholder') || bbAttribute(node, 'title') || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  const bbForm = node => 'form' in node && node.form instanceof HTMLFormElement ? node.form : null;
  const bbFormFingerprint = form => form ? JSON.stringify([
    form.action,
    bbAttribute(form, 'method'),
    bbAttribute(form, 'enctype'),
    bbAttribute(form, 'target'),
    bbAttribute(form, 'name'),
    bbAttribute(form, 'id'),
  ]) : '';
  const bbFingerprint = node => JSON.stringify([
    node.namespaceURI,
    node.tagName,
    bbAttribute(node, 'role'),
    bbAttribute(node, 'type'),
    node instanceof HTMLInputElement ? node.type : '',
    bbAttribute(node, 'autocomplete'),
    bbAttribute(node, 'name'),
    bbAttribute(node, 'id'),
    bbAttribute(node, 'aria-label'),
    bbAttribute(node, 'placeholder'),
    bbAttribute(node, 'title'),
    bbAttribute(node, 'href'),
    bbAttribute(node, 'target'),
    bbAttribute(node, 'formaction'),
    Boolean(node.disabled),
    Boolean(node.readOnly),
    Boolean(node.isContentEditable),
    bbLabel(node),
  ]);
  const bbAncestry = node => {
    const ancestry = [];
    let current = node;
    while (current && ancestry.length <= 256) {
      ancestry.push(current);
      if (current === document) break;
      current = current.parentNode;
    }
    return ancestry.at(-1) === document ? ancestry : null;
  };
  const bbValid = (root, entry) => {
    if (!root || root.url !== location.href || !entry || !entry.node?.isConnected || entry.node.ownerDocument !== document) return false;
    let current = entry.node;
    for (const expected of entry.ancestry) {
      if (current !== expected) return false;
      current = current.parentNode;
    }
    return current === null
      && bbFingerprint(entry.node) === entry.fingerprint
      && bbForm(entry.node) === entry.form
      && bbFormFingerprint(entry.form) === entry.formFingerprint;
  };
`

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
type BrowserDeveloperEvent = {
  sequence: number
  category: 'console' | 'network' | 'page'
  name: string
  timestamp: number
  data: Record<string, unknown>
}
type BrowserTab = {
  id: number
  window: BrowserWindow
  elements: Set<string>
  console: BrowserConsoleEntry[]
  network: BrowserNetworkEntry[]
  pendingNetwork: Map<number, BrowserNetworkEntry>
  developerEvents: BrowserDeveloperEvent[]
  nextDeveloperSequence: number
  debuggerAttached: boolean
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
  tab.developerEvents.length = 0
}

function developerEvent(tab: BrowserTab, category: BrowserDeveloperEvent['category'], name: string, data: Record<string, unknown>): void {
  const event: BrowserDeveloperEvent = {
    sequence: tab.nextDeveloperSequence++,
    category,
    name,
    timestamp: Date.now(),
    data,
  }
  boundedPush(tab.developerEvents, event, MAX_DEVELOPER_EVENTS)
}

function boundedNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null
}

function cdpDomAttribute(name: string, value: string): [string, string] | undefined {
  const normalized = name.toLowerCase()
  if (normalized === 'value' || normalized === 'style' || normalized.startsWith('on') || /(?:password|token|secret|cookie|authorization|api[-_]?key)/i.test(normalized)) {
    return [name, '[redacted]']
  }
  if (normalized === 'href' || normalized === 'src' || normalized === 'action' || normalized === 'formaction') {
    return [name, sanitizeBrowserDiagnosticUrl(value) ?? '[redacted]']
  }
  if (normalized === 'id' || normalized === 'class' || normalized === 'role' || normalized === 'name' || normalized === 'type' || normalized === 'placeholder' || normalized === 'title' || normalized === 'alt' || normalized === 'disabled' || normalized === 'checked' || normalized === 'selected' || normalized.startsWith('aria-')) {
    return [name, redactBrowserDiagnosticText(value).slice(0, 256)]
  }
  return undefined
}

function projectCdpDomNode(value: unknown, depth = 0, count: { value: number } = { value: 0 }): Record<string, unknown> | undefined {
  if (!isRecord(value) || count.value >= MAX_CDP_DOM_NODES || depth > MAX_CDP_DOM_DEPTH) return undefined
  const nodeType = Number.isInteger(value.nodeType) ? value.nodeType : undefined
  if (nodeType !== 1 && nodeType !== 9 && nodeType !== 11) return undefined
  count.value += 1
  const attributes: Array<[string, string]> = []
  if (Array.isArray(value.attributes)) {
    for (let index = 0; index + 1 < value.attributes.length && attributes.length < MAX_CDP_DOM_ATTRIBUTES; index += 2) {
      const name = value.attributes[index]
      const attributeValue = value.attributes[index + 1]
      if (typeof name !== 'string' || typeof attributeValue !== 'string') continue
      const projected = cdpDomAttribute(name, attributeValue)
      if (projected) attributes.push(projected)
    }
  }
  const children = Array.isArray(value.children)
    ? value.children.flatMap(child => {
      const projected = projectCdpDomNode(child, depth + 1, count)
      return projected ? [projected] : []
    })
    : []
  const childNodeCount = typeof value.childNodeCount === 'number' && Number.isInteger(value.childNodeCount) && value.childNodeCount >= 0
    ? value.childNodeCount
    : children.length
  return {
    nodeId: Number.isInteger(value.nodeId) ? value.nodeId : 0,
    nodeType,
    nodeName: typeof value.nodeName === 'string' ? value.nodeName.slice(0, 80) : '',
    localName: typeof value.localName === 'string' ? value.localName.slice(0, 80) : '',
    childNodeCount,
    ...(attributes.length > 0 ? { attributes } : {}),
    ...(children.length > 0 ? { children } : {}),
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
    for (const tab of this.tabs.values()) {
      if (tab.debuggerAttached && tab.window.webContents.debugger.isAttached()) tab.window.webContents.debugger.detach()
      tab.window.destroy()
    }
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
        return { tabs: [...this.tabs.values()].map(tab => ({ id: tab.id, url: sanitizeBrowserDiagnosticUrl(tab.window.webContents.getURL()), title: redactBrowserDiagnosticText(tab.window.getTitle()).slice(0, 500) })) }
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
      case 'cdp_send':
        return await this.cdpSend(request.arguments)
      case 'cdp_read_events':
        return this.cdpReadEvents(request.arguments)
      case 'wait_for_page':
        return await this.waitForPage(request.arguments)
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
      developerEvents: [],
      nextDeveloperSequence: 1,
      debuggerAttached: false,
    }
    this.tabs.set(tab.id, tab)
    window.once('closed', () => {
      if (tab.debuggerAttached && window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
      this.tabs.delete(tab.id)
    })
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
      developerEvent(tab, 'console', 'console-message', {
        level: details.level,
        message: redactBrowserDiagnosticText(details.message),
        source: sanitizeBrowserDiagnosticUrl(details.sourceId),
        line: Number.isSafeInteger(details.lineNumber) && details.lineNumber >= 0 ? details.lineNumber : 0,
      })
    })
    window.webContents.on('did-navigate', (_event, url) => {
      const destination = sanitizeBrowserDiagnosticUrl(url)
      if (destination) developerEvent(tab, 'page', 'navigated', { url: destination })
    })
    try {
      await window.loadURL(url.toString())
      window.focus()
      return { id: tab.id, url: sanitizeBrowserDiagnosticUrl(window.webContents.getURL()), title: redactBrowserDiagnosticText(window.getTitle()).slice(0, 500) }
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
    return { id: tab.id, url: sanitizeBrowserDiagnosticUrl(tab.window.webContents.getURL()), title: redactBrowserDiagnosticText(tab.window.getTitle()).slice(0, 500) }
  }

  private async inspectPage(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    const snapshot = await this.executeElementWorld(tab, `(() => {
      ${ELEMENT_WORLD_PRELUDE}
      const previous = globalThis[bbStateKey];
      const seed = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
      const generation = previous && Number.isSafeInteger(previous.generation)
        ? previous.generation % 4294967294 + 1
        : seed;
      const root = { generation, url: location.href, elements: new Map() };
      globalThis[bbStateKey] = root;
      const nodes = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]'))
        .filter(node => !bbFileUpload(node))
        .slice(0, ${MAX_PAGE_ELEMENTS});
      const elements = nodes.flatMap(node => {
        const ancestry = bbAncestry(node);
        if (!ancestry) return [];
        const id = 'bb-' + generation + '-' + (root.elements.size + 1);
        const form = bbForm(node);
        root.elements.set(id, {
          node,
          ancestry,
          fingerprint: bbFingerprint(node),
          form,
          formFingerprint: bbFormFingerprint(form),
        });
        const rect = node.getBoundingClientRect();
        return [{ id, role: node.getAttribute('role') || node.tagName.toLowerCase(), label: bbLabel(node), disabled: Boolean(node.disabled), secure: bbSensitive(node), x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }];
      });
      return { url: location.href, title: document.title, elements };
    })()`) as { url?: unknown, title?: unknown, elements?: unknown }
    if (!isRecord(snapshot) || !Array.isArray(snapshot.elements)) throw new Error('BILLIARDBUDDY_BROWSER_SNAPSHOT_INVALID')
    const current = httpUrl(snapshot.url)
    if (!current || !this.allowed(current)) throw new Error('BILLIARDBUDDY_BROWSER_SITE_BLOCKED')
    tab.elements.clear()
    for (const element of snapshot.elements) if (isRecord(element) && typeof element.id === 'string') tab.elements.add(element.id)
    return {
      ...snapshot,
      url: sanitizeBrowserDiagnosticUrl(snapshot.url),
      title: redactBrowserDiagnosticText(snapshot.title).slice(0, 500),
    }
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

  private ensureDebugger(tab: BrowserTab): void {
    if (tab.debuggerAttached && tab.window.webContents.debugger.isAttached()) return
    try {
      tab.window.webContents.debugger.attach('1.3')
      tab.debuggerAttached = true
    } catch {
      throw new Error('BILLIARDBUDDY_BROWSER_DEVELOPER_UNAVAILABLE')
    }
  }

  private async cdpSend(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const method = arguments_.method
    if (method !== 'DOM.getDocument' && method !== 'Page.getLayoutMetrics' && method !== 'Performance.getMetrics') {
      throw new Error('BILLIARDBUDDY_BROWSER_CDP_METHOD_DENIED')
    }
    this.ensureDebugger(tab)
    try {
      if (method === 'DOM.getDocument') {
        const response = await tab.window.webContents.debugger.sendCommand('DOM.getDocument', { depth: MAX_CDP_DOM_DEPTH, pierce: false }) as { root?: unknown }
        const root = projectCdpDomNode(response.root)
        if (!root) throw new Error('BILLIARDBUDDY_BROWSER_CDP_DOM_INVALID')
        return {
          method,
          result: { root, projection: 'Only structural DOM metadata and an attribute allowlist are returned. Text nodes, form values, inline styles, event handlers and sensitive attributes are omitted or redacted.' },
        }
      }
      if (method === 'Page.getLayoutMetrics') {
        const response = await tab.window.webContents.debugger.sendCommand('Page.getLayoutMetrics') as Record<string, unknown>
        const projectViewport = (value: unknown) => isRecord(value) ? {
          pageX: boundedNumber(value.pageX), pageY: boundedNumber(value.pageY), clientWidth: boundedNumber(value.clientWidth), clientHeight: boundedNumber(value.clientHeight), scale: boundedNumber(value.scale), zoom: boundedNumber(value.zoom),
        } : null
        return { method, result: { layoutViewport: projectViewport(response.layoutViewport), visualViewport: projectViewport(response.visualViewport), cssLayoutViewport: projectViewport(response.cssLayoutViewport), cssVisualViewport: projectViewport(response.cssVisualViewport) } }
      }
      const response = await tab.window.webContents.debugger.sendCommand('Performance.getMetrics') as { metrics?: unknown }
      const allowedMetrics = new Set(['Timestamp', 'Documents', 'Frames', 'JSEventListeners', 'Nodes', 'LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize'])
      const metrics = Array.isArray(response.metrics) ? response.metrics.flatMap(entry => {
        if (!isRecord(entry) || typeof entry.name !== 'string' || !allowedMetrics.has(entry.name) || !Number.isFinite(entry.value)) return []
        return [{ name: entry.name, value: Math.round((entry.value as number) * 100) / 100 }]
      }) : []
      return { method, result: { metrics } }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('BILLIARDBUDDY_')) throw error
      throw new Error('BILLIARDBUDDY_BROWSER_CDP_COMMAND_FAILED')
    }
  }

  private cdpReadEvents(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const afterSequence = arguments_.afterSequence === undefined ? 0 : arguments_.afterSequence
    const limit = arguments_.limit === undefined ? 50 : arguments_.limit
    if (!Number.isInteger(afterSequence) || typeof afterSequence !== 'number' || afterSequence < 0) throw new Error('BILLIARDBUDDY_BROWSER_CDP_CURSOR_INVALID')
    if (!Number.isInteger(limit) || typeof limit !== 'number' || limit < 1 || limit > 100) throw new Error('BILLIARDBUDDY_BROWSER_CDP_LIMIT_INVALID')
    const first = tab.developerEvents[0]?.sequence ?? tab.nextDeveloperSequence
    const candidates = tab.developerEvents.filter(event => event.sequence > afterSequence)
    const events = candidates.slice(0, limit).map(event => structuredClone(event))
    const cursor = events.at(-1)?.sequence ?? afterSequence
    return {
      cursor,
      events,
      hasMore: candidates.length > events.length,
      truncated: afterSequence > 0 && afterSequence < first - 1,
      privacy: 'Events are projected summaries only. Headers, cookies, storage, credentials, request and response bodies, and raw CDP event payloads are never retained.',
    }
  }

  private async waitForPage(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const text = arguments_.text
    const timeoutMs = arguments_.timeoutMs === undefined ? 5_000 : arguments_.timeoutMs
    if (text !== undefined && (typeof text !== 'string' || text.length === 0 || text.length > 256)) throw new Error('BILLIARDBUDDY_BROWSER_WAIT_TEXT_INVALID')
    if (!Number.isInteger(timeoutMs) || typeof timeoutMs !== 'number' || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('BILLIARDBUDDY_BROWSER_WAIT_TIMEOUT_INVALID')
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      this.currentAllowedUrl(tab)
      const ready = await tab.window.webContents.executeJavaScript(`(() => {
        const wanted = ${JSON.stringify(text ?? '')};
        if (wanted) return (document.body?.innerText || '').includes(wanted);
        return document.readyState === 'complete';
      })()`, true)
      if (ready === true) return { ready: true, waitedFor: text ? 'visible-text' : 'document-complete' }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('BILLIARDBUDDY_BROWSER_WAIT_TIMEOUT')
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
          developerEvent(tab, 'network', 'request', {
            method: entry.method,
            url: entry.url,
            resourceType: entry.resourceType,
          })
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
      developerEvent(tab, 'network', 'response', {
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        status: entry.status,
        fromCache: entry.fromCache,
      })
    })
    webRequest.onErrorOccurred(details => {
      const tab = details.webContentsId === undefined ? undefined : this.tabs.get(details.webContentsId)
      const entry = tab?.pendingNetwork.get(details.id)
      if (!tab || !entry) return
      entry.completedAt = details.timestamp
      entry.error = redactBrowserDiagnosticText(details.error)
      entry.fromCache = details.fromCache
      tab.pendingNetwork.delete(details.id)
      developerEvent(tab, 'network', 'failed', {
        method: entry.method,
        url: entry.url,
        resourceType: entry.resourceType,
        error: entry.error,
      })
    })
  }

  private element(tab: BrowserTab, arguments_: Record<string, unknown>) {
    const id = arguments_.elementId
    if (typeof id !== 'string' || !/^bb-[1-9][0-9]*-[1-9][0-9]*$/.test(id) || !tab.elements.has(id)) throw new Error('BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
    return id
  }

  private async executeElementWorld(tab: BrowserTab, code: string, userGesture = false): Promise<unknown> {
    return await tab.window.webContents.executeJavaScriptInIsolatedWorld(ELEMENT_WORLD_ID, [{ code }], userGesture)
  }

  private elementFailure(result: unknown): never {
    const file = isRecord(result) && result.reason === 'file'
    const secure = isRecord(result) && result.reason === 'secure'
    if (file) throw new Error('BILLIARDBUDDY_BROWSER_FILE_UPLOAD_DENIED')
    throw new Error(secure ? 'BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED' : 'BILLIARDBUDDY_BROWSER_ELEMENT_STALE')
  }

  private async clickElement(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const id = this.element(tab, arguments_)
    const result = await this.executeElementWorld(tab, `(() => {
      ${ELEMENT_WORLD_PRELUDE}
      const root = globalThis[bbStateKey];
      const entry = root?.elements?.get(${JSON.stringify(id)});
      if (!bbValid(root, entry)) return { ok: false, reason: 'stale' };
      if (bbFileUpload(entry.node)) return { ok: false, reason: 'file' };
      if (bbSensitive(entry.node)) return { ok: false, reason: 'secure' };
      entry.node.scrollIntoView({ block: 'center', inline: 'center' });
      if (!bbValid(root, entry)) return { ok: false, reason: 'stale' };
      entry.node.click();
      return { ok: true };
    })()`, true)
    if (!isRecord(result) || result.ok !== true) this.elementFailure(result)
    return { clicked: id }
  }

  private async typeText(arguments_: Record<string, unknown>) {
    const tab = this.tab(arguments_)
    this.currentAllowedUrl(tab)
    const id = this.element(tab, arguments_)
    const text = arguments_.text
    if (typeof text !== 'string' || text.length === 0 || text.length > 4096) throw new Error('BILLIARDBUDDY_BROWSER_TEXT_INVALID')
    const result = await this.executeElementWorld(tab, `(() => {
      ${ELEMENT_WORLD_PRELUDE}
      const root = globalThis[bbStateKey];
      const entry = root?.elements?.get(${JSON.stringify(id)});
      if (!bbValid(root, entry)) return { ok: false, reason: 'stale' };
      const node = entry.node;
      if (bbFileUpload(node)) return { ok: false, reason: 'file' };
      if (!bbEditable(node) || node.disabled || node.readOnly) return { ok: false, reason: 'stale' };
      if (bbSensitive(node)) return { ok: false, reason: 'secure' };
      node.scrollIntoView({ block: 'center', inline: 'center' });
      node.focus();
      if (!bbValid(root, entry) || document.activeElement !== node) return { ok: false, reason: 'stale' };
      if (node instanceof HTMLInputElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return { ok: false, reason: 'stale' };
        setter.call(node, ${JSON.stringify(text)});
      } else if (node instanceof HTMLTextAreaElement) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return { ok: false, reason: 'stale' };
        setter.call(node, ${JSON.stringify(text)});
      } else {
        node.textContent = ${JSON.stringify(text)};
      }
      node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    })()`, true)
    if (!isRecord(result) || result.ok !== true) this.elementFailure(result)
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
