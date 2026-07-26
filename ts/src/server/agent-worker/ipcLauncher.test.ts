import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpcAgentWorkerLauncher, resolveAgentWorkerCommand } from './ipcLauncher.js'
import { AgentWorkerSupervisor } from '../product/agentWorkerSupervisor.js'

const receipt = { job_id: 'agent-worker:run:1', outcome: 'admitted' as const, profile_revision: 'p', resource_keys: ['agent.worker'] as const, fencing_token: 1, lease: { owner_id: 'owner', process_id: 'p', process_generation: 'g', fencing_token: 1, expires_at: '2027-01-01T00:00:00.000Z' } }
const providerRuntimeKeys = ['BB_GATEWAY_MODEL', 'BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS', 'BILLIARDBUDDY_AUTO_COMPACT_WINDOW', 'BB_PROVIDER_CONTRACT_VERSION', 'BB_PROVIDER_REGISTRY_SHA256', 'BB_PROVIDER_WORKER_MANIFEST_SHA256'] as const
const emptyHostRuntime = () => ({
  prepare: async () => ({ commands: [], tools: [], mcp_clients: [] }),
  commandPrompt: async () => [],
  chatPrompt: async (text: string) => text,
  async *model() { await new Promise(() => {}) },
  tools: async () => [],
  approve: async () => {},
  answer: async () => {},
  stop: async () => {},
  shutdown: async () => {},
  subscribe: () => () => {},
})
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await Bun.sleep(10)
}

test('packaged Product Server starts the worker through the internal sidecar mode', () => {
  expect(resolveAgentWorkerCommand({ BB_COMPILED_SIDECAR: '1' }, '/app/billiardbuddy-sidecar')).toEqual([
    '/app/billiardbuddy-sidecar',
    'agent-worker',
  ])
  expect(resolveAgentWorkerCommand({}, '/usr/local/bin/bun')[0]).toBe('/usr/local/bin/bun')
  expect(resolveAgentWorkerCommand({}, '/usr/local/bin/bun')[1]).toEndWith('/src/entrypoints/agent-worker.ts')
})

async function withProviderRuntimeEnv<T>(values: Partial<Record<(typeof providerRuntimeKeys)[number], string>>, action: () => Promise<T>): Promise<T> {
  const original = Object.fromEntries(providerRuntimeKeys.map(key => [key, process.env[key]]))
  try {
    for (const key of providerRuntimeKeys) delete process.env[key]
    Object.assign(process.env, values)
    return await action()
  } finally {
    for (const key of providerRuntimeKeys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
  }
}

test('empty worker model configuration receives the Registry TextReasoning binding and invokes one private Core factory', async () => {
  await withProviderRuntimeEnv({}, async () => {
    let claims = 0; let starts = 0; const settled: string[] = []
    const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable turn' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed' as const, task_id: 'task' } }, settleTaskRunDispatch: async (_r: string, _g: number, state: string) => { settled.push(state) } }
    const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
    let resolves = 0
    const launcher = new IpcAgentWorkerLauncher(
      { resolveTaskRunCoreBinding: async (run, generation) => { resolves++; expect([run, generation]).toEqual(['run', 1]); return { session_id: 'session', work_dir: process.cwd() } } },
      { start: async (identity, binding) => { starts++; expect(identity).toEqual({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable turn' }); expect(binding.session_id).toBe('session'); return emptyHostRuntime() } },
    )
    const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
    expect(await supervisor.dispatch('run', 1)).toBe('started'); await waitFor(() => starts === 1)
    expect(claims).toBe(1); expect(resolves).toBe(1); expect(starts).toBe(1); expect(settled).toEqual([]); await supervisor.stop('run', 1)
  })
})

test('server-owned IPC launcher rejects unknown, stale, non-text, and mixed model bindings before any Core start', async () => {
  const invalidCases: Array<Partial<Record<(typeof providerRuntimeKeys)[number], string>>> = [
    { BB_GATEWAY_MODEL: 'unknown-model' },
    { BB_GATEWAY_MODEL: 'mimo-v2.5' },
    { BB_GATEWAY_MODEL: 'gpt-image-2' },
    { BB_GATEWAY_MODEL: 'fun-asr-flash-2026-06-15' },
    { BILLIARDBUDDY_MODEL_CONTEXT_WINDOWS: '{}' },
    { BILLIARDBUDDY_AUTO_COMPACT_WINDOW: '1' },
    { BB_PROVIDER_REGISTRY_SHA256: '0'.repeat(64) },
    { BB_PROVIDER_WORKER_MANIFEST_SHA256: '0'.repeat(64) },
    { BB_PROVIDER_CONTRACT_VERSION: '999' },
  ]
  for (const env of invalidCases) {
    await withProviderRuntimeEnv(env, async () => {
      let starts = 0; let resolves = 0; const settled: string[] = []; const failures: unknown[] = []
      const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable turn' }), claimTaskRunDispatch: async () => ({ outcome: 'claimed' as const, task_id: 'task' }), settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string, failure?: unknown) => { settled.push(`${state}:${error}`); failures.push(failure) } }
      const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
      const launcher = new IpcAgentWorkerLauncher(
        { resolveTaskRunCoreBinding: async () => { resolves++; return { session_id: 'session', work_dir: process.cwd() } } },
        { start: async () => { starts++; return emptyHostRuntime() } },
      )
      const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
      expect(await supervisor.dispatch('run', 1)).toBe('started'); await waitFor(() => settled.length > 0)
      expect(resolves, JSON.stringify(env)).toBe(0); expect(starts, JSON.stringify(env)).toBe(0); expect(settled).toEqual(['recovery_required:MODEL_CONFIGURATION_INVALID']); expect(failures).toEqual([{ code: 'task_model_configuration', retryable: false }])
    })
  }
}, 20_000)

test('complete explicit TextReasoning binding reaches one real child Core start', async () => {
  await withProviderRuntimeEnv({
    BB_GATEWAY_MODEL: 'deepseek-v4-flash',
  }, async () => {
    let starts = 0; const settled: string[] = []
    const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable turn' }), claimTaskRunDispatch: async () => ({ outcome: 'claimed' as const, task_id: 'task' }), settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string) => { settled.push(`${state}:${error}`) } }
    const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
    const launcher = new IpcAgentWorkerLauncher(
      { resolveTaskRunCoreBinding: async () => ({ session_id: 'session', work_dir: process.cwd() }) },
      { start: async () => { starts++; return emptyHostRuntime() } },
    )
    const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
    expect(await supervisor.dispatch('run', 1)).toBe('started'); await waitFor(() => starts === 1)
    expect(starts).toBe(1); expect(settled).toEqual([]); await supervisor.stop('run', 1)
  })
})

test('real worker owns the Harness loop while the Host samples models and executes tools', async () => {
  await withProviderRuntimeEnv({}, async () => {
    const recorded: unknown[] = []
    let modelSamples = 0
    let hostToolExecutions = 0
    const runtime = {
      prepare: async () => ({ commands: [], tools: [{ name: 'HostProbe' }], mcp_clients: [] }),
      commandPrompt: async () => [],
      chatPrompt: async (text: string) => text,
      async *model(request: { messages: unknown[] }) {
        modelSamples++
        if (modelSamples === 1) {
          yield {
            type: 'assistant', uuid: 'assistant-tool', timestamp: new Date(0).toISOString(),
            message: { id: 'response-tool', role: 'assistant', content: [{ type: 'tool_call', id: 'probe-1', name: 'HostProbe', arguments: { value: 'check' } }], model: 'deepseek-v4-flash', stop_reason: 'tool_call', usage: { input_tokens: 1, output_tokens: 1 } },
          }
          return
        }
        expect(JSON.stringify(request.messages)).toContain('host-evidence')
        yield {
          type: 'assistant', uuid: 'assistant-final', timestamp: new Date(0).toISOString(),
          message: { id: 'response-final', role: 'assistant', content: [{ type: 'text', text: '跨进程闭环完成。' }], model: 'deepseek-v4-flash', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        }
      },
      tools: async () => {
        hostToolExecutions++
        return [{ type: 'user', uuid: 'tool-result', timestamp: new Date(0).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_call_id: 'probe-1', content: 'host-evidence' }] } }]
      },
      approve: async () => {}, answer: async () => {}, stop: async () => {}, shutdown: async () => {}, subscribe: () => () => {},
    }
    const runs = {
      readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: '执行跨进程验证' }),
      claimTaskRunDispatch: async () => ({ outcome: 'claimed' as const, task_id: 'task' }),
      settleTaskRunDispatch: async () => {},
    }
    const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
    const launcher = new IpcAgentWorkerLauncher(
      { resolveTaskRunCoreBinding: async () => ({ session_id: 'session', work_dir: process.cwd() }) },
      { start: async () => runtime },
    )
    const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher, 5_000, { record: async (_run, _generation, message) => { recorded.push(message) } })
    expect(await supervisor.dispatch('run', 1)).toBe('started')
    await waitFor(() => recorded.some(message => (
      message && typeof message === 'object' && (message as { type?: unknown }).type === 'terminal'
    )), 5_000)

    expect(modelSamples).toBe(2)
    expect(hostToolExecutions).toBe(1)
    expect(recorded).toContainEqual(expect.objectContaining({ type: 'event', event: 'extension_snapshot', tool_count: 1 }))
    expect(recorded).toContainEqual({ type: 'event', event: 'delta', data: '跨进程闭环完成。' })
    expect(recorded).toContainEqual({ type: 'terminal', state: 'completed', run_id: 'run' })
    await supervisor.shutdown()
  })
}, 10_000)

test('an explicit named Agent command keeps its deterministic tool route across the private Worker boundary', async () => {
  await withProviderRuntimeEnv({}, async () => {
    const recorded: unknown[] = []
    let commandExpansions = 0
    let modelSamples = 0
    let hostToolExecutions = 0
    const runtime = {
      prepare: async () => ({
        commands: [{
          name: 'agent:agent__project__reviewer',
          description: 'Run the project reviewer',
          userInvocable: true,
          directTool: { name: 'agent__project__reviewer', argument: 'prompt' },
        }],
        tools: [{ name: 'agent__project__reviewer' }],
        mcp_clients: [],
      }),
      commandPrompt: async (_name: string, args: string) => {
        commandExpansions++
        return [{ type: 'text', text: `Assigned to reviewer:\n${args}` }]
      },
      chatPrompt: async (text: string) => text,
      async *model(request: { messages: unknown[] }) {
        modelSamples++
        expect(JSON.stringify(request.messages)).toContain('reviewer-evidence')
        yield {
          type: 'assistant', uuid: 'assistant-final', timestamp: new Date(0).toISOString(),
          message: { id: 'response-final', role: 'assistant', content: [{ type: 'text', text: '指定 Agent 已完成。' }], model: 'deepseek-v4-flash', stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } },
        }
      },
      tools: async (request: { blocks: Array<{ id: string; name: string; arguments: Record<string, unknown> }> }) => {
        hostToolExecutions++
        expect(request.blocks).toEqual([expect.objectContaining({
          name: 'agent__project__reviewer',
          arguments: { prompt: 'inspect auth.ts' },
        })])
        return [{
          type: 'user', uuid: 'tool-result', timestamp: new Date(0).toISOString(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_call_id: request.blocks[0]!.id, content: 'reviewer-evidence' }] },
        }]
      },
      approve: async () => {}, answer: async () => {}, stop: async () => {}, shutdown: async () => {}, subscribe: () => () => {},
    }
    const runs = {
      readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: '/agent:agent__project__reviewer inspect auth.ts' }),
      claimTaskRunDispatch: async () => ({ outcome: 'claimed' as const, task_id: 'task' }),
      settleTaskRunDispatch: async () => {},
    }
    const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
    const launcher = new IpcAgentWorkerLauncher(
      { resolveTaskRunCoreBinding: async () => ({ session_id: 'session', work_dir: process.cwd() }) },
      { start: async () => runtime },
    )
    const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher, 5_000, { record: async (_run, _generation, message) => { recorded.push(message) } })
    expect(await supervisor.dispatch('run', 1)).toBe('started')
    await waitFor(() => recorded.some(message => message && typeof message === 'object' && (message as { type?: unknown }).type === 'terminal'), 5_000)

    expect(commandExpansions).toBe(1)
    expect(hostToolExecutions).toBe(1)
    expect(modelSamples).toBe(1)
    expect(recorded).toContainEqual({ type: 'event', event: 'delta', data: '指定 Agent 已完成。' })
    expect(recorded).toContainEqual({ type: 'terminal', state: 'completed', run_id: 'run' })
    await supervisor.shutdown()
  })
}, 10_000)

test('actual agent-worker child receives no host gateway credentials while retaining IPC-safe environment', async () => {
  await withProviderRuntimeEnv({}, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bb-agent-worker-env-'))
  const output = join(directory, 'env.json')
  const keys = ['BB_GATEWAY_TOKEN', 'BB_GATEWAY_BOOTSTRAP_CREDENTIAL', 'BB_LICENSE_KEY', 'BB_GATEWAY_REFRESH_TOKEN', 'BB_GATEWAY_SESSION', 'BB_GATEWAY_SESSION_PROOF', 'BB_INSTALLATION_ID', 'BB_GATEWAY_URL'] as const
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const originalOutput = process.env.BB_AGENT_WORKER_ENV_OUTPUT
  const originalIpc = process.env.BB_AGENT_WORKER_IPC_SAFE
  try {
    for (const key of keys) process.env[key] = 'host-secret'
    process.env.BB_AGENT_WORKER_ENV_OUTPUT = output
    process.env.BB_AGENT_WORKER_IPC_SAFE = 'preserved'
    const launcher = new IpcAgentWorkerLauncher(
      { resolveTaskRunCoreBinding: async () => ({ session_id: 'unused', work_dir: process.cwd() }) },
      { start: async () => emptyHostRuntime() },
      [process.execPath, '-e', "await Bun.write(process.env.BB_AGENT_WORKER_ENV_OUTPUT, JSON.stringify({ token: process.env.BB_GATEWAY_TOKEN, bootstrap: process.env.BB_GATEWAY_BOOTSTRAP_CREDENTIAL, license: process.env.BB_LICENSE_KEY, refresh: process.env.BB_GATEWAY_REFRESH_TOKEN, session: process.env.BB_GATEWAY_SESSION, proof: process.env.BB_GATEWAY_SESSION_PROOF, installation: process.env.BB_INSTALLATION_ID, ipc: process.env.BB_AGENT_WORKER_IPC_SAFE }))"],
    )
    await launcher.launch({ bootstrap: { capability: {} } } as never)
    for (let attempts = 0; attempts < 50; attempts++) {
      try { readFileSync(output, 'utf8'); break } catch { await Bun.sleep(10) }
    }
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ token: undefined, bootstrap: undefined, license: undefined, refresh: undefined, session: undefined, proof: undefined, installation: undefined, ipc: 'preserved' })
  } finally {
    for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key] }
    if (originalOutput === undefined) delete process.env.BB_AGENT_WORKER_ENV_OUTPUT; else process.env.BB_AGENT_WORKER_ENV_OUTPUT = originalOutput
    if (originalIpc === undefined) delete process.env.BB_AGENT_WORKER_IPC_SAFE; else process.env.BB_AGENT_WORKER_IPC_SAFE = originalIpc
    rmSync(directory, { recursive: true, force: true })
  }
})
})

test('entrypoint without IPC bootstrap fails closed with framed output', async () => {
  const proc = Bun.spawn([process.execPath, new URL('../../entrypoints/agent-worker.ts', import.meta.url).pathname], { stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
  proc.stdin.write('{}\n'); proc.stdin.end(); const output = await new Response(proc.stdout).text(); await proc.exited
  expect(JSON.parse(output.trim())).toEqual({ type: 'fatal', code: 'ENVELOPE_DENIED' })
})
