// 工具名 → 图标/中文动词/摘要(对齐 cc-haha-ref desktop/src/components/chat/ToolCallBlock.tsx:29-41
// 的 TOOL_ICONS + :735-834 的 getPendingSummary/getToolSummary/getToolResultSummary/changedLineSummary,
// 以及 ToolCallGroup.tsx:39-64 的 TOOL_VERBS/generateSummary —— 换成我们真实后端工具名
// (snake_case,见 ts/src/tools/*.ts 的 name 字段)+ 中文动词,不抄英文图标字体/文案。
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
}

export function toolIcon(tool: string): IconComp {
  return ICONS[tool] ?? IconWrench
}

const DISPLAY_NAME: Record<string, string> = {
  run_command: '跑命令',
  run_command_background: '后台跑命令',
  read_file: '读文件',
  read_many_files: '读文件',
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
}

/** 折叠头工具展示名;斜杠命令(command_invocation 塞进 tool 字段的 `/xxx`)原样显示。 */
export function toolDisplayName(tool: string): string {
  if (tool.startsWith('/')) return tool
  return DISPLAY_NAME[tool] ?? tool
}

/** 折叠头「文件名/摘要」预览(file_path 优先,其余按工具取关键字段)。 */
export function toolSummary(tool: string, input: unknown): string {
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const path = obj.file_path ?? obj.path
  if (typeof path === 'string') return path.split('/').pop() || path
  switch (tool) {
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

// —— 视觉皮改造新增(无框行:图标 + 过去式动词·灰 + 文件名/目标·蓝 + 细节·灰,对齐真机 Codex
// 折叠行文案"已读取 xxx"/"已运行 xxx"/"已搜索 xxx")。只加"过去式怎么写"这层展示映射,不碰状态机。
const PAST_VERB: Record<string, string> = {
  run_command: '已运行',
  run_command_background: '已后台运行',
  read_file: '已读取',
  read_many_files: '已读取',
  read_stored_tool_result: '已读取',
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

// —— 活动组头摘要(对齐 Codex 源码 completedHeader.summaryParts + nwe 段生成 + Intl.ListFormat unit 连接:
// 「已读取文件运行了 6 条命令」)。分类照 Codex 活动计数器:探索(读)/搜索/列出/命令/网页/子代理/清单。 ——
type ActivityCategory = 'read' | 'search' | 'list' | 'command' | 'web' | 'fetch' | 'agent' | 'todo' | 'other'

function activityCategory(tool: string): ActivityCategory {
  if (tool === 'read_file' || tool === 'read_many_files') return 'read'
  if (tool === 'grep_files' || tool === 'glob_files') return 'search'
  if (tool === 'list_dir') return 'list'
  if (tool === 'run_command' || tool === 'run_command_background' || tool === 'git_status' || tool === 'git_history') return 'command'
  if (tool === 'WebSearch') return 'web'
  if (tool === 'WebFetch') return 'fetch'
  if (tool === 'agent_task' || tool === 'start_background_agent_task') return 'agent'
  if (tool === 'todo_write') return 'todo'
  return 'other'
}

/** 段文案:首段(isLeading)用「已 X」完整式,后续段用顺承式(对齐 Codex leading/following 变体语感)。 */
function activityPart(cat: ActivityCategory, count: number, isLeading: boolean): string | null {
  switch (cat) {
    case 'read': return isLeading ? '已读取文件' : '读取了文件'
    case 'search': return isLeading ? '已搜索代码' : '搜索了代码'
    case 'list': return isLeading ? '已列出文件' : '列出了文件'
    case 'command': return isLeading ? `已运行 ${count} 条命令` : `运行了 ${count} 条命令`
    case 'web': return isLeading ? '已搜索网页' : '搜索了网页'
    case 'fetch': return isLeading ? '已抓取网页' : '抓取了网页'
    case 'agent': return isLeading ? '已派出子代理' : '派出了子代理'
    case 'todo': return null // 清单有专门的会话栏呈现,组头不占一段
    case 'other': return null
  }
}

/**
 * 完成态活动组头(对齐 Codex hDe):按类别聚段 → Intl.ListFormat('zh',{type:'unit'}) 连接
 * (中文 unit 型无分隔符直接连,正是真机「已读取文件运行了多个命令」的观感);全部无段时兜底「已处理」。
 */
export function summarizeActivity(tools: string[]): string {
  const counts = new Map<ActivityCategory, number>()
  const order: ActivityCategory[] = []
  for (const name of tools) {
    const cat = activityCategory(name)
    if (!counts.has(cat)) order.push(cat)
    counts.set(cat, (counts.get(cat) ?? 0) + 1)
  }
  const parts: string[] = []
  for (const cat of order) {
    const text = activityPart(cat, counts.get(cat) ?? 0, parts.length === 0)
    if (text) parts.push(text)
  }
  if (parts.length === 0) return '已处理'
  try {
    return new Intl.ListFormat('zh-CN', { type: 'unit', style: 'narrow' }).format(parts)
  } catch {
    return parts.join('、')
  }
}
