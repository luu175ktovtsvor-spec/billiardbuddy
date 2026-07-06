import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import { Workspace } from '../workspace/workspace'
import { fileReadTool } from '../tools/fileReadTool'
import { fileWriteTool } from '../tools/fileWriteTool'
import { createAgentTaskTool } from './agentTool'
import type { AgentDefinition } from './agentLoader'

function agent(partial: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: 'researcher',
    description: '研究代理',
    prompt: '你只做研究。',
    filePath: '/agents/researcher.md',
    tools: ['read_file'],
    ...partial,
  }
}

test('agent_task runs an isolated subagent loop and returns only final text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    writeFileSync(join(root, 'data.txt'), 'payload')
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: '1', name: 'read_file', input: { path: 'data.txt' } }] },
      { kind: 'final', text: '子代理结论:payload' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent()],
      model,
      baseTools: [fileReadTool, fileWriteTool],
      baseSystemPrompt: 'BASE',
    })
    const out = await tool.execute({ task: '读 data.txt' }, { workspace: new Workspace(root), permissionMode: 'full' })
    expect(out).toBe('<agent_task agent="researcher">\n子代理结论:payload\n</agent_task>')
    expect(model.received[0]!.system).toContain('BASE')
    expect(model.received[0]!.system).toContain('<subagent name="researcher">')
    expect(model.received[0]!.tools.map(t => t.name)).toEqual(['read_file'])
    expect(model.received[1]!.messages.some(m => m.content.some(b => b.type === 'tool_result' && b.content === 'payload'))).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task requires agent name when multiple agents are available', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent({ name: 'a' }), agent({ name: 'b' })],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
    })
    await expect(tool.execute({ task: 'x' }, { workspace: new Workspace(root) })).rejects.toThrow(/需要指定 agent/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task rejects unknown agent and validates task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent()],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
    })
    await expect(tool.execute({ agent: 'missing', task: 'x' }, { workspace: new Workspace(root) })).rejects.toThrow(/需要指定 agent/)
    // @ts-expect-error 故意传非法入参
    await expect(tool.execute({ agent: 'researcher' }, { workspace: new Workspace(root) })).rejects.toThrow(/task/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

