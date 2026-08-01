import type { AgentWorkerChild, AgentWorkerChildLauncher, AgentWorkerCoreIdentity } from '../product/agentWorkerSupervisor.js'
import { buildProviderRegistryRuntimeEnv, validateProviderRuntimeConfiguration } from '../../../../gateway/providerRegistry.js'
import type { AgentWorkerCoreFactory } from '../product/agentWorkerService.js'
import { stripHostOnlyGatewayEnv } from '../services/gatewayEnv.js'
import type { ProductAgentHostRuntime } from './productAgentHostRuntime.js'
import { getProductMcpOAuthMasterKey, PRODUCT_MCP_OAUTH_KEY_ENV } from './productMcpOAuth.js'

type LaunchInput = Parameters<AgentWorkerChildLauncher['launch']>[0]
type CoreBinding = { session_id: string; work_dir: string; provider: string; model: string; model_route_fingerprint: string; model_attempt_id: string }
const PROVIDER_RUNTIME_ENV_KEYS = [
  'BB_GATEWAY_MODEL',
  'BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS',
  'BILLIARDBUDDY_AUTO_COMPACT_WINDOW',
  'BB_PROVIDER_CONTRACT_VERSION',
  'BB_PROVIDER_REGISTRY_SHA256',
  'BB_PROVIDER_WORKER_MANIFEST_SHA256',
] as const
export type TaskRunCoreBindingResolver = { resolveTaskRunCoreBinding(runId: string, generation: number): Promise<CoreBinding> }
export type ServerPrivateCoreFactory = { start(identity: AgentWorkerCoreIdentity, binding: CoreBinding, input: Parameters<AgentWorkerCoreFactory['start']>[0]): Promise<ProductAgentHostRuntime> }

export function resolveAgentWorkerCommand(
  env: NodeJS.ProcessEnv = process.env,
  executable = process.execPath,
): string[] {
  return env.BB_COMPILED_SIDECAR === '1'
    ? [executable, 'agent-worker']
    : [executable, new URL('../../entrypoints/agent-worker.ts', import.meta.url).pathname]
}

/** Bun IPC is the only transport carrying a child bootstrap; stdout remains framed protocol only. */
export class IpcAgentWorkerLauncher implements AgentWorkerChildLauncher {
  constructor(private readonly bindings: TaskRunCoreBindingResolver, private readonly cores: ServerPrivateCoreFactory, private readonly command: string[] = resolveAgentWorkerCommand()) {}
  async launch(input: LaunchInput): Promise<AgentWorkerChild> {
    const state: { runtime?: ProductAgentHostRuntime; binding?: CoreBinding; unsubscribe?: () => void; starting?: Promise<ProductAgentHostRuntime> } = {}
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
    const failConfiguration = () => {
      if (configurationFatalSent) return
      configurationFatalSent = true
      input.onMessage({ type: 'fatal', code: 'MODEL_CONFIGURATION_INVALID' })
      proc.kill()
    }
    proc = Bun.spawn(this.command, {
      stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', serialization: 'advanced',
      env: { ...workerEnv, ...providerEnv },
      ipc: (message, child) => {
        const record = message && typeof message === 'object' ? message as Record<string, unknown> : undefined
        if (record?.type === 'worker_outbound') {
          if (configurationError) return failConfiguration()
          input.onMessage(record.message as never); return
        }
        if (record?.type !== 'core_request' || typeof record.id !== 'string' || typeof record.operation !== 'string') return
        void this.handleCoreRequest(state, record, input, (outbound) => child.send(outbound)).then((next) => { child.send({ type: 'core_result', id: record.id, ok: next.ok, ...(next.value !== undefined ? { value: next.value } : {}) }) })
      },
    })
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
      stop: async () => { state.unsubscribe?.(); proc.kill(); await proc.exited },
    }
  }
  private async handleCoreRequest(state: { runtime?: ProductAgentHostRuntime; binding?: CoreBinding; unsubscribe?: () => void; starting?: Promise<ProductAgentHostRuntime> }, request: Record<string, unknown>, input: LaunchInput, relay: (message: unknown) => void): Promise<{ ok: boolean; value?: unknown }> {
    try {
      if (request.operation === 'start' && !state.runtime) {
        const value = request.value as { run_id?: unknown; dispatch_generation?: unknown; envelope_digest?: unknown; permission_envelope?: { digest?: unknown }; scheduler_receipt?: { fencing_token?: unknown } } | undefined
        if (!value || value.run_id !== input.bootstrap.capability.run_id || value.dispatch_generation !== input.bootstrap.capability.dispatch_generation || value.envelope_digest !== input.bootstrap.capability.envelope_digest || value.permission_envelope?.digest !== value.envelope_digest || value.scheduler_receipt?.fencing_token !== input.bootstrap.capability.fencing_token) return { ok: false }
        state.starting ??= this.bindings.resolveTaskRunCoreBinding(value.run_id as string, value.dispatch_generation as number).then(binding => {
          state.binding = binding
          return this.cores.start(input.core, binding, value as Parameters<AgentWorkerCoreFactory['start']>[0])
        })
        try {
          state.runtime = await state.starting
          state.unsubscribe = state.runtime.subscribe(message => relay({ type: 'runtime_event', message }))
        } finally { state.starting = undefined }
        return { ok: true, value: { identity: input.core, binding: state.binding } }
      }
      if (!state.runtime) return { ok: false }
      if (request.operation === 'prepare') return { ok: true, value: await state.runtime.prepare() }
      if (request.operation === 'chat_prompt' && request.value && typeof request.value === 'object') { const value = request.value as { text?: unknown; attachments?: unknown }; if (typeof value.text !== 'string' || !Array.isArray(value.attachments) || value.attachments.some(file => typeof file !== 'string')) return { ok: false }; return { ok: true, value: await state.runtime.chatPrompt(value.text, value.attachments as string[]) } }
      if (request.operation === 'command_prompt' && request.value && typeof request.value === 'object') { const value = request.value as { name?: unknown; args?: unknown }; if (typeof value.name !== 'string' || typeof value.args !== 'string') return { ok: false }; return { ok: true, value: await state.runtime.commandPrompt(value.name, value.args) } }
      if (request.operation === 'model') {
        for await (const chunk of state.runtime.model(request.value as never)) relay({ type: 'runtime_chunk', id: request.id, value: chunk })
      }
      else if (request.operation === 'tools') return { ok: true, value: await state.runtime.tools(request.value as never) }
      else if (request.operation === 'approval' && request.value && typeof request.value === 'object') { const value = request.value as { requestId?: unknown; approved?: unknown }; if (typeof value.requestId !== 'string' || typeof value.approved !== 'boolean') return { ok: false }; await state.runtime.approve(value.requestId, value.approved) }
      else if (request.operation === 'question' && request.value && typeof request.value === 'object') { const value = request.value as { requestId?: unknown; answers?: unknown }; if (typeof value.requestId !== 'string' || !Array.isArray(value.answers) || value.answers.some(answer => typeof answer !== 'string')) return { ok: false }; await state.runtime.answer(value.requestId, value.answers as string[]) }
      else if (request.operation === 'stop') await state.runtime.stop()
      else if (request.operation === 'shutdown') { state.unsubscribe?.(); state.unsubscribe = undefined; await state.runtime.shutdown() }
      else return { ok: false }
      return { ok: true }
    } catch { return { ok: false } }
  }
}
