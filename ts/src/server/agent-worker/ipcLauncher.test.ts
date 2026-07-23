import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IpcAgentWorkerLauncher } from './ipcLauncher.js'
import { AgentWorkerSupervisor } from '../product/agentWorkerSupervisor.js'

const receipt = { job_id: 'agent-worker:run:1', outcome: 'admitted' as const, profile_revision: 'p', resource_keys: ['agent.worker'] as const, fencing_token: 1, lease: { owner_id: 'owner', process_id: 'p', process_generation: 'g', fencing_token: 1, expires_at: '2027-01-01T00:00:00.000Z' } }
const providerRuntimeKeys = ['QF_GATEWAY_MODEL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'BB_PROVIDER_CONTRACT_VERSION', 'BB_PROVIDER_REGISTRY_SHA256', 'BB_PROVIDER_WORKER_MANIFEST_SHA256'] as const

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
      { start: async (identity, binding) => { starts++; expect(identity).toEqual({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable turn' }); expect(binding.session_id).toBe('session'); return { input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} } } },
    )
    const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
    expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(100)
    expect(claims).toBe(1); expect(resolves).toBe(1); expect(starts).toBe(1); expect(settled).toEqual([]); await supervisor.stop('run', 1)
  })
})

test('server-owned IPC launcher rejects unknown, stale, non-text, and mixed model bindings before any Core start', async () => {
  const invalidCases: Array<Partial<Record<(typeof providerRuntimeKeys)[number], string>>> = [
    { QF_GATEWAY_MODEL: 'unknown-model' },
    { ANTHROPIC_DEFAULT_OPUS_MODEL: 'unknown-model' },
    { QF_GATEWAY_MODEL: 'mimo-v2.5' },
    { QF_GATEWAY_MODEL: 'gpt-image-2' },
    { QF_GATEWAY_MODEL: 'fun-asr-flash-2026-06-15' },
    { ANTHROPIC_DEFAULT_HAIKU_MODEL: 'mimo-v2.5' },
    { QF_GATEWAY_MODEL: 'deepseek-v4-flash', ANTHROPIC_MODEL: 'mimo-v2.5' },
    { BB_PROVIDER_REGISTRY_SHA256: '0'.repeat(64) },
    { BB_PROVIDER_WORKER_MANIFEST_SHA256: '0'.repeat(64) },
    { BB_PROVIDER_CONTRACT_VERSION: '999' },
  ]
  for (const env of invalidCases) {
    await withProviderRuntimeEnv(env, async () => {
      let starts = 0; let resolves = 0; const settled: string[] = []
      const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable turn' }), claimTaskRunDispatch: async () => ({ outcome: 'claimed' as const, task_id: 'task' }), settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string) => { settled.push(`${state}:${error}`) } }
      const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
      const launcher = new IpcAgentWorkerLauncher(
        { resolveTaskRunCoreBinding: async () => { resolves++; return { session_id: 'session', work_dir: process.cwd() } } },
        { start: async () => { starts++; return { input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} } } },
      )
      const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
      expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(100)
      expect(resolves, JSON.stringify(env)).toBe(0); expect(starts, JSON.stringify(env)).toBe(0); expect(settled).toEqual(['recovery_required:模型配置无效'])
    })
  }
})

test('complete explicit TextReasoning binding reaches one real child Core start', async () => {
  await withProviderRuntimeEnv({
    QF_GATEWAY_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-flash',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-flash',
  }, async () => {
    let starts = 0; const settled: string[] = []
    const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable turn' }), claimTaskRunDispatch: async () => ({ outcome: 'claimed' as const, task_id: 'task' }), settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string) => { settled.push(`${state}:${error}`) } }
    const scheduler = { profileRevision: () => 'p', submit: async () => receipt, complete: async () => receipt } as any
    const launcher = new IpcAgentWorkerLauncher(
      { resolveTaskRunCoreBinding: async () => ({ session_id: 'session', work_dir: process.cwd() }) },
      { start: async () => { starts++; return { input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} } } },
    )
    const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
    expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(100)
    expect(starts).toBe(1); expect(settled).toEqual([]); await supervisor.stop('run', 1)
  })
})

test('actual agent-worker child receives no host gateway credentials while retaining IPC-safe environment', async () => {
  await withProviderRuntimeEnv({}, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bb-agent-worker-env-'))
  const output = join(directory, 'env.json')
  const keys = ['QF_GATEWAY_TOKEN', 'QF_GATEWAY_BOOTSTRAP_CREDENTIAL', 'QF_LICENSE_KEY', 'QF_GATEWAY_REFRESH_TOKEN', 'QF_GATEWAY_SESSION', 'QF_GATEWAY_SESSION_PROOF', 'BB_INSTALLATION_ID', 'QF_GATEWAY_URL'] as const
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const originalOutput = process.env.BB_AGENT_WORKER_ENV_OUTPUT
  const originalIpc = process.env.BB_AGENT_WORKER_IPC_SAFE
  try {
    for (const key of keys) process.env[key] = 'host-secret'
    process.env.BB_AGENT_WORKER_ENV_OUTPUT = output
    process.env.BB_AGENT_WORKER_IPC_SAFE = 'preserved'
    const launcher = new IpcAgentWorkerLauncher(
      { resolveTaskRunCoreBinding: async () => ({ session_id: 'unused', work_dir: process.cwd() }) },
      { start: async () => ({ input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} }) },
      [process.execPath, '-e', "await Bun.write(process.env.BB_AGENT_WORKER_ENV_OUTPUT, JSON.stringify({ token: process.env.QF_GATEWAY_TOKEN, bootstrap: process.env.QF_GATEWAY_BOOTSTRAP_CREDENTIAL, license: process.env.QF_LICENSE_KEY, refresh: process.env.QF_GATEWAY_REFRESH_TOKEN, session: process.env.QF_GATEWAY_SESSION, proof: process.env.QF_GATEWAY_SESSION_PROOF, installation: process.env.BB_INSTALLATION_ID, ipc: process.env.BB_AGENT_WORKER_IPC_SAFE }))"],
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
