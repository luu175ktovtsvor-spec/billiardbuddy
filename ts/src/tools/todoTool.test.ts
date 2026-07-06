import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { todoWriteTool } from './todoTool'
import type { ToolContext } from './Tool'

function ctx(): ToolContext {
  return { workspace: new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w4b-')))) }
}

test('todo_write 写 ctx.todos 并返回清单,不需审批(无权限字段)', async () => {
  const c = ctx()
  const out = await todoWriteTool.execute({ todos: ['探索', { task: '实现', status: 'in_progress' }] }, c)
  expect(c.todos).toEqual([
    { task: '探索', status: 'pending' },
    { task: '实现', status: 'in_progress' },
  ])
  expect(out).toContain('共 2 步')
  expect(todoWriteTool.isReadOnly).toBe(false)
  expect(todoWriteTool.requiresApproval).toBeUndefined() // Delta A:进度记录直接做
})
