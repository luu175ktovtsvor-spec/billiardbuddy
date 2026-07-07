import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from '../tools/Tool'
import { TaskListService } from './taskListService'
import { createStructuredTaskTools } from './taskListTools'

function makeCtx(root: string): ToolContext {
  return { workspace: new Workspace(root), conversationId: 'conv-tools' }
}

function toolsByName(root: string) {
  return new Map(createStructuredTaskTools(new TaskListService(root)).map(tool => [tool.name, tool]))
}

test('structured task tools create, list, get and sync todo updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-list-tools-'))
  try {
    const [create, list, get, update] = createStructuredTaskTools(new TaskListService(root))
    const ctx = makeCtx(root)

    const created = await create!.execute({ subject: '搬 Task 工具', description: '按 CC-Haha 行为补齐', activeForm: '正在搬 Task 工具' }, ctx)
    expect(created).toContain('Task #1 created successfully')
    expect(ctx.todos).toEqual([{ task: '搬 Task 工具', status: 'pending', activeForm: '正在搬 Task 工具' }])

    const listed = await list!.execute({}, ctx)
    expect(listed).toContain('#1 [pending] 搬 Task 工具')

    const detail = await get!.execute({ taskId: '1' }, ctx)
    expect(detail).toContain('Description: 按 CC-Haha 行为补齐')

    const updated = await update!.execute({ task_id: '1', status: 'completed', metadata: { migratedFrom: 'cc-haha' } }, ctx)
    expect(updated).toContain('Updated task #1')
    expect(ctx.todos).toEqual([{ task: '搬 Task 工具', status: 'done', activeForm: '正在搬 Task 工具' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('structured task tools expose CC-Haha PascalCase aliases over the same task list', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-list-tools-'))
  try {
    const tools = toolsByName(root)
    const ctx = makeCtx(root)

    expect([...tools.keys()]).toEqual([
      'task_create',
      'task_list',
      'task_get',
      'task_update',
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
    ])

    const created = await tools.get('TaskCreate')!.execute({ subject: '兼容 CC-Haha TaskCreate', description: 'PascalCase 工具名也要能直接创建任务' }, ctx)
    expect(created).toContain('Task #1 created successfully')

    const listedViaAlias = await tools.get('TaskList')!.execute({}, ctx)
    expect(listedViaAlias).toContain('#1 [pending] 兼容 CC-Haha TaskCreate')

    const updatedViaAlias = await tools.get('TaskUpdate')!.execute({ taskId: '1', status: 'in_progress', activeForm: '正在验证 TaskUpdate' }, ctx)
    expect(updatedViaAlias).toContain('Updated task #1')
    expect(ctx.todos).toEqual([{ task: '兼容 CC-Haha TaskCreate', status: 'in_progress', activeForm: '正在验证 TaskUpdate' }])

    const detailViaLowercase = await tools.get('task_get')!.execute({ taskId: '1' }, ctx)
    expect(detailViaLowercase).toContain('Active: 正在验证 TaskUpdate')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('structured task tools support dependencies and deleted status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-list-tools-'))
  try {
    const [create, , get, update] = createStructuredTaskTools(new TaskListService(root))
    const ctx = makeCtx(root)
    await create!.execute({ subject: '实现', description: '核心代码' }, ctx)
    await create!.execute({ subject: '验证', description: '跑测试' }, ctx)

    const linked = await update!.execute({ taskId: '2', addBlockedBy: ['1'], owner: 'verification' }, ctx)
    expect(linked).toContain('Blocked by: #1')
    const blocker = await get!.execute({ taskId: '1' }, ctx)
    expect(blocker).toContain('Blocks: #2')

    const deleted = await update!.execute({ taskId: '1', status: 'deleted' }, ctx)
    expect(deleted).toContain('Deleted task #1')
    const after = await get!.execute({ taskId: '2' }, ctx)
    expect(after).not.toContain('Blocked by')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
