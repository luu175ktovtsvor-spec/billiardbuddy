import type { AgentWorkerChild, AgentWorkerChildLauncher, AgentWorkerCoreIdentity } from '../product/agentWorkerSupervisor.js'
import { buildProviderRegistryRuntimeEnv, validateProviderRuntimeConfiguration } from '../../../../gateway/providerRegistry.js'
import type { AgentWorkerCore, AgentWorkerCoreFactory } from '../product/agentWorkerService.js'
import { stripHostOnlyGatewayEnv } from '../services/gatewayEnv.js'

type LaunchInput = Parameters<AgentWorkerChildLauncher['launch']>[0]
type CoreBinding = { session_id: string; work_dir: string }
const PROVIDER_RUNTIME_ENV_KEYS = [
  'QF_GATEWAY_MODEL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'BB_PROVIDER_CONTRACT_VERSION',
  'BB_PROVIDER_REGISTRY_SHA256',
  'BB_PROVIDER_WORKER_MANIFEST_SHA256',
] as const
export type TaskRunCoreBindingResolver = { resolveTaskRunCoreBinding(runId: string, generation: number): Promise<CoreBinding> }
export type ServerPrivateCoreFactory = { start(identity: AgentWorkerCoreIdentity, binding: CoreBinding, input: Parameters<AgentWorkerCoreFactory['start']>[0]): Promise<AgentWorkerCore> }

/** Bun IPC is the only transport carrying a child bootstrap; stdout remains framed protocol only. */
export class IpcAgentWorkerLauncher implements AgentWorkerChildLauncher {
  constructor(private readonly bindings: TaskRunCoreBindingResolver, private readonly cores: ServerPrivateCoreFactory, private readonly command: string[] = [process.execPath, new URL('../../entrypoints/agent-worker.ts', import.meta.url).pathname]) {}
  async launch(input: LaunchInput): Promise<AgentWorkerChild> {
    const state: { core?: AgentWorkerCore; unsubscribe?: () => void; starting?: Promise<AgentWorkerCore> } = {}
    // Snapshot all non-secret model inputs before normalizing the child env.  An
    // explicit invalid override must remain invalid; only a wholly absent model
    // configuration is allowed to receive the registry default.
    const inheritedEnv = stripHostOnlyGatewayEnv(process.env)
    const configured = Object.fromEntries(PROVIDER_RUNTIME_ENV_KEYS.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]))
    const providerEnv = { ...buildProviderRegistryRuntimeEnv(configured.QF_GATEWAY_MODEL), ...configured }
    const configurationError = validateProviderRuntimeConfiguration(providerEnv)
    const workerEnv = { ...inheritedEnv }
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
        void this.handleCoreRequest(state, record, input, (outbound) => child.send(outbound)).then((next) => { child.send({ type: 'core_result', id: record.id, ok: next.ok }) })
      },
    })
    proc.send({ type: 'bootstrap', bootstrap: input.bootstrap })
    void (async () => { if (!proc.stdout) return; const reader = proc.stdout.getReader(); while (!(await reader.read()).done) {} })()
    return { send: message => { proc.stdin.write(`${JSON.stringify(message)}\n`) }, stop: async () => { state.unsubscribe?.(); proc.kill(); await proc.exited } }
  }
  private async handleCoreRequest(state: { core?: AgentWorkerCore; unsubscribe?: () => void; starting?: Promise<AgentWorkerCore> }, request: Record<string, unknown>, input: LaunchInput, relay: (message: unknown) => void): Promise<{ ok: boolean }> {
    try {
      if (request.operation === 'start' && !state.core) {
        const value = request.value as { run_id?: unknown; dispatch_generation?: unknown; envelope_digest?: unknown; permission_envelope?: { digest?: unknown }; scheduler_receipt?: { fencing_token?: unknown } } | undefined
        if (!value || value.run_id !== input.bootstrap.capability.run_id || value.dispatch_generation !== input.bootstrap.capability.dispatch_generation || value.envelope_digest !== input.bootstrap.capability.envelope_digest || value.permission_envelope?.digest !== value.envelope_digest || value.scheduler_receipt?.fencing_token !== input.bootstrap.capability.fencing_token) return { ok: false }
        state.starting ??= this.bindings.resolveTaskRunCoreBinding(value.run_id as string, value.dispatch_generation as number).then(binding => this.cores.start(input.core, binding, value as Parameters<AgentWorkerCoreFactory['start']>[0]))
        try {
          state.core = await state.starting
          // Private Bun IPC is the sole Core->child transport. The child
          // translates it into its framed stdout protocol.
          state.unsubscribe = state.core.subscribe?.((message) => relay({ type: 'core_message', message }))
        } finally { state.starting = undefined }
        return { ok: true }
      }
      if (!state.core) return { ok: false }
      if (request.operation === 'input' && typeof request.value === 'string') await state.core.input(request.value, input.core.initial_attachments)
      else if (request.operation === 'approval' && request.value && typeof request.value === 'object') { const value = request.value as { requestId?: unknown; approved?: unknown }; if (typeof value.requestId !== 'string' || typeof value.approved !== 'boolean') return { ok: false }; await state.core.approve(value.requestId, value.approved) }
      else if (request.operation === 'stop') await state.core.stop()
      else if (request.operation === 'shutdown') { state.unsubscribe?.(); state.unsubscribe = undefined; await state.core.shutdown() }
      else return { ok: false }
      return { ok: true }
    } catch { return { ok: false } }
  }
}
