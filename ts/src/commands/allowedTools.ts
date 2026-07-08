import type { ToolContext } from '../tools/Tool'

const TOOL_ALIASES = new Map<string, string[]>([
  ['Bash', ['run_command']],
  ['Edit', ['edit_file']],
  ['Glob', ['glob_files']],
  ['Grep', ['grep_files']],
  ['LS', ['list_dir']],
  ['MultiEdit', ['multi_edit_file']],
  ['NotebookEdit', ['NotebookEdit']],
  ['Read', ['read_file', 'read_many_files']],
  ['Task', ['agent_task']],
  ['TodoWrite', ['todo_write']],
  ['Write', ['write_file']],
])

function aliasKey(value: string): string {
  const match = value.match(/^([A-Za-z][A-Za-z0-9_-]*)(?:\(.*\))?$/)
  return match?.[1] ?? value
}

function scopedSpec(value: string): { key: string; arg: string } | null {
  const match = value.match(/^([A-Za-z][A-Za-z0-9_-]*)\((.*)\)$/)
  const key = match?.[1]?.trim()
  const arg = match?.[2]?.trim()
  return key && arg ? { key, arg } : null
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
    const scoped = scopedSpec(value)
    if (scoped?.key === 'Bash') {
      ctx.sessionAllowedToolRules ??= []
      ctx.sessionAllowedToolRules.push({ tool: 'run_command', commandPattern: scoped.arg })
      continue
    }
    const normalized = normalizeAllowedTools([value])
    if (!normalized) continue
    ctx.sessionAllowedTools ??= new Set<string>()
    for (const tool of normalized) ctx.sessionAllowedTools.add(tool)
  }
}
