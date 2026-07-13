// 技能/命令发现清单(skill listing)—— 对齐 cc-haha SkillTool。
//
// cc 的做法(src/tools/SkillTool/prompt.ts + src/utils/attachments.ts):把「模型可调用的技能/命令」
// 汇成一份发现清单(每条 name + 一句 whenToUse),按约 1% 上下文预算截断,注入会话让模型
// 「看清单 → 自动调」。这里把同一套语义落进我们的系统提示:
//   - 汇总:builtin 命令 + 已加载技能 + 已启用领域包命令(如 billiards:*、/台球)。
//   - 预算:约 1% 上下文窗口(字符),对齐 cc SKILL_BUDGET_CONTEXT_PERCENT。
//   - 截断:领域包 + 技能条目(alwaysInclude)永不被截断(对齐 cc 对 bundled 的保留),
//           普通命令在预算不足时先削描述、再退成 names-only。
//
// 「斜杠命令 = 技能」:cc SkillTool/prompt.ts 里那句「用户提到 /xxx 指的就是一个 skill,用本工具调它」
// 在这份清单的 section 头里以中文复刻,让模型既能响应 /台球 这类显式斜杠,也能按清单主动调起。

import type { CommandLibrary } from '../commands/commandLoader'
import type { PromptCommand } from '../commands/types'
import type { SkillLibrary } from '../skills/skillLoader'

// 发现清单预算 = 约 1% 上下文窗口(字符);对齐 cc SkillTool。
export const SKILL_BUDGET_CONTEXT_PERCENT = 0.01
export const CHARS_PER_TOKEN = 4
export const DEFAULT_CHAR_BUDGET = 8_000 // 回退:200k tokens × 4 字符/token × 1%
export const MAX_LISTING_DESC_CHARS = 250 // 每条描述硬上限(对齐 cc);发现只为路由,展开靠工具读全文
const MIN_DESC_LENGTH = 20

export type DiscoverySource = 'builtin' | 'skill' | 'pack' | 'plugin'

export interface DiscoveryEntry {
  name: string
  description: string
  whenToUse?: string
  argHint?: string
  source: DiscoverySource
  /** 技能落点层(bundled/user/workspace),前端斜杠浮层显示「系统/个人/项目」作用域用。 */
  layer?: PromptCommand['skillLayer']
  /** cc bundled 语义:清单里永不被截断的条目。技能 + 领域包命令置 true,保证 billiards 在极端预算下仍在。 */
  alwaysInclude: boolean
  /** disable-model-invocation:模型面清单排除它(用户面保留)。对齐 cc。 */
  disableModelInvocation?: boolean
  /** user-invocable(默认 true):false 则用户面清单排除它(模型面保留)。对齐 cc。 */
  userInvocable?: boolean
}

export interface DiscoverySources {
  commands?: CommandLibrary
  skills?: SkillLibrary
  contextWindowTokens?: number
  /** 本会话已激活的条件技能(碰到命中 paths 的文件才现身;对齐 cc activateConditionalSkillsForPaths → 并回清单)。 */
  activatedConditionalSkills?: PromptCommand[]
}

export interface PublicCommandEntry {
  name: string
  description: string
  source: DiscoverySource
  layer?: PromptCommand['skillLayer']
  whenToUse?: string
  argHint?: string
}

/** 预算字符数:环境覆盖 > 按上下文窗口算 1% > 默认 8000。对齐 cc getCharBudget。 */
export function getCharBudget(contextWindowTokens?: number): number {
  const override = Number(process.env.SLASH_COMMAND_TOOL_CHAR_BUDGET)
  if (Number.isFinite(override) && override > 0) return override
  if (contextWindowTokens && contextWindowTokens > 0) {
    return Math.floor(contextWindowTokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT)
  }
  return DEFAULT_CHAR_BUDGET
}

const SOURCE_RANK: Record<DiscoverySource, number> = { pack: 0, plugin: 1, skill: 2, builtin: 3 }

function commandSource(cmd: PromptCommand): DiscoverySource {
  if (cmd.filePath?.startsWith('domain-pack://')) return 'pack'
  if (cmd.source === 'plugin') return 'plugin'
  if (cmd.source === 'skills') return 'skill'
  return 'builtin'
}

/**
 * 汇总一份发现条目:领域包命令 → 技能 → builtin/工作区命令。按 source 排序(pack、skill、builtin),
 * 组内保持稳定顺序;按 name 去重(命令优先于同名技能)。
 */
export function collectDiscoveryEntries(opts: { commands?: CommandLibrary; skills?: SkillLibrary; activatedConditionalSkills?: PromptCommand[] }): DiscoveryEntry[] {
  const entries: DiscoveryEntry[] = []
  const seen = new Set<string>()
  const push = (cmd: PromptCommand, source: DiscoverySource) => {
    if (!cmd.name || seen.has(cmd.name)) return
    seen.add(cmd.name)
    entries.push({
      name: cmd.name,
      description: cmd.description,
      whenToUse: cmd.whenToUse,
      argHint: cmd.argumentHint,
      source,
      layer: cmd.skillLayer,
      alwaysInclude: source === 'skill' || source === 'pack',
      ...(cmd.disableModelInvocation ? { disableModelInvocation: true } : {}),
      ...(cmd.userInvocable === false ? { userInvocable: false } : {}),
    })
  }
  for (const cmd of opts.commands?.commands ?? []) push(cmd, commandSource(cmd))
  for (const skill of opts.skills?.skills ?? []) push(skill, skill.source === 'plugin' ? 'plugin' : 'skill')
  // 已激活的条件技能并回清单(碰到命中文件才现身;默认它们被 loadLayeredSkills 排除在 skills 之外)。
  for (const skill of opts.activatedConditionalSkills ?? []) push(skill, 'skill')
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rank = SOURCE_RANK[a.entry.source] - SOURCE_RANK[b.entry.source]
      return rank !== 0 ? rank : a.index - b.index
    })
    .map(item => item.entry)
}

function truncate(value: string, maxLen: number): string {
  if (maxLen <= 0) return ''
  return value.length > maxLen ? value.slice(0, maxLen - 1) + '…' : value
}

function entryDescription(entry: DiscoveryEntry): string {
  const desc = entry.whenToUse ? `${entry.description} - ${entry.whenToUse}` : entry.description
  return desc.length > MAX_LISTING_DESC_CHARS ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + '…' : desc
}

function entryLine(entry: DiscoveryEntry): string {
  return `- /${entry.name}: ${entryDescription(entry)}`
}

/**
 * 按预算格式化发现清单(对齐 cc formatCommandsWithinBudget)。
 * 全量放得下就全给;放不下时保留 alwaysInclude(技能+领域包)整行,其余先削描述、再退 names-only。
 */
export function formatEntriesWithinBudget(entries: DiscoveryEntry[], contextWindowTokens?: number): string {
  if (entries.length === 0) return ''
  const budget = getCharBudget(contextWindowTokens)

  const full = entries.map(entry => ({ entry, line: entryLine(entry) }))
  const fullTotal = full.reduce((sum, item) => sum + item.line.length, 0) + (full.length - 1)
  if (fullTotal <= budget) return full.map(item => item.line).join('\n')

  const preserved = new Set<number>()
  const rest: DiscoveryEntry[] = []
  entries.forEach((entry, index) => {
    if (entry.alwaysInclude) preserved.add(index)
    else rest.push(entry)
  })

  if (rest.length === 0) return full.map(item => item.line).join('\n')

  const preservedChars = full.reduce((sum, item, index) => (preserved.has(index) ? sum + item.line.length + 1 : sum), 0)
  const restNameOverhead = rest.reduce((sum, entry) => sum + `/${entry.name}`.length + 4, 0) + (rest.length - 1)
  const availableForDescs = budget - preservedChars - restNameOverhead
  const maxDescLen = Math.floor(availableForDescs / rest.length)

  if (maxDescLen < MIN_DESC_LENGTH) {
    // 极端预算:alwaysInclude 保留整行,其余退成 names-only。
    return entries.map((entry, index) => (preserved.has(index) ? full[index]!.line : `- /${entry.name}`)).join('\n')
  }

  return entries
    .map((entry, index) => {
      if (preserved.has(index)) return full[index]!.line
      return `- /${entry.name}: ${truncate(entryDescription(entry), maxDescLen)}`
    })
    .join('\n')
}

export function toPublicCommandEntries(entries: DiscoveryEntry[]): PublicCommandEntry[] {
  // 用户面清单(前端斜杠 typeahead):user-invocable:false 的条目不给用户;disable-model-invocation 的用户仍可见。对齐 cc。
  return entries
    .filter(entry => entry.userInvocable !== false)
    .map(entry => ({
    name: entry.name,
    description: entry.description,
    source: entry.source,
    ...(entry.layer ? { layer: entry.layer } : {}),
    ...(entry.whenToUse ? { whenToUse: entry.whenToUse } : {}),
    ...(entry.argHint ? { argHint: entry.argHint } : {}),
  }))
}

/**
 * 组装注入系统提示的「可用技能与命令」段:cc「斜杠命令=技能」语义 + 渐进披露纪律 + 预算内清单。
 * 没有任何可发现条目时返回空串(调用方据此决定是否拼接)。
 */
export function buildSkillCommandListingSection(sources: DiscoverySources): string {
  // 模型面清单:disable-model-invocation 的条目不进(模型看不到、不会调;用户敲斜杠仍可)。对齐 cc。
  const entries = collectDiscoveryEntries(sources).filter(entry => !entry.disableModelInvocation)
  if (entries.length === 0) return ''
  const listing = formatEntriesWithinBudget(entries, sources.contextWindowTokens)
  if (!listing) return ''
  return [
    '# 可用技能与命令(斜杠命令 = 技能)',
    '用户敲 "/<名字>"(例如 /台球、/billiards:daily-ops)就是想调用下面清单里的某个技能或命令 —— 语义等同「斜杠命令就是一个技能」。',
    '命中后用 use_skill / read_skill(技能)或 read_command(命令)把它展开成完整指令再执行;你也可以在判断某条相关时主动调起,不必等用户敲斜杠。',
    '这是一份「发现清单」,只列名字 + 一句使用时机:先扫这份判断相关性,真要用某条时再展开读全文,别一次性全展开,也别调用清单里没有的名字。',
    listing,
  ].join('\n')
}
