import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductSessionMemoryRepository, type ProductSessionMemoryBinding } from './productSessionMemory.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(name: string): Promise<{ root: string; project: string; binding: ProductSessionMemoryBinding }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `bb-session-memory-${name}-`)); roots.push(root)
  const project = path.join(root, 'project'); await fs.mkdir(project)
  return { root, project, binding: { storage_dir: path.join(root, 'memory'), task_id: 'task', lineage_id: 'lineage', resume_binding_id: 'resume-private', work_dir: project, ancestors: [] } }
}

test('resumes only the same task lineage, private binding, and project identity', async () => {
  const { root, binding } = await fixture('binding')
  const repository = new ProductSessionMemoryRepository()
  await repository.appendCompletedTurn(binding, { entry_id: 'entry-1', user: 'inspect the break', assistant: 'the parser owns it' })
  expect(await repository.load(binding)).toContain('the parser owns it')
  expect(await repository.load({ ...binding, task_id: 'other' })).toBe('')
  expect(await repository.load({ ...binding, lineage_id: 'other' })).toBe('')
  expect(await repository.load({ ...binding, resume_binding_id: 'other' })).toBe('')
  const otherProject = path.join(root, 'other-project'); await fs.mkdir(otherProject)
  expect(await repository.load({ ...binding, work_dir: otherProject })).toBe('')
  const names = await fs.readdir(binding.storage_dir)
  expect(names.join('\n')).not.toContain('task')
  expect(names.join('\n')).not.toContain('lineage')
  expect(names.join('\n')).not.toContain('resume-private')
})

test('fork inherits only through its durable checkpoint and then advances independently', async () => {
  const { binding } = await fixture('fork')
  const repository = new ProductSessionMemoryRepository()
  await repository.appendCompletedTurn(binding, { entry_id: 'entry-1', user: 'first', assistant: 'one' })
  await repository.appendCompletedTurn(binding, { entry_id: 'entry-2', user: 'second', assistant: 'two' })
  const child = { ...binding, lineage_id: 'child', resume_binding_id: 'child-private', ancestors: [{ lineage_id: binding.lineage_id, resume_binding_id: binding.resume_binding_id, inherit_through_entry_id: 'entry-1' }] }
  const inherited = await repository.load(child)
  expect(inherited).toContain('first')
  expect(inherited).not.toContain('second')
  await repository.appendCompletedTurn(child, { entry_id: 'entry-child', user: 'branch', assistant: 'child only' })
  expect(await repository.load(child)).toContain('child only')
  expect(await repository.load(binding)).not.toContain('child only')
})

test('missing or expired checkpoint fails closed instead of importing a moving parent head', async () => {
  const { binding } = await fixture('checkpoint')
  const repository = new ProductSessionMemoryRepository()
  await repository.appendCompletedTurn(binding, { entry_id: 'entry-1', user: 'parent', assistant: 'private parent context' })
  const child = { ...binding, lineage_id: 'child', resume_binding_id: 'child-private' }
  expect(await repository.load({ ...child, ancestors: [{ lineage_id: binding.lineage_id, resume_binding_id: binding.resume_binding_id }] })).toBe('')
  expect(await repository.load({ ...child, ancestors: [{ lineage_id: binding.lineage_id, resume_binding_id: binding.resume_binding_id, inherit_through_entry_id: 'missing' }] })).toBe('')
})

test('replaying one durable entry replaces it and task purge removes every lineage', async () => {
  const { binding } = await fixture('replay')
  const repository = new ProductSessionMemoryRepository()
  await repository.appendCompletedTurn(binding, { entry_id: 'entry-1', user: 'old', assistant: 'old answer' })
  await repository.appendCompletedTurn(binding, { entry_id: 'entry-1', user: 'new', assistant: 'new answer' })
  const child = { ...binding, lineage_id: 'child', resume_binding_id: 'child-private' }
  await repository.appendCompletedTurn(child, { entry_id: 'entry-2', user: 'child', assistant: 'child answer' })
  const resumed = await repository.load(binding)
  expect(resumed).toContain('new answer')
  expect(resumed).not.toContain('old answer')
  await repository.purgeTask(binding.storage_dir, binding.task_id)
  expect(await repository.load(binding)).toBe('')
  expect(await repository.load(child)).toBe('')
})
