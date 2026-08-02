/**
 * Explicit, paid acceptance probe for the BilliardBuddy-managed Codex route.
 *
 * It intentionally has no default credentials and is never part of build or
 * CI. The caller must inject a short-lived Gateway access bearer, obtained by
 * the desktop installation-session flow, and must revoke it afterwards.
 *
 * This exercises the same Electron Main runtime that the desktop uses:
 * Rust App Server -> loopback capability adapter -> BilliardBuddy Gateway ->
 * managed DeepSeek Responses. It does not start Electron or touch Renderer.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ElectronCodexNativeRuntime,
  type CodexNativeJsonObject,
  type CodexNativeNotification,
  type CodexNativeServerRequest,
  type NativeCodexTurn,
} from '../electron/services/codexNativeAppServer'
import { textReasoningRegistryEntry } from '../../../gateway/providerRegistry'

const TURN_TIMEOUT_MS = 120_000
const TOOL_TIMEOUT_MS = 90_000

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`missing ${name}`)
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
  if (typeof turn?.id === 'string') return turn.id
  return typeof params?.turnId === 'string' ? params.turnId : undefined
}

function commandExecutionStarted(notification: CodexNativeNotification): boolean {
  if (notification.method !== 'item/started') return false
  const item = jsonObject(jsonObject(notification.params)?.item)
  return item?.type === 'commandExecution'
}

class LiveEvents {
  private readonly completedTurns = new Set<string>()
  private readonly commandStarts = new Set<string>()
  private readonly turnWaiters = new Map<string, () => void>()
  private readonly commandWaiters = new Map<string, () => void>()
  readonly methods = new Set<string>()
  readonly approvalMethods = new Set<string>()

  notify(notification: CodexNativeNotification): void {
    this.methods.add(notification.method)
    const turnId = notificationTurnId(notification)
    if (notification.method === 'turn/completed' && turnId) {
      this.completedTurns.add(turnId)
      this.turnWaiters.get(turnId)?.()
      this.turnWaiters.delete(turnId)
    }
    if (commandExecutionStarted(notification) && turnId) {
      this.commandStarts.add(turnId)
      this.commandWaiters.get(turnId)?.()
      this.commandWaiters.delete(turnId)
    }
  }

  approve(request: CodexNativeServerRequest): CodexNativeJsonObject {
    if (
      request.method !== 'item/commandExecution/requestApproval'
      && request.method !== 'item/fileChange/requestApproval'
    ) throw new Error(`unexpected native server request: ${request.method}`)
    this.approvalMethods.add(request.method)
    return { decision: 'accept' }
  }

  async waitForTurn(turn: NativeCodexTurn, timeout = TURN_TIMEOUT_MS): Promise<void> {
    if (this.completedTurns.has(turn.id)) return
    await this.wait(this.turnWaiters, turn.id, timeout, 'turn did not complete')
  }

  async waitForCommand(turn: NativeCodexTurn): Promise<void> {
    if (this.commandStarts.has(turn.id)) return
    await this.wait(this.commandWaiters, turn.id, TOOL_TIMEOUT_MS, 'tool command did not start')
  }

  private async wait(waiters: Map<string, () => void>, id: string, timeout: number, failure: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id)
        reject(new Error(failure))
      }, timeout)
      waiters.set(id, () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}

function assertThreadRead(value: CodexNativeJsonObject, expectedId: string): void {
  const thread = jsonObject(value.thread)
  if (thread?.id !== expectedId) throw new Error('Rust Thread Store returned an unexpected Thread')
}

async function main(): Promise<void> {
  const gatewayUrl = requiredEnvironment('BB_LIVE_GATEWAY_URL')
  const accessToken = requiredEnvironment('BB_LIVE_GATEWAY_ACCESS_TOKEN')
  const model = process.env.BB_LIVE_MODEL?.trim() || 'deepseek-v4-flash'
  const entry = textReasoningRegistryEntry(model)
  if (!entry || entry.provider !== 'deepseek' || entry.text_reasoning_transport !== 'responses') {
    throw new Error('BB_LIVE_MODEL must be a managed DeepSeek Responses model')
  }
  const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const workspace = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-native-live-workspace-'))
  const approvalWorkspace = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-native-live-approval-'))
  const userDataPath = await mkdtemp(path.join(tmpdir(), 'billiardbuddy-native-live-user-data-'))
  const events = new LiveEvents()
  const route = {
    kind: 'managed' as const,
    gatewayUrl,
    resolveAccessToken: async () => accessToken,
    model,
    contextWindowTokens: entry.verified_context_window,
  }
  const createRuntime = () => new ElectronCodexNativeRuntime({
    desktopRoot,
    userDataPath,
    onNotification: notification => events.notify(notification),
    onServerRequest: async request => events.approve(request),
  })
  let runtime: ElectronCodexNativeRuntime | undefined

  try {
    runtime = createRuntime()
    const thread = await runtime.startThread({ cwd: workspace, route, permissionMode: 'ask' })
    console.log('NATIVE_MANAGED_STAGE=thread_started')
    const firstTurn = await runtime.startTurn(thread, [{
      type: 'text',
      text: 'Reply with exactly LIVE-TURN-OK. Do not call tools.',
    }], 'live-managed-first-turn')
    await events.waitForTurn(firstTurn)
    console.log('NATIVE_MANAGED_STAGE=first_turn_completed')
    assertThreadRead(await runtime.readThread(thread), thread.id)
    await runtime.close()

    // A new product-owned App Server process must reopen the Rust-owned Thread
    // Store rather than relying on Electron memory from the first process.
    runtime = createRuntime()
    const resumed = await runtime.resumeThread({ threadId: thread.id, cwd: workspace, route })
    if (resumed.id !== thread.id) throw new Error('Rust Thread resume changed the Thread id')
    console.log('NATIVE_MANAGED_STAGE=thread_resumed')
    assertThreadRead(await runtime.readThread(resumed), thread.id)

    const toolTurn = await runtime.startTurn(resumed, [{
      type: 'text',
      text: `Use a tool to create ${path.join(approvalWorkspace, 'approval-proof.txt')} with exactly approved as its content. Then reply with exactly TOOL-LOOP-OK.`,
    }], 'live-managed-tool-turn')
    await events.waitForTurn(toolTurn)
    console.log('NATIVE_MANAGED_STAGE=tool_turn_completed')
    const proof = await readFile(path.join(approvalWorkspace, 'approval-proof.txt'), 'utf8')
    if (proof.trim() !== 'approved') throw new Error('native tool did not create the expected workspace file')

    const fork = await runtime.forkThread({
      threadId: resumed.id,
      cwd: workspace,
      route,
      permissionMode: 'ask',
      lastTurnId: toolTurn.id,
    })
    if (fork.id === resumed.id) throw new Error('Rust Thread fork reused the source Thread id')
    assertThreadRead(await runtime.readThread(fork), fork.id)
    await runtime.archiveThread(fork)
    console.log('NATIVE_MANAGED_STAGE=thread_forked_and_archived')

    // The Mac workspace sandbox permits its private temporary directory, so a
    // file write is correctly not an escalation. Network is disabled for this
    // source-native Ask profile and must travel through an approval request.
    const approvalTurn = await runtime.startTurn(resumed, [{
      type: 'text',
      text: 'Use a shell command to make a HEAD request to https://example.com. Request approval for network access if needed. Then reply with exactly NETWORK-APPROVAL-OK.',
    }], 'live-managed-network-approval-turn')
    await events.waitForTurn(approvalTurn)
    console.log('NATIVE_MANAGED_STAGE=network_turn_completed')
    if (events.approvalMethods.size === 0) throw new Error('native tool turn did not issue an approval request')

    const interruptTurn = await runtime.startTurn(resumed, [{
      type: 'text',
      text: 'Use a shell command to sleep for 30 seconds. Do not provide a final answer until that command finishes.',
    }], 'live-managed-interrupt-turn')
    await events.waitForCommand(interruptTurn)
    console.log('NATIVE_MANAGED_STAGE=interrupt_command_started')
    await runtime.interruptTurn(resumed, interruptTurn)
    await events.waitForTurn(interruptTurn)

    // This models loss of the BilliardBuddy-owned App Server process while a
    // native command is running. It must leave no loopback model bridge alive,
    // and a fresh process must reopen the same Rust Thread Store, settle the
    // interrupted turn and accept new work without a second Agent ledger.
    const abruptTurn = await runtime.startTurn(resumed, [{
      type: 'text',
      text: 'Use a shell command to sleep for 5 seconds. Do not provide a final answer until that command finishes.',
    }], 'live-managed-abrupt-close-turn')
    await events.waitForCommand(abruptTurn)
    runtime.closeImmediately()
    runtime = undefined
    await wait(250)
    runtime = createRuntime()
    const recovered = await runtime.resumeThread({ threadId: resumed.id, cwd: workspace, route })
    if (recovered.id !== resumed.id) throw new Error('Rust Thread recovery changed the Thread id')
    assertThreadRead(await runtime.readThread(recovered), recovered.id)
    try {
      await runtime.interruptTurn(recovered, abruptTurn)
      await events.waitForTurn(abruptTurn)
    } catch (error) {
      // The source may already have settled the interrupted turn during
      // restart. That precise rejection proves it did not leave a hidden
      // active Turn that Electron now owns; any other RPC failure is unsafe.
      if (!(error instanceof Error) || !error.message.includes('no active turn to interrupt')) throw error
    }
    const recoveryTurn = await runtime.startTurn(recovered, [{
      type: 'text',
      text: 'Reply with exactly RECOVERY-TURN-OK. Do not call tools.',
    }], 'live-managed-recovery-turn')
    await events.waitForTurn(recoveryTurn)
    console.log('NATIVE_MANAGED_STAGE=abrupt_close_recovered')

    console.log('NATIVE_MANAGED_THREAD_TURN=passed')
    console.log(`NATIVE_MANAGED_APPROVALS=${[...events.approvalMethods].sort().join(',')}`)
    console.log('NATIVE_MANAGED_TOOL_LOOP=passed')
    console.log('NATIVE_MANAGED_FORK_ARCHIVE=passed')
    console.log('NATIVE_MANAGED_INTERRUPT=passed')
    console.log('NATIVE_MANAGED_RESUME=passed')
    console.log('NATIVE_MANAGED_ABRUPT_CLOSE_RECOVERY=passed')
  } finally {
    await runtime?.close().catch(() => undefined)
    // Both paths were created by mkdtemp above; no user workspace or Codex Home
    // is touched by this explicit acceptance probe.
    await rm(workspace, { recursive: true, force: true })
    await rm(approvalWorkspace, { recursive: true, force: true })
    await rm(userDataPath, { recursive: true, force: true })
  }
}

await main()
