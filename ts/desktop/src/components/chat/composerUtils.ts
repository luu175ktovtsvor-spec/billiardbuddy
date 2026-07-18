import type { SettingsTab } from '../../stores/uiStore'
import type { TranslationKey } from '../../i18n'

/** Map from slash command name to its i18n description key */
const SLASH_CMD_DESCRIPTION_KEYS: Record<string, TranslationKey> = {
  agent: 'slashCmd.agent.description',
  mcp: 'slashCmd.mcp.description',
  help: 'slashCmd.help.description',
  plugin: 'slashCmd.plugin.description',
  memory: 'slashCmd.memory.description',
  doctor: 'slashCmd.doctor.description',
  compact: 'slashCmd.compact.description',
  clear: 'slashCmd.clear.description',
  goal: 'slashCmd.goal.description',
  review: 'slashCmd.review.description',
  commit: 'slashCmd.commit.description',
  pr: 'slashCmd.pr.description',
  init: 'slashCmd.init.description',
  config: 'slashCmd.config.description',
  permissions: 'slashCmd.permissions.description',
  'terminal-setup': 'slashCmd.terminal-setup.description',
  vim: 'slashCmd.vim.description',
}

/** Names of commands the desktop owns the description for (i.e. localized in our locales). */
const BUILT_IN_COMMAND_NAMES = new Set(Object.keys(SLASH_CMD_DESCRIPTION_KEYS))

export const PANEL_SLASH_COMMANDS = [
  { name: 'mcp' },
  { name: 'help' },
] as const

export const SETTINGS_SLASH_COMMANDS = [
  { name: 'config', tab: 'general' as const },
  { name: 'plugin', tab: 'plugins' as const },
  { name: 'doctor', tab: 'diagnostics' as const },
] as const

export const SLASH_COMMAND_ALIASES = [
  { name: 'plugins', target: 'plugin' },
  { name: 'settings', target: 'config' },
] as const

const RETIRED_SESSION_INSPECTOR_COMMAND_NAMES = new Set(['status', 'cost', 'context'])

export function isRetiredSessionInspectorCommandName(name: string): boolean {
  return RETIRED_SESSION_INSPECTOR_COMMAND_NAMES.has(name.trim().toLowerCase())
}

export function getLeadingSlashCommandName(value: string): string | null {
  const match = /^\/([^\s/]+)/.exec(value.trim())
  return match?.[1]?.toLowerCase() ?? null
}

export function isRetiredSessionInspectorCommandInput(value: string): boolean {
  const commandName = getLeadingSlashCommandName(value)
  return commandName ? isRetiredSessionInspectorCommandName(commandName) : false
}

/** Static fallback with English descriptions (for non-React contexts) */
export const FALLBACK_SLASH_COMMANDS: SlashCommandOption[] = [
  { name: 'agent', description: 'Run a prompt with a selected Agent', argumentHint: '<agent> <prompt>' },
  { name: 'mcp', description: 'Open available MCP tools for the current chat context' },
  { name: 'help', description: 'Show available desktop and agent commands' },
  { name: 'plugin', description: 'Open desktop plugin controls in Settings' },
  { name: 'memory', description: 'Manage task memory' },
  { name: 'doctor', description: 'Open Doctor in Diagnostics' },
  { name: 'compact', description: 'Compact conversation context' },
  { name: 'clear', description: 'Clear conversation history' },
  { name: 'goal', description: 'Set a completion goal', argumentHint: '[<condition> | clear]' },
  { name: 'review', description: 'Review code changes' },
  { name: 'commit', description: 'Create a git commit' },
  { name: 'pr', description: 'Create a pull request' },
  { name: 'init', description: 'Initialize project instructions' },
  { name: 'config', description: 'Open configuration' },
  { name: 'permissions', description: 'View or manage tool permissions' },
  { name: 'terminal-setup', description: 'Set up terminal integration' },
  { name: 'vim', description: 'Toggle vim editing mode' },
]

/** Build localized fallback commands using the current locale.
 *
 * Resolution order for each command's description:
 *   1. Localized string from the i18n table (zh -> en) when a key is registered.
 *   2. The static English description shipped in FALLBACK_SLASH_COMMANDS.
 *
 * This guarantees we never render a raw key (e.g. "slashCmd.foo.description")
 * in the UI even if a command is missing from SLASH_CMD_DESCRIPTION_KEYS or
 * its translation entry is absent.
 */
export function getLocalizedFallbackCommands(t: (key: TranslationKey) => string): SlashCommandOption[] {
  return FALLBACK_SLASH_COMMANDS.map((cmd) => {
    const key = SLASH_CMD_DESCRIPTION_KEYS[cmd.name]
    let description = cmd.description
    if (key) {
      const translated = t(key)
      // i18n returns the key itself when no translation is found; fall back to
      // the static English description in that case.
      if (translated && translated !== key) {
        description = translated
      }
    }
    return {
      name: cmd.name,
      description,
      ...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
    }
  })
}

export type SlashCommandOption = {
  name: string
  runtimeName?: string
  description: string
  argumentHint?: string
}

type SlashCommandCatalogEntry = {
  name: string
  description?: string
  argumentHint?: string
}

export type AgentSlashCommandSource = {
  displayName: string
  runtimeName: string
}

export function buildAgentSlashCommands(
  agents: ReadonlyArray<AgentSlashCommandSource>,
): SlashCommandOption[] {
  const seenRuntimeNames = new Set<string>()
  const displayNames = new Set<string>()
  const commands: SlashCommandOption[] = []

  for (const agent of agents) {
    const runtimeAgentType = agent.runtimeName.trim()
    const preferredDisplayAgentType = agent.displayName.trim()
    if (!runtimeAgentType || !preferredDisplayAgentType || seenRuntimeNames.has(runtimeAgentType)) continue
    seenRuntimeNames.add(runtimeAgentType)

    const displayAgentType = reserveDisplayName(preferredDisplayAgentType, displayNames)
    displayNames.add(displayAgentType)
    const name = `agent ${displayAgentType}`
    const runtimeName = `agent ${runtimeAgentType}`

    commands.push({
      name,
      ...(runtimeName !== name ? { runtimeName } : {}),
      description: '',
      argumentHint: '<prompt>',
    })
  }

  return commands
}

function reserveDisplayName(preferred: string, reserved: Set<string>): string {
  if (!reserved.has(preferred)) return preferred

  const base = `${preferred}-assistant`
  let candidate = base
  let suffix = 2
  while (reserved.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

export function resolveSlashCommandRuntimeValue(
  value: string,
  commands: ReadonlyArray<SlashCommandOption>,
): string {
  for (const command of commands) {
    if (!command.runtimeName || command.runtimeName === command.name) continue
    const displayPrefix = `/${command.name}`
    if (value !== displayPrefix && !value.startsWith(`${displayPrefix} `)) continue
    return `/${command.runtimeName}${value.slice(displayPrefix.length)}`
  }
  return value
}

export function appendAgentSlashCommands(
  commands: ReadonlyArray<SlashCommandOption>,
  agentCommands: ReadonlyArray<SlashCommandOption>,
): SlashCommandOption[] {
  const names = new Set(commands.map((command) => command.name))
  return [
    ...commands,
    ...agentCommands.filter((command) => !names.has(command.name)),
  ]
}

export type SlashUiAction =
  | {
      type: 'panel'
      command: typeof PANEL_SLASH_COMMANDS[number]['name']
    }
  | {
      type: 'settings'
      tab: SettingsTab
    }
  | {
      type: 'product-managed'
    }

export function resolveSlashUiAction(value: string): SlashUiAction | null {
  const normalizedValue = SLASH_COMMAND_ALIASES.find((alias) => alias.name === value)?.target ?? value
  const panelCommand = PANEL_SLASH_COMMANDS.find((command) => command.name === normalizedValue)
  if (panelCommand) {
    return { type: 'panel', command: panelCommand.name }
  }

  const settingsCommand = SETTINGS_SLASH_COMMANDS.find((command) => command.name === normalizedValue)
  if (settingsCommand) {
    return { type: 'settings', tab: settingsCommand.tab }
  }

  if (['login', 'logout', 'model'].includes(normalizedValue)) {
    return { type: 'product-managed' }
  }

  return null
}

export function mergeSlashCommands(
  preferred: ReadonlyArray<SlashCommandCatalogEntry>,
  fallback: ReadonlyArray<SlashCommandOption> = FALLBACK_SLASH_COMMANDS,
): SlashCommandOption[] {
  const fallbackByName = new Map<string, SlashCommandOption>()
  for (const command of fallback) {
    if (command?.name) fallbackByName.set(command.name, command)
  }

  const merged = new Map<string, SlashCommandOption>()

  for (const command of preferred) {
    if (!command?.name || isRetiredSessionInspectorCommandName(command.name)) continue
    const localized = fallbackByName.get(command.name)
    // For commands the desktop owns the copy for, prefer the localized fallback
    // description so users see translated text instead of the CLI's English.
    const useLocalDescription =
      BUILT_IN_COMMAND_NAMES.has(command.name) && Boolean(localized?.description)
    // Session and Skills APIs intentionally provide only a command name. Do
    // not rehydrate descriptions or argument hints from a remote payload here:
    // custom Skill frontmatter is private implementation data.
    const description = useLocalDescription ? localized!.description : ''
    const argumentHint = useLocalDescription ? localized?.argumentHint : undefined
    merged.set(command.name, {
      name: command.name,
      description,
      ...(argumentHint && { argumentHint }),
    })
  }

  for (const command of fallback) {
    if (!command?.name || isRetiredSessionInspectorCommandName(command.name)) continue
    if (merged.has(command.name)) continue
    merged.set(command.name, command)
  }

  return [...merged.values()].filter((command) => !['login', 'logout', 'model'].includes(command.name))
}

function getSlashCommandMatchRank(command: SlashCommandOption, filter: string): number {
  const name = command.name.toLowerCase()
  const description = command.description.toLowerCase()
  const argumentHint = command.argumentHint?.toLowerCase() ?? ''
  const nameParts = name.split(/[:/._-]+/).filter(Boolean)

  if (name === filter) return 0
  if (name.startsWith(filter)) return 1
  if (nameParts.some((part) => part.startsWith(filter))) return 2
  if (name.includes(filter)) return 3
  if (description.includes(filter)) return 4
  if (argumentHint.includes(filter)) return 5
  return Number.POSITIVE_INFINITY
}

export function filterSlashCommands(
  commands: ReadonlyArray<SlashCommandOption>,
  filter: string,
): SlashCommandOption[] {
  const normalized = filter.toLowerCase()
  if (!normalized.trim()) return [...commands]

  return commands
    .map((command, index) => ({
      command,
      index,
      rank: getSlashCommandMatchRank(command, normalized),
    }))
    .filter((item) => Number.isFinite(item.rank))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.command)
}

export type SlashTrigger = {
  slashPos: number
  filter: string
}

export function findSlashTrigger(value: string, cursorPos: number): SlashTrigger | null {
  const textBeforeCursor = value.slice(0, cursorPos)
  const slashPos = textBeforeCursor.lastIndexOf('/')
  if (slashPos < 0) return null
  if (slashPos > 0 && !/\s/.test(textBeforeCursor[slashPos - 1]!)) return null

  const filter = textBeforeCursor.slice(slashPos + 1)
  if (filter.includes('\n')) return null
  if (/\s/.test(filter)) return null

  return { slashPos, filter }
}

export function replaceSlashToken(
  input: string,
  cursorPos: number,
  command: string,
  options?: { trailingSpace?: boolean },
): { value: string; cursorPos: number } {
  const trigger = findSlashTrigger(input, cursorPos)
  if (!trigger) {
    const prefix = input && !/\s$/.test(input) ? `${input} ` : input
    const token = `/${command}`
    const suffix = options?.trailingSpace !== false ? ' ' : ''
    const value = `${prefix}${token}${suffix}`
    return { value, cursorPos: value.length }
  }

  const before = input.slice(0, trigger.slashPos)
  const after = input.slice(cursorPos)
  const token = `/${command}`
  const suffix = options?.trailingSpace !== false ? ' ' : ''
  const value = `${before}${token}${suffix}${after}`
  const nextCursorPos = before.length + token.length + suffix.length
  return { value, cursorPos: nextCursorPos }
}

export type SlashToken = {
  start: number
  filter: string
}

export function findSlashToken(value: string, cursorPos: number): SlashToken | null {
  const trigger = findSlashTrigger(value, cursorPos)
  if (!trigger) return null
  return { start: trigger.slashPos, filter: trigger.filter }
}

export function replaceSlashCommand(
  value: string,
  cursorPos: number,
  command: string,
): { value: string; cursorPos: number } | null {
  const trigger = findSlashTrigger(value, cursorPos)
  if (!trigger) return null

  return replaceSlashToken(value, cursorPos, command, { trailingSpace: true })
}

export function insertSlashTrigger(
  value: string,
  cursorPos: number,
): { value: string; cursorPos: number } {
  const before = value.slice(0, cursorPos)
  const after = value.slice(cursorPos)
  const needsLeadingSpace = before.length > 0 && !/\s$/.test(before)
  const token = `${needsLeadingSpace ? ' ' : ''}/`
  return {
    value: `${before}${token}${after}`,
    cursorPos: before.length + token.length,
  }
}
