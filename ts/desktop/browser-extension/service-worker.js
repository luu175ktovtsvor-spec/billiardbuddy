const NATIVE_HOST = 'com.billiardbuddy.browser'
const PROTOCOL_VERSION = 1
const HEARTBEAT_MS = 2000
const sessions = new Map()
let nativePort = null
let latestPage = null
let activeTabId = null

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`
}

async function pendingResults() {
  const stored = await chrome.storage.local.get('browser_action_results')
  return Object.values(stored.browser_action_results || {})
}

async function rememberResult(result) {
  const stored = await chrome.storage.local.get('browser_action_results')
  const results = stored.browser_action_results || {}
  results[result.operation_id] = result
  await chrome.storage.local.set({ browser_action_results: results })
}

async function acknowledgeResults(operationIds) {
  if (!operationIds?.length) return
  const stored = await chrome.storage.local.get('browser_action_results')
  const results = stored.browser_action_results || {}
  for (const id of operationIds) delete results[id]
  await chrome.storage.local.set({ browser_action_results: results })
}

function connectNative() {
  if (nativePort) return nativePort
  nativePort = chrome.runtime.connectNative(NATIVE_HOST)
  nativePort.onMessage.addListener(async response => {
    if (!response?.ok) return
    await acknowledgeResults(response.acknowledged_operation_ids)
    if (!response.command || activeTabId === null) return
    const existing = (await pendingResults()).find(item => item.operation_id === response.command.operation_id)
    if (existing) {
      void sendSync()
      return
    }
    let result
    try {
      const executed = await chrome.tabs.sendMessage(activeTabId, { type: 'bb_browser_execute', command: response.command })
      result = {
        operation_id: response.command.operation_id,
        command_id: response.command.command_id,
        outcome: executed?.outcome === 'succeeded' ? 'succeeded' : executed?.outcome === 'outcome_unknown' ? 'outcome_unknown' : 'failed',
        ...(executed?.failure_code ? { failure_code: executed.failure_code } : {}),
      }
    } catch {
      result = { operation_id: response.command.operation_id, command_id: response.command.command_id, outcome: 'failed', failure_code: 'EXTENSION_DISPATCH_FAILED' }
    }
    await rememberResult(result)
    void sendSync()
  })
  nativePort.onDisconnect.addListener(() => { nativePort = null })
  return nativePort
}

async function sendSync() {
  if (!latestPage || activeTabId === null) return
  const sessionId = sessions.get(activeTabId)
  if (!sessionId) return
  try {
    connectNative().postMessage({
      protocol_version: PROTOCOL_VERSION,
      type: 'sync',
      session_id: sessionId,
      page: latestPage,
      results: await pendingResults(),
    })
  } catch {
    nativePort = null
  }
}

chrome.action.onClicked.addListener(async tab => {
  const hostname = tab.url?.startsWith('https://') ? new URL(tab.url).hostname : ''
  if (!tab.id || (hostname !== 'zhipin.com' && !hostname.endsWith('.zhipin.com'))) return
  const wasEnabled = activeTabId === tab.id
  if (activeTabId !== null && activeTabId !== tab.id) {
    await chrome.tabs.sendMessage(activeTabId, { type: 'bb_browser_enabled', enabled: false }).catch(() => undefined)
  }
  activeTabId = wasEnabled ? null : tab.id
  latestPage = null
  if (activeTabId !== null) sessions.set(activeTabId, randomId('browser_session'))
  await chrome.tabs.sendMessage(tab.id, { type: 'bb_browser_enabled', enabled: !wasEnabled })
  await chrome.action.setBadgeText({ tabId: tab.id, text: wasEnabled ? '' : 'ON' })
  await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#2563EB' })
})

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'bb_browser_snapshot' || sender.tab?.id !== activeTabId) return
  latestPage = message.page
  void sendSync()
})

setInterval(() => { void sendSync() }, HEARTBEAT_MS)
