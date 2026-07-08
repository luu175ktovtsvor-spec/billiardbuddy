import type { ToolContext } from '../tools/Tool'
import { parseToolListFromCLI, permissionRuleValueFromString } from '../permissions/permissionRules'

const TOOL_ALIASES = new Map<string, string[]>([
  ['Bash', ['run_command']],
  ['Edit', ['edit_file', 'patch_file', 'patch_files']],
  ['Glob', ['glob_files']],
  ['Grep', ['grep_files']],
  ['LS', ['list_dir']],
  ['MultiEdit', ['multi_edit_file']],
  ['NotebookEdit', ['NotebookEdit']],
  ['PowerShell', ['PowerShell']],
  ['Read', ['read_file', 'read_many_files']],
  ['Task', ['agent_task']],
  ['TodoWrite', ['todo_write']],
  ['Write', ['write_file']],
])

export function allowedToolRulesFromFrontmatter(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value.map(String)
    : typeof value === 'string' && value.trim()
      ? [value]
      : []
  const parsed = parseToolListFromCLI(raw)
  return parsed.length > 0 ? parsed : undefined
}

function aliasKey(value: string): string {
  return permissionRuleValueFromString(value).toolName
}

export function normalizeAllowedTools(values: string[] | undefined): string[] | undefined {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of values ?? []) {
    const value = raw.trim()
    if (!value) continue
    const mapped = TOOL_ALIASES.get(aliasKey(value)) ?? [value]
    for (const tool of mapped) {
      if (seen.has(tool)) continue
      seen.add(tool)
      out.push(tool)
    }
  }
  return out.length > 0 ? out : undefined
}

export function allowedToolsForAgent(values: string[] | undefined): string[] | undefined {
  const normalized = normalizeAllowedTools(values)
  if (!normalized || normalized.includes('*')) return undefined
  return normalized
}

export function addAllowedToolsToContext(ctx: ToolContext, values: string[] | undefined): void {
  for (const raw of values ?? []) {
    const value = raw.trim()
    if (!value) continue
    const rule = permissionRuleValueFromString(value)
    const mapped = TOOL_ALIASES.get(rule.toolName) ?? [rule.toolName]
    if (rule.ruleContent) {
      ctx.sessionAllowedToolRules ??= []
      for (const tool of mapped) ctx.sessionAllowedToolRules.push({ tool, ruleContent: rule.ruleContent })
      continue
    }
    const normalized = normalizeAllowedTools([value])
    if (!normalized) continue
    ctx.sessionAllowedTools ??= new Set<string>()
    for (const tool of normalized) ctx.sessionAllowedTools.add(tool)
  }
}
