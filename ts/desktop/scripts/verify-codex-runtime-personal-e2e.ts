/**
 * Local, credential-free acceptance probe for the real Electron Main runtime.
 *
 * The temporary upstream only returns a source-shaped Responses stream. The
 * test still launches the verified Rust App Server through the production
 * runtime and checks Rust-owned Thread/Turn completion and resume after the
 * request crossed the loopback credential adapter.
 */
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ElectronCodexNativeRuntime,
  type CodexNativeJsonObject,
  type CodexNativeNotification,
  type NativeCodexThread,
  type NativeCodexTurn,
} from '../electron/services/codexNativeAppServer'
import type { PersonalModelProfile } from '../../shared/product/personalModels'

const TURN_TIMEOUT_MS = 30_000
const MODEL = 'billiardbuddy-runtime-e2e-model'
const PROMPT = 'Reply with exactly BILLIARDBUDDY-RUNTIME-E2E-OK. Do not call tools.'
const RESPONSE_TEXT = 'BILLIARDBUDDY-RUNTIME-E2E-OK'

function jsonObject(value: unknown): CodexNativeJsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as CodexNativeJsonObject
    : undefined
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
  if (!object) throw new Error('local upstream received a non-object Responses request')
  return object
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()))
}

class RuntimeEvents {
  private readonly completed = new Set<string>()
  private readonly failures = new Map<string, Error>()
  private readonly waiters = new Map<string, { resolve(): void, reject(error: Error): void }>()
  readonly notifications: CodexNativeNotification[] = []

  notify(notification: CodexNativeNotification): void {
    this.notifications.push(notification)
    const turnId = notificationTurnId(notification)
    if (notification.method === 'turn/completed' && turnId) {
      this.completed.add(turnId)
      this.waiters.get(turnId)?.resolve()
      this.waiters.delete(turnId)
      return
    }
    if (notification.method === 'error' && turnId) {
      const params = jsonObject(notification.params)
      const error = jsonObject(params?.error)
      const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message
        : 'Rust App Server reported an unclassified Turn error'
      const details = typeof params?.additionalDetails === 'string' && params.additionalDetails.trim()
        ? `; ${params.additionalDetails}`
        : typeof error?.additionalDetails === 'string' && error.additionalDetails.trim()
          ? `; ${error.additionalDetails}`
          : ''
      const failure = new Error(`native turn ${turnId} failed: ${message}${details}`)
      this.failures.set(turnId, failure)
      this.waiters.get(turnId)?.reject(failure)
      this.waiters.delete(turnId)
    }
  }

  async waitForTurn(turn: NativeCodexTurn): Promise<void> {
    if (this.completed.has(turn.id)) return
    const failure = this.failures.get(turn.id)
    if (failure) throw failure
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(turn.id)
        reject(new Error(`native turn ${turn.id} did not complete`))
      }, TURN_TIMEOUT_MS)
      this.waiters.set(turn.id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        },
      })
    })
  }
}

function assertThreadRead(value: CodexNativeJsonObject, expectedId: string): void {
  const thread = jsonObject(value.thread)
  if (thread?.id !== expectedId) throw new Error('Rust Thread Store returned an unexpected Thread')
}

function hasResponseText(notification: CodexNativeNotification): boolean {
  return JSON.stringify(notification.params ?? null).includes(RESPONSE_TEXT)
}

async function main(): Promise<void> {
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
      const responseId = `resp_billiardbuddy_runtime_${upstreamRequests}`
      const item = {
        id: `msg_billiardbuddy_runtime_${upstreamRequests}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: RESPONSE_TEXT }],
      }
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' })
      sse(response, 'response.created', { response: { id: responseId } })
      sse(response, 'response.output_item.done', { output_index: 0, item })
      sse(response, 'response.completed', {
        response: {
          id: responseId,
          status: 'completed',
          output: [item],
          usage: {
            input_tokens: 0,
            input_tokens_details: null,
            output_tokens: 0,
            output_tokens_details: null,
            total_tokens: 0,
          },
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
  if (!address || typeof address === 'string') throw new Error('local Responses upstream address is invalid')

  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const workspace = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-runtime-e2e-workspace-'))
  const userDataPath = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-runtime-e2e-user-data-'))
  const profile: PersonalModelProfile = {
    id: 'runtime-e2e-personal-responses',
    label: 'Runtime E2E local Responses upstream',
    base_url: `http://localhost:${address.port}/v1`,
    model: MODEL,
    protocol: 'openai-responses',
    auth_mode: 'bearer',
    api_key: 'runtime-e2e-user-key',
  }
  const route = { kind: 'personal' as const, profile }
  const events = new RuntimeEvents()
  const makeRuntime = () => new ElectronCodexNativeRuntime({
    desktopRoot,
    userDataPath,
    onNotification: notification => events.notify(notification),
  })
  let runtime: ElectronCodexNativeRuntime | undefined

  try {
    runtime = makeRuntime()
    const thread = await runtime.startThread({ cwd: workspace, route, permissionMode: 'ask' })
    const turn = await runtime.startTurn(thread, [{ type: 'text', text: PROMPT }], 'runtime-e2e-turn')
    await events.waitForTurn(turn)
    if (upstreamFailure) throw upstreamFailure
    if (upstreamRequests !== 1) throw new Error(`expected one selected-upstream request, received ${upstreamRequests}`)
    if (upstreamAuthorization !== 'Bearer runtime-e2e-user-key') throw new Error('personal key did not reach the selected upstream')
    if (upstreamBody?.model !== MODEL || !JSON.stringify(upstreamBody).includes(PROMPT)) {
      throw new Error('Rust App Server did not send the selected model and Turn input through the Responses route')
    }
    if (!events.notifications.some(hasResponseText)) throw new Error('native result text did not return through App Server notifications')
    assertThreadRead(await runtime.readThread(thread), thread.id)
    await runtime.close()
    runtime = undefined

    // A new Main-owned runtime must recover the same Rust-owned Thread Store,
    // not a renderer or provider-side session mirror.
    runtime = makeRuntime()
    const resumed: NativeCodexThread = await runtime.resumeThread({ threadId: thread.id, cwd: workspace, route })
    if (resumed.id !== thread.id) throw new Error('source-native Thread resume changed the Thread id')
    assertThreadRead(await runtime.readThread(resumed), thread.id)
    console.log('[codex-runtime-personal-e2e] verified Electron Main -> credential adapter -> Rust App Server -> selected Responses upstream -> notification result -> Thread resume')
  } finally {
    await runtime?.close().catch(() => undefined)
    await closeServer(upstream).catch(() => undefined)
    await rm(workspace, { recursive: true, force: true })
    await rm(userDataPath, { recursive: true, force: true })
  }
}

await main()
