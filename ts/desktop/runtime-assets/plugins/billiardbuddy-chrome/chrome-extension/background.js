// The extension owns Chrome APIs.  The native host only bridges an explicitly
// connected extension to BilliardBuddy's local plugin process; it never reads a
// Chrome profile or opens arbitrary tabs by itself.

const NATIVE_HOST = 'com.billiardbuddy.chrome'
const MAX_PAGE_TEXT = 24_000
const MAX_ELEMENTS = 120
const MAX_TYPED_TEXT = 4096
const MAX_SCREENSHOT_DATA = 16 * 1024 * 1024

let nativePort = null
let readyPromise = null
let policy = { allowedHosts: [], blockedHosts: [] }
const connectedTabs = new Map()

function responseError(message) {
  return { kind: 'error', message: String(message || 'Chrome request failed') }
}

function normalizeHost(value) {
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return null
  }
}

function hostMatches(host, rule) {
  const normalized = String(rule || '').toLowerCase().replace(/\.$/, '')
  if (!normalized) return false
  if (normalized.startsWith('*.')) return host.endsWith(normalized.slice(1))
  return host === normalized
}

function isAllowedUrl(value) {
  const host = normalizeHost(value)
  if (!host) return false
  if (policy.blockedHosts.some(rule => hostMatches(host, rule))) return false
  return policy.allowedHosts.some(rule => hostMatches(host, rule))
}

async function applyPolicy(value) {
  policy = {
    allowedHosts: Array.isArray(value?.allowedHosts) ? value.allowedHosts : [],
    blockedHosts: Array.isArray(value?.blockedHosts) ? value.blockedHosts : [],
  }
  for (const tabId of [...connectedTabs.keys()]) {
    try {
      await connectedTab(tabId)
    } catch {
      connectedTabs.delete(tabId)
      await chrome.action.setBadgeText({ tabId, text: '!' })
      try { await chrome.debugger.detach({ tabId }) } catch { /* tab may already be closing */ }
      try { postNative({ kind: 'tab_disconnected', tabId }) } catch { /* host is already gone */ }
    }
  }
}

function postNative(message) {
  if (!nativePort) throw new Error('BilliardBuddy Chrome host is not connected')
  nativePort.postMessage(message)
}

function ensureNativePort() {
  if (nativePort && readyPromise) return readyPromise
  nativePort = chrome.runtime.connectNative(NATIVE_HOST)
  readyPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('BilliardBuddy Chrome host did not become ready')), 5000)
    nativePort.onMessage.addListener(message => {
      if (message?.kind === 'ready') {
        policy = {
          allowedHosts: Array.isArray(message.allowedHosts) ? message.allowedHosts : [],
          blockedHosts: Array.isArray(message.blockedHosts) ? message.blockedHosts : [],
        }
        clearTimeout(timeout)
        resolve()
        return
      }
      if (message?.kind === 'command') void handleAgentCommand(message)
    })
    nativePort.onDisconnect.addListener(() => {
      clearTimeout(timeout)
      nativePort = null
      readyPromise = null
      connectedTabs.clear()
      chrome.action.setBadgeText({ text: '' })
      reject(new Error(chrome.runtime.lastError?.message || 'BilliardBuddy Chrome host disconnected'))
    })
    nativePort.postMessage({ kind: 'hello' })
  })
  return readyPromise
}

async function connectedTab(tabId) {
  const entry = connectedTabs.get(Number(tabId))
  if (!entry) throw new Error('This tab is not connected. Ask the user to connect it from the BilliardBuddy Chrome extension.')
  // Never trust the URL captured when the user first connected the tab. A
  // page can navigate between two Agent operations; re-read only location.href
  // before exposing page text, screenshots or input to the caller.
  const current = await evaluate(Number(tabId), '({ url: location.href, title: document.title })')
  if (!current || typeof current.url !== 'string' || !isAllowedUrl(current.url)) {
    throw new Error('This tab is no longer on a domain allowed by BilliardBuddy Chrome settings.')
  }
  entry.url = current.url
  entry.title = typeof current.title === 'string' ? current.title : ''
  return entry
}

async function evaluate(tabId, expression, returnByValue = true) {
  const result = await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
    expression,
    returnByValue,
    awaitPromise: true,
    userGesture: true,
  })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Chrome page evaluation failed')
  return result.result?.value
}

function json(value) {
  return JSON.stringify(value)
}

async function inspectPage(tabId) {
  await connectedTab(tabId)
  const snapshot = await evaluate(tabId, `(() => {
    const root = globalThis.__billiardBuddyChrome || (globalThis.__billiardBuddyChrome = { next: 1, generation: crypto.getRandomValues(new Uint32Array(1))[0] || 1 });
    const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_PAGE_TEXT});
    const elements = [...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
      .slice(0, ${MAX_ELEMENTS})
      .map(el => {
        if (!el.dataset.billiardbuddyElementId) el.dataset.billiardbuddyElementId = 'bb-' + root.generation + '-' + (root.next++);
        const input = el instanceof HTMLInputElement;
        const autocomplete = input ? (el.autocomplete || '') : '';
        const secure = input && (el.type === 'password' || /(?:one-time-code|cc-|password|token)/i.test(autocomplete));
        // Never return current form values. Even an ordinary text field may
        // contain a password, API key or private draft that page metadata did
        // not classify correctly.
        const label = (el.getAttribute('aria-label') || el.innerText || el.placeholder || el.title || '').trim().slice(0, 240);
        return { id: el.dataset.billiardbuddyElementId, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, label, disabled: Boolean(el.disabled), secure };
      });
    return { url: location.href, title: document.title, text, elements };
  })()`)
  if (!snapshot || typeof snapshot.url !== 'string' || !isAllowedUrl(snapshot.url)) {
    throw new Error('The tab navigated outside the domains allowed by BilliardBuddy Chrome settings.')
  }
  const current = connectedTabs.get(tabId)
  if (current) {
    current.url = snapshot.url
    current.title = typeof snapshot.title === 'string' ? snapshot.title : ''
  }
  return snapshot
}

function keyDefinition(key) {
  const keys = {
    Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  }
  if (!keys[key]) throw new Error('Only Enter, Tab, Escape, and arrow keys are available through BilliardBuddy Chrome.')
  return keys[key]
}

async function runAgentOperation(op, args) {
  if (op === 'status') {
    return { connected: Boolean(nativePort), allowedHosts: policy.allowedHosts, blockedHosts: policy.blockedHosts, connectedTabCount: connectedTabs.size }
  }
  if (op === 'list_tabs') {
    const tabs = await Promise.all([...connectedTabs.keys()].map(async tabId => {
      try {
        const tab = await connectedTab(tabId)
        return { id: tab.id, title: tab.title, url: tab.url }
      } catch {
        return null
      }
    }))
    return { tabs: tabs.filter(Boolean) }
  }
  const tabId = Number(args?.tabId)
  if (!Number.isSafeInteger(tabId) || tabId < 1) throw new Error('tabId must be a connected Chrome tab ID')
  if (op === 'inspect_page') return await inspectPage(tabId)
  if (op === 'capture_page') {
    await connectedTab(tabId)
    const image = await chrome.debugger.sendCommand({ tabId }, 'Page.captureScreenshot', { format: 'png' })
    await connectedTab(tabId)
    if (typeof image?.data !== 'string' || !image.data || image.data.length > MAX_SCREENSHOT_DATA) {
      throw new Error('The visible Chrome page is too large to capture safely.')
    }
    return { mimeType: 'image/png', data: image.data }
  }
  if (op === 'navigate') {
    await connectedTab(tabId)
    const url = String(args?.url || '')
    if (!isAllowedUrl(url)) throw new Error('The destination domain is not allowed by BilliardBuddy Chrome settings.')
    const navigation = await chrome.debugger.sendCommand({ tabId }, 'Page.navigate', { url })
    if (navigation?.errorText) throw new Error(`Chrome navigation failed: ${navigation.errorText}`)
    const entry = connectedTabs.get(tabId)
    if (entry) entry.url = url
    return { navigated: true, url }
  }
  if (op === 'click_element') {
    await connectedTab(tabId)
    const elementId = String(args?.elementId || '')
    if (!/^bb-[1-9][0-9]*-[1-9][0-9]*$/.test(elementId)) throw new Error('elementId must come from inspect_page')
    const clicked = await evaluate(tabId, `(() => { const el = document.querySelector('[data-billiardbuddy-element-id=' + ${json(elementId)} + ']'); if (!el) return false; el.scrollIntoView({block:'center', inline:'center'}); el.focus?.(); el.click(); return true; })()`)
    if (!clicked) throw new Error('The inspected element is no longer present. Inspect the page again.')
    return { clicked: true, elementId }
  }
  if (op === 'type_text') {
    await connectedTab(tabId)
    const elementId = String(args?.elementId || '')
    const text = String(args?.text || '')
    if (!/^bb-[1-9][0-9]*-[1-9][0-9]*$/.test(elementId)) throw new Error('elementId must come from inspect_page')
    if (!text || text.length > MAX_TYPED_TEXT) throw new Error(`text must contain 1-${MAX_TYPED_TEXT} characters`)
    const focused = await evaluate(tabId, `(() => { const el = document.querySelector('[data-billiardbuddy-element-id=' + ${json(elementId)} + ']'); const secure = el instanceof HTMLInputElement && (el.type === 'password' || /(?:one-time-code|cc-|password|token)/i.test(el.autocomplete || '')); if (!el || el.disabled || secure) return false; el.scrollIntoView({block:'center', inline:'center'}); el.focus(); return document.activeElement === el; })()`)
    if (!focused) throw new Error('The element is unavailable, disabled, or a protected credential field. Inspect the page again.')
    await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', { text })
    return { typed: true, elementId, characterCount: text.length }
  }
  if (op === 'press_key') {
    await connectedTab(tabId)
    const key = keyDefinition(String(args?.key || ''))
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key })
    await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
    return { pressed: key.key }
  }
  throw new Error('Unknown BilliardBuddy Chrome operation')
}

async function handleAgentCommand(message) {
  try {
    await applyPolicy(message.policy)
    const payload = await runAgentOperation(message.op, message.arguments || {})
    postNative({ kind: 'result', id: message.id, payload })
  } catch (error) {
    postNative({ kind: 'error', id: message.id, message: error instanceof Error ? error.message : String(error) })
  }
}

chrome.action.onClicked.addListener(async tab => {
  try {
    if (!tab.id || !tab.url || !/^https?:/i.test(tab.url)) throw new Error('Open a normal http or https page before connecting it.')
    await ensureNativePort()
    if (connectedTabs.has(tab.id)) {
      await chrome.debugger.detach({ tabId: tab.id })
      connectedTabs.delete(tab.id)
      await chrome.action.setBadgeText({ tabId: tab.id, text: '' })
      return
    }
    if (!isAllowedUrl(tab.url)) throw new Error('This site is not in the BilliardBuddy Chrome allowlist.')
    await chrome.debugger.attach({ tabId: tab.id }, '1.3')
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Page.enable')
    } catch (error) {
      try { await chrome.debugger.detach({ tabId: tab.id }) } catch { /* Chrome already detached it */ }
      throw error
    }
    connectedTabs.set(tab.id, { id: tab.id, title: tab.title || '', url: tab.url })
    await chrome.action.setBadgeText({ tabId: tab.id, text: 'ON' })
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#2563eb' })
    postNative({ kind: 'tab_connected', tab: connectedTabs.get(tab.id) })
  } catch (error) {
    await chrome.action.setBadgeText({ tabId: tab.id, text: '!' })
    console.error('BilliardBuddy Chrome could not connect tab', error)
  }
})

chrome.debugger.onDetach.addListener(async source => {
  if (!source.tabId || !connectedTabs.has(source.tabId)) return
  connectedTabs.delete(source.tabId)
  await chrome.action.setBadgeText({ tabId: source.tabId, text: '' })
  try { postNative({ kind: 'tab_disconnected', tabId: source.tabId }) } catch { /* host is already gone */ }
})

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  if (!source.tabId || !connectedTabs.has(source.tabId) || method !== 'Page.frameNavigated') return
  const frame = params?.frame
  if (!frame || frame.parentId || typeof frame.url !== 'string') return
  if (isAllowedUrl(frame.url)) {
    const entry = connectedTabs.get(source.tabId)
    if (entry) entry.url = frame.url
    return
  }
  connectedTabs.delete(source.tabId)
  await chrome.action.setBadgeText({ tabId: source.tabId, text: '!' })
  try { await chrome.debugger.detach({ tabId: source.tabId }) } catch { /* tab may already be closing */ }
  try { postNative({ kind: 'tab_disconnected', tabId: source.tabId }) } catch { /* host is already gone */ }
})
