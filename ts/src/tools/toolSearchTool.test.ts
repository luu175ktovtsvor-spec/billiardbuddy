import { describe, expect, test } from 'bun:test'
import { ToolRegistry } from './registry'
import type { Tool } from './Tool'
import { createToolSearchTool, searchTools, shouldUseLazyToolSpecs, visibleToolSpecs } from './toolSearchTool'

function tool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
    isReadOnly: true,
    async execute() {
      return `${name} ok`
    },
  }
}

describe('tool_search', () => {
  test('small registries keep all tool specs visible', () => {
    const registry = new ToolRegistry([tool('read_file', 'Read a file'), tool('rare_tool', 'Rare capability')])
    registry.register(createToolSearchTool(registry))

    expect(shouldUseLazyToolSpecs(registry)).toBe(false)
    expect(visibleToolSpecs(registry, new Set()).map(spec => spec.name).sort()).toEqual([
      'rare_tool',
      'read_file',
      'tool_search',
    ])
  })

  test('large registries hide cold tools until search reveals them', async () => {
    const tools = [
      tool('read_file', 'Read a file'),
      ...Array.from({ length: 34 }, (_, index) => tool(`cold_tool_${index}`, index === 19 ? 'Import rare invoices from an MCP accounting system' : 'Cold extension tool')),
    ]
    const registry = new ToolRegistry(tools)
    registry.register(createToolSearchTool(registry))

    expect(shouldUseLazyToolSpecs(registry)).toBe(true)
    expect(visibleToolSpecs(registry, new Set()).map(spec => spec.name)).toEqual(['read_file', 'tool_search'])

    const search = registry.get('tool_search')!
    const output = await search.execute({ query: 'rare invoice accounting', limit: 3 }, { workspace: null as any })
    expect(output).toContain('cold_tool_19')

    const revealed = new Set(['cold_tool_19'])
    expect(visibleToolSpecs(registry, revealed).map(spec => spec.name)).toContain('cold_tool_19')
  })

  test('large registries keep MCP resource and prompt index tools visible', () => {
    const tools = [
      tool('read_file', 'Read a file'),
      tool('list_mcp_resources', 'List readable resources and resource templates exposed by connected MCP servers'),
      tool('read_mcp_resource', 'Read a resource from a connected MCP server'),
      tool('list_mcp_prompts', 'List prompt templates exposed by connected MCP servers'),
      tool('read_mcp_prompt', 'Load one MCP prompt template'),
      ...Array.from({ length: 34 }, (_, index) => tool(`mcp__fixture__cold_${index}`, 'Cold MCP extension tool')),
    ]
    const registry = new ToolRegistry(tools)
    registry.register(createToolSearchTool(registry))

    const visible = visibleToolSpecs(registry, new Set()).map(spec => spec.name)
    expect(visible).toContain('list_mcp_resources')
    expect(visible).toContain('read_mcp_resource')
    expect(visible).toContain('list_mcp_prompts')
    expect(visible).toContain('read_mcp_prompt')
    expect(visible.some(name => name.startsWith('mcp__fixture__cold_'))).toBe(false)
  })

  test('matches Chinese coding intents through stable tool aliases', () => {
    const registry = new ToolRegistry([
      tool('project_diagnostics', 'Run a bounded project diagnostic script'),
      tool('grep_files', 'Search text inside workspace files'),
      tool('git_status', 'Read git branch/status and optional bounded diff'),
      tool('git_history', 'Read recent git commit history and optional patch'),
      tool('read_stored_tool_result', 'Read a bounded window from an oversized stored tool result'),
      tool('SendUserMessage', 'Send a message the user will read'),
      tool('Brief', 'Legacy alias for SendUserMessage'),
      tool('read_agent_task_stored_result', 'Read a bounded window from an oversized stored tool result emitted inside an agent_task sidechain'),
      tool('restore_file', 'Restore a file snapshot'),
      tool('list_mcp_resources', 'List readable resources and resource templates exposed by connected MCP servers'),
      tool('read_mcp_resource', 'Read a resource from a connected MCP server'),
      tool('list_mcp_prompts', 'List prompt templates exposed by connected MCP servers'),
      tool('read_mcp_prompt', 'Load one MCP prompt template'),
      tool('NotebookEdit', 'Edit Jupyter notebook cells'),
      tool('LSP', 'Interact with Language Server Protocol code intelligence features'),
      tool('PowerShell', 'Run PowerShell commands with PowerShell-aware security checks'),
      tool('REPL', 'Execute a structured batch of primitive coding tools'),
      tool('TaskOutput', 'Read output from a background task'),
      tool('TaskStop', 'Stop a running background task'),
      tool('TeamCreate', 'Create a local agent team'),
      tool('TeamDelete', 'Delete a local agent team'),
      tool('SendMessage', 'Send a message to another agent'),
      tool('ListPeers', 'List team peers'),
      tool('agent_task', 'Run a focused subagent'),
      tool('start_background_agent_task', 'Start a focused subagent in the background'),
      tool('EnterWorktree', 'Create an isolated git worktree and switch into it'),
      tool('ExitWorktree', 'Exit a worktree session and keep or remove it'),
      tool('EnterPlanMode', 'Request plan mode for non-trivial implementation'),
      tool('VerifyPlanExecution', 'Verify that an approved plan was actually implemented before final summary'),
      tool('generate_image', 'Generate an image'),
    ])
    registry.register(createToolSearchTool(registry))

    expect(searchTools(registry, { query: '跑类型检查', limit: 1 })[0]?.tool.name).toBe('project_diagnostics')
    expect(searchTools(registry, { query: '聚焦测试', limit: 1 })[0]?.tool.name).toBe('project_diagnostics')
    expect(searchTools(registry, { query: '查引用', limit: 1 })[0]?.tool.name).toBe('grep_files')
    expect(searchTools(registry, { query: '查看 diff', limit: 1 })[0]?.tool.name).toBe('git_status')
    expect(searchTools(registry, { query: '暂存 diff', limit: 1 })[0]?.tool.name).toBe('git_status')
    expect(searchTools(registry, { query: '全量改动审阅', limit: 1 })[0]?.tool.name).toBe('git_status')
    expect(searchTools(registry, { query: '提交历史', limit: 1 })[0]?.tool.name).toBe('git_history')
    expect(searchTools(registry, { query: '这段代码谁改的', limit: 1 })[0]?.tool.name).toBe('git_history')
    expect(searchTools(registry, { query: '追溯修改原因', limit: 1 })[0]?.tool.name).toBe('git_history')
    expect(searchTools(registry, { query: '读取长结果', limit: 1 })[0]?.tool.name).toBe('read_stored_tool_result')
    expect(searchTools(registry, { query: '给用户发消息', limit: 1 })[0]?.tool.name).toBe('SendUserMessage')
    expect(searchTools(registry, { query: '读取子代理长结果', limit: 1 })[0]?.tool.name).toBe('read_agent_task_stored_result')
    expect(searchTools(registry, { query: '回滚文件', limit: 1 })[0]?.tool.name).toBe('restore_file')
    expect(searchTools(registry, { query: '列 MCP 资源', limit: 1 })[0]?.tool.name).toBe('list_mcp_resources')
    expect(searchTools(registry, { query: '读取插件资源', limit: 1 })[0]?.tool.name).toBe('read_mcp_resource')
    expect(searchTools(registry, { query: '查看 MCP prompt', limit: 1 })[0]?.tool.name).toBe('list_mcp_prompts')
    expect(searchTools(registry, { query: '读 prompt 模板', limit: 1 })[0]?.tool.name).toBe('read_mcp_prompt')
    expect(searchTools(registry, { query: '修改 ipynb notebook', limit: 1 })[0]?.tool.name).toBe('NotebookEdit')
    expect(searchTools(registry, { query: '语言服务 hover', limit: 1 })[0]?.tool.name).toBe('LSP')
    expect(searchTools(registry, { query: '执行 PowerShell 命令', limit: 1 })[0]?.tool.name).toBe('PowerShell')
    expect(searchTools(registry, { query: '多步代码操作', limit: 1 })[0]?.tool.name).toBe('REPL')
    expect(searchTools(registry, { query: '读取任务输出', limit: 1 })[0]?.tool.name).toBe('TaskOutput')
    expect(searchTools(registry, { query: '停止任务', limit: 1 })[0]?.tool.name).toBe('TaskStop')
    expect(searchTools(registry, { query: '创建团队', limit: 1 })[0]?.tool.name).toBe('TeamCreate')
    expect(searchTools(registry, { query: '清理团队', limit: 1 })[0]?.tool.name).toBe('TeamDelete')
    expect(searchTools(registry, { query: '给代理发消息', limit: 1 })[0]?.tool.name).toBe('SendMessage')
    expect(searchTools(registry, { query: '查看团队成员', limit: 1 })[0]?.tool.name).toBe('ListPeers')
    expect(searchTools(registry, { query: '子代理隔离工作区', limit: 1 })[0]?.tool.name).toBe('agent_task')
    expect(searchTools(registry, { query: '后台子代理隔离工作区', limit: 1 })[0]?.tool.name).toBe('start_background_agent_task')
    expect(searchTools(registry, { query: '创建 git worktree', limit: 1 })[0]?.tool.name).toBe('EnterWorktree')
    expect(searchTools(registry, { query: '退出 worktree', limit: 1 })[0]?.tool.name).toBe('ExitWorktree')
    expect(searchTools(registry, { query: '先规划设计方案', limit: 1 })[0]?.tool.name).toBe('EnterPlanMode')
    expect(searchTools(registry, { query: '收工前验证计划', limit: 1 })[0]?.tool.name).toBe('VerifyPlanExecution')
    expect(searchTools(registry, { query: '生图', limit: 1 })[0]?.tool.name).toBe('generate_image')
  })
})
