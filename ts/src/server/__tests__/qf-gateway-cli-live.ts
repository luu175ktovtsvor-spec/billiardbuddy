/**
 * Live E2E: real BilliardBuddy sidecar → real CLI subprocess → local Provider Proxy
 *          → product gateway (qf-gateway) → Qwen/MiMo → tool_use.
 *
 * This is a MANUAL runner (not a *.test.ts — excluded from `bun test` / check:server /
 * quality_gate) because it needs a reachable product gateway + a valid app token and
 * makes real, metered upstream calls. It proves the full chain WITHOUT the shortcut of
 * calling handleProxyRequest directly: the real CLI subprocess (spawned by the real
 * server) reaches the gateway through the local proxy the managed provider installs.
 *
 * Run:
 *   cd ts
 *   QF_GATEWAY_URL=... QF_GATEWAY_TOKEN=... [QF_GATEWAY_MODEL=mimo-v2.5] \
 *     bun run src/server/__tests__/qf-gateway-cli-live.ts
 *
 * Skips (exit 0) when QF_GATEWAY_URL / QF_GATEWAY_TOKEN are not set, so it is safe to
 * invoke unconditionally in a live-optional smoke lane. It NEVER prints the token/key.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import crypto from 'node:crypto'

const SERVER_PORT = 19891
const BASE_URL = `http://127.0.0.1:${SERVER_PORT}`
const WS_URL = `ws://127.0.0.1:${SERVER_PORT}`

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type ServerMsg = { type: string; [key: string]: any }

function connect(sessionId: string): Promise<{
  ws: WebSocket
  messages: ServerMsg[]
  waitFor: (types: string[], timeoutMs?: number) => Promise<ServerMsg>
  close: () => void
}> {
  return new Promise((resolve, reject) => {
    const messages: ServerMsg[] = []
    const waiters: Array<{ types: string[]; resolve: (m: ServerMsg) => void }> = []
    const ws = new WebSocket(`${WS_URL}/ws/${sessionId}`)
    ws.onmessage = (event) => {
      let msg: ServerMsg
      try { msg = JSON.parse(event.data as string) } catch { return }
      messages.push(msg)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].types.includes(msg.type)) {
          waiters[i].resolve(msg)
          waiters.splice(i, 1)
        }
      }
    }
    ws.onerror = () => reject(new Error('WebSocket error'))
    ws.onopen = () => resolve({
      ws,
      messages,
      waitFor(types, timeoutMs = 120000) {
        const existing = messages.find((m) => types.includes(m.type))
        if (existing) return Promise.resolve(existing)
        return new Promise((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error(`Timeout waiting for [${types.join(', ')}]; got: ${messages.map((m) => m.type).join(', ')}`)),
            timeoutMs,
          )
          waiters.push({ types, resolve: (m) => { clearTimeout(timer); res(m) } })
        })
      },
      close() { ws.close() },
    })
  })
}

function redact(text: string, token: string): string {
  return token ? text.split(token).join('«redacted-token»') : text
}

async function main() {
  const gatewayUrl = (process.env.QF_GATEWAY_URL ?? '').trim()
  const gatewayToken = (process.env.QF_GATEWAY_TOKEN ?? '').trim()
  if (!gatewayUrl || !gatewayToken) {
    console.log('⏭️  SKIP: QF_GATEWAY_URL / QF_GATEWAY_TOKEN not set — live gateway E2E skipped.')
    process.exit(0)
  }

  const tmpDir = mkdtempSync(join(tmpdir(), 'qf-gw-cli-live-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  // Force the real CLI (not the mock fixture) and a deterministic-ish harness.
  delete process.env.CLAUDE_CLI_PATH
  process.env.CC_HAHA_DISABLE_TERMINAL_SHELL_ENV = '1'

  const { startServer } = await import('../index.js')
  const server = startServer(SERVER_PORT, '127.0.0.1')
  const failures: string[] = []
  try {
    await sleep(700)

    // 1. The product gateway must auto-activate as the managed provider (no manual config).
    const models = await (await fetch(`${BASE_URL}/api/models`)).json() as any
    const activeId = models?.provider?.id
    console.log(`active provider: ${activeId}`)
    if (activeId !== 'qf-gateway') {
      failures.push(`expected qf-gateway auto-active, got ${activeId}`)
    }

    // 2. Drive the REAL CLI subprocess to complete a harmless tool call through the gateway.
    const sessionId = crypto.randomUUID()
    const client = await connect(sessionId)
    await client.waitFor(['connected'], 8000)
    client.ws.send(JSON.stringify({ type: 'set_permission_mode', mode: 'bypassPermissions' }))
    await client.waitFor(['permission_mode_changed'], 8000).catch(() => null)
    client.ws.send(JSON.stringify({
      type: 'user_message',
      content: 'Use the Bash tool to run exactly `echo billiardbuddy-live-ok` and then reply with only the command output. Do not ask for confirmation.',
    }))

    // A real tool call surfaces as content_start(blockType tool_use) / tool_use_complete.
    const toolEvt = await client.waitFor(['tool_use_complete', 'content_start', 'error'], 150000)
    if (toolEvt.type === 'error') {
      failures.push(`session error: ${redact(String(toolEvt.message ?? ''), gatewayToken)}`)
    } else {
      const sawTool = client.messages.some(
        (m) => m.type === 'tool_use_complete' || (m.type === 'content_start' && m.blockType === 'tool_use'),
      )
      console.log(`tool_use observed through gateway: ${sawTool}`)
      if (!sawTool) failures.push('no tool_use observed from the real CLI subprocess')
    }
    await client.waitFor(['message_complete', 'result'], 60000).catch(() => null)

    // 3. Token/key must never appear in the transcript we received.
    const transcript = JSON.stringify(client.messages)
    if (gatewayToken && transcript.includes(gatewayToken)) {
      failures.push('SECURITY: app token leaked into the WS transcript')
    }
    client.close()
  } catch (err) {
    failures.push(`exception: ${redact(err instanceof Error ? err.message : String(err), gatewayToken)}`)
  } finally {
    server.stop(true)
    rmSync(tmpDir, { recursive: true, force: true })
  }

  if (failures.length > 0) {
    console.log('\n❌ LIVE E2E FAILED:')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log('\n✅ LIVE E2E PASSED: real CLI subprocess completed a tool call through qf-gateway; no token leak.')
  process.exit(0)
}

void main()
