import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { AgentWorkerSupervisor } from './agentWorkerSupervisor.js'
import { AgentWorkerService } from './agentWorkerService.js'
import { ProductResourceScheduler } from './resourceScheduler.js'
import { DesktopResourceProfiles, conservativeDesktopResourceProfile } from './resourceProfiles.js'

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'worker-supervisor-')); const now = new Date('2026-01-01T00:00:00.000Z'); const scheduler = new ProductResourceScheduler({ statePath: path.join(root, 'scheduler.json'), now: () => now, profiles: new DesktopResourceProfiles(conservativeDesktopResourceProfile(now, 'test', 'toolchain'), () => now, 'test', 'toolchain') })
  let submits = 0; const submit = scheduler.submit.bind(scheduler); scheduler.submit = async claim => { submits++; return submit(claim) }
  const settled: string[] = []; let claims = 0; let launches = 0; const sent: unknown[] = []
  const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed' as const, task_id: 'task' } }, settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string) => { settled.push(`${state}:${error}`) } }
  const launcher = { launch: async (input: { onMessage: (message: any) => void }) => { launches++; const child = { send: (message: unknown) => sent.push(message), stop: async () => {} }; setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0); return child } }
  return { scheduler, runs, launcher, settled, sent, get submits() { return submits }, get claims() { return claims }, get launches() { return launches } }
}

test('supervisor rejects unbound input and starts exactly one child/Core binding per durable dispatch', async () => {
  const f = await fixture(); const supervisor = new AgentWorkerSupervisor({ ...f.runs, readTaskRunDispatchIdentity: async () => { throw new Error('unbound') } }, f.scheduler, f.launcher)
  expect(await supervisor.dispatch('run', 1)).toBe('recovery_required'); expect(f.launches).toBe(0); expect(f.claims).toBe(0); expect(f.sent).toEqual([]); expect(f.settled).toEqual([])
  const bound = new AgentWorkerSupervisor(f.runs, f.scheduler, f.launcher); expect(await bound.dispatch('run', 1)).toBe('started'); expect(await bound.dispatch('run', 1)).toBe('started'); await Bun.sleep(10)
  expect(f.launches).toBe(1); expect(f.claims).toBe(1); expect(f.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'start', run_id: 'run' })]))

  const preclaim = await fixture(); const unavailable = { profileRevision: () => 'test', submit: async () => { throw new Error('scheduler unavailable') } } as unknown as ProductResourceScheduler
  const failedBeforeClaim = new AgentWorkerSupervisor(preclaim.runs, unavailable, preclaim.launcher)
  expect(await failedBeforeClaim.dispatch('run', 1)).toBe('recovery_required'); expect(preclaim.claims).toBe(0); expect(preclaim.launches).toBe(0); expect(preclaim.sent).toEqual([])
})

test('supervisor fences stop and protocol mismatch into one durable settlement', async () => {
  const f = await fixture(); const badLauncher = { launch: async (input: { onMessage: (message: any) => void }) => { const child = { send: () => {}, stop: async () => {} }; setTimeout(() => input.onMessage({ type: 'hello', versions: { min: 2, max: 2 }, capabilities: [] }), 0); return child } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, badLauncher); expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(10); expect(f.settled).toEqual(['recovery_required:CAPABILITY_MISMATCH']); expect((await f.scheduler.snapshot()).active).toBe(0)
})

test('invalid model configuration settles before Core startup with stable product projection', async () => {
  const f = await fixture()
  const launcher = { launch: async (input: { onMessage: (message: any) => void }) => {
    const child = { send: () => {}, stop: async () => {} }
    setTimeout(() => input.onMessage({ type: 'fatal', code: 'MODEL_CONFIGURATION_INVALID' }), 0)
    return child
  } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, launcher)
  expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(10)
  expect(f.sent).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: 'start' })])); expect(f.settled).toEqual(['recovery_required:模型配置无效'])
})

test('concurrent dispatch calls share one startup before the first durable await', async () => {
  const f = await fixture(); const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, f.launcher)
  expect(await Promise.all([supervisor.dispatch('run', 1), supervisor.dispatch('run', 1), supervisor.dispatch('run', 1)])).toEqual(['started', 'started', 'started']); await Bun.sleep(10)
  expect(f.submits).toBe(1); expect(f.claims).toBe(1); expect(f.launches).toBe(1); expect(f.settled).toEqual([])
})

test('supervisor claim and child bootstrap start one private Core without a second claim', async () => {
  const f = await fixture(); let coreStarts = 0
  const launcher = { launch: async (input: any) => {
    const service = new AgentWorkerService({ ...input.bootstrap, cores: { start: async () => { coreStarts++; return { input: async () => {}, approve: async () => {}, stop: async () => {}, shutdown: async () => {} } } } }, () => new Date('2026-01-01T00:00:00.000Z'))
    const child = { send: (message: any) => { if (message.type === 'start') void service.start(message) }, stop: async () => {} }
    setTimeout(() => { input.onMessage({ type: 'hello', versions: { min: 1, max: 1 }, capabilities: [] }); input.onMessage({ type: 'ready' }) }, 0)
    return child
  } }
  const supervisor = new AgentWorkerSupervisor(f.runs, f.scheduler, launcher)
  expect(await supervisor.dispatch('run', 1)).toBe('started'); await Bun.sleep(10)
  expect(f.claims).toBe(1); expect(coreStarts).toBe(1); expect(f.settled).toEqual([])
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
  expect(await supervisor.dispatch('run', 1)).toBe('started'); onExit?.(); onExit?.(); await Bun.sleep(10)
  expect(f.settled).toEqual(['recovery_required:CHILD_EXIT']); expect((await f.scheduler.snapshot()).active).toBe(0)

  const stopped = await fixture(); const active = new AgentWorkerSupervisor(stopped.runs, stopped.scheduler, stopped.launcher)
  expect(await active.dispatch('run', 1)).toBe('started'); await Bun.sleep(10); await active.stop('run', 1); await active.stop('run', 1)
  expect(stopped.sent).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'stop' })])); expect(stopped.settled).toEqual(['terminal:STOPPED']); expect((await stopped.scheduler.snapshot()).active).toBe(0)
})

test('scheduler completion errors cannot hide the durable settlement attempt', async () => {
  const completedFences: number[] = []; const settled: string[] = []; let claims = 0
  const scheduler = { profileRevision: () => 'test', submit: async () => ({ outcome: 'admitted', job_id: 'agent-worker:run:1', fencing_token: 1 }), complete: async (_job: string, fencing: number) => { completedFences.push(fencing); throw new Error('journal unavailable') } } as unknown as ProductResourceScheduler
  const runs = { readTaskRunDispatchIdentity: async () => ({ task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'private' }), claimTaskRunDispatch: async () => { claims++; return { outcome: 'claimed' as const, task_id: 'task' } }, settleTaskRunDispatch: async (_r: string, _g: number, state: string, error?: string) => { settled.push(`${state}:${error}`) } }
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
  const sink: string[] = []
  const launcher = { launch: async (input: { onMessage: (message: any) => void }) => {
    onMessage = input.onMessage
    const child = { send: () => {}, stop: async () => {} }
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
})
