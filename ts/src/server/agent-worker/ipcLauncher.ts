import type { AgentWorkerChild, AgentWorkerChildLauncher, AgentWorkerCoreIdentity } from '../product/agentWorkerSupervisor.js'
import { buildProviderRegistryRuntimeEnv, validateProviderRuntimeConfiguration } from '../../../../gateway/providerRegistry.js'
import type { AgentWorkerCoreFactory } from '../product/agentWorkerService.js'
import { stripHostOnlyGatewayEnv } from '../services/gatewayEnv.js'
import type { ProductAgentHostRuntime } from './productAgentHostRuntime.js'
import { validProductModelOperationReceipt } from '../../../shared/product/harnessMessages.js'
import { getProductMcpOAuthMasterKey, PRODUCT_MCP_OAUTH_KEY_ENV } from './productMcpOAuth.js'
import { TASK_RUN_EXTERNAL_OPERATION_KINDS, type TaskRunExternalOperationKind } from '../product/taskRunLedgerModel.js'
import type { ProductTaskPlan } from '../../../shared/product/taskEvents.js'

type LaunchInput = Parameters<AgentWorkerChildLauncher['launch']>[0]
type CoreBinding = { session_id: string; work_dir: string; provider: string; model: string; model_route_fingerprint: string; model_attempt_id: string }
type WorkerHostState = {
  runtime?: ProductAgentHostRuntime
  binding?: CoreBinding
  unsubscribe?: () => void
  starting?: Promise<ProductAgentHostRuntime>
  closed: boolean
  runtime_shutdown?: Promise<void>
  claim_watchdog?: ReturnType<typeof setInterval>
  claim_check_in_flight?: boolean
  on_runtime_started?: () => void
  stop_process?: () => Promise<void>
  external_operation_states: Map<string, 'in_flight' | 'result_obtained'>
}
const PROVIDER_RUNTIME_ENV_KEYS = [
  'BB_GATEWAY_MODEL',
  'BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS',
  'BILLIARDBUDDY_AUTO_COMPACT_WINDOW',
  'BB_PROVIDER_CONTRACT_VERSION',
  'BB_PROVIDER_REGISTRY_SHA256',
  'BB_PROVIDER_WORKER_MANIFEST_SHA256',
] as const
export type TaskRunCoreBindingResolver = {
  assertTaskRunExecutionClaim(runId: string, generation: number, executionClaimToken: string): Promise<void>
  resolveTaskRunCoreBinding(runId: string, generation: number, executionClaimToken: string): Promise<CoreBinding>
  beginTaskRunExternalOperation(runId: string, generation: number, executionClaimToken: string, kind: TaskRunExternalOperationKind): Promise<
    | { outcome: 'started'; operation_id: string }
    | { outcome: 'not_owner' | 'outcome_unknown' }
  >
  recordTaskRunExternalOperationResult(runId: string, generation: number, executionClaimToken: string, operationId: string): Promise<'result_obtained' | 'outcome_unknown' | 'not_owner'>
  checkpointTaskRunExternalOperation(runId: string, generation: number, executionClaimToken: string, operationId: string, checkpoint: { digest: string }): Promise<'checkpointed' | 'outcome_unknown' | 'not_owner'>
  checkpointTaskRunMcpPrepare(runId: string, generation: number, executionClaimToken: string, operationId: string, snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number }): Promise<'checkpointed' | 'outcome_unknown' | 'not_owner'>
  markTaskRunExternalOperationOutcomeUnknown(runId: string, generation: number, executionClaimToken: string, operationId: string): Promise<'marked' | 'already_outcome_unknown' | 'not_owner'>
  recordTaskRunPlan(runId: string, generation: number, plan: ProductTaskPlan, executionClaimToken: string): Promise<unknown>
}
export type ServerPrivateCoreFactory = { start(identity: AgentWorkerCoreIdentity, binding: CoreBinding, input: Parameters<AgentWorkerCoreFactory['start']>[0]): Promise<ProductAgentHostRuntime> }

export function resolveAgentWorkerCommand(
  env: NodeJS.ProcessEnv = process.env,
  executable = process.execPath,
): string[] {
  return env.BB_COMPILED_SIDECAR === '1'
    ? [executable, 'agent-worker']
    : [executable, new URL('../../entrypoints/agent-worker.ts', import.meta.url).pathname]
}

function coreExternalOperationKind(operation: unknown): TaskRunExternalOperationKind | undefined {
  switch (operation) {
    case 'prepare': return 'mcp_prepare'
    case 'chat_prompt': return 'chat_prompt'
    case 'command_prompt': return 'command_prompt'
    case 'model': return 'model'
    case 'tools': return 'tools'
    default: return undefined
  }
}

/** Bun IPC is the only transport carrying a child bootstrap; stdout remains framed protocol only. */
export class IpcAgentWorkerLauncher implements AgentWorkerChildLauncher {
  constructor(private readonly bindings: TaskRunCoreBindingResolver, private readonly cores: ServerPrivateCoreFactory, private readonly command: string[] = resolveAgentWorkerCommand()) {}
  async launch(input: LaunchInput): Promise<AgentWorkerChild> {
    const state: WorkerHostState = { closed: false, external_operation_states: new Map() }
    // Snapshot all non-secret model inputs before normalizing the child env.  An
    // explicit invalid override must remain invalid; only a wholly absent model
    // configuration is allowed to receive the registry default.
    const inheritedEnv = stripHostOnlyGatewayEnv(process.env)
    const configured = Object.fromEntries(PROVIDER_RUNTIME_ENV_KEYS.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
    const providerEnv = { ...buildProviderRegistryRuntimeEnv(configured.BB_GATEWAY_MODEL), ...configured }
    const configurationError = validateProviderRuntimeConfiguration(providerEnv)
    const workerEnv: NodeJS.ProcessEnv = { ...inheritedEnv, [PRODUCT_MCP_OAUTH_KEY_ENV]: getProductMcpOAuthMasterKey() }
    for (const key of PROVIDER_RUNTIME_ENV_KEYS) delete workerEnv[key]
    let configurationFatalSent = false
    let proc!: ReturnType<typeof Bun.spawn>
    const closeRuntime = (): Promise<void> => {
      state.closed = true
      if (state.claim_watchdog) clearInterval(state.claim_watchdog)
      state.claim_watchdog = undefined
      state.unsubscribe?.()
      state.unsubscribe = undefined
      if (state.runtime_shutdown) return state.runtime_shutdown
      const shutdown = (async () => {
        const abortRuntime = async (runtime: ProductAgentHostRuntime) => {
          await runtime.stop().catch(() => undefined)
          void runtime.shutdown().catch(() => undefined)
        }
        if (state.runtime) await abortRuntime(state.runtime)
        else if (state.starting) void state.starting.then(abortRuntime, () => undefined)
        state.runtime = undefined
      })()
      state.runtime_shutdown = shutdown
      return shutdown
    }
    const stopProcess = async () => {
      await closeRuntime()
      try { proc.kill() } catch {}
      await proc.exited
    }
    state.stop_process = stopProcess
    const startClaimWatchdog = () => {
      if (state.closed || state.claim_watchdog) return
      const capability = input.bootstrap.capability
      const timer = setInterval(() => {
        if (state.closed || state.claim_check_in_flight) return
        state.claim_check_in_flight = true
        void this.bindings.assertTaskRunExecutionClaim(
          capability.run_id,
          capability.dispatch_generation,
          capability.execution_claim_token,
        ).catch(() => stopProcess()).finally(() => {
          state.claim_check_in_flight = false
        })
      }, 500)
      timer.unref?.()
      state.claim_watchdog = timer
    }
    state.on_runtime_started = startClaimWatchdog
    const failConfiguration = () => {
      if (configurationFatalSent) return
      configurationFatalSent = true
      input.onMessage({ type: 'fatal', code: 'MODEL_CONFIGURATION_INVALID' })
      void stopProcess()
    }
    proc = Bun.spawn(this.command, {
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', serialization: 'advanced',
      env: { ...workerEnv, ...providerEnv },
      ipc: (message, child) => {
        const record = message && typeof message === 'object' ? message as Record<string, unknown> : undefined
        if (record?.type === 'worker_outbound') {
          if (state.closed) return
          if (configurationError) return failConfiguration()
          input.onMessage(record.message as never); return
        }
        if (record?.type !== 'core_request' || typeof record.id !== 'string' || typeof record.operation !== 'string') return
        if (state.closed) {
          child.send({ type: 'core_result', id: record.id, ok: false })
          return
        }
        void this.handleCoreRequest(state, record, input, (outbound) => {
          if (!state.closed) child.send(outbound)
        }).then((next) => {
          if (!state.closed) child.send({ type: 'core_result', id: record.id, ok: next.ok, ...(next.value !== undefined ? { value: next.value } : {}) })
        })
      },
    })
    let exitReported = false
    const reportExit = () => {
      if (exitReported) return
      exitReported = true
      void closeRuntime()
      input.onExit()
    }
    void proc.exited.then(reportExit, reportExit)
    proc.send({ type: 'bootstrap', bootstrap: input.bootstrap })
    void (async () => {
      if (!proc.stdout || typeof proc.stdout === 'number') return
      const reader = proc.stdout.getReader()
      while (!(await reader.read()).done) {}
    })()
    return {
      send: message => {
        if (!proc.stdin || typeof proc.stdin === 'number') throw new Error('AGENT_WORKER_STDIN_UNAVAILABLE')
        proc.stdin.write(`${JSON.stringify(message)}\n`)
      },
      stop: stopProcess,
    }
  }
  private async handleCoreRequest(state: WorkerHostState, request: Record<string, unknown>, input: LaunchInput, relay: (message: unknown) => void): Promise<{ ok: boolean; value?: unknown }> {
    try {
      if (state.closed) return { ok: false }
      const capability = input.bootstrap.capability
      if (request.execution_claim_token !== capability.execution_claim_token) return { ok: false }
      if (request.operation === 'start' && !state.runtime) {
        const value = request.value as { run_id?: unknown; dispatch_generation?: unknown; execution_claim_token?: unknown; envelope_digest?: unknown; permission_envelope?: { digest?: unknown }; scheduler_receipt?: { fencing_token?: unknown } } | undefined
        if (!value || value.run_id !== capability.run_id || value.dispatch_generation !== capability.dispatch_generation || value.execution_claim_token !== capability.execution_claim_token || value.envelope_digest !== capability.envelope_digest || value.permission_envelope?.digest !== value.envelope_digest || value.scheduler_receipt?.fencing_token !== capability.fencing_token) return { ok: false }
        state.starting ??= this.bindings.resolveTaskRunCoreBinding(value.run_id as string, value.dispatch_generation as number, value.execution_claim_token as string).then(binding => {
          state.binding = binding
          return this.cores.start(input.core, binding, value as Parameters<AgentWorkerCoreFactory['start']>[0])
        })
        try {
          const runtime = await state.starting
          if (state.closed) {
            await runtime.shutdown().catch(() => undefined)
            return { ok: false }
          }
          state.runtime = runtime
          state.unsubscribe = state.runtime.subscribe(message => relay({ type: 'runtime_event', message }))
          state.on_runtime_started?.()
        } finally { state.starting = undefined }
        return { ok: true, value: { identity: input.core, binding: state.binding } }
      }
      const runtime = state.runtime
      if (!runtime) return { ok: false }

      const beginExternalOperation = async (kind: TaskRunExternalOperationKind): Promise<string> => {
        const started = await this.bindings.beginTaskRunExternalOperation(
          capability.run_id,
          capability.dispatch_generation,
          capability.execution_claim_token,
          kind,
        )
        if (started.outcome !== 'started') throw new Error('TASK_RUN_EXTERNAL_OPERATION_DENIED')
        state.external_operation_states.set(started.operation_id, 'in_flight')
        return started.operation_id
      }
      const markExternalOperationUnknown = async (operationId: string): Promise<void> => {
        const outcome = await this.bindings.markTaskRunExternalOperationOutcomeUnknown(
          capability.run_id,
          capability.dispatch_generation,
          capability.execution_claim_token,
          operationId,
        )
        if (outcome !== 'marked' && outcome !== 'already_outcome_unknown') throw new Error('TASK_RUN_EXTERNAL_OPERATION_UNRESOLVED')
        state.external_operation_states.delete(operationId)
        // Once a result is unknown, no later Hook/model/tool request may use
        // this Runtime while the child is still unwinding its exception.
        void state.stop_process?.()
      }
      const recordExternalOperationResult = async (operationId: string): Promise<void> => {
        const outcome = await this.bindings.recordTaskRunExternalOperationResult(
          capability.run_id,
          capability.dispatch_generation,
          capability.execution_claim_token,
          operationId,
        )
        if (outcome !== 'result_obtained') throw new Error('TASK_RUN_EXTERNAL_OPERATION_UNRESOLVED')
        if (state.external_operation_states.has(operationId)) state.external_operation_states.set(operationId, 'result_obtained')
      }
      const checkpointExternalOperation = async (operationId: string, digest: string): Promise<void> => {
        const outcome = await this.bindings.checkpointTaskRunExternalOperation(
          capability.run_id,
          capability.dispatch_generation,
          capability.execution_claim_token,
          operationId,
          { digest },
        )
        if (outcome !== 'checkpointed') throw new Error('TASK_RUN_EXTERNAL_OPERATION_UNRESOLVED')
        state.external_operation_states.delete(operationId)
      }
      const checkpointMcpPrepare = async (operationId: string, snapshot: { digest: string; tool_count: number; command_count: number; mcp_server_count: number }): Promise<void> => {
        const outcome = await this.bindings.checkpointTaskRunMcpPrepare(
          capability.run_id,
          capability.dispatch_generation,
          capability.execution_claim_token,
          operationId,
          snapshot,
        )
        if (outcome !== 'checkpointed') throw new Error('TASK_RUN_EXTERNAL_OPERATION_UNRESOLVED')
        state.external_operation_states.delete(operationId)
      }
      const withExternalOperation = async <T>(kind: TaskRunExternalOperationKind, operation: () => Promise<T>): Promise<{ value: T; operation_id: string }> => {
        const operationId = await beginExternalOperation(kind)
        try {
          const value = await operation()
          await recordExternalOperationResult(operationId)
          return { value, operation_id: operationId }
        } catch (error) {
          await markExternalOperationUnknown(operationId).catch(() => undefined)
          throw error
        }
      }

      if (request.operation === 'external_operation_begin') {
        const kind = request.value && typeof request.value === 'object'
          ? (request.value as { kind?: unknown }).kind
          : undefined
        if (typeof kind !== 'string' || !(TASK_RUN_EXTERNAL_OPERATION_KINDS as readonly string[]).includes(kind)) return { ok: false }
        const operationId = await beginExternalOperation(kind as TaskRunExternalOperationKind)
        return { ok: true, value: { operation_id: operationId } }
      }
      if (request.operation === 'external_operation_result') {
        const operationId = request.value && typeof request.value === 'object'
          ? (request.value as { operation_id?: unknown }).operation_id
          : undefined
        if (typeof operationId !== 'string') return { ok: false }
        await recordExternalOperationResult(operationId)
        return { ok: true }
      }
      if (request.operation === 'external_operation_checkpoint') {
        const value = request.value && typeof request.value === 'object'
          ? request.value as { operation_id?: unknown; checkpoint_digest?: unknown }
          : undefined
        if (!value || typeof value.operation_id !== 'string' || typeof value.checkpoint_digest !== 'string') return { ok: false }
        await checkpointExternalOperation(value.operation_id, value.checkpoint_digest)
        return { ok: true }
      }
      if (request.operation === 'external_operation_mcp_checkpoint') {
        const value = request.value && typeof request.value === 'object'
          ? request.value as { operation_id?: unknown; snapshot?: unknown }
          : undefined
        const snapshot = value?.snapshot
        if (!value || typeof value.operation_id !== 'string' || !snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return { ok: false }
        const record = snapshot as { digest?: unknown; tool_count?: unknown; command_count?: unknown; mcp_server_count?: unknown }
        if (
          typeof record.digest !== 'string'
          || typeof record.tool_count !== 'number' || !Number.isSafeInteger(record.tool_count)
          || typeof record.command_count !== 'number' || !Number.isSafeInteger(record.command_count)
          || typeof record.mcp_server_count !== 'number' || !Number.isSafeInteger(record.mcp_server_count)
        ) return { ok: false }
        await checkpointMcpPrepare(value.operation_id, {
          digest: record.digest,
          tool_count: record.tool_count,
          command_count: record.command_count,
          mcp_server_count: record.mcp_server_count,
        })
        return { ok: true }
      }
      if (request.operation === 'external_operation_unknown') {
        const operationId = request.value && typeof request.value === 'object'
          ? (request.value as { operation_id?: unknown }).operation_id
          : undefined
        if (typeof operationId !== 'string') return { ok: false }
        await markExternalOperationUnknown(operationId)
        return { ok: true }
      }

      const effectKind = coreExternalOperationKind(request.operation)
      if (!effectKind && request.operation !== 'stop' && request.operation !== 'shutdown') {
        await this.bindings.assertTaskRunExecutionClaim(capability.run_id, capability.dispatch_generation, capability.execution_claim_token)
        if (state.closed) return { ok: false }
      }
      if (request.operation === 'prepare') return { ok: true, value: await withExternalOperation('mcp_prepare', async () => await runtime.prepare()) }
      if (request.operation === 'engine_tools') return {
        ok: true,
        value: await withExternalOperation('mcp_prepare', async () => ({
          surface: await runtime.engineTools(),
          snapshot: await runtime.prepare(),
        })),
      }
      if (request.operation === 'chat_prompt' && request.value && typeof request.value === 'object') {
        const value = request.value as { text?: unknown; attachments?: unknown }
        const text = value.text
        const attachments = value.attachments
        if (typeof text !== 'string' || !Array.isArray(attachments) || attachments.some(file => typeof file !== 'string')) return { ok: false }
        return { ok: true, value: await withExternalOperation('chat_prompt', async () => await runtime.chatPrompt(text, attachments as string[])) }
      }
      if (request.operation === 'command_prompt' && request.value && typeof request.value === 'object') {
        const value = request.value as { name?: unknown; args?: unknown }
        const name = value.name
        const args = value.args
        if (typeof name !== 'string' || typeof args !== 'string') return { ok: false }
        return { ok: true, value: await withExternalOperation('command_prompt', async () => await runtime.commandPrompt(name, args)) }
      }
      if (request.operation === 'model') {
        const completed = await withExternalOperation('model', async () => {
          for await (const chunk of runtime.model(request.value as never)) relay({ type: 'runtime_chunk', id: request.id, value: chunk })
        })
        return { ok: true, value: { operation_id: completed.operation_id } }
      }
      if (request.operation === 'engine_model' && request.value && typeof request.value === 'object') {
        const value = request.value as Record<string, unknown>
        const operationId = value.operation_id
        if (typeof operationId !== 'string' || state.external_operation_states.get(operationId) !== 'in_flight') return { ok: false }
        const { operation_id: _operationId, ...modelRequest } = value
        for await (const chunk of runtime.engineModel(modelRequest as never)) relay({ type: 'runtime_chunk', id: request.id, value: chunk })
        return { ok: true }
      }
      if (request.operation === 'hook_model' && request.value && typeof request.value === 'object') {
        const value = request.value as { operation_id?: unknown; prompt?: unknown; model?: unknown; timeout_ms?: unknown }
        if (
          typeof value.operation_id !== 'string'
          || state.external_operation_states.get(value.operation_id) !== 'in_flight'
          || typeof value.prompt !== 'string' || value.prompt.length === 0 || value.prompt.length > 100_000
          || (value.model !== undefined && (typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 512))
          || (value.timeout_ms !== undefined && (typeof value.timeout_ms !== 'number' || !Number.isSafeInteger(value.timeout_ms) || value.timeout_ms < 1_000 || value.timeout_ms > 600_000))
        ) return { ok: false }
        for await (const chunk of runtime.hookModel({
          prompt: value.prompt,
          ...(typeof value.model === 'string' ? { model: value.model } : {}),
          ...(typeof value.timeout_ms === 'number' ? { timeout_ms: value.timeout_ms } : {}),
        })) {
          relay({ type: 'runtime_chunk', id: request.id, value: chunk })
        }
        return { ok: true }
      }
      if (request.operation === 'model_ack' && request.value && typeof request.value === 'object') {
        const value = request.value as { operation_id?: unknown; receipt?: unknown }
        if (
          typeof value.operation_id !== 'string'
          || state.external_operation_states.get(value.operation_id) !== 'in_flight'
          || !validProductModelOperationReceipt(value.receipt)
        ) return { ok: false }
        await runtime.acknowledgeModelResult(value.receipt)
        return { ok: true }
      }
      if (request.operation === 'engine_tool' && request.value && typeof request.value === 'object') {
        const value = request.value as Record<string, unknown>
        const operationId = value.operation_id
        if (typeof operationId !== 'string' || state.external_operation_states.get(operationId) !== 'in_flight') return { ok: false }
        const { operation_id: _operationId, ...toolRequest } = value
        return { ok: true, value: await runtime.engineTool({ ...toolRequest, parent_operation_id: operationId } as never) }
      }
      if (request.operation === 'plan' && request.value && typeof request.value === 'object') {
        const value = request.value as { operation_id?: unknown; plan?: unknown }
        if (
          typeof value.operation_id !== 'string'
          || state.external_operation_states.get(value.operation_id) !== 'in_flight'
          || !value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan)
        ) return { ok: false }
        await this.bindings.recordTaskRunPlan(
          capability.run_id,
          capability.dispatch_generation,
          value.plan as ProductTaskPlan,
          capability.execution_claim_token,
        )
        return { ok: true }
      }
      if (request.operation === 'tools') return { ok: true, value: await withExternalOperation('tools', async () => await runtime.tools(request.value as never)) }
      if (request.operation === 'approval' && request.value && typeof request.value === 'object') {
        const value = request.value as { requestId?: unknown; approved?: unknown }
        if (typeof value.requestId !== 'string' || typeof value.approved !== 'boolean') return { ok: false }
        await runtime.approve(value.requestId, value.approved)
      }
      else if (request.operation === 'question' && request.value && typeof request.value === 'object') {
        const value = request.value as { requestId?: unknown; answers?: unknown }
        if (typeof value.requestId !== 'string' || !Array.isArray(value.answers) || value.answers.some(answer => typeof answer !== 'string')) return { ok: false }
        await runtime.answer(value.requestId, value.answers as string[])
      }
      else if (request.operation === 'stop') await runtime.stop()
      else if (request.operation === 'shutdown') { state.unsubscribe?.(); state.unsubscribe = undefined; await runtime.shutdown() }
      else return { ok: false }
      return { ok: true }
    } catch { return { ok: false } }
  }
}
