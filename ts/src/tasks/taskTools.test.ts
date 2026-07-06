import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import { Workspace } from '../workspace/workspace'
import type { AgentDefinition } from '../agents/agentLoader'
import { TaskService } from './taskService'
import { createBackgroundAgentTaskTool, createTaskTools } from './taskTools'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('start_background_agent_task runs an isolated agent and read_background_task restores events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'task-tools-'))
  try {
    const tasks = new TaskService(root)
    const agent: AgentDefinition = {
      name: 'researcher',
      description: '研究代理',
      prompt: '研究并总结。',
      filePath: join(root, 'researcher.md'),
    }
    const model = scriptedModel([{ kind: 'final', text: '后台结论' }])
    const start = createBackgroundAgentTaskTool({
      tasks,
      agents: [agent],
      model,
      baseTools: [],
      baseSystemPrompt: 'base prompt',
    })
    const ctx = { workspace: new Workspace(root), conversationId: 'c1', permissionMode: 'full' as const }
    const started = await start.execute({ task: '分析数据', title: '后台分析' }, ctx)
    expect(started).toContain('<background_task_started')

    const done = await waitFor(async () => {
      const list = await tasks.list({ conversationId: 'c1' })
      return list[0]?.status === 'completed' ? list[0] : null
    })
    expect(done.title).toBe('后台分析')
    expect(done.result).toBe('后台结论')
    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({ type: 'text', text: '分析数据' })

    const [, readTask] = createTaskTools(tasks)
    const restored = await readTask!.execute({ task_id: done.id }, ctx)
    expect(restored).toContain('status="completed"')
    expect(restored).toContain('后台结论')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
