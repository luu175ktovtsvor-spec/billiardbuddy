import { afterEach, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServerPrivateNativeCorePort } from '../../cli/print.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })

test('native ProductTask /init is local, idempotent, and terminal without model execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-native-init-')); roots.push(root)
  const project = path.join(root, 'project'); await fs.mkdir(project)
  const auto_memory = { storage_dir: path.join(root, 'auto-memory'), work_dir: project, enabled: true, task_id: 'task', entry_id: 'entry' }

  const run = async (run_id: string) => {
    const events: unknown[] = []
    const port = await createServerPrivateNativeCorePort({ run_id, session_id: `session-${run_id}`, work_dir: project, auto_memory })
    port.subscribe(message => events.push(message))
    await port.input('/init')
    return events
  }

  expect(await run('first')).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'delta', data: '项目已初始化。' },
    { type: 'terminal', state: 'completed', run_id: 'first' },
  ])
  const firstInstruction = await fs.readFile(path.join(project, 'BilliardBuddy.md'), 'utf8')
  expect(await run('second')).toEqual([
    { type: 'event', event: 'started' },
    { type: 'event', event: 'delta', data: '项目已经初始化，无需更改。' },
    { type: 'terminal', state: 'completed', run_id: 'second' },
  ])
  expect(await fs.readFile(path.join(project, 'BilliardBuddy.md'), 'utf8')).toBe(firstInstruction)
})
