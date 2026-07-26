import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductAutoMemoryRepository, type ProductAutoMemoryBinding } from './productAutoMemory.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

async function fixture(name: string): Promise<{ root: string; project: string; binding: ProductAutoMemoryBinding }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `bb-auto-memory-${name}-`)); roots.push(root)
  const project = path.join(root, 'project'); await fs.mkdir(project)
  return { root, project, binding: { storage_dir: path.join(root, 'memory'), work_dir: project, enabled: true } }
}

test('/init creates one private project record and one non-overwriting instruction file', async () => {
  const { project, binding } = await fixture('init')
  const repository = new ProductAutoMemoryRepository()
  expect(await repository.initialize(binding, new Date('2026-01-01T00:00:00.000Z'))).toEqual({ created: true, instruction_created: true })
  const instruction = await fs.readFile(path.join(project, 'BilliardBuddy.md'), 'utf8')
  expect(await repository.initialize(binding, new Date('2027-01-01T00:00:00.000Z'))).toEqual({ created: false, instruction_created: false })
  expect(await fs.readFile(path.join(project, 'BilliardBuddy.md'), 'utf8')).toBe(instruction)
  expect((await fs.readdir(binding.storage_dir)).join('\n')).not.toContain(project)
})

test('existing compatible instructions are preserved and suppress a duplicate file', async () => {
  const { project, binding } = await fixture('instructions')
  await fs.writeFile(path.join(project, 'AGENTS.md'), 'existing guidance')
  const repository = new ProductAutoMemoryRepository()
  expect((await repository.initialize(binding)).instruction_created).toBeFalse()
  await expect(fs.stat(path.join(project, 'BilliardBuddy.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(path.join(project, 'AGENTS.md'), 'utf8')).toBe('existing guidance')
})

test('long-term memory crosses tasks only inside the exact initialized project', async () => {
  const { root, binding } = await fixture('isolation')
  const repository = new ProductAutoMemoryRepository()
  expect(await repository.load(binding)).toBe('')
  await repository.initialize(binding)
  await repository.appendCompletedTurn(binding, { task_id: 'task-a', entry_id: 'entry-a', user: 'remember the parser boundary', assistant: 'the parser owns normalization' })
  expect(await repository.load(binding)).toContain('parser owns normalization')
  expect(await repository.load({ ...binding, enabled: false })).toBe('')
  const other = path.join(root, 'other'); await fs.mkdir(other)
  expect(await repository.load({ ...binding, work_dir: other })).toBe('')
})

test('nested task directories share one active-checkout identity', async () => {
  const { project, binding } = await fixture('nested')
  await fs.mkdir(path.join(project, '.git'))
  const nested = path.join(project, 'packages', 'app'); await fs.mkdir(nested, { recursive: true })
  const repository = new ProductAutoMemoryRepository()
  await repository.initialize({ ...binding, work_dir: nested })
  await repository.appendCompletedTurn({ ...binding, work_dir: nested }, { task_id: 'task', entry_id: 'entry', user: 'nested request', assistant: 'shared checkout result' })
  expect(await repository.load(binding)).toContain('shared checkout result')
  expect(await fs.readFile(path.join(project, 'BilliardBuddy.md'), 'utf8')).toContain('project instructions')
})

test('replaying one durable source replaces it without duplicating long-term context', async () => {
  const { binding } = await fixture('replay')
  const repository = new ProductAutoMemoryRepository(); await repository.initialize(binding)
  await repository.appendCompletedTurn(binding, { task_id: 'task', entry_id: 'entry', user: 'old request', assistant: 'old result' })
  await repository.appendCompletedTurn(binding, { task_id: 'task', entry_id: 'entry', user: 'new request', assistant: 'new result' })
  const memory = await repository.load(binding)
  expect(memory).toContain('new result')
  expect(memory).not.toContain('old result')
})

test('task purge removes only that task contribution from shared project memory', async () => {
  const { binding } = await fixture('purge-task')
  const repository = new ProductAutoMemoryRepository(); await repository.initialize(binding)
  await repository.appendCompletedTurn(binding, { task_id: 'task-a', entry_id: 'entry-a', user: 'remove me', assistant: 'task a result' })
  await repository.appendCompletedTurn(binding, { task_id: 'task-b', entry_id: 'entry-b', user: 'keep me', assistant: 'task b result' })
  await repository.purgeTaskTurns(binding.storage_dir, 'task-a', ['entry-a'])
  const memory = await repository.load(binding)
  expect(memory).not.toContain('task a result')
  expect(memory).toContain('task b result')
})
