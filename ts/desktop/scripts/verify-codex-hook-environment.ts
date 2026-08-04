/**
 * Credential-free runtime regression for the patched Codex Hook child path.
 *
 * It uses the staged BilliardBuddy engine, a loopback-only Responses server,
 * and a temporary plugin Hook. The probe records booleans only: adapter
 * capability values never reach disk, stdout, or the fake upstream.
 */
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  CodexNativeAppServerClient,
  type CodexNativeJsonObject,
  type CodexNativeNotification,
} from '../electron/services/codexNativeAppServer'
import { startCodexNativeProvider, type StartedCodexNativeProvider } from '../electron/services/codexNativeProvider'
import type { PersonalModelProfile } from '../../shared/product/personalModels'
import {
  detectCodexEngineTarget,
  stagedCodexEngineBinaryName,
  verifyStagedCodexEngine,
} from './stage-codex-engine'

const TURN_TIMEOUT_MS = 30_000
const MODEL = 'billiardbuddy-hook-environment-e2e-model'
const PROMPT = 'Reply with exactly BILLIARDBUDDY-HOOK-ENVIRONMENT-E2E-OK. Do not call tools.'
const RESPONSE_TEXT = 'BILLIARDBUDDY-HOOK-ENVIRONMENT-E2E-OK'
const PLUGIN_ID = 'bb-hook-environment@test'

type HookIdentity = {
  key: string
  currentHash: string
  trustStatus: 'untrusted' | 'trusted' | 'modified' | 'managed'
}

type ProbeResult = {
  gatewayAdapterToken: boolean
  personalResponsesAdapterToken: boolean
  chatAdapterToken: boolean
  pluginRoot: boolean
  pluginData: boolean
}

function jsonObject(value: unknown): CodexNativeJsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as CodexNativeJsonObject
    : undefined
}

function nonEmptyText(value: unknown, limit = 4_096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit
}

function notificationTurnId(notification: CodexNativeNotification): string | undefined {
  const params = jsonObject(notification.params)
  const turn = jsonObject(params?.turn)
  return typeof turn?.id === 'string'
    ? turn.id
    : typeof params?.turnId === 'string'
      ? params.turnId
      : undefined
}

function sse(response: ServerResponse, event: string, data: CodexNativeJsonObject): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
}

async function requestBody(request: IncomingMessage): Promise<CodexNativeJsonObject> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  const object = jsonObject(value)
  if (!object) throw new Error('hook environment upstream received a non-object Responses request')
  return object
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

function pluginHook(listing: CodexNativeJsonObject): HookIdentity {
  if (!Array.isArray(listing.data)) throw new Error('HOOK_ENVIRONMENT_HOOK_LIST_INVALID')
  const matches: HookIdentity[] = []
  for (const entry of listing.data) {
    const group = jsonObject(entry)
    if (!group || !Array.isArray(group.hooks)) throw new Error('HOOK_ENVIRONMENT_HOOK_LIST_INVALID')
    for (const rawHook of group.hooks) {
      const hook = jsonObject(rawHook)
      if (hook?.pluginId !== PLUGIN_ID) continue
      const key = hook.key
      const currentHash = hook.currentHash
      const trustStatus = hook.trustStatus
      if (
        !nonEmptyText(key)
        || !nonEmptyText(currentHash, 1_024)
        || (trustStatus !== 'untrusted' && trustStatus !== 'trusted' && trustStatus !== 'modified' && trustStatus !== 'managed')
      ) throw new Error('HOOK_ENVIRONMENT_HOOK_LIST_INVALID')
      matches.push({ key, currentHash, trustStatus })
    }
  }
  const match = matches[0]
  if (matches.length !== 1 || !match) throw new Error('HOOK_ENVIRONMENT_PLUGIN_HOOK_NOT_FOUND')
  return match
}

function threadId(response: CodexNativeJsonObject): string {
  const thread = jsonObject(response.thread)
  if (!nonEmptyText(thread?.id, 200)) throw new Error('HOOK_ENVIRONMENT_THREAD_START_INVALID')
  return thread.id
}

function turnId(response: CodexNativeJsonObject): string {
  const turn = jsonObject(response.turn)
  if (!nonEmptyText(turn?.id, 200)) throw new Error('HOOK_ENVIRONMENT_TURN_START_INVALID')
  return turn.id
}

function shellQuote(value: string): string {
  if (process.platform === 'win32') return `"${value.replace(/"/g, '\\"')}"`
  return `'${value.replace(/'/g, "'\\''")}'`
}

async function writePluginHook(engineHome: string, probePath: string, resultPath: string): Promise<void> {
  const pluginRoot = path.join(engineHome, 'plugins', 'cache', 'test', 'bb-hook-environment', 'local')
  await mkdir(path.join(pluginRoot, '.codex-plugin'), { recursive: true })
  await mkdir(path.join(pluginRoot, 'hooks'), { recursive: true })
  await writeFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), '{"name":"bb-hook-environment"}\n')
  const command = [process.execPath, probePath, resultPath].map(shellQuote).join(' ')
  await writeFile(path.join(pluginRoot, 'hooks', 'hooks.json'), `${JSON.stringify({
    hooks: {
      UserPromptSubmit: [{
        hooks: [{ type: 'command', command, timeout: 10 }],
      }],
    },
  }, null, 2)}\n`)
  await writeFile(path.join(engineHome, 'config.toml'), `[features]\nplugins = true\nhooks = true\n\n[plugins."${PLUGIN_ID}"]\nenabled = true\n`)
}

async function writeProbe(probePath: string): Promise<void> {
  const source = [
    "import { writeFileSync } from 'node:fs'",
    'const resultPath = process.argv[2]',
    'if (!resultPath) throw new Error(\'missing probe result path\')',
    'const probe = {',
    '  gatewayAdapterToken: Boolean(process.env.BB_CODEX_GATEWAY_ADAPTER_TOKEN),',
    '  personalResponsesAdapterToken: Boolean(process.env.BB_CODEX_PERSONAL_RESPONSES_ADAPTER_TOKEN),',
    '  chatAdapterToken: Boolean(process.env.BB_CODEX_CHAT_ADAPTER_TOKEN),',
    '  pluginRoot: Boolean(process.env.PLUGIN_ROOT),',
    '  pluginData: Boolean(process.env.PLUGIN_DATA),',
    '}',
    "writeFileSync(resultPath, `${JSON.stringify(probe)}\\n`, { encoding: 'utf8', mode: 0o600 })",
  ].join('\n')
  await writeFile(probePath, `${source}\n`, { mode: 0o700 })
}

class Events {
  private readonly completed = new Set<string>()
  private readonly waiters = new Map<string, () => void>()

  notify(notification: CodexNativeNotification): void {
    const id = notificationTurnId(notification)
    if (notification.method !== 'turn/completed' || !id) return
    this.completed.add(id)
    this.waiters.get(id)?.()
    this.waiters.delete(id)
  }

  async waitForTurn(id: string): Promise<void> {
    if (this.completed.has(id)) return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error('HOOK_ENVIRONMENT_TURN_TIMEOUT'))
      }, TURN_TIMEOUT_MS)
      this.waiters.set(id, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function probeResult(value: unknown): ProbeResult {
  const result = jsonObject(value)
  if (!result) throw new Error('HOOK_ENVIRONMENT_PROBE_INVALID')
  const keys: Array<keyof ProbeResult> = [
    'gatewayAdapterToken',
    'personalResponsesAdapterToken',
    'chatAdapterToken',
    'pluginRoot',
    'pluginData',
  ]
  if (!keys.every(key => typeof result[key] === 'boolean')) throw new Error('HOOK_ENVIRONMENT_PROBE_INVALID')
  return {
    gatewayAdapterToken: result.gatewayAdapterToken as boolean,
    personalResponsesAdapterToken: result.personalResponsesAdapterToken as boolean,
    chatAdapterToken: result.chatAdapterToken as boolean,
    pluginRoot: result.pluginRoot as boolean,
    pluginData: result.pluginData as boolean,
  }
}

async function main(): Promise<void> {
  const target = detectCodexEngineTarget()
  const desktopRoot = path.resolve(import.meta.dir, '..')
  const binaryDirectory = path.join(desktopRoot, 'runtime-assets', 'binaries')
  verifyStagedCodexEngine({ destinationDir: binaryDirectory, target, verifyOnly: true })

  let upstreamRequests = 0
  let upstreamAuthorization: string | undefined
  let upstreamBody: CodexNativeJsonObject | undefined
  let upstreamFailure: Error | undefined
  const upstream = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        response.writeHead(404, { 'content-type': 'application/json' })
        response.end('{"error":"not found"}')
        return
      }
      upstreamRequests += 1
      upstreamAuthorization = request.headers.authorization
      upstreamBody = await requestBody(request)
      const item = {
        id: 'msg_billiardbuddy_hook_environment',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: RESPONSE_TEXT }],
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      sse(response, 'response.created', { response: { id: 'resp_billiardbuddy_hook_environment' } })
      sse(response, 'response.output_item.done', { output_index: 0, item })
      sse(response, 'response.completed', {
        response: {
          id: 'resp_billiardbuddy_hook_environment',
          status: 'completed',
          output: [item],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      })
      response.end()
    } catch (error) {
      upstreamFailure = error instanceof Error ? error : new Error(String(error))
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: upstreamFailure.message }))
    }
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('HOOK_ENVIRONMENT_UPSTREAM_ADDRESS_INVALID')

  const workspace = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-hook-environment-workspace-'))
  const engineHome = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-hook-environment-home-'))
  const probePath = path.join(engineHome, 'probe.mjs')
  const resultPath = path.join(engineHome, 'probe-result.json')
  const profile: PersonalModelProfile = {
    id: 'hook-environment-personal-responses',
    label: 'Hook environment local Responses upstream',
    base_url: `http://127.0.0.1:${address.port}/v1`,
    model: MODEL,
    protocol: 'openai-responses',
    auth_mode: 'bearer',
    api_key: 'hook-environment-user-key',
  }
  const events = new Events()
  let provider: StartedCodexNativeProvider | undefined
  let client: CodexNativeAppServerClient | undefined

  try {
    await writeProbe(probePath)
    await writePluginHook(engineHome, probePath, resultPath)
    provider = await startCodexNativeProvider({ kind: 'personal', profile })
    client = new CodexNativeAppServerClient({
      command: [path.join(binaryDirectory, stagedCodexEngineBinaryName(target))],
      engineHome,
      cwd: workspace,
      configOverrides: provider.configOverrides,
      environment: {
        ...provider.environment,
        // These two inert sentinels exercise every current BilliardBuddy
        // adapter-token name without exposing a real capability.
        BB_CODEX_GATEWAY_ADAPTER_TOKEN: 'hook-environment-gateway-sentinel',
        BB_CODEX_CHAT_ADAPTER_TOKEN: 'hook-environment-chat-sentinel',
      },
      onNotification: notification => events.notify(notification),
      onServerRequest: async request => {
        throw new Error(`HOOK_ENVIRONMENT_SERVER_REQUEST_FORBIDDEN:${request.method}`)
      },
    })
    await client.start()

    const initiallyListed = await client.request<CodexNativeJsonObject>('hooks/list', { cwds: [workspace] })
    const hook = pluginHook(initiallyListed)
    if (hook.trustStatus !== 'untrusted') throw new Error('HOOK_ENVIRONMENT_HOOK_NOT_UNTRUSTED')
    await client.request<CodexNativeJsonObject>('config/batchWrite', {
      edits: [{
        keyPath: 'hooks.state',
        value: { [hook.key]: { trusted_hash: hook.currentHash } },
        mergeStrategy: 'upsert',
      }],
      reloadUserConfig: true,
    })
    if (pluginHook(await client.request<CodexNativeJsonObject>('hooks/list', { cwds: [workspace] })).trustStatus !== 'trusted') {
      throw new Error('HOOK_ENVIRONMENT_TRUST_NOT_APPLIED')
    }

    const thread = threadId(await client.request<CodexNativeJsonObject>('thread/start', {
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      model: provider.model,
      modelProvider: 'billiardbuddy',
      sandbox: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
    }))
    const turn = turnId(await client.request<CodexNativeJsonObject>('turn/start', {
      threadId: thread,
      cwd: workspace,
      runtimeWorkspaceRoots: [workspace],
      clientUserMessageId: 'hook-environment-turn',
      input: [{ type: 'text', text: PROMPT, textElements: [] }],
    }))
    await events.waitForTurn(turn)
    if (upstreamFailure) throw upstreamFailure
    if (upstreamRequests !== 1 || upstreamAuthorization !== 'Bearer hook-environment-user-key') {
      throw new Error('HOOK_ENVIRONMENT_PERSONAL_RESPONSES_ROUTE_INVALID')
    }
    if (upstreamBody?.model !== MODEL || !JSON.stringify(upstreamBody).includes(PROMPT)) {
      throw new Error('HOOK_ENVIRONMENT_TURN_NOT_SENT_TO_RESPONSES')
    }

    const observed = probeResult(JSON.parse(await readFile(resultPath, 'utf8')) as unknown)
    const expected: ProbeResult = {
      gatewayAdapterToken: false,
      personalResponsesAdapterToken: false,
      chatAdapterToken: false,
      pluginRoot: true,
      pluginData: true,
    }
    if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error('HOOK_ENVIRONMENT_SANITIZATION_FAILED')
    console.log('[codex-hook-environment] verified patched Hook child token isolation, explicit plugin environment, native trust state and Responses Turn')
  } finally {
    await client?.close().catch(() => undefined)
    await provider?.close().catch(() => undefined)
    await closeServer(upstream).catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
    await rm(engineHome, { recursive: true, force: true })
  }
}

await main()
