import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { extractDescription, parseMarkdownDocument, stringField } from './frontmatter'
import { allowedToolRulesFromFrontmatter, normalizeAllowedTools } from './allowedTools'
import { parseArgumentNames, substituteArguments } from './argumentSubstitution'
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

const SLASH_COMMAND_RE = /^\/([A-Za-z0-9_:.-]+)(?:\s+([\s\S]*))?$/

export const BRIDGE_SAFE_LOCAL_COMMANDS = new Set([
  'compact',
  'clear',
  'cost',
  'summary',
  'release-notes',
  'files',
])

export function normalizeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, '').replace(/\s+/g, '-').replace(/[^A-Za-z0-9_:.-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
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

export async function loadCommandFile(filePath: string): Promise<PromptCommand> {
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
    source: 'commands',
    filePath,
    baseDir,
    contentLength: doc.body.length,
    async getPrompt(args: string, _ctx: ToolContext): Promise<string> {
      const substituted = substituteArguments(body, args, true, argumentNames, '命令参数')
      return `命令: /${name}\n基础目录: ${baseDir}\n\n${substituted}`
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

export async function loadCommandsDir(rootDir: string): Promise<CommandLibrary> {
  const commands: PromptCommand[] = []
  for (const filePath of await walkMarkdown(rootDir)) {
    try {
      const s = await stat(filePath)
      if (!s.isFile()) continue
      commands.push(await loadCommandFile(filePath))
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

export async function loadCommandsFromRoots(rootDirs: string[]): Promise<CommandLibrary> {
  const byName = new Map<string, PromptCommand>()
  for (const rootDir of rootDirs) {
    const library = await loadCommandsDir(rootDir)
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

export function createCommandTools(library: CommandLibrary): Tool[] {
  const listCommands: Tool<Record<string, never>> = {
    name: 'list_commands',
    description: 'List available slash commands by name and short description. Use read_command only when a command is relevant.',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    async execute() {
      return formatCommandIndex(library)
    },
  }

  const readCommand: Tool<{ name: string; args?: string }> = {
    name: 'read_command',
    description: 'Load the full instructions for one slash command by exact name. Input: { name, args? }.',
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

  return [listCommands, readCommand]
}
