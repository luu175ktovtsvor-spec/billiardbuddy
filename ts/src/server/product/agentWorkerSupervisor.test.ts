import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentWorkerSupervisor } from './agentWorkerSupervisor.js'
import { AgentWorkerService } from './agentWorkerService.js'
import { ProductResourceScheduler } from './resourceScheduler.js'
import { DesktopResourceProfiles, conservativeDesktopResourceProfile } from './resourceProfiles.js'

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error('timed out waiting for supervisor state')
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-supervisor-')); const now = new Date('2026-01-01T00:00:00.000Z'); const scheduler = new ProductResourceScheduler({ statePath: path.join(root, 'scheduler.json'), now: () => now, profiles: new DesktopResourceProfiles(conservativeDesktopResourceProfile(now, 'test', 'toolchain'), () => now, 'test', 'toolchain') })
  let submits = 0; const submit = scheduler.submit.bind(scheduler); scheduler.submit = async claim => { submits++; return submit(claim) }
  const settled: string[] = []; const failures: unknown[] = []; let claims = 0; let launches = 0; const sent: unknown[] = []
  const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable user turn' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed' as const, task_id: 'task' } }, settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string, failure?: unknown) => { settled.push(`${state}:${error}`); failures.push(failure) } }
  const launcher = { launch: async (input: { onMessage: (message: any) => void }) => { launches++; const child = { send: (message: unknown) => sent.push(message), stop: async () => {} }; setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0); return child } }
  return { scheduler, runs, launcher, settled, failures, sent, get submits() { return submits }, get claims() { return claims }, get launches() { return launches } }
}

test('supervisor rejects unbound input and starts exactly one child/Core binding per durable dispatch', async () => {
  const f = await fixture(); const supervisor = new AgentWorkerSupervisor({ ...f.runs, readTaskRunDispatchIdentity: async () => { throw new Error('unbound') } }, f.scheduler, f.launcher)
  expect(await supervisor.dispatch('run', 1)).toBe('recovery_required'); expect(f.launches).toBe(0); expect(f.claims).toBe(0); expect(f.sent).toEqual([]); expect(f.settled).toEqual([])
  const bound = new AgentWorkerSupervisor(f.runs, f.scheduler, f.launcher); expect(await bound.dispatch('run', 1)).toBe('started'); expect(await bound.dispatch('run', 1)).toBe('started'); await waitFor(() => f.sent.some(message => (message as { type?: unknown }).type === 'start'))
  expect(f.launches).toBe(1); expect(f.claims).toBe(1); expect(f.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'start', run_id: 'run' })]))
  expect(await bound.approve('run', 1, 'approval-1', true)).toBeTrue()
  expect(f.sent).toEqual(expect.arrayContaining([{ type: 'approval_response', request_id: 'approval-1', approved: true }]))
  expect(await bound.approve('other', 1, 'approval-1', true)).toBeFalse()

  const preclaim = await fixture(); const unavailable = { profileRevision: () => 'test', submit: async () => { throw new Error('scheduler unavailable') } } as unknown as ProductResourceScheduler
  const failedBeforeClaim = new AgentWorkerSupervisor(preclaim.runs, unavailable, preclaim.launcher)
  expect(await failedBeforeClaim.dispatch('run', 1)).toBe('recovery_required'); expect(preclaim.claims).toBe(0); expect(preclaim.launches).toBe(0); expect(preclaim.sent).toEqual([])
})

test('supervisor fences stop and protocol mismatch into one durable settlement', async () => {
  const f = await fixture(); const badLauncher = { launch: async (input: { onMessage: (message: any) => void }) => { const child = { send: () => {}, stop: async () => {} }; setTimeout(() => input.onMessage({ type: 'hello', versions: { min: 2, max: 2 }, capabilities: [] }), 0); return child } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, badLauncher); expect(await supervisor.dispatch('run', 1)).toBe('started'); await waitFor(async () => f.settled.length === 1 && (await f.scheduler.snapshot()).active === 0); expect(f.settled).toEqual(['recovery_required:CAPABILITY_MISMATCH']); expect((await f.scheduler.snapshot()).active).toBe(0)
})

test('invalid model configuration settles before Core startup with stable product projection', async () => {
  const f = await fixture()
  const launcher = { launch: async (input: { onMessage: (message: any) => void }) => {
    const child = { send: () => {}, stop: async () => {} }
    setTimeout(() => input.onMessage({ type: 'fatal', code: 'MODEL_CONFIGURATION_INVALID' }), 0)
    return child
  } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, launcher)
  expect(await supervisor.dispatch('run', 1)).toBe('started'); await waitFor(() => f.settled.length === 1)
  expect(f.sent).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'start' })])); expect(f.settled).toEqual(['recovery_required:MODEL_CONFIGURATION_INVALID'])
  expect(f.failures).toEqual([{ code: 'task_model_configuration', retryable: false }])
})

test('concurrent dispatch calls share one startup before the first durable await', async () => {
  const f = await fixture(); const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, f.launcher)
  expect(await Promise.all([supervisor.dispatch('run', 1), supervisor.dispatch('run', 1), supervisor.dispatch('run', 1)])).toEqual(['started', 'started', 'started']); await waitFor(() => f.launches === 1)
  expect(f.submits).toBe(1); expect(f.claims).toBe(1); expect(f.launches).toBe(1); expect(f.settled).toEqual([])
})

test('BB-09A waits in the durable scheduler instead of failing a resource-queued run', async () => {
  const f = await fixture()
  const callbacks = new Map<string, (message: any) => void>()
  const launches: string[] = []
  const runs = {
    ...f.runs,
    readTaskRunDispatchIdentity: async (runId: string) => ({ task_id: `task-${runId}`, lineage_id: `lineage-${runId}`, resume_binding_id: `resume-${runId}`, initial_input: runId }),
  }
  const launcher = { launch: async (input: { run_id: string; onMessage: (message: any) => void }) => {
    launches.push(input.run_id)
    callbacks.set(input.run_id, input.onMessage)
    const child = { send: () => {}, stop: async () => {} }
    setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0)
    return child
  } }
  const supervisor = new AgentWorkerSupervisor(runs, f.scheduler, launcher)
  expect(await supervisor.dispatch('first', 1)).toBe('started')
  const queued = supervisor.dispatch('second', 1)
  await Bun.sleep(40)
  expect(launches).toEqual(['first'])
  callbacks.get('first')?.({ type: 'terminal', state: 'completed', run_id: 'first' })
  expect(await queued).toBe('started')
  expect(launches).toEqual(['first', 'second'])
})

test('BB-09A heartbeats a long queue head so a waiting run cannot overtake an expired lease', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-queue-heartbeat-'))
  const scheduler = new ProductResourceScheduler({ statePath: path.join(root, 'scheduler.json'), leaseMs: 1_000 })
  const heartbeat = scheduler.heartbeat.bind(scheduler)
  let heartbeatCalls = 0
  scheduler.heartbeat = async (...args) => {
    heartbeatCalls += 1
    return heartbeat(...args)
  }
  const callbacks = new Map<string, (message: any) => void>()
  const launches: string[] = []
  const runs = {
    readTaskRunDispatchIdentity: async (runId: string) => ({ task_id: `task-${runId}`, lineage_id: `lineage-${runId}`, resume_binding_id: `resume-${runId}`, initial_input: runId }),
    claimTaskRunDispatch: async () => ({ outcome: 'claimed' as const, task_id: 'task' }),
    settleTaskRunDispatch: async () => {},
  }
  const launcher = { launch: async (input: { run_id: string; onMessage: (message: any) => void }) => {
    launches.push(input.run_id); callbacks.set(input.run_id, input.onMessage)
    setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0)
    return { send: () => {}, stop: async () => {} }
  } }
  const supervisor = new AgentWorkerSupervisor(runs, scheduler, launcher)
  const originalLeaseStartedAt = Date.now()
  expect(await supervisor.dispatch('first', 1)).toBe('started')
  const waiting = supervisor.dispatch('second', 1)
  await waitFor(() => heartbeatCalls > 0)
  await Bun.sleep(Math.max(0, originalLeaseStartedAt + 1_100 - Date.now()))
  expect(launches).toEqual(['first'])
  expect((await scheduler.snapshot()).active).toBe(1)
  callbacks.get('first')?.({ type: 'terminal', state: 'completed', run_id: 'first' })
  expect(await waiting).toBe('started')
  expect(launches).toEqual(['first', 'second'])
})

test('stop during scheduler admission releases the late fencing claim without launching Core', async () => {
  const f = await fixture()
  const submit = f.scheduler.submit.bind(f.scheduler)
  let admitted!: () => void
  const admission = new Promise<void>((resolve) => { admitted = resolve })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  f.scheduler.submit = async (claim) => {
    const receipt = await submit(claim)
    admitted()
    await held
    return receipt
  }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, f.launcher)
  const dispatch = supervisor.dispatch('run', 1)
  await admission
  await supervisor.stop('run', 1)
  release()

  expect(await dispatch).toBe('recovery_required')
  expect(f.claims).toBe(0)
  expect(f.launches).toBe(0)
  expect(f.settled).toEqual(['terminal:STOPPED'])
  expect((await f.scheduler.snapshot()).active).toBe(0)
})

test('supervisor claim and child bootstrap start one private Core without a second claim', async () => {
  const f = await fixture(); let coreStarts = 0; const inputs: string[] = []
  const launcher = { launch: async (input: any) => {
    const service = new AgentWorkerService({ ...input.bootstrap, cores: { start: async () => { coreStarts++; return { input: async (text: string) => { inputs.push(text) }, approve: async () => {}, stop: async () => {}, shutdown: async () => {} } } } }, () => new Date('2026-01-01T00:00:00.000Z'))
    const child = { send: (message: any) => { if (message.type === 'start') void service.start(message).then(input.onMessage); if (message.type === 'input') void service.input(message.text) }, stop: async () => {} }
    setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0)
    return child
  } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, launcher)
  expect(await supervisor.dispatch('run', 1)).toBe('started'); await waitFor(() => coreStarts === 1)
  expect(f.claims).toBe(1); expect(coreStarts).toBe(1); expect(inputs).toEqual(['durable user turn']); expect(f.settled).toEqual([])
})

test('launch failure after the durable claim settles and releases exactly once', async () => {
  const f = await fixture(); const failingLauncher = { launch: async () => { throw new Error('crash') } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, failingLauncher)
  expect(await supervisor.dispatch('run', 1)).toBe('recovery_required'); expect(f.claims).toBe(1); expect(f.launches).toBe(0); expect(f.settled).toEqual(['recovery_required:LAUNCH_FAILED']); expect((await f.scheduler.snapshot()).active).toBe(0)
  expect(await supervisor.dispatch('run', 1)).toBe('recovery_required'); expect(f.settled).toHaveLength(1)
})

test('ready timeout and repeated late callbacks settle/release exactly once', async () => {
  const f = await fixture(); let onMessage: ((message: any) => void) | undefined
  const silentLauncher = { launch: async (input: { onMessage: (message: any) => void }) => { onMessage = input.onMessage; return { send: () => {}, stop: async () => {} } } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, silentLauncher, 1)
  expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(15)
  onMessage?.({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); onMessage?.({ type: 'ready' }); await Bun.sleep(5)
  expect(f.settled).toEqual(['recovery_required:READY_TIMEOUT']); expect((await f.scheduler.snapshot()).active).toBe(0)
})

test('child exit and stop/shutdown settle their fencing claim once', async () => {
  const f = await fixture(); let onExit: (() => void) | undefined; const sent: unknown[] = []
  const exitingLauncher = { launch: async (input: { onExit: () => void }) => { onExit = input.onExit; return { send: (message: unknown) => sent.push(message), stop: async () => {} } } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, exitingLauncher)
  expect(await supervisor.dispatch('run', 1)).toBe('started'); onExit?.(); onExit?.(); await waitFor(async () => f.settled.length === 1 && (await f.scheduler.snapshot()).active === 0)
  expect(f.settled).toEqual(['recovery_required:CHILD_EXIT']); expect((await f.scheduler.snapshot()).active).toBe(0)

  const stopped = await fixture(); const stoppingLauncher = { launch: async (input: { onMessage: (message: any) => void; onExit: () => void }) => { const child = { send: (message: unknown) => stopped.sent.push(message), stop: async () => input.onExit() }; setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0); return child } }; const active = new AgentWorkerSupervisor(stopped.runs, stopped.scheduler, stoppingLauncher)
  expect(await active.dispatch('run', 1)).toBe('started'); await waitFor(() => stopped.sent.some(message => (message as { type?: unknown }).type === 'start')); await active.stop('run', 1); await active.stop('run', 1)
  expect(stopped.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'stop' })])); expect(stopped.settled).toEqual(['terminal:STOPPED']); expect((await stopped.scheduler.snapshot()).active).toBe(0)
})

test('scheduler completion errors cannot hide the durable settlement attempt', async () => {
  const completedFences: number[] = []; const settled: string[] = []; let claims = 0
  const scheduler = { profileRevision: () => 'test', submit: async () => ({ outcome: 'admitted', job_id: 'agent-worker:run:1', fencing_token: 1 }), complete: async (_job: string, fencing: number) => { completedFences.push(fencing); throw new Error('journal unavailable') } } as unknown as ProductResourceScheduler
  const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private', initial_input: 'durable user turn' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed' as const, task_id: 'task' } }, settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string) => { settled.push(`${state}:${error}`) } }
  const supervisor = new AgentWorkerSupervisor(runs, scheduler, { launch: async () => { throw new Error('launch') } })
  expect(await supervisor.dispatch('run', 1)).toBe('recovery_required'); expect(claims).toBe(1); expect(completedFences).toEqual([1]); expect(settled).toEqual(['recovery_required:LAUNCH_FAILED'])
})

test('scheduled dispatch atomically claims schedule.dispatch with agent.worker', async () => {
  const f = await fixture()
  let claim: { resources: unknown; priority: unknown } | undefined
  const submit = f.scheduler.submit.bind(f.scheduler)
  f.scheduler.submit = async (input) => { claim = { resources: input.resources, priority: input.priority }; return submit(input) }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, f.launcher)
  expect(await supervisor.dispatch('scheduled-run', 1, 'scheduled')).toBe('started')
  await Bun.sleep(10)
  expect(claim?.resources).toEqual([{ key: 'schedule.dispatch', units: 1 }, { key: 'agent.worker', units: 1 }])
  expect(claim?.priority).toBe('scheduled')
})

test('terminal projection closes the relay before a late Core delta', async () => {
  const f = await fixture()
  let onMessage: ((message: any) => void) | undefined
  let childStops = 0
  const sink: string[] = []
  const launcher = { launch: async (input: { onMessage: (message: any) => void }) => {
    onMessage = input.onMessage
    const child = { send: () => {}, stop: async () => { childStops++ } }
    setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0)
    return child
  } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, launcher, 5_000, { record: async (_run, _generation, message) => { sink.push(message.type === 'event' ? `event:${message.event}` : `terminal:${message.state}`); await Bun.sleep(5) } })
  expect(await supervisor.dispatch('run', 1)).toBe('started')
  await Bun.sleep(10)
  onMessage?.({ type: 'terminal', state: 'completed', run_id: 'run' })
  onMessage?.({ type: 'event', event: 'delta', data: 'late' })
  await Bun.sleep(15)
  expect(sink).toEqual(['terminal:completed'])
  expect(f.settled).toEqual(['terminal:TERMINAL'])
  expect(childStops).toBe(1)
})
