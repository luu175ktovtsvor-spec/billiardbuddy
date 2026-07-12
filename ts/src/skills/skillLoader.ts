import { existsSync, realpathSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileGlobMatchesPathForRule } from '../permissions/filePathRuleMatch'
import { getUserConfigHomeDir, MEMORY_DOT_DIR } from '../harness/memoryNames'
import { resolveBundledDir } from '../harness/bundledRoot'
import { booleanField, extractDescription, parseMarkdownDocument, stringArrayField, stringField } from '../commands/frontmatter'
import { addAllowedToolsToContext, allowedToolRulesFromFrontmatter, normalizeAllowedTools } from '../commands/allowedTools'
import { parseArgumentNames, substituteArguments } from '../commands/argumentSubstitution'
import { executeShellCommandsInPrompt, substitutePromptTemplateVars } from '../commands/promptShellExecution'
import type { PromptCommand } from '../commands/types'
import { applyConfigChangeHooks, mergeHookRegistries, type HookSource } from '../hooks/hooks'
import { normalizeHookRegistry } from '../hooks/hookConfig'
import type { Tool, ToolContext } from '../tools/Tool'
import { addInvokedSkill } from './invokedSkills'

export interface SkillLibrary {
  skills: PromptCommand[]
  byName: Map<string, PromptCommand>
}

export interface SkillIndexOptions {
  recommendedSkillNames?: string[]
  recommendedOnly?: boolean
  query?: string
  limit?: number
}

interface ListSkillsInput {
  recommended_only?: boolean
  query?: string
  limit?: number
}

interface UseSkillInput {
  name?: string
  skill?: string
  args?: string
}

export type ExecuteSkillFn = (skill: PromptCommand, args: string, ctx: ToolContext) => Promise<string>

function safeName(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function quoteYaml(value: string): string {
  return JSON.stringify(value)
}

function yamlArray(values: string[] | undefined): string | undefined {
  if (!values || values.length === 0) return undefined
  return `[${values.map(quoteYaml).join(', ')}]`
}

export function formatUseSkillResult(skill: PromptCommand, prompt: string): string {
  if (!skill.allowedTools || skill.allowedTools.length === 0) return prompt
  return `${prompt}\n\n<skill_allowed_tools skill="${xmlAttr(skill.name)}">\n${skill.allowedTools.map(tool => `- ${tool}`).join('\n')}\n</skill_allowed_tools>`
}

export function recordInvokedSkill(skill: PromptCommand, content: string, ctx: ToolContext): void {
  addInvokedSkill(skill.name, skill.filePath || `${skill.source}:${skill.name}`, content, ctx.conversationId ?? null)
}

export function allowSkillTools(skill: PromptCommand, ctx: ToolContext): void {
  addAllowedToolsToContext(ctx, skill.allowedToolRules ?? skill.allowedTools)
}

export function registerSkillHooks(skill: PromptCommand, ctx: ToolContext): void {
  if (!skill.hooks || skill.hooks.rules.length === 0) return
  ctx.sessionHooks = mergeHookRegistries(ctx.sessionHooks, skill.hooks)
  ctx.onSessionHooksChanged?.(ctx.sessionHooks)
}

// —— use_skill 授权闸(对齐 cc SkillTool.checkPermissions,掰回“调技能绕过 Bash 审批”的提权洞)——
// 现状漏洞:use_skill 没有审批闸,execute() 会把技能 frontmatter 的 allowedTools 直接灌进会话 allow
// (allowSkillTools)、把 hooks 注册进会话(registerSkillHooks)。于是模型只要调一个带
// `allowedTools:[Bash(git push:*)]` 的技能,就等于在本会话内自助放开 git push,绕过 run_command 审批。
// 掰回:给 use_skill 补 requiresApprovalFor——仅含安全声明属性的技能自动放行;凡携带
// allowedTools/allowedToolRules/hooks(授权类字段)的技能默认走审批闸(ask),批准后才在
// execute() 里灌工具/挂 hook。allowlist 口径照 cc:任何不在安全名单里的属性只要有实义值即视为需审批,
// 未来新增字段默认从严。
const SAFE_SKILL_PROPERTIES = new Set<string>([
  'type', 'name', 'description', 'whenToUse',
  'argumentHint', 'argNames', 'model', 'context', 'agent',
  // 可见性/别名/条件披露字段纯元数据,不授予工具/hook,不触发审批(否则带这些字段的普通技能会被误判需审批)。
  'disableModelInvocation', 'userInvocable', 'aliases', 'skillLayer', 'paths',
  'source', 'filePath', 'baseDir', 'contentLength', 'getPrompt',
])

/** 技能是否只含安全属性(无 allowedTools/allowedToolRules/hooks 等授权类字段)。移植自 cc skillHasOnlySafeProperties。 */
export function skillHasOnlySafeProperties(skill: PromptCommand): boolean {
  for (const key of Object.keys(skill)) {
    if (SAFE_SKILL_PROPERTIES.has(key)) continue
    const value = (skill as unknown as Record<string, unknown>)[key]
    if (value === undefined || value === null) continue
    if (Array.isArray(value) && value.length === 0) continue
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) continue
    return false
  }
  return true
}

/** 携带 allowedTools/hooks 的技能需审批(纯安全技能免审批)。取反自 skillHasOnlySafeProperties。 */
export function skillRequiresApproval(skill: PromptCommand): boolean {
  return !skillHasOnlySafeProperties(skill)
}

/** use_skill 的名字解析:优先 name 别名,回退 skill;都空返回空串。 */
function resolveUseSkillName(input: UseSkillInput | undefined): string {
  const alias = typeof input?.name === 'string' ? input.name.trim() : ''
  if (alias) return alias
  return typeof input?.skill === 'string' ? input.skill.trim() : ''
}

/**
 * ctx.permissionRules 里是否存在放行该技能的 use_skill allow 规则(按名精确或 `prefix:*` 前缀)。
 * 对齐 cc SkillTool.checkPermissions 的 allowRules 匹配,让“记住允许某技能”后二次调用免审批。
 * 裸 use_skill allow(无 ruleContent)= 放开全部技能,由权限瀑布(resolve.ts allowRule)统一处理,
 * 这里只认按名/前缀规则。
 */
function useSkillAllowRuleMatches(ctx: ToolContext, name: string): boolean {
  for (const rule of ctx.permissionRules ?? []) {
    if (rule.ruleBehavior !== 'allow' || rule.ruleValue.toolName !== 'use_skill') continue
    const content = rule.ruleValue.ruleContent
    if (content === undefined) continue
    const normalized = content.startsWith('/') ? content.slice(1) : content
    if (normalized === name) return true
    if (normalized.endsWith(':*') && name.startsWith(normalized.slice(0, -2))) return true
  }
  return false
}

/**
 * frontmatter hooks 的信任来源(对齐 cc-haha hook 源分层)。
 * **工作区提供的 .claude/skills 传 'local'**:其 command/http hook 受信任门约束,未受信工作区里不 spawn。
 * app 内置 / 插件 skills 省略 → managed(可信,不受 trust 门约束)。
 * ⚠️ 当前生产只从 app 目录 / 已启用插件加载(defaultSkillsRoot、pluginContribs → 一律 managed);若日后接入
 * 工作区 .claude/skills,加载它们时**必须**传 hookSource:'local',否则工作区 skill 的 command hook 绕过信任门。
 */
/**
 * 解析 `paths` frontmatter(对齐 cc parseSkillPaths):支持字符串(逗号/换行分隔)或数组;去掉 `/**` 后缀
 * (ignore 库把 path 视作连同其内容一起命中);全为 `**`(match-all)= 无条件 → 返回 undefined(不当条件技能)。
 */
export function parseSkillPaths(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw)
    ? raw.map(v => String(v))
    : typeof raw === 'string'
      ? raw.split(/[\n,]/)
      : []
  const patterns = list
    .map(p => p.trim())
    .map(p => (p.endsWith('/**') ? p.slice(0, -3) : p))
    .filter(p => p.length > 0)
  if (patterns.length === 0 || patterns.every(p => p === '**')) return undefined
  return patterns
}

/**
 * 条件技能激活(对齐 cc activateConditionalSkillsForPaths):给一批被"碰到"的文件路径,返回其中命中某条件技能
 * `paths` glob 的技能名集合。调用方(loop)把这些名字并进本回合发现清单,让条件技能"碰到匹配文件才现身"。
 * 匹配复用文件路径规则引擎(fileGlobMatchesPathForRule),与权限/read-ignore 同一套 glob 语义。
 */
export function activateConditionalSkillsForPaths(library: SkillLibrary, workspaceRoot: string, touchedPaths: string[]): Set<string> {
  const activated = new Set<string>()
  if (touchedPaths.length === 0) return activated
  const conditional = library.byName ? [...new Set(library.byName.values())].filter(s => s.paths && s.paths.length > 0) : []
  for (const skill of conditional) {
    for (const pattern of skill.paths ?? []) {
      const hit = touchedPaths.some(p => {
        const abs = isAbsolute(p) ? p : join(workspaceRoot, p)
        return fileGlobMatchesPathForRule(workspaceRoot, abs, pattern, 'localSettings')
      })
      if (hit) { activated.add(skill.name); break }
    }
  }
  return activated
}

export async function loadSkillFile(filePath: string, source: PromptCommand['source'] = 'skills', hookSource?: HookSource): Promise<PromptCommand> {
  const raw = await readFile(filePath, 'utf8')
  const doc = parseMarkdownDocument(raw)
  const baseDir = dirname(filePath)
  const name = safeName(stringField(doc.frontmatter, 'name') ?? basename(baseDir))
  const description = stringField(doc.frontmatter, 'description') ?? extractDescription(doc.body) ?? name
  const whenToUse = stringField(doc.frontmatter, 'whenToUse') ?? stringField(doc.frontmatter, 'when_to_use')
  const allowedToolRules = allowedToolRulesFromFrontmatter(doc.frontmatter.allowedTools ?? doc.frontmatter.allowed_tools)
  const allowedTools = normalizeAllowedTools(allowedToolRules)
  const model = stringField(doc.frontmatter, 'model')
  const context = stringField(doc.frontmatter, 'context')
  const agent = stringField(doc.frontmatter, 'agent')
  const hooks = normalizeHookRegistry(doc.frontmatter.hooks, hookSource ? { source: hookSource } : undefined)
  const argumentHint = stringField(doc.frontmatter, 'argument-hint') ?? stringField(doc.frontmatter, 'argumentHint')
  const argumentNames = parseArgumentNames(doc.frontmatter.arguments as string | string[] | undefined)
  const disableModelInvocation = booleanField(doc.frontmatter, 'disable-model-invocation') ?? booleanField(doc.frontmatter, 'disableModelInvocation')
  const userInvocable = booleanField(doc.frontmatter, 'user-invocable') ?? booleanField(doc.frontmatter, 'userInvocable')
  const aliases = (stringArrayField(doc.frontmatter, 'aliases') ?? []).map(safeName).filter(a => a && a !== name)
  const paths = parseSkillPaths(doc.frontmatter.paths)
  const body = doc.body.trim()

  return {
    type: 'prompt',
    name,
    description,
    whenToUse,
    allowedTools,
    allowedToolRules,
    ...(argumentHint ? { argumentHint } : {}),
    ...(argumentNames.length > 0 ? { argNames: argumentNames } : {}),
    model,
    ...(context === 'fork' || context === 'inline' ? { context } : {}),
    ...(agent ? { agent } : {}),
    ...(hooks.rules.length > 0 ? { hooks } : {}),
    ...(disableModelInvocation ? { disableModelInvocation } : {}),
    ...(userInvocable === false ? { userInvocable } : {}),
    ...(aliases.length > 0 ? { aliases } : {}),
    ...(paths && paths.length > 0 ? { paths } : {}),
    source,
    filePath,
    baseDir,
    contentLength: doc.body.length,
    async getPrompt(args: string, ctx: ToolContext): Promise<string> {
      const substituted = substituteArguments(body, args, true, argumentNames, '用户给这个技能的参数')
      // 动态注入(对齐 cc loadSkillsDir.ts:344-398):模板变量替换 + 内嵌 shell 执行。
      // MCP 来源技能是远程不可信内容,绝不执行其正文内嵌 shell(cc 同款安全门)。
      let finalContent = substitutePromptTemplateVars(
        `技能: ${name}\n基础目录: ${baseDir}\n\n${substituted}`,
        { skillDir: baseDir, sessionId: ctx?.conversationId },
      )
      if (source !== 'mcp') {
        finalContent = await executeShellCommandsInPrompt(finalContent, ctx, `/${name}`, { allowedTools })
      }
      return finalContent
    },
  }
}

export interface LoadSkillsDirOptions {
  source?: PromptCommand['source']
  /** frontmatter hooks 的信任来源;工作区 .claude/skills 传 'local'(受信任门约束),app/插件省略 → managed。 */
  hookSource?: HookSource
  /** 技能落点层标记(bundled/user/workspace),透传到 PromptCommand.skillLayer 供前端显示作用域。 */
  layer?: PromptCommand['skillLayer']
}

export async function loadSkillsDir(rootDir: string, options: LoadSkillsDirOptions = {}): Promise<SkillLibrary> {
  const skills: PromptCommand[] = []
  let entries: string[] = []
  try {
    entries = await readdir(rootDir)
  } catch {
    return { skills, byName: new Map() }
  }

  for (const entry of entries.sort()) {
    if (entry.startsWith('.')) continue
    const skillPath = join(rootDir, entry, 'SKILL.md')
    try {
      const s = await stat(skillPath)
      if (!s.isFile()) continue
      const skill = await loadSkillFile(skillPath, options.source ?? 'skills', options.hookSource)
      if (options.layer) skill.skillLayer = options.layer
      skills.push(skill)
    } catch {
      continue
    }
  }

  const byName = new Map<string, PromptCommand>()
  for (const skill of skills) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return { skills: [...byName.values()], byName }
}

/** 技能落点三层的子目录名(用户/工作区目录下都叫 skills)。 */
const SKILLS_SUBDIR = 'skills'

/**
 * app 内置技能目录(=cc bundled skills):随包发的 `SKILL.md` 内容目录,managed 可信(不受信任门约束)。
 * 放 `ts/src/skills/bundled/<name>/SKILL.md`。✅ 打包态定位已修(resolveBundledDir:execPath 相对 +
 * electron-builder 把本目录发到 Resources/bundled/skills;否则编译二进制 import.meta.dir=/$bunfs、
 * cwd=userData 都找不到,打包后 bundled 技能静默消失——2026-07-11 审计实证并修复)。
 */
export function bundledSkillsRoot(): string {
  return resolveBundledDir('skills', [
    join(import.meta.dir, 'bundled'),
    join(process.cwd(), 'src', 'skills', 'bundled'),
    join(process.cwd(), 'ts', 'src', 'skills', 'bundled'),
  ])
}

/** 用户自建技能目录:`~/.billiardbuddy/skills`(create_skill 默认落这;白标铁律——绝不 .claude)。managed 可信。 */
export function userSkillsRoot(): string {
  return join(getUserConfigHomeDir(), SKILLS_SUBDIR)
}

/** 工作区技能目录:`<root>/.billiardbuddy/skills`。⚠️加载必须 hookSource:'local'(其 command hook 受信任门约束)。 */
export function workspaceSkillsRoot(workspaceRoot: string): string {
  return join(workspaceRoot, MEMORY_DOT_DIR, SKILLS_SUBDIR)
}

export interface LoadLayeredSkillsOptions {
  /** app 内置技能根;默认 bundledSkillsRoot()。 */
  bundledRoot?: string
  /** 用户自建技能根;默认 userSkillsRoot()。传 null 跳过该层(测试用)。 */
  userRoot?: string | null
  /** 工作区根(项目目录);给了才加载 `<root>/.billiardbuddy/skills`(local 信任)。 */
  workspaceRoot?: string
}

/**
 * 三层技能落点合并加载(对齐 cc skill 分层 + 白标目录):
 *   bundled(app 内置,managed) → user(~/.billiardbuddy/skills,managed) → workspace(.billiardbuddy/skills,local)
 * 同名技能后加载覆盖先加载(workspace > user > bundled),让用户/工作区能覆写内置技能。
 * ⚠️ 工作区技能以 hookSource:'local' 加载,否则其 frontmatter command hook 会绕过信任门在未受信工作区里 spawn。
 */
export async function loadLayeredSkills(opts: LoadLayeredSkillsOptions = {}): Promise<SkillLibrary> {
  const bundledRoot = opts.bundledRoot ?? bundledSkillsRoot()
  const userRoot = opts.userRoot === null ? undefined : (opts.userRoot ?? userSkillsRoot())
  const libs: SkillLibrary[] = []
  libs.push(await loadSkillsDir(bundledRoot, { layer: 'bundled' }))
  if (userRoot) libs.push(await loadSkillsDir(userRoot, { layer: 'user' }))
  if (opts.workspaceRoot) libs.push(await loadSkillsDir(workspaceSkillsRoot(opts.workspaceRoot), { hookSource: 'local', layer: 'workspace' }))

  const byName = new Map<string, PromptCommand>()
  const order: string[] = []
  for (const lib of libs) {
    for (const skill of lib.skills) {
      if (!byName.has(skill.name)) order.push(skill.name)
      byName.set(skill.name, skill) // 后加载覆盖同名
    }
  }
  const nameDeduped = order.map(name => byName.get(name)!)
  // realpath 去重(对齐 cc:symlink 安全,同一物理文件经不同路径/名加载只算一次)。realpath 失败退回原路径。
  const seenReal = new Set<string>()
  const deduped: PromptCommand[] = []
  for (const skill of nameDeduped) {
    let rp = skill.filePath
    try { rp = realpathSync(skill.filePath) } catch { /* 文件不在/权限:退回原路径参与去重 */ }
    if (seenReal.has(rp)) { byName.delete(skill.name); continue }
    seenReal.add(rp)
    deduped.push(skill)
  }
  // 别名登记(对齐 cc):别名只占未被真实主名占用的键,主名永远优先。
  const realNames = new Set(deduped.map(s => s.name))
  for (const skill of deduped) {
    for (const alias of skill.aliases ?? []) {
      if (!realNames.has(alias)) byName.set(alias, skill)
    }
  }
  // 条件技能(带 paths)默认不进发现清单(对齐 cc unconditional/conditional 分离):仍在 byName 里(可 by-name 调 +
  // 供 activateConditionalSkillsForPaths 扫描),只是不主动现身;碰到命中路径的文件时由 loop 并进本回合清单。
  const skills = deduped.filter(s => !(s.paths && s.paths.length > 0))
  return { skills, byName }
}

export function formatSkillIndex(library: SkillLibrary, opts: SkillIndexOptions = {}): string {
  if (library.skills.length === 0) return '当前没有可用技能。'
  const recommended = normalizeSkillNames(opts.recommendedSkillNames)
  const recommendedRank = new Map([...recommended].map((name, index) => [name, index]))
  const query = opts.query?.trim().toLowerCase() ?? ''
  const limit = clampLimit(opts.limit, 80)
  const skills = library.skills
    // 模型面清单:disable-model-invocation 的技能不列(用户敲斜杠仍可)。对齐 cc。
    .filter(skill => !skill.disableModelInvocation)
    .filter(skill => !opts.recommendedOnly || recommended.has(skill.name))
    .filter(skill => !query || skillMatchesQuery(skill, query))
    .sort((a, b) => {
      const ar = recommendedRank.get(a.name)
      const br = recommendedRank.get(b.name)
      if (ar !== undefined || br !== undefined) return (ar ?? Number.MAX_SAFE_INTEGER) - (br ?? Number.MAX_SAFE_INTEGER)
      return a.name.localeCompare(b.name)
    })
    .slice(0, limit)

  if (skills.length === 0) return '当前没有匹配技能。'
  const prefix = recommended.size > 0
    ? `已启用领域包推荐技能优先展示:${[...recommended].join(', ')}\n`
    : ''
  return prefix + skills
    .map(skill => {
      const mark = recommended.has(skill.name) ? ' [推荐]' : ''
      const suffix = skill.whenToUse ? ` 使用时机:${skill.whenToUse}` : ''
      return `- ${skill.name}${mark}: ${skill.description}${suffix}`
    })
    .join('\n')
}

export function createSkillTools(library: SkillLibrary, opts: { skillRoot?: string; recommendedSkillNames?: string[]; executeSkill?: ExecuteSkillFn } = {}): Tool[] {
  const listSkills: Tool<ListSkillsInput> = {
    name: 'list_skills',
    description: 'List available skills by name and short description. Enabled domain packs are shown first. Use read_skill to load the full instructions only when a skill is relevant. Input: { query?, recommended_only?, limit? }.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        recommended_only: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
    isReadOnly: true,
    async execute(input) {
      return formatSkillIndex(library, {
        recommendedSkillNames: opts.recommendedSkillNames,
        recommendedOnly: input?.recommended_only === true,
        query: typeof input?.query === 'string' ? input.query : undefined,
        limit: typeof input?.limit === 'number' ? input.limit : undefined,
      })
    },
  }

  const readSkill: Tool<{ name: string; args?: string }> = {
    name: 'read_skill',
    description: 'Load the full instructions for one skill by exact name. Input: { name, args? }.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        args: { type: 'string' },
      },
      required: ['name'],
    },
    isReadOnly: true,
    async execute(input, ctx) {
      if (!input || typeof input.name !== 'string') throw new Error('read_skill 需要 string 参数 name')
      const skill = library.byName.get(input.name)
      if (!skill) return `没有找到技能「${input.name}」。可先调用 list_skills 查看可用技能。`
      if (skill.disableModelInvocation) return `技能「${skill.name}」标记为不可由模型调用(disable-model-invocation),只能由用户手动触发。`
      return await skill.getPrompt(typeof input.args === 'string' ? input.args : '', ctx)
    },
  }

  const useSkill: Tool<UseSkillInput> = {
    name: 'use_skill',
    description: 'Execute one skill by exact name. Use this after list_skills/read_skill when the skill should actively guide the current work. Input: { skill, args? }.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        name: { type: 'string', description: 'Alias for skill.' },
        args: { type: 'string' },
      },
      required: ['skill'],
    },
    isReadOnly: false,
    // 授权闸:携带 allowedTools/hooks 的技能默认 ask,批准后 execute() 才灌工具/挂 hook。
    // 缺名/未知技能 → false(execute 会抛清晰错误或回“没找到”,不授予任何权限)。
    requiresApprovalFor(input, ctx) {
      const name = resolveUseSkillName(input)
      if (!name) return false
      const skill = library.byName.get(name)
      if (!skill) return false
      if (skillHasOnlySafeProperties(skill)) return false // 纯安全属性技能自动放行
      if (useSkillAllowRuleMatches(ctx, name)) return false // 已记住允许该技能 → 免审批
      return true // 携带 allowedTools/hooks → 走审批闸
    },
    approvalReasonFor(input) {
      const name = resolveUseSkillName(input)
      const skill = name ? library.byName.get(name) : undefined
      const grants: string[] = []
      if (skill?.allowedTools && skill.allowedTools.length > 0) grants.push(`授予工具 ${skill.allowedTools.join(', ')}`)
      if (skill?.hooks && skill.hooks.rules.length > 0) grants.push(`注册 ${skill.hooks.rules.length} 条会话 hook`)
      return {
        what: `运行技能「${name || '?'}」`,
        why: grants.length > 0 ? `该技能会${grants.join(';')},等于在本会话内放开这些能力` : '模型请求运行该技能',
        impact: grants.length > 0
          ? '批准后这些工具/hook 在本会话内自动放行,请确认技能来源可信(否则可能被用来绕过逐次审批,如 git push)'
          : '',
      }
    },
    async execute(input, ctx) {
      const name = resolveUseSkillName(input)
      if (!name) throw new Error('use_skill 需要 string 参数 name')
      const skill = library.byName.get(name)
      if (!skill) return `没有找到技能「${name}」。可先调用 list_skills 查看可用技能。`
      if (skill.disableModelInvocation) return `技能「${skill.name}」标记为不可由模型调用(disable-model-invocation),只能由用户手动触发。`
      const args = typeof input?.args === 'string' ? input.args : ''
      if (opts.executeSkill) return await opts.executeSkill(skill, args, ctx)
      const prompt = await skill.getPrompt(args, ctx)
      recordInvokedSkill(skill, prompt, ctx)
      if (skill.context !== 'fork') {
        allowSkillTools(skill, ctx)
        registerSkillHooks(skill, ctx)
      }
      return formatUseSkillResult(skill, prompt)
    },
  }

  const tools: Tool[] = [listSkills, readSkill, useSkill]

  if (opts.skillRoot) {
    const createSkill: Tool<{
      name: string
      description: string
      instructions: string
      whenToUse?: string
      allowedTools?: string[]
      overwrite?: boolean | string
    }> = {
      name: 'create_skill',
      description: 'Create a reusable SKILL.md from a proven workflow. Input: { name, description, instructions, whenToUse?, allowedTools?, overwrite? }.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          instructions: { type: 'string' },
          whenToUse: { type: 'string' },
          allowedTools: { type: 'array', items: { type: 'string' } },
          overwrite: { type: ['boolean', 'string'] },
        },
        required: ['name', 'description', 'instructions'],
      },
      isReadOnly: false,
      requiresApproval: true,
      approvalClass: 'file',
      async execute(input, ctx) {
        if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('create_skill 需要 string 参数 name')
        if (typeof input.description !== 'string' || !input.description.trim()) throw new Error('create_skill 需要 string 参数 description')
        if (typeof input.instructions !== 'string' || !input.instructions.trim()) throw new Error('create_skill 需要 string 参数 instructions')
        const name = safeName(input.name).toLowerCase()
        if (!name) throw new Error('create_skill name 归一化后为空')
        const root = resolve(opts.skillRoot!)
        const dir = resolve(root, name)
        if (dir !== root && !dir.startsWith(`${root}/`)) throw new Error('create_skill path escaped skills root')
        const skillPath = join(dir, 'SKILL.md')
        const overwrite = input.overwrite === true || (typeof input.overwrite === 'string' && ['true', '1', 'yes', 'y'].includes(input.overwrite.trim().toLowerCase()))
        try {
          const existing = await stat(skillPath)
          if (existing.isFile() && !overwrite) throw new Error(`create_skill 已存在:${name};如需覆盖请设置 overwrite:true`)
        } catch (err) {
          if (err instanceof Error && err.message.includes('已存在')) throw err
        }

        const allowedTools = Array.isArray(input.allowedTools)
          ? input.allowedTools.map(String).map(x => x.trim()).filter(Boolean)
          : undefined
        const frontmatter = [
          '---',
          `name: ${quoteYaml(name)}`,
          `description: ${quoteYaml(input.description.trim())}`,
          input.whenToUse?.trim() ? `whenToUse: ${quoteYaml(input.whenToUse.trim())}` : '',
          yamlArray(allowedTools) ? `allowedTools: ${yamlArray(allowedTools)}` : '',
          '---',
        ].filter(Boolean).join('\n')
        const content = `${frontmatter}\n\n${input.instructions.trim()}\n`
        await mkdir(dir, { recursive: true })
        await writeFile(skillPath, content, 'utf8')

        const loaded = await loadSkillFile(skillPath, 'skills')
        library.byName.set(loaded.name, loaded)
        const idx = library.skills.findIndex(skill => skill.name === loaded.name)
        if (idx >= 0) library.skills[idx] = loaded
        else library.skills.push(loaded)
        // ConfigChange hook(对齐 cc executeConfigChangeHooks source:'skills':技能文件在会话中变更,审计用途,不阻断)。
        await applyConfigChangeHooks(ctx.activeHooks, 'skills', skillPath, ctx).catch(() => undefined)
        return `已创建技能 ${loaded.name}: ${skillPath}`
      },
    }
    tools.push(createSkill)
  }

  return tools
}

function normalizeSkillNames(values: string[] | undefined): Set<string> {
  const out = new Set<string>()
  for (const value of values ?? []) {
    const name = safeName(value)
    if (name) out.add(name)
  }
  return out
}

function skillMatchesQuery(skill: PromptCommand, query: string): boolean {
  const haystack = [
    skill.name,
    skill.description,
    skill.whenToUse ?? '',
    skill.allowedTools?.join(' ') ?? '',
  ].join('\n').toLowerCase()
  return haystack.includes(query)
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.max(1, Math.min(200, Math.floor(value)))
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}
