import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  ScheduledAgentTaskService,
  nextScheduledAgentTaskRun,
} from '../desktop/electron/services/scheduledAgentTasks'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-scheduled-tasks-'))
  temporaryRoots.push(root)
  return root
}

describe('ScheduledAgentTaskService', () => {
  test('一次性计划只恢复原生 Thread 一次并持久化完成状态', async () => {
    const userDataPath = await temporaryRoot()
    let now = 1_000
    const runs: string[] = []
    const service = new ScheduledAgentTaskService({
      userDataPath,
      now: () => now,
      run: async task => {
        runs.push(`${task.threadId}:${task.prompt}`)
        return { turnId: 'turn-1' }
      },
    })
    await service.start()
    const task = await service.create({
      threadId: 'thread-1',
      cwd: userDataPath,
      prompt: '继续任务',
      schedule: { kind: 'once', at: 1_010 },
      enabled: true,
    })
    now = 1_010
    await (service as unknown as { runDue(): Promise<void> }).runDue()
    service.stop()

    expect(runs).toEqual(['thread-1:继续任务'])
    expect(service.list()).toEqual([
      expect.objectContaining({ id: task.id, enabled: false, lastRunAt: 1_010 }),
    ])

    const restored = new ScheduledAgentTaskService({ userDataPath, now: () => now, run: async () => ({ turnId: 'unused' }) })
    await restored.start()
    expect(restored.list()).toEqual([
      expect.objectContaining({ id: task.id, enabled: false, lastRunAt: 1_010 }),
    ])
    restored.stop()
  })

  test('损坏的持久化文件不会把服务留在伪启动状态', async () => {
    const userDataPath = await temporaryRoot()
    const directory = path.join(userDataPath, 'agent-runtime', 'scheduled-tasks')
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, 'tasks.json'), '{not-json')
    const service = new ScheduledAgentTaskService({ userDataPath, run: async () => ({ turnId: 'unused' }) })

    await expect(service.start()).rejects.toThrow('BILLIARDBUDDY_SCHEDULED_TASKS_CORRUPT')
    await fs.rm(path.join(directory, 'tasks.json'))
    await service.start()
    service.stop()
  })

  test('日计划按本地时钟计算下一个未来时间', () => {
    const after = new Date(2026, 7, 3, 9, 30, 0, 0).getTime()
    expect(nextScheduledAgentTaskRun({ kind: 'daily', hour: 10, minute: 15 }, after))
      .toBe(new Date(2026, 7, 3, 10, 15, 0, 0).getTime())
  })
})
