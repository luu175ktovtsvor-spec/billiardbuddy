import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskAuthorityRepository, readLegacyProductTasks } from '../product/authorityRepository.js'
import { lock } from '../../utils/lockfile.js'

const child = process.env.BB_AUTHORITY_CHILD_ARGS ? JSON.parse(process.env.BB_AUTHORITY_CHILD_ARGS) as { authority: string; ready: string; start: string; result: string; operation: string; mode?: string; release?: string; done?: string } : undefined
async function exists(file: string) { return fs.access(file).then(() => true).catch(() => false) }
async function waitFor(file: string) { for (let i = 0; i < 500; i++) { if (await exists(file)) return; await Bun.sleep(10) }; throw new Error(`timeout waiting for ${file}`) }
if (child) {
  if (child.mode === 'holder') { const guard = `${child.authority}.guard`; await fs.open(guard, 'a').then(handle => handle.close()); const releaseLock = await lock(guard, { stale: 30_000 }); await fs.writeFile(child.ready, ''); await waitFor(child.release!); await releaseLock(); await fs.writeFile(child.done!, ''); process.exit(0) }
  await fs.writeFile(child.ready, '')
  try { await waitFor(child.start); const repository = new ProductTaskAuthorityRepository(child.authority); await repository.reserve({ client_operation_id: child.operation, product_task_id: 'task', kind: 'create', canonical_input: '{\"workDir\":\"/tmp\"}', expected_revision: 0 }); const final = await repository.finalize(child.operation, { client_operation_id: child.operation, expected_revision: 0, outcome: 'accepted', revision: 1 }); await fs.writeFile(child.result, JSON.stringify({ outcome: 'success', revision: final.revision })) } catch (error) { await fs.writeFile(child.result, JSON.stringify({ outcome: (error as Error).message })) }
  process.exit(0)
}

describe('product task authority repository', () => {
  test('reads legacy sources without mutating bytes and enforces CAS', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-'))
    const legacy = path.join(dir, 'product-tasks.json')
    const authority = path.join(dir, 'product-task-authority.v1.json')
    const body = JSON.stringify({ version: 4, tasks: { task: { id: 'task', title: 'legacy' } } })
    await fs.writeFile(legacy, body)
    const source = await readLegacyProductTasks(legacy)
    expect(source.recordDigest('task')).toHaveLength(64)
    expect(await fs.readFile(legacy, 'utf8')).toBe(body)
    const repository = new ProductTaskAuthorityRepository(authority)
    const accepted = await repository.compareAndWrite(0, state => {
      state.receipts.op = { client_operation_id: 'op', expected_revision: 0, outcome: 'accepted', revision: 1 }
      state.events.op = { event_sequence: 1, client_operation_id: 'op', kind: 'rename', revision: 1 }
      state.outbox.op = { state: 'pending' }
    })
    expect(accepted.revision).toBe(1)
    await expect(repository.compareAndWrite(0, () => {})).rejects.toThrow('AUTHORITY_CONFLICT')
    await fs.writeFile(authority, JSON.stringify({ version: 1, revision: 0, event_sequence: 0, tasks: { constructor: {} }, receipts: {}, events: {}, outbox: {} }))
    await expect(repository.read()).rejects.toThrow('AUTHORITY_INVALID')
  })
})


test('rejects malformed nested persisted authority maps fail-closed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-invalid-'))
  const authority = path.join(dir, 'product-task-authority.v1.json')
  await fs.writeFile(authority, JSON.stringify({ version: 1, revision: 1, event_sequence: 1, tasks: {}, side_tasks: { side: { id: 'side', parentTaskId: 'parent', taskId: 'child', title: 'bad', status: 'open', createdAt: 'not-a-date', updatedAt: '2026-01-01T00:00:00.000Z' } }, bindings: {}, receipts: {}, events: {}, outbox: {}, prepared: {}, provenance: {} }))
  await expect(new ProductTaskAuthorityRepository(authority).read()).rejects.toThrow('AUTHORITY_INVALID')
})

test('uses an OS-backed lock for two independent Bun authority writers', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-process-race-')); const authority = path.join(dir, 'authority.json'); const start = path.join(dir, 'start')
  const children = ['left', 'right'].map((operation) => { const ready = path.join(dir, `${operation}.ready`); const result = path.join(dir, `${operation}.result`); const proc = Bun.spawn([process.execPath, 'test', import.meta.path], { env: { ...process.env, BB_AUTHORITY_CHILD_ARGS: JSON.stringify({ authority, ready, start, result, operation }) }, stdout: 'ignore', stderr: 'ignore' }); return { proc, ready, result } })
  await Promise.all(children.map(child => waitFor(child.ready))); await fs.writeFile(start, ''); await Promise.all(children.map(child => child.proc.exited))
  const outcomes = await Promise.all(children.map(async child => JSON.parse(await fs.readFile(child.result, 'utf8')) as { outcome: string }))
  expect(outcomes.filter(result => result.outcome === 'success')).toHaveLength(1); expect(outcomes.filter(result => result.outcome === 'AUTHORITY_CONFLICT')).toHaveLength(1)
  const final = await new ProductTaskAuthorityRepository(authority).read(); expect(final.revision).toBe(2); expect(Object.keys(final.receipts)).toHaveLength(1); expect(Object.keys(final.prepared)).toEqual([])
})

test('does not reclaim a live proper-lockfile lease before its holder releases', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-live-lock-')); const authority = path.join(dir, 'authority.json'); const holderReady = path.join(dir, 'holder.ready'); const release = path.join(dir, 'release'); const done = path.join(dir, 'done'); const writerReady = path.join(dir, 'writer.ready'); const writerResult = path.join(dir, 'writer.result'); const env = (value: object) => ({ ...process.env, BB_AUTHORITY_CHILD_ARGS: JSON.stringify(value) })
  const holder = Bun.spawn([process.execPath, 'test', import.meta.path], { env: env({ authority, ready: holderReady, release, done, result: '', operation: 'holder', mode: 'holder' }), stdout: 'ignore', stderr: 'ignore' }); await waitFor(holderReady)
  const writer = Bun.spawn([process.execPath, 'test', import.meta.path], { env: env({ authority, ready: writerReady, start: holderReady, result: writerResult, operation: 'writer' }), stdout: 'ignore', stderr: 'ignore' }); await waitFor(writerReady); await Bun.sleep(50)
  expect(await exists(writerResult)).toBeFalse(); expect(await exists(`${authority}.guard.lock`)).toBeTrue()
  await fs.writeFile(release, ''); await waitFor(done); await writer.exited; await holder.exited
  expect(JSON.parse(await fs.readFile(writerResult, 'utf8')).outcome).toBe('success'); const final = await new ProductTaskAuthorityRepository(authority).read(); expect(final.revision).toBe(2); expect(Object.keys(final.prepared)).toEqual([])
})
