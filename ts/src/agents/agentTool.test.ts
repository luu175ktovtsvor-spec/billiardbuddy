import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scriptedModel } from '../harness/fakeModel'
import { Workspace } from '../workspace/workspace'
import { fileReadTool } from '../tools/fileReadTool'
import { fileWriteTool } from '../tools/fileWriteTool'
import { createAgentTaskSidechainTools, createAgentTaskTool } from './agentTool'
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
      sidechainRoot: join(root, 'sidechains'),
    })
    const progress: string[] = []
    const out = await tool.execute({ task: '读 data.txt' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      progressEmit: event => progress.push(event.chunk),
    })
    expect(out).toContain('<agent_task agent="researcher" agent_id="agent_')
    expect(out).toContain('\n子代理结论:payload\n</agent_task>')
    expect(progress.join('')).toContain('子代理 researcher 开始:读 data.txt')
    expect(progress.join('')).toContain('子代理 researcher 调用 read_file: data.txt')
    expect(progress.join('')).toContain('子代理 researcher 结论:子代理结论:payload')
    expect(model.received[0]!.system).toContain('BASE')
    expect(model.received[0]!.system).toContain('<subagent name="researcher">')
    expect(model.received[0]!.tools.map(t => t.name)).toEqual(['read_file'])
    expect(model.received[1]!.messages.some(m => m.content.some(b => b.type === 'tool_result' && b.content === 'payload'))).toBe(true)
    const transcriptDir = join(root, 'sidechains', 'transcripts')
    const transcriptFile = readdirSync(transcriptDir).find(name => name.endsWith('.jsonl') && !name.includes('content-replacements'))
    expect(transcriptFile).toBeTruthy()
    const transcriptText = readFileSync(join(transcriptDir, transcriptFile!), 'utf8')
    expect(transcriptText).toContain('读 data.txt')
    expect(transcriptText).toContain('子代理结论:payload')
    const metadataText = readFileSync(join(transcriptDir, transcriptFile!.replace(/\.jsonl$/, '.meta.json')), 'utf8')
    expect(metadataText).toContain('"agentType": "researcher"')
    expect(metadataText).toContain('"parentConversationId"')
    const agentId = out.match(/agent_id="([^"]+)"/)?.[1]
    expect(agentId).toBeTruthy()
    const readSidechain = createAgentTaskSidechainTools(join(root, 'sidechains')).find(t => t.name === 'read_agent_task_sidechain')!
    const sidechainOutput = await readSidechain.execute({ agent_id: agentId }, { workspace: new Workspace(root) })
    expect(sidechainOutput).toContain(`<agent_task_sidechain id="${agentId}" status="ok"`)
    expect(sidechainOutput).toContain('<tool_result tool_use_id="1">payload</tool_result>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task sidechain stores aggregate replacements for large subagent tool batches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-'))
  try {
    const outputA = `A-HEAD\n${'a'.repeat(130_000)}\nA-TAIL`
    const outputB = `B-HEAD\n${'b'.repeat(90_000)}\nB-TAIL`
    const logTool = (name: string, output: string): import('../tools/Tool').Tool => ({
      name,
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute() {
        return output
      },
    })
    const model = scriptedModel([
      {
        kind: 'tool_calls',
        calls: [
          { id: 'log-a', name: 'log_a', input: {} },
          { id: 'log-b', name: 'log_b', input: {} },
        ],
      },
      { kind: 'final', text: '子代理完成大日志分析' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['log_a', 'log_b'] })],
      model,
      baseTools: [logTool('log_a', outputA), logTool('log_b', outputB)],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '分析两份大日志' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_conv',
    })

    expect(out).toContain('子代理完成大日志分析')
    const transcriptDir = join(root, 'sidechains', 'transcripts')
    const transcriptFile = readdirSync(transcriptDir).find(name => name.endsWith('.jsonl') && !name.includes('content-replacements'))
    expect(transcriptFile).toBeTruthy()
    const transcriptId = transcriptFile!.replace(/\.jsonl$/, '')
    const replacementsText = readFileSync(join(transcriptDir, `${transcriptId}.content-replacements.jsonl`), 'utf8')
    expect(replacementsText).toContain('"kind":"tool-result"')
    expect(replacementsText).toContain('<stored_tool_result')
    const transcriptText = readFileSync(join(transcriptDir, transcriptFile!), 'utf8')
    expect(transcriptText).toContain('<stored_tool_result')
    expect(transcriptText).not.toContain('a'.repeat(80_000))
    const toolResultDir = join(root, 'sidechains', 'tool-results', transcriptId)
    const storedFiles = readdirSync(toolResultDir)
    expect(storedFiles.length).toBe(1)
    const readStoredResult = createAgentTaskSidechainTools(join(root, 'sidechains')).find(t => t.name === 'read_agent_task_stored_result')!
    const storedOutput = await readStoredResult.execute({ agent_id: transcriptId, path: storedFiles[0], tail: true, max_bytes: 64 }, { workspace: new Workspace(root) })
    expect(storedOutput).toContain('<stored_tool_result_read status="completed"')
    expect(storedOutput).toContain(`agent_id="${transcriptId}"`)
    expect(storedOutput).toContain('A-TAIL')
    expect(storedOutput).not.toContain('A-HEAD')
    const rejected = await readStoredResult.execute({ agent_id: transcriptId, path: join(root, 'outside.txt') }, { workspace: new Workspace(root) })
    expect(rejected).toContain('status="rejected"')
    const listSidechains = createAgentTaskSidechainTools(join(root, 'sidechains')).find(t => t.name === 'list_agent_task_sidechains')!
    const listOutput = await listSidechains.execute({ parent_conversation_id: 'parent_conv' }, { workspace: new Workspace(root) })
    expect(listOutput).toContain(`id="${transcriptId}"`)
    expect(listOutput).toContain('<task>分析两份大日志</task>')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task isolation=worktree runs tools in an isolated git worktree and keeps dirty work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-worktree-'))
  try {
    initGitRepo(root)
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'w1', name: 'write_file', input: { path: 'worker.txt', content: 'from subagent' } }] },
      { kind: 'final', text: '写入完成' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({ tools: ['write_file'] })],
      model,
      baseTools: [fileWriteTool],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '写 worker.txt', isolation: 'worktree' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_conv',
    })

    expect(out).toContain('<agent_worktree status="kept"')
    const worktreePath = out.match(/<agent_worktree status="kept" path="([^"]+)"/)?.[1]
    expect(worktreePath).toBeTruthy()
    expect(existsSync(join(worktreePath!, 'worker.txt'))).toBe(true)
    expect(existsSync(join(root, 'worker.txt'))).toBe(false)
    const transcriptDir = join(root, 'sidechains', 'transcripts')
    const metadataFile = readdirSync(transcriptDir).find(name => name.endsWith('.meta.json'))
    expect(metadataFile).toBeTruthy()
    expect(readFileSync(join(transcriptDir, metadataFile!), 'utf8')).toContain(`"worktreePath": "${worktreePath}"`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task honors agent frontmatter defaults for prompt, permissions, maxTurns and worktree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-defaults-'))
  try {
    initGitRepo(root)
    let seenPermission = ''
    let seenWorkspace = ''
    const inspectTool: import('../tools/Tool').Tool = {
      name: 'inspect_ctx',
      description: '',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      async execute(_, ctx) {
        seenPermission = ctx.permissionMode ?? ''
        seenWorkspace = ctx.workspace.root
        return 'ok'
      },
    }
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'i1', name: 'inspect_ctx', input: {} }] },
      { kind: 'final', text: 'fallback final should not be used when maxTurns=1' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({
        tools: ['inspect_ctx', 'write_file'],
        disallowedTools: ['write_file'],
        initialPrompt: '先遵守 agent 初始提示。',
        permissionMode: 'plan',
        maxTurns: 1,
        isolation: 'worktree',
      })],
      model,
      baseTools: [inspectTool, fileWriteTool],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '检查默认值' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
      conversationId: 'parent_defaults',
    })

    expect(model.received[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'text',
      text: '先遵守 agent 初始提示。\n\n检查默认值',
    })
    expect(model.received[0]!.tools.map(t => t.name)).toEqual(['inspect_ctx'])
    expect(seenPermission).toBe('plan')
    expect(seenWorkspace).toContain(join(root, '.claude', 'worktrees'))
    expect(model.received[1]!.tools).toEqual([])
    expect(out).toContain('fallback final should not be used when maxTurns=1')
    expect(out).toContain('<agent_worktree status="removed_clean">')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function writeFixtureMcpServer(root: string): string {
  const file = join(root, 'agent-fixture-mcp-server.ts')
  writeFileSync(file, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'agent-fixture', version: '1.0.0' })
server.registerTool('agent_echo', {
  description: 'Echo from an agent-scoped MCP server',
  inputSchema: { text: z.string() },
  annotations: { readOnlyHint: true },
}, async ({ text }) => ({
  content: [{ type: 'text', text: 'agent-mcp:' + text }],
}))
await server.connect(new StdioServerTransport())
`)
  return file
}

test('agent_task connects agent frontmatter mcpServers and injects MCP tools', async () => {
  const root = mkdtempSync(join(process.cwd(), '.agent-tool-mcp-'))
  try {
    const fixture = writeFixtureMcpServer(root)
    const model = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'mcp1', name: 'mcp__agent_fixture__agent_echo', input: { text: 'hello' } }] },
      { kind: 'final', text: 'MCP 子代理完成' },
    ])
    const tool = createAgentTaskTool({
      agents: [agent({
        tools: ['mcp__agent_fixture__agent_echo'],
        mcpServers: [{ 'agent fixture': { command: process.execPath, args: [fixture] } }],
        requiredMcpServers: ['agent fixture'],
      })],
      model,
      baseTools: [],
      sidechainRoot: join(root, 'sidechains'),
    })

    const out = await tool.execute({ task: '调用 agent MCP' }, {
      workspace: new Workspace(root),
      permissionMode: 'full',
    })

    expect(model.received[0]!.tools.map(tool => tool.name)).toContain('mcp__agent_fixture__agent_echo')
    expect(model.received[1]!.messages.some(message =>
      message.content.some(block => block.type === 'tool_result' && block.content.includes('agent-mcp:hello')),
    )).toBe(true)
    expect(out).toContain('MCP 子代理完成')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task rejects agents whose required MCP servers are unavailable', async () => {
  const root = mkdtempSync(join(process.cwd(), '.agent-tool-mcp-required-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent({ requiredMcpServers: ['missing-server'] })],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
    })
    await expect(tool.execute({ task: '需要 MCP' }, { workspace: new Workspace(root) }))
      .rejects.toThrow(/requires MCP servers matching: missing-server/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agent_task launches background task when agent definition has background true', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-tool-background-default-'))
  try {
    const tool = createAgentTaskTool({
      agents: [agent({ background: true, isolation: 'worktree' })],
      model: scriptedModel([{ kind: 'final', text: 'unused' }]),
      baseTools: [],
      startBackgroundAgent: async (input) => ({
        task: { id: 'bg_agent_1', title: `${input.agent}: ${input.task}`, params: { agent_id: 'bg_agent_1' } },
        agent: agent({ name: input.agent ?? 'researcher' }),
      }),
    })
    const out = await tool.execute({ task: '后台默认执行' }, { workspace: new Workspace(root) })
    expect(out).toContain('<background_task_started id="bg_agent_1" agent="researcher" agent_id="bg_agent_1" status="queued">')
    expect(out).toContain('researcher: 后台默认执行')
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

function initGitRepo(cwd: string): void {
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'codex@example.test'])
  git(cwd, ['config', 'user.name', 'Codex Test'])
  writeFileSync(join(cwd, 'README.md'), 'hello\n')
  git(cwd, ['add', 'README.md'])
  git(cwd, ['commit', '-m', 'initial'])
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    },
  })
}
