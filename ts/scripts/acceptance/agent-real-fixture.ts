import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { InstallationSessionManager, type InstallationSessionStore } from '../../desktop/electron/services/installationSession.js'
import { ProductTaskService } from '../../src/server/product/taskService.js'
import { dispatcherFor, shutdownDispatcherFor } from '../../src/server/product/taskRunDispatchBridge.js'
import { productTaskWorkerRuntimeEvents } from '../../src/server/product/taskWorkerRuntimeEvents.js'
import { ProductResourceScheduler } from '../../src/server/product/resourceScheduler.js'
import { configureChromeSessionBridge } from '../../src/server/services/chromeSessionBridge.js'

type TerminalEvent = Extract<Awaited<ReturnType<ProductTaskService['listTaskEvents']>>['events'][number], { type: 'run_terminal' }>

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`AGENT_FIXTURE_${name}_NOT_CONFIGURED`)
  return value
}

async function waitForWorking(service: ProductTaskService, taskId: string, runId: string, storagePath: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (productTaskWorkerRuntimeEvents.snapshot(taskId).state === 'working') return
    const terminal = (await service.listTaskEvents(taskId, 0, 500)).events.find(event => event.type === 'run_terminal' && event.run_id === runId)
    if (terminal?.type === 'run_terminal') {
      const authority = JSON.parse(await fs.readFile(path.join(path.dirname(storagePath), 'product-task-authority.v1.json'), 'utf8')) as { dispatch_records?: Record<string, { error?: unknown }> }
      const internal = typeof authority.dispatch_records?.[runId]?.error === 'string' ? authority.dispatch_records[runId]!.error : 'unknown'
      throw new Error(`AGENT_FIXTURE_WORKER_${terminal.state}_${terminal.failure?.code ?? 'unknown'}_${internal}`)
    }
    await Bun.sleep(25)
  }
  throw new Error('AGENT_FIXTURE_WORKER_START_TIMEOUT')
}

async function waitForTerminal(
  service: ProductTaskService,
  taskId: string,
  runId: string,
  timeoutMs = 3 * 60_000,
): Promise<TerminalEvent> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = await service.listTaskEvents(taskId, 0, 500)
    const terminal = page.events.find((event): event is TerminalEvent => event.type === 'run_terminal' && event.run_id === runId)
    if (terminal) return terminal
    await Bun.sleep(100)
  }
  throw new Error(`AGENT_FIXTURE_TERMINAL_TIMEOUT:${runId}`)
}

function taskText(service: ProductTaskService, taskId: string): Promise<string> {
  return service.getTaskThread(taskId).then(thread => thread.entries
    .filter(entry => entry.type === 'assistant_text')
    .map(entry => entry.text)
    .join('\n'))
}

async function logoutWithRetry(manager: InstallationSessionManager): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await manager.logout(); return } catch (error) {
      lastError = error
      if (attempt < 2) await Bun.sleep(250)
    }
  }
  throw lastError
}

async function main(): Promise<void> {
  const gatewayUrl = required('BB_GATEWAY_URL')
  const bootstrapCredential = required('BB_GATEWAY_BOOTSTRAP_CREDENTIAL')
  const licenseKey = required('BB_LICENSE_KEY')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-real-agent-'))
  const storagePath = path.join(root, 'product-tasks.json')
  const sessionStore: InstallationSessionStore & { value: string | null } = {
    value: null,
    load() { return this.value },
    save(value) { this.value = value },
    clear() { this.value = null },
  }
  const sessions = new InstallationSessionManager({
    gatewayUrl,
    bootstrapCredential,
    licenseKey,
    installationId: `agent-fixture-${randomUUID()}`,
  }, sessionStore)
  let service: ProductTaskService | undefined
  let activated = false
  const runtimeActivityPhases: string[] = []
  const unsubscribeRuntime = productTaskWorkerRuntimeEvents.subscribe((_taskId, event) => {
    if (event.type === 'activity') runtimeActivityPhases.push(`${event.kind}:${event.phase}`)
  })
  try {
    const accessToken = await sessions.accessToken()
    activated = true
    process.env.BB_GATEWAY_URL = gatewayUrl
    process.env.BB_GATEWAY_TOKEN = accessToken
    configureChromeSessionBridge({
      statePath: path.join(root, 'browser-actions.json'),
      descriptorPath: path.join(root, 'browser-descriptor.json'),
      scheduler: new ProductResourceScheduler({ statePath: path.join(root, 'browser-scheduler.json') }),
    })

    const firstFragment = `A-${randomUUID().slice(0, 8)}`
    const secondFragment = `B-${randomUUID().slice(0, 8)}`
    await fs.writeFile(path.join(root, 'acceptance-a.txt'), `${firstFragment}\n`, 'utf8')
    await fs.writeFile(path.join(root, 'acceptance-b.txt'), `${secondFragment}\n`, 'utf8')

    let liveDispatcher: ReturnType<typeof dispatcherFor> | undefined
    const dispatcherProxy = {
      dispatch: (...args: Parameters<ReturnType<typeof dispatcherFor>['dispatch']>) => liveDispatcher!.dispatch(...args),
      stop: (...args: Parameters<ReturnType<typeof dispatcherFor>['stop']>) => liveDispatcher!.stop(...args),
      approve: (...args: Parameters<ReturnType<typeof dispatcherFor>['approve']>) => liveDispatcher!.approve(...args),
      answer: (...args: Parameters<ReturnType<typeof dispatcherFor>['answer']>) => liveDispatcher!.answer(...args),
      steer: (...args: Parameters<ReturnType<typeof dispatcherFor>['steer']>) => liveDispatcher!.steer(...args),
    }
    service = new ProductTaskService({ storagePath, dispatcher: dispatcherProxy, autoMemoryEnabled: async () => false })
    liveDispatcher = dispatcherFor(service)

    const draft = await service.createNewTaskComposerDraft({
      ttl_ms: 60_000,
      client_operation_id: `fixture-draft-${randomUUID()}`,
    })
    const draftId = String(draft.draft.draft_id)
    const taskId = String(draft.draft.target_task_id)
    const first = await service.createAndSubmitTask({
      draft_id: draftId,
      expected_draft_revision: Number(draft.draft.revision),
      client_operation_id: `fixture-first-${randomUUID()}`,
      text: '必须使用 Read 工具读取工作目录里的 acceptance-a.txt，只保留文件第一行的校验片段；不要猜测内容。读取后继续留意本回合追加的新要求，最终把所有校验片段原样写在同一个回答里。',
      attachment_ids: [],
      permission_mode: 'approve_for_me',
    })
    if (first.outcome !== 'accepted' || !first.result || !('run_id' in first.result)) throw new Error(`AGENT_FIXTURE_FIRST_SUBMIT_${first.outcome}`)
    process.stdout.write('agent-real-fixture: worker starting\n')
    await waitForWorking(service, taskId, first.result.run_id, storagePath)

    const queued = await service.submitTaskRun(taskId, {
      expected_task_revision: first.entity_revisions.task,
      expected_lineage_revision: first.entity_revisions.lineage,
      client_operation_id: `fixture-queue-${randomUUID()}`,
      text: '补充要求：还必须使用 Read 工具读取 acceptance-b.txt 的第一行，并把它与上一条文件的校验片段一起原样回答。',
      attachment_ids: [],
    })
    if (queued.outcome !== 'accepted' || !queued.result || !('queue_item_id' in queued.result)) throw new Error(`AGENT_FIXTURE_QUEUE_${queued.outcome}`)
    const steered = await service.steerTaskInputQueue(taskId, {
      queue_item_id: queued.result.queue_item_id,
      expected_task_revision: queued.entity_revisions.task,
      client_operation_id: `fixture-steer-${randomUUID()}`,
    })
    if (steered.outcome !== 'accepted' || steered.delivery !== 'steer') throw new Error(`AGENT_FIXTURE_STEER_${steered.outcome}_${steered.delivery}`)

    const firstTerminal = await waitForTerminal(service, taskId, first.result.run_id)
    if (firstTerminal.state !== 'completed') throw new Error(`AGENT_FIXTURE_FIRST_${firstTerminal.state}_${firstTerminal.failure?.code ?? 'unknown'}`)
    const firstEvents = (await service.listTaskEvents(taskId, 0, 500)).events
    const completedReads = firstEvents.filter(event => event.type === 'activity' && event.kind === 'file_read' && event.phase === 'completed')
    const activitySummary = firstEvents.filter(event => event.type === 'activity').map(event => event.type === 'activity' ? `${event.kind}:${event.phase}` : '').join(',')
    const firstText = await taskText(service, taskId)
    if (completedReads.length < 2 || !firstText.includes(firstFragment) || !firstText.includes(secondFragment)) {
      throw new Error(`AGENT_FIXTURE_MULTI_TOOL_RESULT_INVALID_reads=${completedReads.length}_first=${firstText.includes(firstFragment)}_second=${firstText.includes(secondFragment)}_durable=${activitySummary || 'none'}_runtime=${runtimeActivityPhases.join(',') || 'none'}`)
    }
    if (!firstEvents.some(event => event.type === 'queue_updated' && event.queue_item_id === queued.result.queue_item_id && event.phase === 'injected')) {
      throw new Error('AGENT_FIXTURE_STEER_NOT_DURABLE')
    }

    const task = (await service.listTasksAuthoritatively()).tasks.find(candidate => candidate.id === taskId)
    const lineage = await service.getConversationLineageCurrent(taskId)
    if (!task?.revision || !lineage || !Number.isSafeInteger(lineage.revision)) throw new Error('AGENT_FIXTURE_CONTINUATION_STATE_INVALID')
    const second = await service.submitTaskRun(taskId, {
      expected_task_revision: task.revision,
      expected_lineage_revision: Number(lineage.revision),
      client_operation_id: `fixture-second-${randomUUID()}`,
      text: '只根据已经持久化的上一轮会话，原样回答两个校验片段；不要重新读取文件。',
      attachment_ids: [],
    })
    if (second.outcome !== 'accepted' || !second.result || !('run_id' in second.result)) throw new Error(`AGENT_FIXTURE_SECOND_SUBMIT_${second.outcome}`)
    const secondTerminal = await waitForTerminal(service, taskId, second.result.run_id)
    if (secondTerminal.state !== 'completed') throw new Error(`AGENT_FIXTURE_SECOND_${secondTerminal.state}_${secondTerminal.failure?.code ?? 'unknown'}`)
    const allText = await taskText(service, taskId)
    if (!allText.includes(firstFragment) || !allText.includes(secondFragment)) throw new Error('AGENT_FIXTURE_SESSION_MEMORY_INVALID')

    await shutdownDispatcherFor(service)
    const restarted = new ProductTaskService({ storagePath, autoMemoryEnabled: async () => false })
    const restoredThread = await restarted.getTaskThread(taskId)
    const restoredText = restoredThread.entries.filter(entry => entry.type === 'assistant_text').map(entry => entry.text).join('\n')
    const terminalCount = (await restarted.listTaskEvents(taskId, 0, 500)).events.filter(event => event.type === 'run_terminal' && event.state === 'completed').length
    if (!restoredText.includes(firstFragment) || !restoredText.includes(secondFragment) || terminalCount !== 2 || restoredThread.recoveryRequired) {
      throw new Error('AGENT_FIXTURE_RESTART_INVALID')
    }

    process.stdout.write(`agent-real-fixture: PASS turns=${terminalCount} file_reads=${completedReads.length} steer=injected restart=restored\n`)
  } finally {
    unsubscribeRuntime()
    if (service) await shutdownDispatcherFor(service).catch(() => undefined)
    if (activated) await logoutWithRetry(sessions)
    else sessions.dispose()
    delete process.env.BB_GATEWAY_TOKEN
    await fs.rm(root, { recursive: true, force: true })
  }
}

await main()
