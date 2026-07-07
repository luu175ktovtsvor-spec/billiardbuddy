import type { Tool, ToolSpec } from './Tool'
import type { ToolRegistry } from './registry'

export const TOOL_SEARCH_NAME = 'tool_search'
export const TOOL_SCHEMA_LAZY_THRESHOLD = 32

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const DIRECT_MCP_TOOL_LIMIT = 3

const HOT_TOOL_NAMES = new Set([
  TOOL_SEARCH_NAME,
  'read_file',
  'read_many_files',
  'write_file',
  'edit_file',
  'multi_edit_file',
  'NotebookEdit',
  'patch_file',
  'patch_files',
  'EnterWorktree',
  'ExitWorktree',
  'list_dir',
  'glob_files',
  'grep_files',
  'code_outline',
  'git_status',
  'git_history',
  'LSP',
  'read_stored_tool_result',
  'SendUserMessage',
  'Brief',
  'list_project_instructions',
  'project_diagnostics',
  'PowerShell',
  'REPL',
  'run_command',
  'todo_write',
  'task_create',
  'task_list',
  'task_get',
  'task_update',
  'TaskCreate',
  'TaskList',
  'TaskGet',
  'TaskUpdate',
  'TaskOutput',
  'TaskStop',
  'TeamCreate',
  'TeamDelete',
  'SendMessage',
  'ListPeers',
  'ask_user_question',
  'AskUserQuestion',
  'enter_plan',
  'EnterPlanMode',
  'exit_plan',
  'ExitPlanMode',
  'VerifyPlanExecution',
  'verify_plan_execution',
  'file_history',
  'restore_file',
  'list_skills',
  'read_skill',
  'create_skill',
  'list_commands',
  'read_command',
  'list_mcp_resources',
  'read_mcp_resource',
  'list_mcp_prompts',
  'read_mcp_prompt',
  'search_store_docs',
  'billiards_ops_checklist',
  'agent_task',
  'list_agent_task_sidechains',
  'read_agent_task_sidechain',
  'read_agent_task_stored_result',
  'start_background_agent_task',
  'list_background_tasks',
  'read_background_task',
  'cancel_background_task',
  'make_poster',
  'generate_image',
  'generate_video',
])

const TOOL_SEARCH_ALIASES: Record<string, string[]> = {
  read_file: ['读文件', '读取文件', '查看文件', '打开文件', '精读代码', 'read code'],
  read_many_files: ['批量读文件', '读取多个文件', '读多文件', '多文件上下文', 'batch read'],
  write_file: ['写文件', '新建文件', '创建文件', '覆盖文件', 'write code'],
  edit_file: ['改文件', '修改文件', '替换代码', '编辑代码', 'edit code'],
  multi_edit_file: ['批量编辑', '多处替换', '批量修改', '重命名调用点', 'multi edit'],
  NotebookEdit: ['编辑 notebook', '修改 ipynb', 'Jupyter notebook', 'notebook edit', '改笔记本'],
  patch_file: ['打补丁', '应用补丁', 'unified diff', '复杂修改', 'patch code'],
  patch_files: ['多文件补丁', '批量补丁', '跨文件修改', '原子补丁', 'multi file patch'],
  EnterWorktree: ['worktree', '创建 worktree', '进入 worktree', '隔离工作区', 'git worktree', 'EnterWorktree'],
  ExitWorktree: ['worktree', '退出 worktree', '离开 worktree', '删除 worktree', '保留 worktree', 'ExitWorktree'],
  list_dir: ['列目录', '看目录', '目录结构', '查看文件夹', '递归目录', '项目树', 'tree', 'ls'],
  glob_files: ['找文件', '按模式找文件', '文件匹配', 'glob', 'find files'],
  grep_files: ['搜代码', '查引用', '查关键字', '搜索文本', '找调用', 'grep', 'ripgrep'],
  code_outline: ['代码结构', '符号列表', '符号窗口', '看 imports', '看函数', '类和函数', 'outline code'],
  git_status: ['git 状态', '查看改动', '查看 diff', '工作区改动', '代码变更', '暂存 diff', '已暂存改动', '全量改动审阅', 'staged changes', 'staged diff', 'git diff', 'git status'],
  git_history: ['git 历史', '提交历史', '查看提交', '谁改的', '为什么改', '追溯修改', '回归来源', 'commit log', 'git log', 'git show', '历史 diff', '回归定位'],
  LSP: ['LSP', '语言服务', '跳转定义', '查引用', 'hover', '符号搜索', '调用层级', 'definition', 'references', 'workspace symbol'],
  read_stored_tool_result: ['读取长结果', '读取工具结果', '完整工具结果', 'stored tool result', 'stored_tool_result', '大结果回读'],
  SendUserMessage: ['给用户发消息', '回复用户', '用户可见消息', 'SendUserMessage', 'Brief', 'brief mode', 'message user'],
  Brief: ['legacy Brief', 'SendUserMessage alias', 'brief mode'],
  list_project_instructions: ['查项目规则', '项目指令', '目录规则', 'agents.md', 'claude.md', 'scope 规则'],
  project_diagnostics: ['跑诊断', '跑类型检查', '类型检查', '跑 lint', '跑测试', '聚焦测试', '附近测试', '验证改动', 'typecheck', 'diagnostics'],
  PowerShell: ['PowerShell', 'pwsh', 'powershell', 'Windows 命令', '执行 PowerShell', 'PowerShell 终端', 'Windows shell'],
  REPL: ['REPL', '批量工具', '批量执行', '工具编排', '多步代码操作', 'batch tools', 'primitive tools'],
  run_command: ['跑命令', '执行命令', '运行脚本', '终端', 'shell', 'bash'],
  todo_write: ['任务清单', '更新计划', 'todo', '进度清单'],
  task_create: ['创建任务', '结构化任务', 'task create', 'TaskCreate', '拆任务'],
  task_list: ['任务列表', '列任务', '查看任务', 'task list', 'TaskList'],
  task_get: ['任务详情', '读取任务', '查看单个任务', 'task get', 'TaskGet'],
  task_update: ['更新任务', '完成任务', '删除任务', '任务状态', 'task update', 'TaskUpdate'],
  TaskCreate: ['创建任务', '结构化任务', 'task create', 'task_create', '拆任务', 'CC-Haha task'],
  TaskList: ['任务列表', '列任务', '查看任务', 'task list', 'task_list', 'CC-Haha task'],
  TaskGet: ['任务详情', '读取任务', '查看单个任务', 'task get', 'task_get', 'CC-Haha task'],
  TaskUpdate: ['更新任务', '完成任务', '删除任务', '任务状态', 'task update', 'task_update', 'CC-Haha task'],
  TaskOutput: ['读取任务输出', '后台任务输出', '查看任务日志', 'TaskOutput', 'task output', 'read task output'],
  TaskStop: ['停止任务', '取消任务', '中断任务', 'TaskStop', 'task stop', 'kill task'],
  TeamCreate: ['创建团队', '创建 team', 'TeamCreate', '多代理团队', 'agent swarm', 'spawn team'],
  TeamDelete: ['删除团队', '清理团队', '解散 team', 'TeamDelete', 'cleanup team', 'disband team'],
  SendMessage: ['发消息', '给代理发消息', '队友通信', 'SendMessage', 'message teammate', 'agent message'],
  ListPeers: ['列队友', '查看团队成员', '列 peers', 'ListPeers', 'agent peers', 'team members'],
  enter_plan: ['进入计划模式', '先规划', '设计方案', 'EnterPlanMode', 'plan mode', '计划审批前探索'],
  EnterPlanMode: ['进入计划模式', '先规划', '设计方案', 'EnterPlanMode', 'plan mode', '计划审批前探索'],
  VerifyPlanExecution: ['验证计划', '计划执行校验', 'VerifyPlanExecution', 'verify plan', 'implementation verification', '收工前验证'],
  verify_plan_execution: ['验证计划', '计划执行校验', 'verify_plan_execution', 'verify plan', '收工前验证'],
  file_history: ['文件历史', '修改历史', '备份记录', '查看备份', '多文件历史', '批量备份记录'],
  restore_file: ['回滚文件', '恢复文件', '撤销修改', '还原备份', '多文件回滚'],
  list_skills: ['列技能', '查看技能', 'skills'],
  read_skill: ['读技能', '技能说明', 'skill docs'],
  create_skill: ['创建技能', '沉淀技能', '保存技能'],
  list_commands: ['列命令', 'slash 命令', '斜杠命令'],
  read_command: ['读命令', '命令详情', 'prompt command'],
  list_mcp_resources: ['列 MCP 资源', '查看 MCP 资源', '外部资源列表', '插件资源', 'mcp resources', 'list resources'],
  read_mcp_resource: ['读取 MCP 资源', '读外部资源', '读取插件资源', 'resource uri', 'read resource'],
  list_mcp_prompts: ['列 MCP prompt', '查看 MCP prompt', '外部 prompt 模板', '插件 prompt', 'mcp prompts', 'list prompts'],
  read_mcp_prompt: ['读取 MCP prompt', '读 prompt 模板', '加载外部 prompt', 'prompt template', 'read prompt'],
  search_store_docs: ['查知识库', '查店铺资料', '专有资料', '资料来源', 'rag', 'store docs'],
  billiards_ops_checklist: ['台球运营核对', '门店运营检查', '台球清单', '经营建议核对'],
  agent_task: ['子代理', '派子任务', '并行研究', '让代理分析', 'subagent', '子代理隔离工作区', '子代理 worktree', 'agent isolation'],
  list_agent_task_sidechains: ['列子代理轨迹', '同步子代理历史', 'agent sidechains', 'list agent transcripts'],
  read_agent_task_sidechain: ['读子代理轨迹', '读取子代理 transcript', '查看子代理历史', 'agent sidechain', 'agent transcript'],
  read_agent_task_stored_result: ['读取子代理长结果', '读取子代理工具结果', '子代理 stored tool result', 'agent stored result', 'sidechain stored result'],
  start_background_agent_task: ['后台任务', '后台子代理', '异步任务', '长任务', '后台子代理隔离工作区', '后台 agent worktree'],
  list_background_tasks: ['列后台任务', '任务列表', '查看后台任务'],
  read_background_task: ['读后台任务', '查看任务详情', '任务日志', 'trace'],
  cancel_background_task: ['取消后台任务', '停止任务', '中断任务'],
  make_poster: ['做海报', '生成海报', '门店海报', 'poster'],
  generate_image: ['生图', '生成图片', '图片生成', '画图', 'image generation'],
  generate_video: ['生视频', '生成视频', '图生视频', '短视频', 'video generation'],
}

interface ToolSearchInput {
  query?: string
  task?: string
  limit?: number
}

interface ToolMatch {
  tool: Tool
  score: number
}

export function createToolSearchTool(registry: ToolRegistry): Tool<ToolSearchInput> {
  return {
    name: TOOL_SEARCH_NAME,
    description: [
      'Search hidden or less common tools by task, then use the returned tool names and schemas in the next step.',
      'Use this when the needed capability is not in the visible tool list, especially for MCP/plugin/media/extension tools.',
      'Input: { query OR task, limit? }.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        task: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    isReadOnly: true,
    async execute(input) {
      const matches = searchTools(registry, input)
      const query = toolSearchQuery(input)
      if (matches.length === 0) {
        return `<tool_search query="${xmlAttr(query)}" count="0">\n没有找到匹配工具。请换更具体的能力/平台/动作关键词再搜。\n</tool_search>`
      }
      return [
        `<tool_search query="${xmlAttr(query)}" count="${matches.length}">`,
        ...matches.map(({ tool, score }) => formatToolMatch(tool, score)),
        '</tool_search>',
      ].join('\n')
    },
  }
}

export function searchTools(registry: ToolRegistry, input: unknown): ToolMatch[] {
  const query = toolSearchQuery(input)
  const terms = queryTerms(query)
  const limit = toolSearchLimit(input)
  const matches = registry.list()
    .filter(tool => tool.name !== TOOL_SEARCH_NAME)
    .map(tool => ({ tool, score: scoreTool(tool, query, terms) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit)
  return matches
}

export function revealToolNamesForSearch(registry: ToolRegistry, input: unknown): string[] {
  return searchTools(registry, input).map(item => item.tool.name)
}

export function visibleToolSpecs(registry: ToolRegistry, revealedToolNames: Set<string>): ToolSpec[] {
  const tools = registry.list()
  if (!shouldUseLazyToolSpecs(registry)) return registry.specs()
  const mcpToolCount = tools.filter(tool => tool.name.startsWith('mcp__')).length
  return tools
    .filter(tool => HOT_TOOL_NAMES.has(tool.name) || revealedToolNames.has(tool.name) || (mcpToolCount <= DIRECT_MCP_TOOL_LIMIT && tool.name.startsWith('mcp__')))
    .map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }))
}

export function shouldUseLazyToolSpecs(registry: ToolRegistry): boolean {
  return !!registry.get(TOOL_SEARCH_NAME) && registry.list().length > TOOL_SCHEMA_LAZY_THRESHOLD
}

function toolSearchQuery(input: unknown): string {
  const obj = asRecord(input)
  return stringValue(obj.query) || stringValue(obj.task) || stringValue(obj.intent)
}

function toolSearchLimit(input: unknown): number {
  const n = Number(asRecord(input).limit)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)))
}

function queryTerms(query: string): string[] {
  const terms = new Set<string>()
  const lower = query.toLowerCase()
  for (const word of lower.match(/[a-z0-9_:-]{2,}/g) ?? []) terms.add(word)
  for (const seq of lower.match(/[\u4e00-\u9fff]{2,}/g) ?? []) {
    terms.add(seq)
    for (let i = 0; i < seq.length - 1; i++) terms.add(seq.slice(i, i + 2))
  }
  return [...terms]
}

function scoreTool(tool: Tool, query: string, terms: string[]): number {
  if (!query.trim()) return HOT_TOOL_NAMES.has(tool.name) ? 0 : 1
  const name = tool.name.toLowerCase()
  const desc = tool.description.toLowerCase()
  const schemaText = JSON.stringify(tool.inputSchema).toLowerCase()
  const aliasText = toolAliases(tool.name).join('\n').toLowerCase()
  const haystack = `${name}\n${desc}\n${schemaText}\n${aliasText}`
  let score = haystack.includes(query.toLowerCase()) ? 12 : 0
  for (const term of terms) {
    if (name.includes(term)) score += 7
    if (aliasText.includes(term)) score += term.length >= 3 ? 6 : 3
    if (desc.includes(term)) score += term.length >= 3 ? 4 : 2
    if (schemaText.includes(term)) score += 1
  }
  if (name.startsWith('mcp__')) score += 0.5
  return score
}

function toolAliases(name: string): string[] {
  if (TOOL_SEARCH_ALIASES[name]) return TOOL_SEARCH_ALIASES[name]
  if (name.startsWith('mcp__')) return ['mcp', '插件工具', '外部工具', name.replaceAll('__', ' ')]
  return []
}

function formatToolMatch(tool: Tool, score: number): string {
  const spec = JSON.stringify(tool.inputSchema)
  return [
    `<tool name="${xmlAttr(tool.name)}" read_only="${tool.isReadOnly}" score="${Number(score.toFixed(2))}">`,
    xmlText(tool.description),
    '<input_schema>',
    xmlText(spec.length > 4000 ? `${spec.slice(0, 4000)}...` : spec),
    '</input_schema>',
    '</tool>',
  ].join('\n')
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function xmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
