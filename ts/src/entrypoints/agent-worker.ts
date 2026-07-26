/** Internal framed worker entrypoint. Bootstrap arrives only over Bun private IPC. */
import { createInterface } from 'node:readline'
import { AgentWorkerProtocol } from '../server/agent-worker/framedProtocol.js'
import { createProductAgentHarness } from '../server/agent-worker/productAgentHarness.js'
import { ProductSkillTool } from '../server/agent-worker/productSkillTool.js'
import { ProductSubtaskTool } from '../server/agent-worker/productSubtaskTool.js'
import type { ProductHostRuntimeSnapshot } from '../server/agent-worker/productAgentHostRuntime.js'
import { runProductTools } from '../server/agent-worker/productToolExecution.js'
import type { AgentWorkerBootstrap, AgentWorkerCore, AgentWorkerCoreFactory } from '../server/product/agentWorkerService.js'
import { AgentWorkerService } from '../server/product/agentWorkerService.js'
import type { AgentWorkerCoreIdentity } from '../server/product/agentWorkerSupervisor.js'
import type { ProductAgentHarnessPort } from '../server/agent-worker/productAgentHarness.js'
import type { ProductAssistantMessage, ProductHarnessMessage, ProductToolCallBlock } from '../../shared/product/harnessMessages.js'
import type { AgentWorkerOutbound } from '../../shared/product/agentWorker.js'
import type { ProductCanUseTool, ProductCommand, ProductThinkingConfig, ProductTool, ProductToolContext } from '../server/agent-worker/productTool.js'

type CoreBinding = { session_id: string; work_dir: string }
type StartResult = { identity: AgentWorkerCoreIdentity; binding: CoreBinding }
type CoreRequest = {
  type: 'core_request'
  id: string
  operation: 'start' | 'prepare' | 'command_prompt' | 'chat_prompt' | 'model' | 'tools' | 'approval' | 'question' | 'stop' | 'shutdown'
  value?: unknown
}
type PendingRequest = {
  chunks: unknown[]
  done: boolean
  error?: Error
  resolve(value?: unknown): void
  reject(error: Error): void
  wake?: () => void
}

let sequence = 0
const pending = new Map<string, PendingRequest>()

function beginRequest(operation: CoreRequest['operation'], value?: unknown): { id: string; promise: Promise<unknown>; entry: PendingRequest } {
  const id = `core_${++sequence}`
  let resolve!: (value?: unknown) => void
  let reject!: (error: Error) => void
  const promise = new Promise<unknown>((next, fail) => { resolve = next; reject = fail })
  const entry: PendingRequest = { chunks: [], done: false, resolve, reject }
  pending.set(id, entry)
  process.send?.({ type: 'core_request', id, operation, value } satisfies CoreRequest)
  return { id, promise, entry }
}

function request(operation: CoreRequest['operation'], value?: unknown): Promise<unknown> {
  return beginRequest(operation, value).promise
}

async function* requestStream(operation: CoreRequest['operation'], value?: unknown): AsyncGenerator<unknown, void> {
  const { id, entry, promise } = beginRequest(operation, value)
  void promise.catch(() => undefined)
  try {
    while (!entry.done || entry.chunks.length > 0) {
      if (entry.chunks.length > 0) { yield entry.chunks.shift(); continue }
      if (entry.error) throw entry.error
      await new Promise<void>(resolve => { entry.wake = resolve })
    }
    if (entry.error) throw entry.error
  } finally {
    pending.delete(id)
  }
}

function remoteCommands(snapshot: ProductHostRuntimeSnapshot): ProductCommand[] {
  return snapshot.commands.map(descriptor => ({
    ...descriptor,
    type: 'prompt' as const,
    source: 'mcp' as const,
    progressMessage: '正在加载扩展',
    contentLength: 0,
    directTool: descriptor.directTool,
    getPromptForCommand: async (args: string) => await request('command_prompt', { name: descriptor.name, args }) as never,
  }))
}

function remoteTools(snapshot: ProductHostRuntimeSnapshot): ProductTool[] {
  return snapshot.tools.map(descriptor => descriptor.name === ProductSubtaskTool.name
    ? ProductSubtaskTool
    : descriptor.name === ProductSkillTool.name
      ? ProductSkillTool
      : { name: descriptor.name } as ProductTool)
}

async function createWorkerHarness(start: StartResult, input: Parameters<AgentWorkerCoreFactory['start']>[0]): Promise<ProductAgentHarnessPort> {
  let snapshot: ProductHostRuntimeSnapshot | undefined
  const prepare = async () => snapshot ??= await request('prepare') as ProductHostRuntimeSnapshot
  const runModel = (value: { messages: ProductHarnessMessage[]; systemPrompt: readonly string[]; thinkingConfig: ProductThinkingConfig; options: { model?: string } }) => requestStream('model', {
    messages: value.messages,
    systemPrompt: [...value.systemPrompt],
    thinkingConfig: value.thinkingConfig,
    model: value.options.model,
  }) as never
  const executeTools = async function* (
    blocks: ProductToolCallBlock[],
    assistantMessages: ProductAssistantMessage[],
    canUseTool: ProductCanUseTool,
    context: ProductToolContext,
  ) {
    for (const block of blocks) {
      if (block.name === ProductSubtaskTool.name || block.name === ProductSkillTool.name) {
        yield* runProductTools([block], assistantMessages, canUseTool, context)
        continue
      }
      const messages = await request('tools', { blocks: [block], assistantMessages, messages: context.messages }) as ProductHarnessMessage[]
      for (const message of messages) yield { message, newContext: context }
    }
  }
  const harness = await createProductAgentHarness({
    run_id: input.run_id,
    task_id: start.identity.task_id,
    session_id: start.binding.session_id,
    work_dir: start.binding.work_dir,
    permission_envelope: input.permission_envelope,
    mcp_host: {
      connect: async () => {
        const current = await prepare()
        return {
          clients: current.mcp_clients as never,
          tools: remoteTools(current),
          commands: remoteCommands(current),
          resources: {},
        }
      },
    },
    load_commands: async () => [],
    load_tools: () => [],
    run_model: runModel as never,
    execute_tools: executeTools,
    build_chat_prompt: (text, attachments) => request('chat_prompt', { text, attachments }) as Promise<import('../../shared/product/harnessMessages.js').ProductPrompt>,
    session_context: start.identity.session_context,
    harness_session: start.identity.harness_session,
    ...(start.identity.auto_memory ? {
      auto_memory: {
        storage_dir: start.identity.auto_memory.storage_dir,
        work_dir: start.binding.work_dir,
        enabled: start.identity.auto_memory.enabled,
        task_id: start.identity.task_id,
        entry_id: start.identity.auto_memory.entry_id,
      },
    } : {}),
  })
  return harness
}

let protocol: AgentWorkerProtocol | undefined
function emit(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
  process.send?.({ type: 'worker_outbound', message })
}

process.on('message', (message: unknown) => {
  const record = message && typeof message === 'object' ? message as Record<string, unknown> : undefined
  if (record?.type === 'bootstrap' && record.bootstrap && !protocol) {
    const bootstrap = record.bootstrap as AgentWorkerBootstrap
    const service = new AgentWorkerService({
      ...bootstrap,
      cores: {
        start: async input => {
          const start = await request('start', input) as StartResult
          const harness = await createWorkerHarness(start, input)
          const unsubscribe = harness.subscribe(message => protocol?.relayCoreMessage(message))
          let firstInput = true
          const core: AgentWorkerCore = {
            input: async (text, attachments, queueItemId) => {
              const initialAttachments = firstInput && !queueItemId ? start.identity.initial_attachments : attachments
              if (!queueItemId) firstInput = false
              return harness.input(text, initialAttachments, queueItemId)
            },
            approve: async (requestId, approved) => { await Promise.all([harness.approve(requestId, approved), request('approval', { requestId, approved })]) },
            answer: async (requestId, answers) => { await Promise.all([harness.answer(requestId, answers), request('question', { requestId, answers })]) },
            stop: async () => { await Promise.all([harness.stop(), request('stop')]) },
            shutdown: async () => { unsubscribe(); await Promise.all([harness.shutdown(), request('shutdown')]) },
          }
          return core
        },
      },
    })
    protocol = new AgentWorkerProtocol(service, emit)
    protocol.announce()
    return
  }
  if (record?.type === 'core_result' && typeof record.id === 'string') {
    const entry = pending.get(record.id)
    if (!entry) return
    entry.done = true
    if (record.ok === true) entry.resolve(record.value)
    else { entry.error = new Error('CORE_PORT_DENIED'); entry.reject(entry.error) }
    entry.wake?.()
    if (entry.chunks.length === 0) pending.delete(record.id)
    return
  }
  if (record?.type === 'runtime_chunk' && typeof record.id === 'string') {
    const entry = pending.get(record.id)
    if (!entry) return
    entry.chunks.push(record.value)
    entry.wake?.()
    entry.wake = undefined
    return
  }
  if (record?.type === 'runtime_event' && protocol) {
    protocol.relayCoreMessage(record.message as AgentWorkerOutbound)
  }
})

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => protocol ? protocol.receive(line) : emit({ type: 'fatal', code: 'ENVELOPE_DENIED' }))
