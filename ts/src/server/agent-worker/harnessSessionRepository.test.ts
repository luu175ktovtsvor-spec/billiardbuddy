import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductHarnessSessionRepository, type ProductHarnessSessionBinding } from './harnessSessionRepository.js'
import { createProductUserMessage } from './productMessages.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function binding(): Promise<ProductHarnessSessionBinding> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-harness-session-'))
  roots.push(root)
  return { storage_dir: root, binding_id: 'binding-1', lineage_id: 'lineage-1' }
}

function value(run: number) {
  return {
    context_prefix: `summary-${run}`,
    messages: [createProductUserMessage({ content: `message-${run}` })],
    run_id: `run-${run}`,
    instruction_digest: String(run).padStart(64, '0'),
    instruction_prompt: `instructions-${run}`,
  }
}

describe('ProductHarnessSessionRepository', () => {
  test('serializes concurrent saves and leaves one complete recoverable snapshot', async () => {
    const target = await binding()
    const repository = new ProductHarnessSessionRepository()

    await Promise.all(Array.from({ length: 12 }, (_, index) => repository.save(target, value(index + 1))))

    const restored = await repository.load(target)
    expect(restored).toBeDefined()
    expect(restored?.run_id).toMatch(/^run-\d+$/)
    expect(restored?.messages).toHaveLength(1)
    expect(restored?.messages[0]?.message.content).toMatch(/^message-\d+$/)
    expect((await fs.readdir(target.storage_dir)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  test('rejects a symbolic-link session file', async () => {
    const target = await binding()
    const repository = new ProductHarnessSessionRepository()
    await repository.save(target, value(1))
    const file = (await fs.readdir(target.storage_dir)).find(name => name.endsWith('.json'))
    expect(file).toBeDefined()
    const external = path.join(target.storage_dir, 'external.json')
    await fs.rename(path.join(target.storage_dir, file!), external)
    await fs.symlink(external, path.join(target.storage_dir, file!))

    await expect(repository.load(target)).rejects.toThrow('HARNESS_SESSION_INVALID')
    await expect(repository.save(target, value(2))).rejects.toThrow('HARNESS_SESSION_INVALID')
  })

  test('purges one private binding without affecting another lineage', async () => {
    const target = await binding()
    const other = { ...target, binding_id: 'binding-2', lineage_id: 'lineage-2' }
    const repository = new ProductHarnessSessionRepository()
    await repository.save(target, value(1))
    await repository.save(other, value(2))
    await repository.purge(target)
    expect(await repository.load(target)).toBeUndefined()
    expect(await repository.load(other)).toMatchObject({ run_id: 'run-2' })
  })
})
