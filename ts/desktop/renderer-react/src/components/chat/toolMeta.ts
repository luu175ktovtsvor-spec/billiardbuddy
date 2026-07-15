// 工具名到图标、中文动词和摘要的展示映射，工具标识以真实后端注册表为准。
import type { ComponentType } from 'react'
import {
  IconTerminal,
  IconFileText,
  IconFilePlus,
  IconFilePen,
  IconGlobe2,
  IconRobot,
  IconWrench,
  IconSearch,
  IconChecklist,
} from '../shared/icons'

export type IconComp = ComponentType<{ size?: number }>

const ICONS: Record<string, IconComp> = {
  run_command: IconTerminal,
  run_command_background: IconTerminal,
  read_file: IconFileText,
  read_many_files: IconFileText,
  read_stored_tool_result: IconFileText,
  read_skill: IconWrench,
  use_skill: IconWrench,
  tool_search: IconWrench,
  list_dir: IconFileText,
  git_status: IconFileText,
  git_history: IconFileText,
  write_file: IconFilePlus,
  edit_file: IconFilePen,
  multi_edit_file: IconFilePen,
  patch_file: IconFilePen,
  patch_files: IconFilePen,
  edit_excel: IconFilePen,
  NotebookEdit: IconFilePen,
  glob_files: IconSearch,
  grep_files: IconSearch,
  WebSearch: IconGlobe2,
  WebFetch: IconGlobe2,
  agent_task: IconRobot,
  start_background_agent_task: IconRobot,
  todo_write: IconChecklist,
  generate_image: IconWrench,
  make_poster: IconWrench,
  edit_image: IconFilePen,
  select_image_candidates: IconSearch,
}

export function toolIcon(tool: string): IconComp {
  return ICONS[tool] ?? IconWrench
}

const DISPLAY_NAME: Record<string, string> = {
  run_command: '跑命令',
  run_command_background: '后台跑命令',
  read_file: '读文件',
  read_many_files: '读文件',
  read_skill: '读取技能',
  use_skill: '读取技能',
  tool_search: '搜索工具',
  write_file: '写文件',
  edit_file: '改文件',
  multi_edit_file: '改文件',
  patch_file: '改文件',
  patch_files: '改文件',
  edit_excel: '改表格',
  glob_files: '找文件',
  grep_files: '搜内容',
  list_dir: '看目录',
  git_status: 'Git 状态',
  git_history: 'Git 历史',
  WebSearch: '搜网页',
  WebFetch: '抓网页',
  agent_task: '子代理',
  start_background_agent_task: '子代理',
  todo_write: '任务清单',
  NotebookEdit: '改 Notebook',
  generate_image: '生成图片',
  make_poster: '生成海报',
  edit_image: '确认修改图片',
  select_image_candidates: '筛选图片',
}

/** 折叠头工具展示名;斜杠命令(command_invocation 塞进 tool 字段的 `/xxx`)原样显示。 */
export function toolDisplayName(tool: string): string {
  if (tool.startsWith('/')) return tool
  return DISPLAY_NAME[tool] ?? tool
}

/** 部分 OpenAI-compatible 流会把多个同名调用拼成 `list_dirlist_dir`。 */
export function repeatedToolBase(tool: string): string | null {
  for (const name of Object.keys(DISPLAY_NAME).sort((a, b) => b.length - a.length)) {
    if (tool.length <= name.length || tool.length % name.length !== 0) continue
    if (name.repeat(tool.length / name.length) === tool) return name
  }
  return null
}

/** 将 `read_many_filesread_file` 这类 provider 粘连名拆成已知工具；单个正常工具名不命中。 */
export function concatenatedToolParts(tool: string): string[] | null {
  const names = Object.keys(DISPLAY_NAME).sort((a, b) => b.length - a.length)
  const memo = new Map<number, string[] | null>()
  const splitAt = (offset: number): string[] | null => {
    if (offset === tool.length) return []
    if (memo.has(offset)) return memo.get(offset) ?? null
    for (const name of names) {
      if (!tool.startsWith(name, offset)) continue
      const rest = splitAt(offset + name.length)
      if (rest) {
        const parts = [name, ...rest]
        memo.set(offset, parts)
        return parts
      }
    }
    memo.set(offset, null)
    return null
  }
  const parts = splitAt(0)
  return parts && parts.length > 1 ? parts : null
}

/** 上游偶发会把同名工具拼接成未知工具；若后续同一基础工具已成功重试，不把该协议噪音算作用户失败。 */
export function visibleActivityTools<T extends { id: string; tool: string; status: ActivitySummaryItem['status'] }>(tools: T[]): T[] {
  const hiddenRecoveredIds = new Set(tools.flatMap((tool, index) => {
    if (tool.status !== 'error') return []
    if (concatenatedToolParts(tool.tool)) return [tool.id]
    const base = repeatedToolBase(tool.tool)
    if (!base) return []
    return tools.slice(index + 1).some(later => later.tool === base && later.status === 'ok') ? [tool.id] : []
  }))
  return tools.filter(tool => !hiddenRecoveredIds.has(tool.id))
}

/** 折叠头「文件名/摘要」预览(file_path 优先,其余按工具取关键字段)。 */
export function toolSummary(tool: string, input: unknown): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const path = obj.file_path ?? obj.path
  if (typeof path === 'string') return path.split('/').pop() || path
  switch (tool) {
    case 'read_skill':
    case 'use_skill': {
      const skill = obj.name ?? obj.skill
      return typeof skill === 'string' ? `${skill} 技能` : ''
    }
    case 'tool_search': {
      const query = obj.query ?? obj.task
      return typeof query === 'string' ? query : ''
    }
    case 'edit_image': {
      const source = obj.source_image_path ?? obj.source_generation_id
      return typeof source === 'string' ? source.split('/').pop() || source : ''
    }
    case 'generate_image':
    case 'make_poster':
      return typeof obj.description === 'string' ? obj.description : ''
    case 'select_image_candidates':
      return typeof obj.path === 'string' ? obj.path : '当前文件夹'
    case 'run_command':
    case 'run_command_background':
      return typeof obj.command === 'string' ? obj.command : ''
    case 'glob_files':
    case 'grep_files':
      return typeof obj.pattern === 'string' ? obj.pattern : ''
    case 'WebSearch':
      return typeof obj.query === 'string' ? obj.query : ''
    case 'WebFetch':
      return typeof obj.url === 'string' ? obj.url : ''
    case 'agent_task':
    case 'start_background_agent_task':
      return typeof obj.description === 'string' ? obj.description : ''
    default:
      return ''
  }
}

/** 折叠头右侧「进行中」动词(对齐 cc getPendingSummary)。 */
export function pendingVerb(tool: string): string {
  if (tool === 'write_file') return '正在写内容'
  if (['edit_file', 'multi_edit_file', 'patch_file', 'patch_files', 'edit_excel'].includes(tool)) return '正在改文件'
  if (tool === 'run_command' || tool === 'run_command_background') return '正在跑命令'
  if (tool === 'read_file' || tool === 'read_many_files') return '正在读文件'
  if (tool === 'glob_files' || tool === 'grep_files') return '正在搜索'
  if (tool === 'WebSearch') return '正在搜网页'
  if (tool === 'WebFetch') return '正在抓网页'
  if (tool === 'agent_task' || tool === 'start_background_agent_task') return '正在派子代理'
  return '正在准备工具'
}

// 无框活动行由状态动词、目标和可选结果摘要组成。
const PAST_VERB: Record<string, string> = {
  run_command: '已运行',
  run_command_background: '已后台运行',
  read_file: '已读取',
  read_many_files: '已读取',
  read_stored_tool_result: '已读取',
  read_skill: '读取',
  use_skill: '读取',
  tool_search: '已加载工具',
  list_dir: '已查看目录',
  git_status: '已查看 Git 状态',
  git_history: '已查看 Git 历史',
  glob_files: '已找到文件',
  grep_files: '已搜索内容',
  WebSearch: '已搜索网页',
  WebFetch: '已抓取网页',
  agent_task: '已完成',
  start_background_agent_task: '已完成',
  todo_write: '已更新清单',
  generate_image: '已生成图片',
  make_poster: '已生成海报',
  edit_image: '已修改图片',
  select_image_candidates: '已筛选图片',
}

/** 折叠头右侧「已完成」动词(过去式;读/搜类工具换真机过去式写法,改文件/跑命令保留现有动宾短语)。 */
export function pastVerb(tool: string): string {
  if (tool.startsWith('/')) return tool
  return PAST_VERB[tool] ?? toolDisplayName(tool)
}

/** 工具行三态动词(对齐 Codex 源码 toolActivity.active:running=「正在 X」/ran=「已 X」/stopped=「已停止」)。
 *  中文规则:过去式「已X」→ 进行时「正在X」;不规则写法进特例表。 */
const RUNNING_VERB_SPECIAL: Record<string, string> = {
  run_command_background: '正在后台运行',
  agent_task: '正在执行',
  start_background_agent_task: '正在执行',
  glob_files: '正在查找文件',
}
export function statusVerb(tool: string, status: 'running' | 'ok' | 'error' | 'interrupted'): string {
  if (status === 'interrupted') return '已停止'
  const past = pastVerb(tool)
  if (status === 'error') return past.startsWith('已') ? `未${past.slice(1)}` : `${past}失败`
  if (status === 'running') {
    return RUNNING_VERB_SPECIAL[tool] ?? (past.startsWith('已') ? `正在${past.slice(1)}` : past)
  }
  return past
}

/** 折叠头「文件名/目标」是否该渲染成蓝色链接(对齐 Codex:只有真实文件路径才是蓝链接,
 *  命令/查询/URL 等目标一律留灰,不滥用蓝色)。逻辑和 toolSummary 取值优先级保持一致。 */
export function toolTargetIsFile(input: unknown): boolean {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return typeof obj.file_path === 'string' || typeof obj.path === 'string'
}

/** read_file 的行范围细节(对齐真机"L1-末尾"写法);无 start_line 时返回空串。 */
export function readRangeDetail(tool: string, input: unknown): string {
  if (tool !== 'read_file') return ''
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const { start_line: start, end_line: end } = obj
  if (start === undefined && end === undefined) return ''
  const startNum = typeof start === 'number' ? start : typeof start === 'string' ? Number(start) || 1 : 1
  const endLabel = end === undefined ? '末尾' : String(end)
  return `L${startNum}-${endLabel}`
}

/** 秒数格式化(对齐 StreamingIndicator 的 formatElapsed,工具编组/助手回合头共用)。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s}s`
}

function changedLineCount(oldString: string, newString: string): number {
  const oldLines = oldString.split('\n')
  const newLines = newString.split('\n')
  let changed = 0
  const max = Math.max(oldLines.length, newLines.length)
  for (let i = 0; i < max; i += 1) {
    if ((oldLines[i] ?? '') !== (newLines[i] ?? '')) changed += 1
  }
  return changed
}

/** 折叠头右侧「已完成」动词摘要(对齐 cc changedLineSummary,成功态用过去式)。 */
export function doneVerb(tool: string, input: unknown): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  if (tool === 'edit_file' || tool === 'multi_edit_file') {
    if (typeof obj.old_string === 'string' && typeof obj.new_string === 'string') {
      return `改了 ${changedLineCount(obj.old_string, obj.new_string)} 行`
    }
    return '改了文件'
  }
  if (tool === 'write_file' && typeof obj.content === 'string') {
    return `写了 ${obj.content.split('\n').length} 行`
  }
  return ''
}

/** 输出摘要(对齐 cc getToolResultSummary):错误取首行(截 72 字);Bash 成功不重复展示,
 *  其余多行给「N 行输出」,单行给内容本身(截 36 字)。 */
export function resultSummary(tool: string, output: string | undefined, isError: boolean): string {
  const text = (output ?? '').trim()
  if (!text) return ''
  if (isError) {
    const firstLine = text
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .find(Boolean)
    if (!firstLine) return '出错了'
    return firstLine.length <= 72 ? firstLine : `${firstLine.slice(0, 72)}…`
  }
  if (tool === 'run_command' || tool === 'run_command_background') return ''
  const lineCount = text.split('\n').length
  if (lineCount > 1) return `${lineCount} 行输出`
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= 36 ? compact : `${compact.slice(0, 36)}…`
}

const GROUP_VERB: Record<string, (n: number) => string> = {
  run_command: (n) => `跑了 ${n} 条命令`,
  run_command_background: (n) => `后台跑了 ${n} 条命令`,
  read_file: (n) => `读了 ${n} 个文件`,
  read_many_files: (n) => `读了 ${n} 个文件`,
  write_file: (n) => `写了 ${n} 个文件`,
  edit_file: (n) => `改了 ${n} 个文件`,
  multi_edit_file: (n) => `改了 ${n} 个文件`,
  patch_file: (n) => `改了 ${n} 个文件`,
  patch_files: (n) => `改了 ${n} 个文件`,
  edit_excel: (n) => `改了 ${n} 个表格`,
  glob_files: () => '找了文件',
  grep_files: (n) => `搜了 ${n} 次`,
  list_dir: (n) => `看了 ${n} 次目录`,
  WebSearch: () => '搜了网页',
  WebFetch: (n) => `抓了 ${n} 个网页`,
  agent_task: (n) => `派了 ${n} 个子代理`,
  start_background_agent_task: (n) => `派了 ${n} 个子代理`,
  todo_write: () => '更新了任务清单',
}

/** 分组折叠头摘要(对齐 cc generateSummary):按工具计数、拼成一句大白话。 */
export function groupSummary(tools: string[]): string {
  const counts = new Map<string, number>()
  for (const name of tools) counts.set(name, (counts.get(name) ?? 0) + 1)
  const parts: string[] = []
  for (const [name, count] of counts) {
    const fn = GROUP_VERB[name]
    parts.push(fn ? fn(count) : `调用了 ${toolDisplayName(name)} × ${count}`)
  }
  return parts.join('·')
}

export interface ActivitySummaryItem {
  tool: string
  status: 'running' | 'ok' | 'error' | 'interrupted'
  input?: unknown
}

const IMAGE_PATH_RE = /\.(?:avif|gif|jpe?g|png|webp)$/i

function inputPath(input: unknown): string {
  const obj = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const path = obj.file_path ?? obj.path
  return typeof path === 'string' ? path : ''
}

/** 完成态采用 Codex 当前活动摘要口径；具体数量和目标留在展开明细。 */
export function summarizeActivity(items: ActivitySummaryItem[]): string {
  const done = items.filter(item => item.status === 'ok')
  if (done.length === 0) {
    if (items.some(item => item.status === 'running')) return '正在处理'
    if (items.some(item => item.status === 'interrupted')) return '已停止'
    return '部分步骤未完成'
  }

  const count = (names: string[]): number => done.filter(item => names.includes(item.tool)).length
  const imageReads = done.filter(item => item.tool === 'read_file' && IMAGE_PATH_RE.test(inputPath(item.input))).length
  const fileReads = count(['read_file', 'read_many_files']) - imageReads
  const folderReads = count(['list_dir'])
  const candidateSelections = count(['select_image_candidates'])
  const loadedTools = count(['read_skill', 'use_skill', 'tool_search'])
  const searches = count(['glob_files', 'grep_files'])
  const commands = count(['run_command', 'run_command_background', 'git_status', 'git_history'])
  const webSearches = count(['WebSearch'])
  const webFetches = count(['WebFetch'])
  const agents = count(['agent_task', 'start_background_agent_task'])
  const todos = count(['todo_write'])
  const counted = folderReads + candidateSelections + loadedTools + imageReads + fileReads + searches + commands + webSearches + webFetches + agents + todos
  const parts: string[] = []

  if (folderReads) parts.push('已列出文件')
  if (candidateSelections) parts.push('已筛选图片')
  if (loadedTools) parts.push('已加载工具')
  if (imageReads + fileReads) parts.push('已读取文件')
  if (searches) parts.push('已搜索文件')
  if (commands) parts.push(commands === 1 ? '运行了一个命令' : '运行了多个命令')
  if (webSearches) parts.push('已搜索网页')
  if (webFetches) parts.push('已查看网页')
  if (agents) parts.push('已完成子任务')
  if (done.length > counted) parts.push('已完成步骤')

  if (parts.length === 0) return '已处理'
  return parts.join('')
}
