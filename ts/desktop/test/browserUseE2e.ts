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
    response.end('<!doctype html><title>Browser E2E</title><input aria-label="normal input"><input type="password" aria-label="password input"><script>console.warn("API_KEY=private-value https://example.test/reset/private-path-token?token=secret"); fetch("/reset/private-path-token?token=secret")</script>')
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
    assert.match(toolText(await tool(client, 'status')), /"ready":true/)

    const opened = JSON.parse(toolText(await tool(client, 'open_tab', { url: fixture.url }))) as Json
    const tabId = opened.id
    assert.equal(typeof tabId, 'number', 'Browser MCP did not return a tab ID')
    const page = JSON.parse(toolText(await tool(client, 'inspect_page', { tabId }))) as Json
    const elements = page.elements
    assert.ok(Array.isArray(elements), 'Browser MCP did not return page elements')
    const normal = elements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'normal input')
    const password = elements.map(element => record(element, 'Browser element is invalid')).find(element => element.label === 'password input')
    assert.equal(typeof normal?.id, 'string', 'Browser MCP did not identify the normal field')
    assert.equal(typeof password?.id, 'string', 'Browser MCP did not identify the password field')
    assert.match(toolText(await tool(client, 'type_text', { tabId, elementId: normal?.id, text: 'safe' })), /"typed":4/)

    const denied = await tool(client, 'type_text', { tabId, elementId: password?.id, text: 'must-not-type' })
    assert.equal(denied.isError, true, 'Browser MCP typed into a password field')
    const deniedContent = denied.content
    assert.ok(Array.isArray(deniedContent) && deniedContent.length > 0, 'Browser MCP omitted denial detail')
    assert.match(String(record(deniedContent[0], 'Browser denial is invalid').text), /BILLIARDBUDDY_BROWSER_SECURE_FIELD_DENIED/)

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
