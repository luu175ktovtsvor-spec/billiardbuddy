/**
 * Explicit, paid acceptance probe for a user-selected personal provider.
 *
 * This is intentionally separate from test and CI. It starts the production
 * Electron Main runtime with an empty workspace and temporary CODEX_HOME,
 * sends only fixed text prompts, rejects every server request, and destroys
 * the temporary state afterwards. The actual API key never reaches Rust or
 * stdout: the local credential adapter receives it only in this Bun process.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ElectronCodexNativeRuntime,
  type CodexNativeJsonObject,
  type CodexNativeNotification,
  type CodexNativeServerRequest,
  type NativeCodexThread,
  type NativeCodexTurn,
} from '../electron/services/codexNativeAppServer'
import { EphemeralCredentialStore } from '../electron/services/keychain'
import { ProviderCredentialService } from '../electron/services/providerCredentials'
import {
  type PersonalModelAuthMode,
  type PersonalModelProfile,
  type PersonalModelProtocol,
} from '../../shared/product/personalModels'

const MIN_TURNS = 2
const MAX_TURNS = 16
const DEFAULT_TURNS = 2
const MIN_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_TIMEOUT_MS = 120_000

type HostNetwork = {
  fetchImpl?: typeof fetch
}

async function hostNetwork(): Promise<HostNetwork> {
  if (!process.versions.electron) return {}
  const { app, net } = await import('electron')
  await app.whenReady()
  return {
    fetchImpl: (input, init) => net.fetch(input instanceof URL ? input.toString() : input, init),
  }
}

async function finish(code: number): Promise<void> {
  if (process.versions.electron) {
    const { app } = await import('electron')
    app.exit(code)
    return
  }
  if (code !== 0) process.exitCode = code
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`BILLIARDBUDDY_REAL_PROVIDER_SMOKE_MISSING_${name}`)
  return value
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  if (!/^[0-9]+$/.test(raw)) throw new Error(`BILLIARDBUDDY_REAL_PROVIDER_SMOKE_INVALID_${name}`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`BILLIARDBUDDY_REAL_PROVIDER_SMOKE_INVALID_${name}`)
  }
  return value
}

function protocol(value: string): PersonalModelProtocol {
  if (value === 'openai-responses' || value === 'openai-compatible') return value
  throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_PROTOCOL_UNSUPPORTED')
}

function authMode(value: string | undefined): PersonalModelAuthMode {
  if (value === undefined || value === '' || value === 'bearer') return 'bearer'
  if (value === 'x-api-key' || value === 'api-key') return value
  throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_AUTH_MODE_UNSUPPORTED')
}

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

function completedTurnStatus(notification: CodexNativeNotification): string | undefined {
  const params = jsonObject(notification.params)
  const turn = jsonObject(params?.turn)
  return typeof turn?.status === 'string' ? turn.status : undefined
}

function agentMessageText(notification: CodexNativeNotification): string | undefined {
  if (notification.method !== 'item/completed') return undefined
  const item = jsonObject(jsonObject(notification.params)?.item)
  return item?.type === 'agentMessage' && typeof item.text === 'string' ? item.text : undefined
}

/** Keep paid smoke failures classified without printing provider diagnostics. */
function safeCodexErrorCode(error: CodexNativeJsonObject | undefined): string {
  const direct = error?.code
  if (typeof direct === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(direct)) return direct
  if (typeof direct === 'number' && Number.isSafeInteger(direct)) return `CODE_${direct}`
  const info = jsonObject(error?.codexErrorInfo)
  if (typeof error?.codexErrorInfo === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(error.codexErrorInfo)) {
    return error.codexErrorInfo.toUpperCase()
  }
  if (info) {
    const variant = Object.keys(info).find(key => /^[A-Za-z0-9_-]{1,96}$/.test(key))
    if (variant) {
      const status = info[variant]
      if (status && typeof status === 'object' && !Array.isArray(status)) {
        const httpStatusCode = (status as CodexNativeJsonObject).httpStatusCode
        if (typeof httpStatusCode === 'number' && Number.isSafeInteger(httpStatusCode)) {
          return `${variant.toUpperCase()}_HTTP_${httpStatusCode}`
        }
      }
      return variant.toUpperCase()
    }
  }
  return 'UNCLASSIFIED'
}

class RuntimeEvents {
  private readonly completed = new Map<string, string | undefined>()
  private readonly failures = new Map<string, string>()
  private readonly turnWaiters = new Map<string, () => void>()
  private readonly agentMessages = new Map<string, string[]>()
  readonly serverRequests: string[] = []

  notify(notification: CodexNativeNotification): void {
    const turnId = notificationTurnId(notification)
    const text = agentMessageText(notification)
    if (turnId && text !== undefined) {
      const messages = this.agentMessages.get(turnId) ?? []
      messages.push(text)
      this.agentMessages.set(turnId, messages)
    }
    if (notification.method === 'turn/completed' && turnId) {
      this.completed.set(turnId, completedTurnStatus(notification))
      this.turnWaiters.get(turnId)?.()
      this.turnWaiters.delete(turnId)
      return
    }
    if (notification.method === 'error' && turnId) {
      const params = jsonObject(notification.params)
      const error = jsonObject(params?.error)
      const code = safeCodexErrorCode(error)
      this.failures.set(turnId, code)
      this.turnWaiters.get(turnId)?.()
      this.turnWaiters.delete(turnId)
    }
  }

  rejectServerRequest(request: CodexNativeServerRequest): never {
    this.serverRequests.push(request.method)
    throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_SERVER_REQUEST_FORBIDDEN')
  }

  async waitForCompletedTurn(turn: NativeCodexTurn, timeoutMs: number): Promise<void> {
    if (!this.completed.has(turn.id)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.turnWaiters.delete(turn.id)
          reject(new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_TURN_TIMEOUT'))
        }, timeoutMs)
        this.turnWaiters.set(turn.id, () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    const failure = this.failures.get(turn.id)
    if (failure) throw new Error(`BILLIARDBUDDY_REAL_PROVIDER_SMOKE_TURN_ERROR_${failure}`)
    const status = this.completed.get(turn.id)
    if (status !== 'completed') {
      const safeStatus = typeof status === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(status)
        ? status.toUpperCase()
        : 'UNKNOWN'
      throw new Error(`BILLIARDBUDDY_REAL_PROVIDER_SMOKE_TURN_STATUS_${safeStatus}`)
    }
  }

  assertExactAgentMessage(turn: NativeCodexTurn, marker: string): void {
    if (!this.agentMessages.get(turn.id)?.some(message => message.trim() === marker)) {
      throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_MARKER_MISSING')
    }
  }
}

function assertThreadRead(value: CodexNativeJsonObject, expectedId: string): void {
  const thread = jsonObject(value.thread)
  if (thread?.id !== expectedId) throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_THREAD_READ_INVALID')
}

function marker(index: number): string {
  return `BILLIARDBUDDY_REAL_PROVIDER_TURN_${index}_OK`
}

function prompt(index: number): string {
  const expected = marker(index)
  return [
    'This is a controlled provider compatibility probe.',
    `Reply with exactly ${expected} and no other text.`,
    'Do not call tools, access files, open a browser, request approval, or use external resources.',
  ].join(' ')
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const safeCodes = [
    /BILLIARDBUDDY_REAL_PROVIDER_SMOKE_[A-Z0-9_]+/,
    /PERSONAL_MODEL_[A-Z0-9_]+/,
    /CODEX_[A-Z0-9_]+/,
    /NATIVE_[A-Z0-9_]+/,
  ]
  for (const pattern of safeCodes) {
    const code = message.match(pattern)?.[0]
    if (code) return code
  }
  return 'BILLIARDBUDDY_REAL_PROVIDER_SMOKE_FAILED'
}

async function main(): Promise<void> {
  const turns = boundedInteger('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_TURNS', DEFAULT_TURNS, MIN_TURNS, MAX_TURNS)
  const timeoutMs = boundedInteger('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  if (process.env.BILLIARDBUDDY_REAL_PROVIDER_SMOKE !== '1') {
    throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_DISABLED')
  }
  if (process.env.BILLIARDBUDDY_REAL_PROVIDER_SMOKE_CONFIRMATION !== `RUN_BILLABLE_PERSONAL_AGENT_TURNS_${turns}`) {
    throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_CONFIRMATION_REQUIRED')
  }
  const host = await hostNetwork()

  const requestedProfile = {
    label: 'BilliardBuddy real provider smoke',
    base_url: requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_BASE_URL'),
    model: requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_MODEL'),
    protocol: protocol(requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_PROTOCOL')),
    auth_mode: authMode(process.env.BILLIARDBUDDY_REAL_PROVIDER_AUTH_MODE?.trim()),
    api_key: requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_API_KEY'),
  }
  const credentials = new ProviderCredentialService(new EphemeralCredentialStore())
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const workspace = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-real-provider-workspace-'))
  const userDataPath = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-real-provider-user-data-'))
  const events = new RuntimeEvents()
  const createRuntime = () => new ElectronCodexNativeRuntime({
    desktopRoot,
    userDataPath,
    fetchImpl: host.fetchImpl,
    onNotification: notification => events.notify(notification),
    onServerRequest: async request => events.rejectServerRequest(request),
  })
  let runtime: ElectronCodexNativeRuntime | undefined
  let profile: PersonalModelProfile | undefined
  const turnIds: string[] = []

  try {
    // Mirror the Main-process startup order: save the user-owned connection,
    // select it, then resolve the active profile for the native Agent route.
    const saved = credentials.save({ id: 'realprovidersmoke', ...requestedProfile })
    if (saved.active_profile_id !== 'realprovidersmoke') {
      throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_PROFILE_NOT_SELECTED')
    }
    profile = credentials.agentTextReasoningProfile() ?? undefined
    if (!profile) throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_PROFILE_NOT_READ_BACK')
    const route = { kind: 'personal' as const, profile }

    runtime = createRuntime()
    let thread = await runtime.startThread({ cwd: workspace, route, permissionMode: 'ask' })
    for (let index = 1; index <= turns; index += 1) {
      if (index === 2) {
        await runtime.close()
        runtime = createRuntime()
        const resumed: NativeCodexThread = await runtime.resumeThread({ threadId: thread.id, cwd: workspace, route })
        if (resumed.id !== thread.id) throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_THREAD_RESUME_INVALID')
        thread = resumed
      }
      const turn = await runtime.startTurn(thread, [{ type: 'text', text: prompt(index) }], `real-provider-smoke-turn-${index}`)
      turnIds.push(turn.id)
      await events.waitForCompletedTurn(turn, timeoutMs)
      console.log(`BILLIARDBUDDY_REAL_PROVIDER_STAGE=turn_${index}_completed`)
      events.assertExactAgentMessage(turn, marker(index))
      if (events.serverRequests.length > 0) throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_SERVER_REQUEST_FORBIDDEN')
    }
    assertThreadRead(await runtime.readThread(thread), thread.id)
    const history = await runtime.listThreadTurns(thread, { limit: turns, itemsView: 'summary' })
    const serializedHistory = JSON.stringify(history)
    for (const turnId of turnIds) {
      if (!serializedHistory.includes(turnId)) {
        throw new Error('BILLIARDBUDDY_REAL_PROVIDER_SMOKE_HISTORY_UNVERIFIED')
      }
    }
    console.log(`[codex-runtime-real-provider] passed ${turns} billable text-only Turns with Rust Thread resume and no tool approval`)
  } finally {
    await runtime?.close().catch(() => undefined)
    if (profile) {
      try { credentials.remove(profile.id) } catch { /* cleanup must not hide the smoke failure */ }
    }
    await rm(workspace, { recursive: true, force: true })
    await rm(userDataPath, { recursive: true, force: true })
  }
}

try {
  await main()
  await finish(0)
} catch (error) {
  // A provider may return arbitrary diagnostic text. Keep a paid-test failure
  // useful without ever echoing a credential or provider response to stdout.
  console.error(`[codex-runtime-real-provider] failed ${safeFailureCode(error)}`)
  await finish(1)
}
