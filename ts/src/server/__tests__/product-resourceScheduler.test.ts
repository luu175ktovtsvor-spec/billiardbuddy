import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ProductResourceClaim, ProductResourceProfile } from '../../../shared/product/resourceScheduler.js'
import { ProductResourceScheduler } from '../product/resourceScheduler.js'
import { DesktopResourceProfiles, conservativeDesktopResourceProfile } from '../product/resourceProfiles.js'

function claim(id: string, owner = 'owner-a', overrides: Partial<ProductResourceClaim> = {}): ProductResourceClaim {
  return { job_id: id, owner_id: owner, idempotency_key: `key-${id}`, scope: 'desktop-host', resources: [{ key: 'agent.worker', units: 1 }], bytes: { memory: 1, input: 1, temp: 1, output: 1 }, priority: 'interactive', cancel_mode: 'cooperative', resume_policy: 'idempotent', profile_revision: 'conservative-desktop-v1', ...overrides }
}
async function scheduler(profile?: ProductResourceProfile) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-resource-scheduler-')); let now = new Date('2026-01-01T00:00:00.000Z')
  const baseline = conservativeDesktopResourceProfile(now, 'test', 'toolchain')
  const profiles = new DesktopResourceProfiles(baseline, () => now, 'test', 'toolchain')
  if (profile) profiles.promote(profile)
  const make = (processId: string) => new ProductResourceScheduler({ statePath: path.join(root, 'scheduler.json'), profiles, now: () => now, processId, processGeneration: `${processId}-g`, leaseMs: 1_000 })
  return { make, statePath: path.join(root, 'scheduler.json'), advance(ms: number) { now = new Date(now.getTime() + ms) }, profiles }
}

describe('ProductResourceScheduler', () => {
  test('uses one durable fencing winner for two schedulers and expires crashed leases', async () => {
    const fixture = await scheduler(); const left = fixture.make('left'); const right = fixture.make('right')
    const [one, two] = await Promise.all([left.submit(claim('run')), right.submit(claim('run'))])
    expect([one.outcome, two.outcome].filter(outcome => outcome === 'admitted')).toHaveLength(1)
    const admitted = one.outcome === 'admitted' ? one : two
    expect(admitted.fencing_token).toBeNumber()
    expect((await right.complete('run', admitted.fencing_token! + 1)).reason_code).toBe('STALE_FENCING')
    fixture.advance(1_001)
    expect((await right.snapshot()).active).toBe(0)
  })

  test('reserves all resources atomically, accounts bytes separately, queues fairly, and cancels', async () => {
    const fixture = await scheduler(); const first = fixture.make('one'); const second = fixture.make('two')
    const active = await first.submit(claim('active', 'owner-a', { bytes: { memory: 10, input: 20, temp: 30, output: 40 } }))
    const queued = await second.submit(claim('queued', 'owner-b', { resources: [{ key: 'agent.worker', units: 1 }, { key: 'filesystem.write.workspace', units: 1 }], priority: 'scheduled' }))
    const unrelated = await first.submit(claim('unrelated', 'owner-c', { resources: [{ key: 'filesystem.write.workspace', units: 1 }] }))
    expect(active.outcome).toBe('admitted'); expect(queued.outcome).toBe('queued'); expect(unrelated.outcome).toBe('admitted')
    expect((await first.snapshot()).bytes).toEqual({ memory: 11, input: 21, temp: 31, output: 41 })
    expect((await second.cancel('queued')).reason_code).toBe('CANCELLED')
    await first.complete('active', active.fencing_token!)
    await first.complete('unrelated', unrelated.fencing_token!)
    expect((await second.snapshot())).toMatchObject({ active: 0, queued: 0 })
  })

  test('rotates trusted owners ahead of a second FIFO job from the previous owner', async () => {
    const fixture = await scheduler(); const subject = fixture.make('one')
    const first = await subject.submit(claim('first', 'owner-a'))
    await subject.submit(claim('again', 'owner-a'))
    await subject.submit(claim('other', 'owner-b'))
    await subject.complete('first', first.fencing_token!)
    const state = await subject.snapshot()
    expect(state.lease_owner).toBe('owner-b')
  })

  test('rejects profileless resources and drains without accepting new work', async () => {
    const fixture = await scheduler(); const subject = fixture.make('one')
    expect((await subject.submit(claim('media', 'owner-a', { resources: [{ key: 'media.ffmpeg.encode', units: 1 }] }))).reason_code).toBe('PROFILE_REQUIRED')
    await subject.beginDrain()
    expect((await subject.submit(claim('later'))).reason_code).toBe('DRAINING')
  })

  test('retains an outcome_unknown reservation through restart until fenced reconciliation', async () => {
    const fixture = await scheduler(); const original = fixture.make('one')
    const paid = await original.submit(claim('paid', 'owner-a', { cancel_mode: 'outcome_unknown' }))
    expect((await original.cancel('paid'))).toMatchObject({ outcome: 'admitted', fencing_token: paid.fencing_token })
    fixture.advance(10_000)
    const restored = fixture.make('two')
    expect(await restored.snapshot()).toMatchObject({ active: 1, lease_owner: 'owner-a' })
    expect((await restored.submit(claim('conflict', 'owner-b'))).outcome).toBe('queued')
    expect((await restored.complete('paid', paid.fencing_token! + 1)).reason_code).toBe('STALE_FENCING')
    expect((await restored.complete('paid', paid.fencing_token!)).outcome).toBe('admitted')
    expect((await restored.complete('paid', paid.fencing_token!)).reason_code).toBe('STALE_FENCING')
    expect(await restored.snapshot()).toMatchObject({ active: 1, lease_owner: 'owner-b' })
  })

  test('fails closed on malformed journal roots and never overwrites their bytes', async () => {
    const fixture = await scheduler(); const subject = fixture.make('one')
    const malformed = '{"version":1,"sequence":0,"fencing":0,"status":"ready","last_owner":null,"jobs":{},"unexpected":true}\n'
    await fs.writeFile(fixture.statePath, malformed)
    await expect(subject.submit(claim('blocked'))).rejects.toThrow('SCHEDULER_STATE_INVALID')
    expect(await fs.readFile(fixture.statePath, 'utf8')).toBe(malformed)
  })

  test('fails closed on malformed persisted job and lease state without reset', async () => {
    const fixture = await scheduler(); const subject = fixture.make('one')
    const admitted = await subject.submit(claim('active'))
    const journal = JSON.parse(await fs.readFile(fixture.statePath, 'utf8')) as { jobs: Record<string, { lease: Record<string, unknown> }> }
    journal.jobs.active.lease.unexpected = true
    const malformed = `${JSON.stringify(journal)}\n`
    await fs.writeFile(fixture.statePath, malformed)
    await expect(subject.snapshot()).rejects.toThrow('SCHEDULER_STATE_INVALID')
    await expect(subject.complete('active', admitted.fencing_token!)).rejects.toThrow('SCHEDULER_STATE_INVALID')
    expect(await fs.readFile(fixture.statePath, 'utf8')).toBe(malformed)
  })
})
