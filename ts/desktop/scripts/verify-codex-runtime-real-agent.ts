/**
 * Explicit, paid acceptance probe for a real personal Agent workflow.
 *
 * This is deliberately separate from CI. It uses the production Electron Main
 * runtime with a temporary Rust CODEX_HOME and temporary workspace, allows one
 * harmless command, deliberately declines one network command, and never
 * prints the supplied provider key or provider diagnostics. The provider
 * protocol is selected by the environment so the same workflow can validate
 * native Responses and the Chat adapter.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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

const MIN_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_TIMEOUT_MS = 150_000
const TOOL_ONE_MARKER = 'BILLIARDBUDDY_AGENT_TOOL_ONE_OK'
const RESPONSE_ONE_MARKER = 'BILLIARDBUDDY_AGENT_RESPONSE_ONE_OK'
const RESPONSE_TWO_MARKER = 'BILLIARDBUDDY_AGENT_RESPONSE_TWO_OK'
const DENIED_COMMAND = 'curl -I https://example.com'

type HostNetwork = { fetchImpl?: typeof fetch }

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
  if (!value) throw new Error(`BILLIARDBUDDY_REAL_AGENT_MISSING_${name}`)
  return value
}

function protocol(value: string): PersonalModelProtocol {
  if (value === 'openai-responses' || value === 'openai-compatible') return value
  throw new Error('BILLIARDBUDDY_REAL_AGENT_PROTOCOL_UNSUPPORTED')
}

function authMode(value: string | undefined): PersonalModelAuthMode {
  if (value === undefined || value === '' || value === 'bearer') return 'bearer'
  if (value === 'x-api-key' || value === 'api-key') return value
  throw new Error('BILLIARDBUDDY_REAL_AGENT_AUTH_MODE_UNSUPPORTED')
}

function boundedTimeout(): number {
  const raw = process.env.BILLIARDBUDDY_REAL_PROVIDER_SMOKE_TIMEOUT_MS?.trim()
  if (!raw) return DEFAULT_TIMEOUT_MS
  if (!/^[0-9]+$/.test(raw)) throw new Error('BILLIARDBUDDY_REAL_AGENT_TIMEOUT_INVALID')
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw new Error('BILLIARDBUDDY_REAL_AGENT_TIMEOUT_INVALID')
  }
  return value
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
  const turn = jsonObject(jsonObject(notification.params)?.turn)
  return typeof turn?.status === 'string' ? turn.status : undefined
}

function agentMessageText(notification: CodexNativeNotification): string | undefined {
  if (notification.method !== 'item/completed') return undefined
  const item = jsonObject(jsonObject(notification.params)?.item)
  return item?.type === 'agentMessage' && typeof item.text === 'string' ? item.text : undefined
}

/**
 * App Server v2 reports turn failures as `error.codexErrorInfo`, not as an
 * HTTP-style `error.code`. Keep the paid probe useful without echoing provider
 * messages, URLs, request bodies, or credentials.
 */
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

function itemType(notification: CodexNativeNotification): string | undefined {
  return jsonObject(jsonObject(notification.params)?.item)?.type as string | undefined
}

function commandText(value: unknown): string {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ')
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) return ''
  return value.join(' ').trim().replace(/\s+/g, ' ')
}

function commandFromNotification(notification: CodexNativeNotification): string {
  const item = jsonObject(jsonObject(notification.params)?.item)
  return commandText(item?.command)
}

function commandFromRequest(request: CodexNativeServerRequest): string {
  return commandText(jsonObject(request.params)?.command)
}

function safeCommand(command: string, marker: string): boolean {
  const normalized = normalizeShellCommand(command)
  return new RegExp(`^(?:(?:\/usr\/bin\/)?printf|printf) ['"]?${marker}['"]?$`).test(normalized)
}

function normalizeShellCommand(command: string): string {
  return command
    .replace(/^\s*(?:\/bin\/)?(?:bash|sh|zsh)\s+-lc\s+/, '')
    .replace(/^['"]|['"]$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
}

function deniedCommand(command: string): boolean {
  return normalizeShellCommand(command) === DENIED_COMMAND
}

class AgentEvents {
  private readonly completed = new Map<string, string | undefined>()
  private readonly failures = new Map<string, string>()
  private readonly waiters = new Map<string, () => void>()
  private readonly messages = new Map<string, string[]>()
  private readonly commandStarted = new Map<string, string[]>()
  private readonly commandCompleted = new Map<string, string[]>()
  private readonly deniedCommandExecutions = new Set<string>()
  readonly approvals: string[] = []
  readonly approvalRequests: string[] = []
  readonly unexpectedCommands: string[] = []
  readonly methods = new Set<string>()

  notify(notification: CodexNativeNotification): void {
    this.methods.add(notification.method)
    const turnId = notificationTurnId(notification)
    if (!turnId) return
    const text = agentMessageText(notification)
    if (text !== undefined) {
      const messages = this.messages.get(turnId) ?? []
      messages.push(text)
      this.messages.set(turnId, messages)
    }
    if (notification.method === 'item/started' && itemType(notification) === 'commandExecution') {
      const commands = this.commandStarted.get(turnId) ?? []
      commands.push(commandFromNotification(notification))
      this.commandStarted.set(turnId, commands)
    }
    if (notification.method === 'item/completed' && itemType(notification) === 'commandExecution') {
      const item = jsonObject(jsonObject(notification.params)?.item)
      const command = commandFromNotification(notification)
      const commands = this.commandCompleted.get(turnId) ?? []
      commands.push(command)
      this.commandCompleted.set(turnId, commands)
      if (deniedCommand(command) && item?.status === 'completed') this.deniedCommandExecutions.add(turnId)
    }
    if (notification.method === 'turn/completed') {
      this.completed.set(turnId, completedTurnStatus(notification))
      this.waiters.get(turnId)?.()
      this.waiters.delete(turnId)
      return
    }
    if (notification.method === 'error') {
      const error = jsonObject(jsonObject(notification.params)?.error)
      const code = safeCodexErrorCode(error)
      this.failures.set(turnId, code)
      this.waiters.get(turnId)?.()
      this.waiters.delete(turnId)
    }
  }

  async handleServerRequest(request: CodexNativeServerRequest): Promise<CodexNativeJsonObject> {
    if (request.method !== 'item/commandExecution/requestApproval') {
      throw new Error('BILLIARDBUDDY_REAL_AGENT_SERVER_REQUEST_UNEXPECTED')
    }
    const command = commandFromRequest(request)
    if (safeCommand(command, TOOL_ONE_MARKER)) {
      this.approvals.push(command)
      return { decision: 'accept' }
    }
    if (deniedCommand(command)) {
      this.approvalRequests.push(command)
      return { decision: 'decline' }
    }
    this.unexpectedCommands.push(command)
    return { decision: 'decline' }
  }

  async waitForCompletedTurn(turn: NativeCodexTurn, timeoutMs: number): Promise<void> {
    if (!this.completed.has(turn.id)) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiters.delete(turn.id)
          reject(new Error('BILLIARDBUDDY_REAL_AGENT_TURN_TIMEOUT'))
        }, timeoutMs)
        this.waiters.set(turn.id, () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
    const failure = this.failures.get(turn.id)
    if (failure) throw new Error(`BILLIARDBUDDY_REAL_AGENT_TURN_ERROR_${failure}`)
    if (this.completed.get(turn.id) !== 'completed') throw new Error('BILLIARDBUDDY_REAL_AGENT_TURN_NOT_COMPLETED')
  }

  assertMarker(turn: NativeCodexTurn, marker: string): void {
    if (!this.messages.get(turn.id)?.some(message => message.trim() === marker)) {
      throw new Error('BILLIARDBUDDY_REAL_AGENT_MARKER_MISSING')
    }
  }

  assertCommand(turn: NativeCodexTurn, marker: string): void {
    const started = this.commandStarted.get(turn.id) ?? []
    const completed = this.commandCompleted.get(turn.id) ?? []
    if (!started.some(command => safeCommand(command, marker)) || !completed.some(command => safeCommand(command, marker))) {
      throw new Error('BILLIARDBUDDY_REAL_AGENT_COMMAND_LIFECYCLE_MISSING')
    }
  }

  assertNoUnexpectedCommands(): void {
    if (this.unexpectedCommands.length > 0) throw new Error('BILLIARDBUDDY_REAL_AGENT_UNEXPECTED_COMMAND')
  }

  assertApprovalRequest(): void {
    if (this.approvalRequests.length === 0) throw new Error('BILLIARDBUDDY_REAL_AGENT_APPROVAL_NOT_REQUESTED')
    if (this.deniedCommandExecutions.size > 0) throw new Error('BILLIARDBUDDY_REAL_AGENT_DENIED_COMMAND_EXECUTED')
  }
}

function promptOne(): string {
  return [
    'Act as a coding agent in the current temporary workspace.',
    `Run exactly one shell command: printf '${TOOL_ONE_MARKER}'.`,
    'Do not run any other command, do not access the network, and do not edit files.',
    `After the command succeeds, reply with exactly ${RESPONSE_ONE_MARKER} and no other text.`,
  ].join(' ')
}

function promptTwo(): string {
  return [
    'Continue the coding-agent task in the same workspace after the application was restarted.',
    `Request exactly one shell command: ${DENIED_COMMAND}. The desktop client will decline this request, so do not execute it or retry it.`,
    'Do not run any other command and do not edit files.',
    `After the command succeeds, reply with exactly ${RESPONSE_TWO_MARKER} and no other text.`,
  ].join(' ')
}

function safeFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  const patterns = [
    /BILLIARDBUDDY_REAL_AGENT_[A-Z0-9_]+/,
    /PERSONAL_MODEL_[A-Z0-9_]+/,
    /CODEX_[A-Z0-9_]+/,
    /NATIVE_[A-Z0-9_]+/,
  ]
  for (const pattern of patterns) {
    const code = message.match(pattern)?.[0]
    if (code) return code
  }
  return 'BILLIARDBUDDY_REAL_AGENT_FAILED'
}

async function main(): Promise<void> {
  if (process.env.BILLIARDBUDDY_REAL_PROVIDER_SMOKE !== '1') {
    throw new Error('BILLIARDBUDDY_REAL_AGENT_DISABLED')
  }
  if (process.env.BILLIARDBUDDY_REAL_PROVIDER_SMOKE_CONFIRMATION !== 'RUN_BILLABLE_PERSONAL_AGENT_TOOL_TURNS_2') {
    throw new Error('BILLIARDBUDDY_REAL_AGENT_CONFIRMATION_REQUIRED')
  }
  const host = await hostNetwork()
  const requestedProfile = {
    label: 'BilliardBuddy real Agent tool smoke',
    base_url: requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_BASE_URL'),
    model: requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_MODEL'),
    protocol: protocol(requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_PROTOCOL')),
    auth_mode: authMode(process.env.BILLIARDBUDDY_REAL_PROVIDER_AUTH_MODE?.trim()),
    api_key: requiredEnvironment('BILLIARDBUDDY_REAL_PROVIDER_API_KEY'),
  }
  const credentials = new ProviderCredentialService(new EphemeralCredentialStore())
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const workspace = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-real-agent-workspace-'))
  const userDataPath = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-real-agent-user-data-'))
  const fixture = path.join(workspace, 'agent-file-search-fixture.txt')
  await writeFile(fixture, 'BILLIARDBUDDY_AGENT_FILE_SEARCH_OK\n', 'utf8')
  const events = new AgentEvents()
  const createRuntime = () => new ElectronCodexNativeRuntime({
    desktopRoot,
    userDataPath,
    fetchImpl: host.fetchImpl,
    onNotification: notification => events.notify(notification),
    onServerRequest: request => events.handleServerRequest(request),
  })
  let runtime: ElectronCodexNativeRuntime | undefined
  let profile: PersonalModelProfile | undefined
  const turnIds: string[] = []

  try {
    const saved = credentials.save({ id: 'realagentsmoke', ...requestedProfile })
    if (saved.active_profile_id !== 'realagentsmoke') throw new Error('BILLIARDBUDDY_REAL_AGENT_PROFILE_NOT_SELECTED')
    profile = credentials.agentTextReasoningProfile() ?? undefined
    if (!profile) throw new Error('BILLIARDBUDDY_REAL_AGENT_PROFILE_NOT_READ_BACK')
    const route = { kind: 'personal' as const, profile }

    runtime = createRuntime()
    let thread: NativeCodexThread = await runtime.startThread({ cwd: workspace, route, permissionMode: 'ask' })
    const fileSearch = await runtime.searchWorkspaceFiles(thread, 'agent-file-search-fixture')
    if (!fileSearch.files.some(file => file.path === fixture || file.fileName === 'agent-file-search-fixture.txt')) {
      throw new Error('BILLIARDBUDDY_REAL_AGENT_FILE_SEARCH_MISSING')
    }
    console.log('BILLIARDBUDDY_REAL_AGENT_STAGE=file_search_passed')

    const firstTurn = await runtime.startTurn(thread, [{ type: 'text', text: promptOne() }], 'real-agent-tool-turn-1')
    turnIds.push(firstTurn.id)
    await events.waitForCompletedTurn(firstTurn, boundedTimeout())
    events.assertCommand(firstTurn, TOOL_ONE_MARKER)
    events.assertMarker(firstTurn, RESPONSE_ONE_MARKER)
    events.assertNoUnexpectedCommands()
    console.log(`BILLIARDBUDDY_REAL_AGENT_STAGE=turn_1_completed approvals=${events.approvals.length}`)

    await runtime.close()
    runtime = createRuntime()
    thread = await runtime.resumeThread({ threadId: thread.id, cwd: workspace, route })
    const secondTurn = await runtime.startTurn(thread, [{ type: 'text', text: promptTwo() }], 'real-agent-tool-turn-2')
    turnIds.push(secondTurn.id)
    await events.waitForCompletedTurn(secondTurn, boundedTimeout())
    events.assertMarker(secondTurn, RESPONSE_TWO_MARKER)
    events.assertApprovalRequest()
    events.assertNoUnexpectedCommands()
    console.log(`BILLIARDBUDDY_REAL_AGENT_STAGE=turn_2_completed approval_requests=${events.approvalRequests.length}`)

    const history = JSON.stringify(await runtime.listThreadTurns(thread, { limit: 2, itemsView: 'summary' }))
    for (const turnId of turnIds) {
      if (!history.includes(turnId)) throw new Error('BILLIARDBUDDY_REAL_AGENT_HISTORY_MISSING')
    }
    console.log(`[codex-runtime-real-agent] passed file search, two native tool Turns, approval bridge, Thread resume, and history for ${requestedProfile.protocol}`)
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
  console.error(`[codex-runtime-real-agent] failed ${safeFailureCode(error)}`)
  await finish(1)
}
