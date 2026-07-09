// 领域包门面(facade)· 把「注册表里已启用的 pack」装配成会话可用的命令库/hook/工具
//
// 架构分层(可插拔地基):
//   types.ts        —— DomainPack 通用接口(id/name/aliases/命令/工具/sessionStartContext/知识/守卫/版本)
//   registry.ts     —— 通用加载器(发现-装载-启停-版本),核心不 import 任何具体 pack
//   builtinPacks.ts —— 「发现」清单:把内置 pack(台球是第一个)注册进默认注册表
//   billiards/pack.ts —— 台球作为「第一个注册的 pack」,自包含,不在本文件硬编码
//   domainPacks.ts(本文件)—— 门面:resolveEnabledPacks 走注册表解析,再把解析出的 pack 装配成 hooks/命令/工具
//
// 本文件不再 `import './billiards'` 也不再内联 pack 定义;所有具体领域内容都在各 pack 模块里。
// server / harness 依旧从这里 import 同名函数(公共 API 未变),只是底层换成注册表驱动。

import type { HookRegistry } from '../hooks/hooks'
import { commandLibraryFromCommands, normalizeCommandName, type CommandLibrary } from '../commands/commandLoader'
import type { PromptCommand } from '../commands/types'
import type { Tool, ToolContext } from '../tools/Tool'
import { getDefaultPackRegistry } from './builtinPacks'
import type { DomainPack, DomainPackCommand, PublicDomainPack } from './types'

// 类型对外透传(server 有 `import { type DomainPack } from '../packs/domainPacks'`,保持不变)。
export type { DomainPack, DomainPackCommand, DomainPackKnowledge, DomainPackGuardrails, PublicDomainPack } from './types'
// 注册表 / 发现层对外透传,便于面板与后续第三方 pack 装载复用同一套加载器。
export { PackRegistry, normalizePackId, type RegisteredPack } from './registry'
export { getDefaultPackRegistry, registerBuiltinPacks, BUILTIN_PACKS } from './builtinPacks'

/**
 * 已注册且启用的内置领域包快照(注册顺序)。多数消费方应走 resolveEnabledPacks / listPublicDomainPacks
 * 以实时反映启停;本快照仅供不关心启停变化的兼容场景。
 */
export const DOMAIN_PACKS: DomainPack[] = getDefaultPackRegistry().list()

export function publicDomainPack(pack: DomainPack): PublicDomainPack {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description,
    version: pack.version ?? '0.0.0',
    aliases: pack.aliases ?? [],
    default_enabled: pack.defaultEnabled === true,
    suggested_skills: pack.suggestedSkills ?? [],
    suggested_commands: (pack.commands ?? []).map(command => command.name),
    suggested_tools: (pack.tools ?? []).map(tool => tool.name),
  }
}

/** 面板/前端的稳定 pack 清单(实时反映注册表启停)。 */
export function listPublicDomainPacks(): PublicDomainPack[] {
  return getDefaultPackRegistry().list().map(publicDomainPack)
}

/** 解析本次会话要挂的领域包:读取 enabled_packs/knowledge_packs 别名,经注册表解析(仅返回已启用、去重)。 */
export function resolveEnabledPacks(input: Record<string, unknown>): DomainPack[] {
  const registry = getDefaultPackRegistry()
  const explicit = firstDefined(
    input.enabled_packs,
    input.enabledPacks,
    input.knowledge_packs,
    input.knowledgePacks,
  )
  const ids = stringArray(explicit)
  // 兼容旧入参:未显式给包列表但带 billiards_mode 时,回退挂台球(历史 API 契约)。
  if (ids.length === 0 && explicit === undefined && (input.billiards_mode === true || input.billiardsMode === true)) {
    ids.push('billiards')
  }

  const seen = new Set<string>()
  const packs: DomainPack[] = []
  for (const id of ids) {
    const pack = registry.resolve(id)
    if (!pack || seen.has(pack.id)) continue
    seen.add(pack.id)
    packs.push(pack)
  }
  return packs
}

export function createDomainPackHookRegistry(packs: DomainPack[]): HookRegistry | undefined {
  if (packs.length === 0) return undefined
  return {
    rules: packs.map(pack => ({
      event: 'SessionStart',
      handler: () => ({ action: 'context', additionalContext: pack.sessionStartContext }),
    })),
  }
}

export function suggestedSkillNamesForPacks(packs: DomainPack[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const name of pack.suggestedSkills ?? []) {
      const trimmed = name.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      out.push(trimmed)
    }
  }
  return out
}

export function suggestedCommandNamesForPacks(packs: DomainPack[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const command of pack.commands ?? []) {
      const name = normalizeCommandName(command.name)
      if (!name || seen.has(name)) continue
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function createDomainPackCommandLibrary(packs: DomainPack[]): CommandLibrary | undefined {
  const commands: PromptCommand[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const command of pack.commands ?? []) {
      const name = normalizeCommandName(command.name)
      if (!name || seen.has(name)) continue
      seen.add(name)
      commands.push(domainPackCommand(pack, { ...command, name }))
    }
  }
  if (commands.length === 0) return undefined
  const library = commandLibraryFromCommands(commands)
  registerDomainPackCommandAliases(library, packs)
  return library
}

/**
 * 把领域包命令的 aliases 注册进 library.byName(不进 commands 数组,清单不重复出条)。
 * 用于合并后重新挂别名:mergeCommandLibraries 只从 commands 数组重建 byName,会丢掉这些别名键,
 * 所以每次拿到最终 library 后都要再调一次,保证 /台球、/球房、/billiards 都能解析到入口命令。
 */
export function registerDomainPackCommandAliases(library: CommandLibrary, packs: DomainPack[]): void {
  for (const pack of packs) {
    for (const command of pack.commands ?? []) {
      const canonical = normalizeCommandName(command.name)
      const target = canonical ? library.byName.get(canonical) : undefined
      if (!target) continue
      for (const alias of command.aliases ?? []) {
        const key = normalizeCommandName(alias)
        if (!key || library.byName.has(key)) continue
        library.byName.set(key, target)
      }
    }
  }
}

export function createDomainPackTools(packs: DomainPack[]): Tool[] {
  const out: Tool[] = []
  const seen = new Set<string>()
  for (const pack of packs) {
    for (const tool of pack.tools ?? []) {
      if (seen.has(tool.name)) continue
      seen.add(tool.name)
      out.push(tool)
    }
  }
  return out
}

export function mergeHookRegistries(...registries: Array<HookRegistry | undefined>): HookRegistry | undefined {
  const rules = registries.flatMap(registry => registry?.rules ?? [])
  return rules.length > 0 ? { rules } : undefined
}

function domainPackCommand(pack: DomainPack, command: DomainPackCommand): PromptCommand {
  const prompt = command.prompt.trim()
  return {
    type: 'prompt',
    name: command.name,
    description: command.description,
    whenToUse: command.whenToUse,
    allowedTools: command.allowedTools,
    source: 'commands',
    filePath: `domain-pack://${pack.id}/${command.name}`,
    baseDir: `domain-pack://${pack.id}`,
    contentLength: prompt.length,
    async getPrompt(args: string, _ctx: ToolContext): Promise<string> {
      const argText = args.trim() ? `\n\n命令参数:\n${args.trim()}` : ''
      return [
        `命令: /${command.name}`,
        `领域包: ${pack.name} (${pack.id})`,
        '',
        prompt,
        argText.trimEnd(),
      ].filter(Boolean).join('\n')
    },
  }
}

function firstDefined(...values: unknown[]): unknown {
  return values.find(value => value !== undefined)
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
  if (typeof value === 'string' && value.trim()) return value.split(/[,\n，]/).map(item => item.trim()).filter(Boolean)
  return []
}
