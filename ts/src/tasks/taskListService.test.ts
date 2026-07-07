import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskListService } from './taskListService'

test('TaskListService persists structured tasks per conversation scope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-list-service-'))
  try {
    const scope = { conversationId: 'conv-a', workspaceRoot: root }
    const service = new TaskListService(root)
    const first = await service.create(scope, { subject: '读源码', description: '扫描 CC-Haha tools' })
    const second = await service.create(scope, { subject: '写测试', description: '覆盖迁移行为' })
    expect(first.id).toBe('1')
    expect(second.id).toBe('2')

    const reloaded = new TaskListService(root)
    expect((await reloaded.list(scope)).map(task => task.subject)).toEqual(['读源码', '写测试'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('TaskListService updates status, metadata and task dependencies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-list-service-'))
  try {
    const scope = { conversationId: 'conv-b', workspaceRoot: root }
    const service = new TaskListService(root)
    const blocker = await service.create(scope, { subject: '先实现', description: '核心能力' })
    const blocked = await service.create(scope, { subject: '再验证', description: '测试验证' })

    const updated = await service.update(scope, blocked.id, {
      status: 'in_progress',
      addBlockedBy: [blocker.id],
      metadata: { source: 'cc-haha' },
    })
    expect(updated.task?.status).toBe('in_progress')
    expect(updated.updatedFields).toContain('blockedBy')
    expect(updated.updatedFields).toContain('metadata')

    const tasks = await service.list(scope)
    expect(tasks.find(task => task.id === blocker.id)?.blocks).toEqual([blocked.id])
    expect(tasks.find(task => task.id === blocked.id)?.blockedBy).toEqual([blocker.id])

    const deleted = await service.update(scope, blocker.id, { status: 'deleted' })
    expect(deleted.deleted).toBe(true)
    expect((await service.get(scope, blocker.id))).toBeNull()
    expect((await service.get(scope, blocked.id))?.blockedBy).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
