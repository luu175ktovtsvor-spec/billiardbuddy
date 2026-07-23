import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskAuthorityRepository, readLegacyProductTasks } from '../product/authorityRepository.js'
import { lock } from '../../utils/lockfile.js'

const child = process.env.BB_AUTHORITY_CHILD_ARGS ? JSON.parse(process.env.BB_AUTHORITY_CHILD_ARGS) as { authority: string; ready: string; start: string; result: string; operation: string; mode?: string; release?: string; done?: string; entity?: 'draft' | 'attachment' | 'lineage'; canonical?: string; expected?: number } : undefined
async function exists(file: string) { return fs.access(file).then(() => true).catch(() => false) }
async function waitFor(file: string) { for (let i = 0; i < 500; i++) { if (await exists(file)) return; await Bun.sleep(10) }; throw new Error(`timeout waiting for ${file}`) }
if (child) {
  if (child.mode === 'holder') { const guard = `${child.authority}.guard`; await fs.open(guard, 'a').then(handle => handle.close()); const releaseLock = await lock(guard, { stale: 30_000 }); await fs.writeFile(child.ready, ''); await waitFor(child.release!); await releaseLock(); await fs.writeFile(child.done!, ''); process.exit(0) }
  if (child.mode === 'root-lineage') { await fs.writeFile(child.ready, ''); await waitFor(child.start); try { const repository = new ProductTaskAuthorityRepository(child.authority); const { result } = await repository.transactCapabilities((state) => { const stored = state.tasks.task as { task?: Record<string, unknown> } | undefined; const task = stored?.task; const revision = typeof task?.revision === 'number' ? task.revision : 0; if (!task || revision !== child.expected) throw new Error('AUTHORITY_CONFLICT'); const id = `lineage_${child.operation}`; const now = '2026-07-19T00:00:00.000Z'; state.conversation_lineages[id] = { lineage_id: id, product_task_id: 'task', revision: 0, compact_generation: 0, resume_binding_id: 'private', state: 'active', created_at: now, updated_at: now }; task.current_lineage_id = id; task.revision = revision + 1; state.receipts[child.operation] = { client_operation_id: child.operation, expected_revision: revision, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: id } }; state.event_sequence += 1; state.events[child.operation] = { event_sequence: state.event_sequence, client_operation_id: child.operation, kind: 'lineage_create', revision: state.revision + 1, canonical_input: JSON.stringify({ expected: child.expected }), entity_id: id }; return { id } }); await fs.writeFile(child.result, JSON.stringify({ outcome: 'success', ...result })) } catch (error) { await fs.writeFile(child.result, JSON.stringify({ outcome: (error as Error).message })) }; process.exit(0) }
  if (child.mode === 'bind') { await fs.writeFile(child.ready, ''); await waitFor(child.start); try { const repository = new ProductTaskAuthorityRepository(child.authority); const canonical = child.canonical!; const { result } = await repository.transactCapabilities((state) => { const prior = state.receipts[child.operation]; if (prior) { if (state.events[child.operation]?.canonical_input !== canonical) throw new Error('AUTHORITY_CONFLICT'); return { changed: false as const, value: { outcome: 'duplicate', receipt: prior } } }; const task = (state.tasks.task as { task: { revision: number } }).task; const workspace = state.workspaces.workspace; if (task.revision !== 0 || workspace.revision !== 0) throw new Error('AUTHORITY_CONFLICT'); task.revision++; workspace.revision++; const receipt = { client_operation_id: child.operation, expected_revision: 0, outcome: 'accepted' as const, revision: state.revision + 1 }; state.receipts[child.operation] = receipt; state.event_sequence++; state.events[child.operation] = { event_sequence: state.event_sequence, client_operation_id: child.operation, kind: 'bind_workspace', revision: state.revision + 1, canonical_input: canonical }; return { outcome: 'accepted', receipt } }); await fs.writeFile(child.result, JSON.stringify({ outcome: 'success', ...result })) } catch (error) { await fs.writeFile(child.result, JSON.stringify({ outcome: (error as Error).message })) }; process.exit(0) }
  if (child.mode === 'capability') { await fs.writeFile(child.ready, ''); await waitFor(child.start); try { const repository = new ProductTaskAuthorityRepository(child.authority); const canonical = child.canonical!; const { result } = await repository.transactCapabilities((state) => { const prior = state.receipts[child.operation]; if (prior) { if (state.events[child.operation]?.canonical_input !== canonical) throw new Error('AUTHORITY_CONFLICT'); return { id: (prior.result as { entity_id: string }).entity_id, duplicate: true } } const id = `${child.entity}_${child.operation}`; const now = '2026-07-19T00:00:00.000Z'; if (child.entity === 'draft') state.composer_drafts[id] = { draft_id: id, installation_id: 'install', target_task_id: 'task', revision: 0, last_activity: now, state: 'active', created_at: now, expires_at: '2026-07-20T00:00:00.000Z' }; if (child.entity === 'attachment') state.task_attachments[id] = { attachment_id: id, installation_id: 'install', owner_kind: 'product_task', owner_id: 'task', source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'text/plain', storage_kind: 'external_reference', byte_size: 0, state: 'staged', refs: ['task'], created_at: now, last_activity: now, expires_at: '2026-07-20T00:00:00.000Z', revision: 0 }; if (child.entity === 'lineage') state.conversation_lineages[id] = { lineage_id: id, product_task_id: 'task', revision: 0, compact_generation: 0, resume_binding_id: 'private', state: 'active', created_at: now, updated_at: now }; state.receipts[child.operation] = { client_operation_id: child.operation, expected_revision: 0, outcome: 'accepted', revision: state.revision + 1, result: { entity_id: id } }; state.event_sequence += 1; state.events[child.operation] = { event_sequence: state.event_sequence, client_operation_id: child.operation, kind: `${child.entity}_create`, revision: state.revision + 1, canonical_input: canonical, entity_id: id }; return { id, duplicate: false } }); await fs.writeFile(child.result, JSON.stringify({ outcome: 'success', ...result })) } catch (error) { await fs.writeFile(child.result, JSON.stringify({ outcome: (error as Error).message })) }; process.exit(0) }
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


test('accepts explicit rev1 as an in-memory capability projection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-explicit-rev1-'))
  const authority = path.join(dir, 'product-task-authority.v1.json')
  const body = JSON.stringify({ version: 1, authority_schema_revision: 1, revision: 0, event_sequence: 0, tasks: {}, side_tasks: {}, bindings: {}, receipts: {}, events: {}, outbox: {}, prepared: {}, provenance: {} })
  await fs.writeFile(authority, body)
  const projected = await new ProductTaskAuthorityRepository(authority).read()
  expect(projected.authority_schema_revision).toBe(1)
  expect(projected.workspaces).toEqual({})
  expect(await fs.readFile(authority, 'utf8')).toBe(body)
})

test('projects rev1 authority maps without changing bytes, then upgrades on mutation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-rev1-'))
  const authority = path.join(dir, 'product-task-authority.v1.json')
  const body = JSON.stringify({ version: 1, revision: 0, event_sequence: 0, tasks: {}, side_tasks: {}, bindings: {}, receipts: {}, events: {}, outbox: {}, prepared: {}, provenance: {} })
  await fs.writeFile(authority, body)
  const repository = new ProductTaskAuthorityRepository(authority)
  const projected = await repository.read()
  expect(projected.authority_schema_revision).toBe(1)
  expect(projected.workspaces).toEqual({})
  expect(await fs.readFile(authority, 'utf8')).toBe(body)
  await repository.mutateCapabilities((file) => { file.task_scopes.task = { kind: 'installation-default' } })
  const written = JSON.parse(await fs.readFile(authority, 'utf8')) as Record<string, unknown>
  expect(written.authority_schema_revision).toBe(2)
  expect(written).toHaveProperty('workspaces')
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


test('serializes capability create identity across independent Bun processes', async () => {
  for (const entity of ['draft', 'attachment', 'lineage'] as const) {
    for (const canonicalPair of [['same', 'same'], ['left', 'right']] as const) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `authority-${entity}-race-`)); const authority = path.join(dir, 'authority.json'); const start = path.join(dir, 'start')
      const children = canonicalPair.map((canonical, index) => { const ready = path.join(dir, `${index}.ready`); const result = path.join(dir, `${index}.result`); const proc = Bun.spawn([process.execPath, 'test', import.meta.path], { env: { ...process.env, BB_AUTHORITY_CHILD_ARGS: JSON.stringify({ authority, ready, start, result, operation: 'op', mode: 'capability', entity, canonical }) }, stdout: 'ignore', stderr: 'ignore' }); return { ready, result, proc } })
      await Promise.all(children.map(child => waitFor(child.ready))); await fs.writeFile(start, ''); await Promise.all(children.map(child => child.proc.exited)); const results = await Promise.all(children.map(child => fs.readFile(child.result, 'utf8').then(JSON.parse))) as Array<{ outcome: string; id?: string }>
      if (canonicalPair[0] === canonicalPair[1]) { expect(results.map(result => result.outcome)).toEqual(['success', 'success']); expect(new Set(results.map(result => result.id))).toEqual(new Set([`${entity}_op`])) } else { expect(results.filter(result => result.outcome === 'success')).toHaveLength(1); expect(results.filter(result => result.outcome === 'AUTHORITY_CONFLICT')).toHaveLength(1) }
      const final = await new ProductTaskAuthorityRepository(authority).read(); expect(Object.keys(final.receipts)).toEqual(['op']); expect(Object.values(final.events)[0]?.entity_id).toBe(`${entity}_op`)
    }
  }
})


test('root lineage CAS fences independent Bun processes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'root-lineage-race-')); const authority = path.join(dir, 'authority.json'); const repository = new ProductTaskAuthorityRepository(authority); const now = '2026-07-19T00:00:00.000Z'
  await repository.mutateCapabilities(state => { state.tasks.task = { task: { id: 'task', projectId: '', directoryId: '', workDir: '', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now, worktreeState: 'not_requested', actions: [], revision: 0 }, binding: { coreSessionId: 'core' } } })
  const start = path.join(dir, 'start'); const children = ['a', 'b'].map(operation => { const ready = path.join(dir, `${operation}.ready`); const result = path.join(dir, `${operation}.result`); const proc = Bun.spawn([process.execPath, 'test', import.meta.path], { env: { ...process.env, BB_AUTHORITY_CHILD_ARGS: JSON.stringify({ authority, ready, start, result, operation, mode: 'root-lineage', expected: 0 }) }, stdout: 'ignore', stderr: 'ignore' }); return { ready, result, proc } })
  await Promise.all(children.map(child => waitFor(child.ready))); await fs.writeFile(start, ''); await Promise.all(children.map(child => child.proc.exited)); const results = await Promise.all(children.map(child => fs.readFile(child.result, 'utf8').then(JSON.parse))) as Array<{ outcome: string }>; expect(results.filter(result => result.outcome === 'success')).toHaveLength(1); expect(results.filter(result => result.outcome === 'AUTHORITY_CONFLICT')).toHaveLength(1)
  const final = await repository.read(); expect(Object.keys(final.conversation_lineages)).toHaveLength(1); expect((final.tasks.task as { task: { revision: number; current_lineage_id: string } }).task.revision).toBe(1); expect(Object.keys(final.receipts)).toHaveLength(1)
})

test('bind transaction fences same and different canonical subprocess operations', async () => {
  for (const canonicals of [['same', 'same'], ['left', 'right']] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bind-race-')); const authority = path.join(dir, 'authority.json'); const repository = new ProductTaskAuthorityRepository(authority); const now = '2026-07-19T00:00:00.000Z'
    await repository.mutateCapabilities(state => { state.tasks.task = { task: { id: 'task', projectId: '', directoryId: '', workDir: '', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now, worktreeState: 'not_requested', actions: [], revision: 0 }, binding: { coreSessionId: 'core' } }; state.workspaces.workspace = { workspace_id: 'workspace', installation_id: 'install', canonical_root: '/workspace', root_identity: { platform: 'test', volume_id: 'v', file_id: 'f' }, revision: 0, availability: 'available', created_at: now, updated_at: now } })
    const start = path.join(dir, 'start'); const children = canonicals.map((canonical, index) => { const ready = path.join(dir, `${index}.ready`), result = path.join(dir, `${index}.result`); return { ready, result, proc: Bun.spawn([process.execPath, 'test', import.meta.path], { env: { ...process.env, BB_AUTHORITY_CHILD_ARGS: JSON.stringify({ authority, ready, start, result, operation: 'bind', mode: 'bind', canonical }) }, stdout: 'ignore', stderr: 'ignore' }) } })
    await Promise.all(children.map(child => waitFor(child.ready))); await fs.writeFile(start, ''); await Promise.all(children.map(child => child.proc.exited)); const results = await Promise.all(children.map(child => fs.readFile(child.result, 'utf8').then(JSON.parse))) as Array<{ outcome: string; receipt?: unknown }>
    if (canonicals[0] === canonicals[1]) { expect(results.map(result => result.outcome).sort()).toEqual(['accepted', 'duplicate']); expect(results[0].receipt).toEqual(results[1].receipt) } else { expect(results.filter(result => result.outcome === 'accepted')).toHaveLength(1); expect(results.filter(result => result.outcome === 'AUTHORITY_CONFLICT')).toHaveLength(1) }
    const final = await repository.read(); expect((final.tasks.task as { task: { revision: number } }).task.revision).toBe(1); expect(final.workspaces.workspace.revision).toBe(1); expect(Object.keys(final.receipts)).toEqual(['bind'])
  }
})
