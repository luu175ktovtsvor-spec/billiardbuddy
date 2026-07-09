import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { extractDescription, parseMarkdownDocument, stringField } from '../commands/frontmatter'
import { addAllowedToolsToContext, allowedToolRulesFromFrontmatter, normalizeAllowedTools } from '../commands/allowedTools'
import { parseArgumentNames, substituteArguments } from '../commands/argumentSubstitution'
import type { PromptCommand } from '../commands/types'
import { mergeHookRegistries, type HookSource } from '../hooks/hooks'
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
  return value.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
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

/**
 * frontmatter hooks 的信任来源(对齐 cc-haha hook 源分层)。
 * **工作区提供的 .claude/skills 传 'local'**:其 command/http hook 受信任门约束,未受信工作区里不 spawn。
 * app 内置 / 插件 skills 省略 → managed(可信,不受 trust 门约束)。
 * ⚠️ 当前生产只从 app 目录 / 已启用插件加载(defaultSkillsRoot、pluginContribs → 一律 managed);若日后接入
 * 工作区 .claude/skills,加载它们时**必须**传 hookSource:'local',否则工作区 skill 的 command hook 绕过信任门。
 */
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
    source,
    filePath,
    baseDir,
    contentLength: doc.body.length,
    async getPrompt(args: string, _ctx: ToolContext): Promise<string> {
      const substituted = substituteArguments(body, args, true, argumentNames, '用户给这个技能的参数')
      return `技能: ${name}\n基础目录: ${baseDir}\n\n${substituted}`
    },
  }
}

export interface LoadSkillsDirOptions {
  source?: PromptCommand['source']
  /** frontmatter hooks 的信任来源;工作区 .claude/skills 传 'local'(受信任门约束),app/插件省略 → managed。 */
  hookSource?: HookSource
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
      skills.push(await loadSkillFile(skillPath, options.source ?? 'skills', options.hookSource))
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

export function formatSkillIndex(library: SkillLibrary, opts: SkillIndexOptions = {}): string {
  if (library.skills.length === 0) return '当前没有可用技能。'
  const recommended = normalizeSkillNames(opts.recommendedSkillNames)
  const recommendedRank = new Map([...recommended].map((name, index) => [name, index]))
  const query = opts.query?.trim().toLowerCase() ?? ''
  const limit = clampLimit(opts.limit, 80)
  const skills = library.skills
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
    async execute(input, ctx) {
      const name = typeof input?.name === 'string' && input.name.trim()
        ? input.name.trim()
        : typeof input?.skill === 'string' ? input.skill.trim() : ''
      if (!name) throw new Error('use_skill 需要 string 参数 name')
      const skill = library.byName.get(name)
      if (!skill) return `没有找到技能「${name}」。可先调用 list_skills 查看可用技能。`
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
      async execute(input) {
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
