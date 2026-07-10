import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { extractDescription, parseMarkdownDocument, stringField } from './frontmatter'
import { addAllowedToolsToContext, allowedToolRulesFromFrontmatter, normalizeAllowedTools } from './allowedTools'
import { mergeHookRegistries, type HookSource } from '../hooks/hooks'
import { normalizeHookRegistry } from '../hooks/hookConfig'
import { parseArgumentNames, substituteArguments } from './argumentSubstitution'
import { executeShellCommandsInPrompt, substitutePromptTemplateVars } from './promptShellExecution'
import type { PromptCommand } from './types'
import type { Tool, ToolContext } from '../tools/Tool'

export interface CommandLibrary {
  commands: PromptCommand[]
  byName: Map<string, PromptCommand>
}

export interface ParsedCommandInvocation {
  name: string
  args: string
  raw: string
}

export type BridgeCommandDescriptor = PromptCommand | {
  type: 'local' | 'local-jsx'
  name: string
}

// 名字允许 Unicode 字母/数字(含中文,如 /台球),让领域斜杠命令能用母语敲;参数段仍是任意文本。
const SLASH_COMMAND_RE = /^\/([\p{L}\p{N}_:.-]+)(?:\s+([\s\S]*))?$/u

export const BRIDGE_SAFE_LOCAL_COMMANDS = new Set([
  'compact',
  'clear',
  'cost',
  'summary',
  'release-notes',
  'files',
])

export function normalizeCommandName(value: string): string {
  // 保留 Unicode 字母/数字(含中文)、下划线、冒号、点、连字符;其它字符归一成连字符。
  // 这样 /台球、/球房 这类领域斜杠命令能作为合法命令名存活(旧实现会把中文全删成空串)。
  return value.trim().replace(/^\/+/, '').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_:.-]/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
}

export function parseCommandInvocation(value: string): ParsedCommandInvocation | null {
  const raw = value.trim()
  const match = SLASH_COMMAND_RE.exec(raw)
  if (!match) return null
  const name = normalizeCommandName(match[1]!)
  if (!name) return null
  return { name, args: match[2]?.trim() ?? '', raw }
}

export function isBridgeSafeCommand(command: BridgeCommandDescriptor): boolean {
  if (command.type === 'local-jsx') return false
  if (command.type === 'prompt') return true
  return BRIDGE_SAFE_LOCAL_COMMANDS.has(normalizeCommandName(command.name))
}

export function filterBridgeSafeCommands(commands: PromptCommand[]): PromptCommand[] {
  return commands.filter(isBridgeSafeCommand)
}

export function bridgeUnsafeCommandMessage(name: string): string {
  return `/${normalizeCommandName(name)} isn't available over Remote Control.`
}

function stripMd(value: string): string {
  return extname(value).toLowerCase() === '.md' ? basename(value, extname(value)) : basename(value)
}

/**
 * hookSource:命令 frontmatter hooks 的信任来源(镜像 skillLoader.loadSkillFile)。
 * **工作区来源的命令目录必须传 'local'**(受 allowManagedHooksOnly + workspace trust 信任门约束,
 * 防恶意仓库经命令 frontmatter hooks RCE);app 内置/领域包命令省略 → managed(可信)。
 */
export async function loadCommandFile(filePath: string, hookSource?: HookSource): Promise<PromptCommand> {
  const raw = await readFile(filePath, 'utf8')
  const doc = parseMarkdownDocument(raw)
  const baseDir = dirname(filePath)
  const name = normalizeCommandName(stringField(doc.frontmatter, 'name') ?? stripMd(filePath))
  const description = stringField(doc.frontmatter, 'description') ?? extractDescription(doc.body) ?? name
  const whenToUse = stringField(doc.frontmatter, 'whenToUse') ?? stringField(doc.frontmatter, 'when_to_use')
  const allowedToolRules = allowedToolRulesFromFrontmatter(doc.frontmatter.allowedTools ?? doc.frontmatter.allowed_tools)
  const allowedTools = normalizeAllowedTools(allowedToolRules)
  const model = stringField(doc.frontmatter, 'model')
  const context = stringField(doc.frontmatter, 'context')
  const agent = stringField(doc.frontmatter, 'agent')
  // frontmatter hooks(对齐 cc 命令/技能统一契约:命令与技能同构,hooks 字段不再被静默丢弃)。
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
    source: 'commands',
    filePath,
    baseDir,
    contentLength: doc.body.length,
    async getPrompt(args: string, ctx: ToolContext): Promise<string> {
      const substituted = substituteArguments(body, args, true, argumentNames, '命令参数')
      // 动态注入(对齐 cc processSlashCommand 的命令体展开):模板变量替换 + 内嵌 shell 执行。
      // 命令都从本机文件加载(source:'commands'),没有 MCP 远程来源,无需 mcp 安全门;若日后接
      // MCP prompts 进这条管线,必须按 source==='mcp' 跳过内嵌 shell(对齐 cc)。
      const finalContent = substitutePromptTemplateVars(
        `命令: /${name}\n基础目录: ${baseDir}\n\n${substituted}`,
        { skillDir: baseDir, sessionId: ctx?.conversationId },
      )
      return await executeShellCommandsInPrompt(finalContent, ctx, `/${name}`, { allowedTools })
    },
  }
}

async function walkMarkdown(rootDir: string, depth = 0): Promise<string[]> {
  if (depth > 4) return []
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = []
  try {
    entries = await readdir(rootDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.')) continue
    const p = join(rootDir, entry.name)
    if (entry.isDirectory()) out.push(...await walkMarkdown(p, depth + 1))
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md') && entry.name !== 'SKILL.md') out.push(p)
  }
  return out
}

export async function loadCommandsDir(rootDir: string, hookSource?: HookSource): Promise<CommandLibrary> {
  const commands: PromptCommand[] = []
  for (const filePath of await walkMarkdown(rootDir)) {
    try {
      const s = await stat(filePath)
      if (!s.isFile()) continue
      commands.push(await loadCommandFile(filePath, hookSource))
    } catch {
      continue
    }
  }
  const byName = new Map<string, PromptCommand>()
  for (const command of commands) {
    if (!byName.has(command.name)) byName.set(command.name, command)
  }
  return { commands: [...byName.values()], byName }
}

export async function loadCommandsFromRoots(rootDirs: string[], hookSource?: HookSource): Promise<CommandLibrary> {
  const byName = new Map<string, PromptCommand>()
  for (const rootDir of rootDirs) {
    const library = await loadCommandsDir(rootDir, hookSource)
    for (const command of library.commands) byName.set(command.name, command)
  }
  return { commands: [...byName.values()], byName }
}

export function commandLibraryFromCommands(commands: PromptCommand[]): CommandLibrary {
  const byName = new Map<string, PromptCommand>()
  for (const command of commands) byName.set(command.name, command)
  return { commands: [...byName.values()], byName }
}

export function mergeCommandLibraries(...libraries: Array<CommandLibrary | undefined>): CommandLibrary {
  const byName = new Map<string, PromptCommand>()
  for (const library of libraries) {
    for (const command of library?.commands ?? []) byName.set(command.name, command)
  }
  return { commands: [...byName.values()], byName }
}

export function publicCommand(command: PromptCommand) {
  return {
    name: command.name,
    description: command.description,
    whenToUse: command.whenToUse,
    allowedTools: command.allowedTools,
    allowedToolRules: command.allowedToolRules,
    argumentHint: command.argumentHint,
    argNames: command.argNames,
    model: command.model,
    context: command.context,
    agent: command.agent,
    source: command.source,
    contentLength: command.contentLength,
  }
}

export function formatCommandIndex(library: CommandLibrary): string {
  if (library.commands.length === 0) return '当前没有可用命令。'
  return library.commands
    .map(command => {
      const suffix = command.whenToUse ? ` 使用时机:${command.whenToUse}` : ''
      return `- /${command.name}: ${command.description}${suffix}`
    })
    .join('\n')
}

export interface CreateCommandToolsOptions {
  /** 统一执行契约(对齐 cc 单一 Skill 工具语义):与 use_skill 共用的执行器(PromptCommand 同构),
   *  承载 allowedTools 灌注/hooks 注册/context:fork 后台派发。省略时 use_command 走内置内联语义。 */
  executeCommand?: (command: PromptCommand, args: string, ctx: ToolContext) => Promise<string>
}

/** 命令是否只有安全属性(镜像 skillLoader.skillHasOnlySafeProperties):不带 allowedTools/hooks/fork 的命令自动放行。 */
function commandHasOnlySafeProperties(command: PromptCommand): boolean {
  if (command.allowedTools && command.allowedTools.length > 0) return false
  if (command.allowedToolRules && command.allowedToolRules.length > 0) return false
  if (command.hooks && command.hooks.rules.length > 0) return false
  if (command.context === 'fork') return false
  return true
}

/** ctx.permissionRules 里是否有放行该命令的 use_command allow 规则(镜像 use_skill 的记忆规则匹配)。 */
function useCommandAllowRuleMatches(ctx: ToolContext, name: string): boolean {
  for (const rule of ctx.permissionRules ?? []) {
    if (rule.ruleBehavior !== 'allow' || rule.ruleValue.toolName !== 'use_command') continue
    const content = rule.ruleValue.ruleContent
    if (content === undefined) continue
    const normalized = content.startsWith('/') ? content.slice(1) : content
    if (normalized === name) return true
    if (normalized.endsWith(':*') && name.startsWith(normalized.slice(0, -2))) return true
  }
  return false
}

export function createCommandTools(library: CommandLibrary, opts: CreateCommandToolsOptions = {}): Tool[] {
  const listCommands: Tool<Record<string, never>> = {
    name: 'list_commands',
    description: 'List available slash commands by name and short description. Use use_command to run one, or read_command to only inspect its instructions.',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    async execute() {
      return formatCommandIndex(library)
    },
  }

  const readCommand: Tool<{ name: string; args?: string }> = {
    name: 'read_command',
    description: 'Inspect the full instructions of one slash command by exact name WITHOUT executing it (no tool grants, no hooks). Use use_command to actually run it. Input: { name, args? }.',
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
      if (!input || typeof input.name !== 'string') throw new Error('read_command 需要 string 参数 name')
      const name = normalizeCommandName(input.name)
      const command = library.byName.get(name)
      if (!command) return `没有找到命令「/${name}」。可先调用 list_commands 查看可用命令。`
      return await command.getPrompt(typeof input.args === 'string' ? input.args : '', ctx)
    },
  }

  // 统一执行契约(对齐 cc:单一 Skill 工具同时承担命令与技能的执行语义;消除
  // "用户敲 /命令落权限、模型经 read_command 调不落权限"的行为不对称):
  // use_command 与 use_skill 同一套审批闸(带 allowedTools/hooks/fork 的命令默认 ask、
  // 可 allow 规则记忆)+ 同一个执行器(server 传入的 executeSkill,PromptCommand 同构)。
  const useCommand: Tool<{ name?: string; command?: string; args?: string }> = {
    name: 'use_command',
    description: 'Execute one slash command by exact name, with the same semantics as the user typing /name (tool grants, hooks, fork). Input: { name, args? }.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        command: { type: 'string', description: 'Alias for name.' },
        args: { type: 'string' },
      },
      required: ['name'],
    },
    isReadOnly: false,
    requiresApprovalFor(input, ctx) {
      const raw = typeof input?.name === 'string' && input.name.trim() ? input.name : typeof input?.command === 'string' ? input.command : ''
      const name = raw ? normalizeCommandName(raw) : ''
      if (!name) return false
      const command = library.byName.get(name)
      if (!command) return false
      if (commandHasOnlySafeProperties(command)) return false
      if (useCommandAllowRuleMatches(ctx, name)) return false
      return true
    },
    approvalReasonFor(input) {
      const raw = typeof input?.name === 'string' && input.name.trim() ? input.name : typeof input?.command === 'string' ? input.command : ''
      const name = raw ? normalizeCommandName(raw) : '?'
      const command = library.byName.get(name)
      const grants: string[] = []
      if (command?.allowedTools && command.allowedTools.length > 0) grants.push(`授予工具 ${command.allowedTools.join(', ')}`)
      if (command?.hooks && command.hooks.rules.length > 0) grants.push(`注册 ${command.hooks.rules.length} 条会话 hook`)
      if (command?.context === 'fork') grants.push('派发后台工作代理')
      return {
        what: `运行命令「/${name}」`,
        why: grants.length > 0 ? `该命令会${grants.join(';')},等于在本会话内放开这些能力` : '模型请求运行该命令',
        impact: grants.length > 0
          ? '批准后这些工具/hook 在本会话内自动放行,请确认命令来源可信(否则可能被用来绕过逐次审批)'
          : '',
      }
    },
    async execute(input, ctx) {
      const raw = typeof input?.name === 'string' && input.name.trim() ? input.name : typeof input?.command === 'string' ? input.command : ''
      if (!raw) throw new Error('use_command 需要 string 参数 name')
      const name = normalizeCommandName(raw)
      const command = library.byName.get(name)
      if (!command) return `没有找到命令「/${name}」。可先调用 list_commands 查看可用命令。`
      const args = typeof input?.args === 'string' ? input.args : ''
      if (opts.executeCommand) return await opts.executeCommand(command, args, ctx)
      // 无执行器兜底(独立跑工具/测试):内联展开 + 权限/hook 灌注,与 use_skill 的内置路径同构。
      const prompt = await command.getPrompt(args, ctx)
      if (command.context !== 'fork') {
        allowCommandTools(command, ctx)
        registerCommandHooks(command, ctx)
      }
      return [`<command_invoked name="/${command.name}">`, prompt, '</command_invoked>'].join('\n')
    },
  }

  return [listCommands, readCommand, useCommand]
}

/** 把命令 frontmatter 的 allowedTools 灌进会话权限上下文(与 skillLoader.allowSkillTools 同构)。 */
function allowCommandTools(command: PromptCommand, ctx: ToolContext): void {
  addAllowedToolsToContext(ctx, command.allowedToolRules ?? command.allowedTools)
}

/** 把命令 frontmatter hooks 合进会话 hooks(与 skillLoader.registerSkillHooks 同构)。 */
function registerCommandHooks(command: PromptCommand, ctx: ToolContext): void {
  if (!command.hooks || command.hooks.rules.length === 0) return
  ctx.sessionHooks = mergeHookRegistries(ctx.sessionHooks, command.hooks)
  ctx.onSessionHooksChanged?.(ctx.sessionHooks)
}
