import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskService } from '../product/taskService.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe('scheduled ProductTask grant', () => {
  test('binds one logical occurrence to the selected workspace and automatic reviewer', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-schedule-grant-'))
    roots.push(root)
    const workspace = path.join(root, 'workspace')
    await fs.mkdir(workspace)
    const service = new ProductTaskService({
      storagePath: path.join(root, 'product-tasks.json'),
      dispatcher: { dispatch: async () => 'started' },
      now: () => new Date('2026-07-24T06:15:00.000Z'),
    })

    const first = await service.submitScheduledTaskRun(
      'daily-review',
      '每日营业复盘',
      '读取经营数据并整理复盘。',
      workspace,
      '2026-07-24T06:00:00.000Z',
    )
    const duplicate = await service.submitScheduledTaskRun(
      'daily-review',
      '每日营业复盘',
      '读取经营数据并整理复盘。',
      workspace,
      '2026-07-24T06:00:00.000Z',
    )
    const nextOccurrence = await service.submitScheduledTaskRun(
      'daily-review',
      '每日营业复盘',
      '读取经营数据并整理复盘。',
      workspace,
      '2026-07-25T06:00:00.000Z',
    )

    expect(duplicate).toEqual(first)
    expect(nextOccurrence.task_id).not.toBe(first.task_id)
    expect((await service.readTaskRunDispatchIdentity(nextOccurrence.run_id, nextOccurrence.dispatch_generation)).session_context)
      .toMatchObject({ text: '', compact_generation: 0, estimated_tokens: 0 })
    expect(await service.readTaskRunDispatchIdentity(first.run_id, first.dispatch_generation)).toMatchObject({
      initial_input: '读取经营数据并整理复盘。',
      permission_snapshot: {
        mode: 'approve_for_me',
        sandbox: 'workspace-write',
        approval: 'on-request',
        reviewer: 'automatic',
      },
    })
    expect(await service.resolveTaskRunCoreBinding(first.run_id, first.dispatch_generation)).toMatchObject({
      work_dir: await fs.realpath(workspace),
    })
    expect(await service.inspectScheduledTaskRun(first.run_id, first.dispatch_generation)).toEqual({ state: 'running' })
  })
})
