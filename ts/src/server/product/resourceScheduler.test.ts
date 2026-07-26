import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductResourceScheduler } from './resourceScheduler.js'
import { conservativeDesktopResourceProfile, DesktopResourceProfiles } from './resourceProfiles.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

describe('DesktopResourceProfiles', () => {
  test('uses conservative baseline and degrades expired, mismatched, and failed benchmarks', () => {
    let now = new Date('2026-01-01T00:00:00.000Z')
    const baseline = conservativeDesktopResourceProfile(now, 'test', 'toolchain', { machine_class: 'baseline', logical_cpu_count: 2, memory_bytes: 4_000 })
    const profiles = new DesktopResourceProfiles(baseline, () => now, 'test', 'toolchain')
    expect(profiles.current()).toMatchObject({ status: 'baseline', profile: { revision: 'conservative-desktop-v1' } })
    const promoted = { ...baseline, revision: 'device-v1', expires_at: '2026-01-02T00:00:00.000Z', hardware: { machine_class: 'arm64-16g', logical_cpu_count: 10, memory_bytes: 16_000 } }
    expect(profiles.promote(promoted)).toMatchObject({ status: 'promoted', profile: { revision: 'device-v1' }, hardware: promoted.hardware, benchmark: { platform: 'test', toolchain: 'toolchain', profile_revision: 'device-v1', expires_at: '2026-01-02T00:00:00.000Z' } })
    now = new Date('2026-01-03T00:00:00.000Z')
    expect(profiles.current()).toMatchObject({ status: 'degraded', reason: 'PROFILE_EXPIRED', profile: { revision: 'conservative-desktop-v1' }, hardware: promoted.hardware, benchmark: { profile_revision: 'device-v1', toolchain: 'toolchain', expires_at: '2026-01-02T00:00:00.000Z' } })
    expect(profiles.benchmarkFailed(promoted)).toMatchObject({ status: 'degraded', reason: 'BENCHMARK_FAILED', hardware: promoted.hardware })
    expect(profiles.promote({ ...baseline, revision: 'unsafe', limits: { ...baseline.limits, 'agent.worker': { ...baseline.limits['agent.worker']!, max_active: 99 } } })).toMatchObject({ status: 'degraded', reason: 'BENCHMARK_FAILED' })
    expect(profiles.promote({ ...promoted, revision: 'wrong-toolchain', toolchain: 'other' })).toMatchObject({ status: 'degraded', reason: 'TOOLCHAIN_MISMATCH', hardware: promoted.hardware, benchmark: { profile_revision: 'wrong-toolchain', toolchain: 'other' } })
    expect(profiles.promote({ ...promoted, revision: 'wrong-platform', platform: 'other' })).toMatchObject({ status: 'degraded', reason: 'PLATFORM_MISMATCH', hardware: promoted.hardware, benchmark: { profile_revision: 'wrong-platform', platform: 'other' } })
  })
})

test('owner purge rejects live work and removes only terminal jobs for that ProductTask', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-resource-owner-purge-')); roots.push(root)
  const scheduler = new ProductResourceScheduler({ statePath: path.join(root, 'scheduler.json') })
  const receipt = await scheduler.submit({
    job_id: 'job-task-a', owner_id: 'task:task-a', idempotency_key: 'job-task-a', scope: 'desktop-host',
    resources: [{ key: 'agent.worker', units: 1 }], bytes: { memory: 0, input: 0, temp: 0, output: 0 },
    priority: 'interactive', cancel_mode: 'cooperative', resume_policy: 'manual', profile_revision: scheduler.profileRevision(),
  })
  expect(receipt.outcome).toBe('admitted')
  await expect(scheduler.purgeOwnerJobs('task:task-a')).rejects.toThrow('OWNER_JOBS_ACTIVE')
  await scheduler.complete('job-task-a', receipt.fencing_token!)
  await scheduler.purgeOwnerJobs('task:task-a')
  expect(await scheduler.hasBlockingOwnerJobs('task:task-a')).toBeFalse()
})
