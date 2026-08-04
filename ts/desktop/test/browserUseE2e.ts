import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import { InAppBrowserHost } from '../electron/services/inAppBrowserHost'

type Json = Record<string, unknown>

function record(value: unknown, message: string): Json {
  assert.equal(typeof value, 'object', message)
  assert.notEqual(value, null, message)
  assert.equal(Array.isArray(value), false, message)
  return value as Json
}

class McpClient {
  private nextId = 1
  private buffer = ''
  private readonly pending = new Map<number, { resolve: (value: Json) => void, reject: (reason: Error) => void, timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => this.read(chunk))
    child.once('error', error => this.close(error))
    child.once('exit', () => this.close(new Error('Browser MCP exited before its response')))
  }

  async request(method: string, params?: Json): Promise<Json> {
    const id = this.nextId++
    const response = new Promise<Json>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Browser MCP timed out for ${method}`))
      }, 30_000)
      this.pending.set(id, { resolve, reject, timer })
    })
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`)
    return await response
  }

  private read(chunk: string) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      const message = record(JSON.parse(line), 'Browser MCP returned invalid JSON')
      const id = message.id
      if (typeof id !== 'number') continue
      const pending = this.pending.get(id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(id)
      pending.resolve(message)
    }
  }

  private close(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

function toolResult(response: Json): Json {
  assert.equal('error' in response, false, `MCP protocol error: ${JSON.stringify(response)}`)
  return record(response.result, 'Browser MCP omitted its result')
}

function toolText(result: Json): string {
  assert.equal(result.isError, false, `Browser tool failed: ${JSON.stringify(result)}`)
  const content = result.content
  assert.ok(Array.isArray(content) && content.length > 0, 'Browser tool returned no content')
  const first = record(content[0], 'Browser tool content is invalid')
  assert.equal(first.type, 'text', 'Browser tool did not return text')
  assert.equal(typeof first.text, 'string', 'Browser tool text is invalid')
  return first.text as string
}

async function tool(client: McpClient, name: string, arguments_: Json = {}): Promise<Json> {
  return toolResult(await client.request('tools/call', { name, arguments: arguments_ }))
}

async function startFixture(): Promise<{ url: string, close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/reset/private-path-token')) {
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
      <title>Browser E2E</title>
      <input aria-label="normal input" value="must-not-leak">
      <input type="file" aria-label="file upload">
      <input type="password" aria-label="field-type">
      <input autocomplete="one-time-code" aria-label="field-autocomplete">
      <input name="access_token" aria-label="field-name">
      <input id="api-key" aria-label="field-id">
      <input aria-label="authentication token">
      <input placeholder="credit card number">
      <input title="verification code">
      <input aria-label="move trigger">
      <input aria-label="fingerprint trigger">
      <input aria-label="fingerprint target">
      <div id="first-slot"><button aria-label="move target">move target</button></div>
      <div id="second-slot"></div>
      <button aria-label="identity original">identity original</button>
      <button aria-label="identity evil">identity evil</button>
      <script>
        console.warn("API_KEY=private-value https://example.test/reset/private-path-token?token=secret");
        fetch("/reset/private-path-token?token=secret");
        const identityOriginal = document.querySelector('[aria-label="identity original"]');
        const identityEvil = document.querySelector('[aria-label="identity evil"]');
        identityOriginal.addEventListener('click', () => identityOriginal.setAttribute('aria-label', 'identity original clicked'));
        identityEvil.addEventListener('click', () => identityEvil.setAttribute('aria-label', 'identity evil clicked'));
        const spoof = new MutationObserver(records => {
          const mutation = records.find(record => record.target === identityOriginal && (record.attributeName === 'data-billiardbuddy-element' || record.attributeName === 'data-billiardbuddy-element-id'));
          if (!mutation) return;
          spoof.disconnect();
          const value = mutation.target.getAttribute(mutation.attributeName);
          mutation.target.removeAttribute(mutation.attributeName);
          identityEvil.setAttribute(mutation.attributeName, value);
        });
        spoof.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['data-billiardbuddy-element', 'data-billiardbuddy-element-id'] });
        document.querySelector('[aria-label="move trigger"]').addEventListener('input', () => {
          document.querySelector('#second-slot').append(document.querySelector('[aria-label="move target"]'));
        });
        document.querySelector('[aria-label="fingerprint trigger"]').addEventListener('input', () => {
          document.querySelector('[aria-label="fingerprint target"]').setAttribute('name', 'api_key');
        });
      </script>`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string', 'Browser E2E fixture address is invalid')
  return { url: `http://127.0.0.1:${address.port}/`, close: async () => { server.close(); await once(server, 'close') } }
}

async function stop(child: ChildProcessWithoutNullStreams | undefined) {
  if (!child || child.exitCode !== null) return
  child.stdin.end()
  child.kill()
  await once(child, 'exit').catch(() => undefined)
}

async function main() {
  const binary = process.argv[2]
  if (!binary || !path.isAbsolute(binary)) throw new Error('Browser E2E requires an absolute staged MCP binary path')
  await fs.access(binary)
  const userData = await fs.mkdtemp(path.join(tmpdir(), 'billiardbuddy-browser-e2e-'))
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined
  let host: InAppBrowserHost | undefined
  let child: ChildProcessWithoutNullStreams | undefined
  try {
    app.setPath('userData', userData)
    await fs.mkdir(path.join(userData, 'agent-runtime', 'browser-use'), { recursive: true })
    await fs.writeFile(path.join(userData, 'agent-runtime', 'browser-use', 'config.json'), JSON.stringify({ allowedHosts: ['127.0.0.1'], blockedHosts: [] }))
    await app.whenReady()
    fixture = await startFixture()
    host = new InAppBrowserHost({ userDataPath: userData, mainWindow: () => null, showWindow: false })
    await host.start()
    child = spawn(binary, [], { env: { ...process.env, CODEX_HOME: path.join(userData, 'agent-runtime') }, stdio: 'pipe' })
    const client = new McpClient(child)

    const initialized = record((await client.request('initialize')).result, 'Browser MCP did not initialize')
    assert.equal(record(initialized.serverInfo, 'Browser MCP omitted its server info').name, 'billiardbuddy-browser-use')
    const listed = record((await client.request('tools/list')).result, 'Browser MCP did not list tools')
    const declaredTools = listed.tools
    assert.ok(Array.isArray(declaredTools), 'Browser MCP tools are invalid')
    for (const name of ['open_tab', 'close_tab', 'navigate', 'click_element', 'type_text', 'press_key']) {
      const declared = declaredTools.find(tool => record(tool, 'Browser MCP tool is invalid').name === name)
      const annotations = record(record(declared, `Browser MCP omitted ${name}`).annotations, `Browser MCP ${name} omitted approval annotations`)
      assert.equal(annotations.readOnlyHint, false, `Browser MCP ${name} cannot be read-only`)
      assert.equal(annotations.destructiveHint, true, `Browser MCP ${name} must require Codex Core approval`)
    }
    assert.match(toolText(await tool(client, 'status')), /"ready":true/)

    const opened = JSON.parse(toolText(await tool(client, 'open_tab', { url: fixture.url }))) as Json
    const tabId = opened.id
    assert.equal(typeof tabId, 'number', 'Browser MCP did not return a tab ID')
    assert.match(toolText(await tool(client, 'wait_for_page', { tabId })), /"ready":true/)
    const page = JSON.parse(toolText(await tool(client, 'inspect_page', { tabId }))) as Json
    const elements = page.elements
    assert.ok(Array.isArray(elements), 'Browser MCP did not return page elements')
    const normal = elements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'normal input')
    const fileUpload = elements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'file upload')
    const password = elements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'field-type')
    assert.equal(typeof normal?.id, 'string', 'Browser MCP did not identify the normal field')
    assert.equal(fileUpload, undefined, 'Browser MCP exposed a file chooser control')
    assert.equal(typeof password?.id, 'string', 'Browser MCP did not identify the password field')
    assert.match(toolText(await tool(client, 'type_text', { tabId, elementId: normal?.id, text: 'safe' })), /"typed":4/)

    const denied = await tool(client, 'type_text', { tabId, elementId: password?.id, text: 'must-not-type' })
    assert.equal(denied.isError, true, 'Browser MCP typed into a password field')
    const deniedContent = denied.content
    assert.ok(Array.isArray(deniedContent) && deniedContent.length > 0, 'Browser MCP omitted denial detail')
    assert.match(String(record(deniedContent[0], 'Browser denial is invalid').text), /BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED/)

    const securityCases = [
      'field-type',
      'field-autocomplete',
      'field-name',
      'field-id',
      'authentication token',
      'credit card number',
      'verification code',
    ]
    for (const label of securityCases) {
      const field = elements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === label)
      assert.equal(field?.secure, true, `Browser did not classify ${label} as sensitive`)
      const protectedResult = await tool(client, 'type_text', { tabId, elementId: field?.id, text: 'must-not-type' })
      assert.equal(protectedResult.isError, true, `Browser typed into sensitive field ${label}`)
      assert.match(String(record((protectedResult.content as unknown[])[0], 'Browser sensitive-field denial is invalid').text), /BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED/)
    }

    const identity = elements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'identity original')
    assert.equal(typeof identity?.id, 'string', 'Browser did not identify the spoof-resistance target')
    assert.match(toolText(await tool(client, 'click_element', { tabId, elementId: identity?.id })), /"clicked"/)
    const afterIdentity = JSON.parse(toolText(await tool(client, 'inspect_page', { tabId }))) as Json
    const afterIdentityElements = afterIdentity.elements as unknown[]
    assert.ok(afterIdentityElements.map(element => record(element, 'Browser element is invalid')).some(element => element.label === 'identity original clicked'), 'Browser clicked a page-forged element ID instead of the inspected node')
    assert.ok(afterIdentityElements.map(element => record(element, 'Browser element is invalid')).some(element => element.label === 'identity evil'), 'Browser clicked the page-forged replacement node')

    const moveTarget = afterIdentityElements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'move target')
    const moveTrigger = afterIdentityElements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'move trigger')
    assert.match(toolText(await tool(client, 'type_text', { tabId, elementId: moveTrigger?.id, text: 'move' })), /"typed":4/)
    const movedResult = await tool(client, 'click_element', { tabId, elementId: moveTarget?.id })
    assert.equal(movedResult.isError, true, 'Browser clicked an inspected node after its DOM ancestry changed')
    assert.match(String(record((movedResult.content as unknown[])[0], 'Browser moved-node denial is invalid').text), /BILLIARDBUDDY_BROWSER_ELEMENT_STALE/)

    const fingerprintTarget = afterIdentityElements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'fingerprint target')
    const fingerprintTrigger = afterIdentityElements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'fingerprint trigger')
    assert.match(toolText(await tool(client, 'type_text', { tabId, elementId: fingerprintTrigger?.id, text: 'change' })), /"typed":6/)
    const fingerprintResult = await tool(client, 'type_text', { tabId, elementId: fingerprintTarget?.id, text: 'must-not-type' })
    assert.equal(fingerprintResult.isError, true, 'Browser typed after the inspected element fingerprint changed')
    assert.match(String(record((fingerprintResult.content as unknown[])[0], 'Browser fingerprint denial is invalid').text), /BILLIARDBUDDY_BROWSER_ELEMENT_STALE/)

    const screenshot = await tool(client, 'capture_page', { tabId })
    assert.equal(screenshot.isError, false, `Browser screenshot failed: ${JSON.stringify(screenshot)}`)
    const screenshotContent = screenshot.content
    assert.ok(Array.isArray(screenshotContent) && screenshotContent.length > 0, 'Browser MCP omitted screenshot content')
    const image = record(screenshotContent[0], 'Browser screenshot is invalid')
    assert.equal(image.type, 'image')
    assert.equal(image.mimeType, 'image/png')
    assert.ok(typeof image.data === 'string' && image.data.length > 100, 'Browser screenshot is empty')

    const developer = JSON.parse(toolText(await tool(client, 'developer_snapshot', { tabId }))) as Json
    const serializedDeveloper = JSON.stringify(developer)
    assert.match(serializedDeveloper, /API_KEY=\[redacted\]/, 'Browser developer snapshot omitted redacted console evidence')
    assert.match(serializedDeveloper, /\/reset\/\[redacted\]/, 'Browser developer snapshot omitted redacted network evidence')
    assert.doesNotMatch(serializedDeveloper, /private-value|private-path-token|token=secret/, 'Browser developer snapshot exposed console or URL secrets')
    assert.doesNotMatch(serializedDeveloper, /requestHeaders|responseHeaders|cookies|localStorage/, 'Browser developer snapshot exposed a forbidden browser surface')

    const cdpDom = JSON.parse(toolText(await tool(client, 'cdp_send', { tabId, method: 'DOM.getDocument' }))) as Json
    assert.equal(cdpDom.method, 'DOM.getDocument', 'Browser did not return the allowlisted CDP method')
    const serializedDom = JSON.stringify(cdpDom)
    assert.doesNotMatch(serializedDom, /must-not-leak|private-value|token=secret/, 'Browser CDP DOM projection exposed a form value or secret')
    assert.match(serializedDom, /projection/, 'Browser CDP DOM projection omitted its boundary')
    const cdpPerformance = JSON.parse(toolText(await tool(client, 'cdp_send', { tabId, method: 'Performance.getMetrics' }))) as Json
    assert.equal(cdpPerformance.method, 'Performance.getMetrics', 'Browser did not expose the allowlisted performance projection')
    const deniedCdp = await tool(client, 'cdp_send', { tabId, method: 'Network.getResponseBody' })
    assert.equal(deniedCdp.isError, true, 'Browser MCP accepted a forbidden CDP method')

    const developerEvents = JSON.parse(toolText(await tool(client, 'cdp_read_events', { tabId, afterSequence: 0, limit: 100 }))) as Json
    const serializedEvents = JSON.stringify(developerEvents)
    assert.ok(Array.isArray(developerEvents.events) && developerEvents.events.length > 0, 'Browser did not retain projected developer events')
    assert.equal(typeof developerEvents.cursor, 'number', 'Browser developer event cursor is missing')
    assert.doesNotMatch(serializedEvents, /private-value|private-path-token|token=secret|requestHeaders|responseHeaders|cookies|localStorage/, 'Browser developer events exposed a forbidden surface')

    await fs.writeFile(
      path.join(userData, 'agent-runtime', 'browser-use', 'config.json'),
      JSON.stringify({ allowedHosts: [], blockedHosts: ['127.0.0.1'] }),
    )
    await host.reloadPolicy()
    const tabsAfterRevocation = JSON.parse(toolText(await tool(client, 'list_tabs'))) as Json
    assert.deepEqual(tabsAfterRevocation.tabs, [], 'Browser policy revocation left a blocked tab available')

    await host.stop()
    host = undefined
    const unavailable = await tool(client, 'status')
    assert.equal(unavailable.isError, true, 'Browser MCP did not fail closed after its host stopped')
    assert.match(String(record((unavailable.content as unknown[])[0], 'Browser unavailable result is invalid').text), /not ready/)
    console.log('Browser Use Electron host E2E passed')
  } finally {
    await stop(child)
    await host?.stop()
    await fixture?.close()
    await fs.rm(userData, { recursive: true, force: true })
  }
}

void main().then(() => app.exit(0), error => {
  console.error(error)
  app.exit(1)
})
