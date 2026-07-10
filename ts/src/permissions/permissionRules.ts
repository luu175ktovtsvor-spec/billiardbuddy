import type { PermissionRuleValue } from './types'

export type { PermissionRuleValue } from './types'

type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

const ESCAPED_STAR_PLACEHOLDER = '\x00ESCAPED_STAR\x00'
const ESCAPED_BACKSLASH_PLACEHOLDER = '\x00ESCAPED_BACKSLASH\x00'
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, 'g')
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(ESCAPED_BACKSLASH_PLACEHOLDER, 'g')
export const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50

const SAFE_ENV_VARS = new Set([
  'GOEXPERIMENT',
  'GOOS',
  'GOARCH',
  'CGO_ENABLED',
  'GO111MODULE',
  'RUST_BACKTRACE',
  'RUST_LOG',
  'NODE_ENV',
  'PYTHONUNBUFFERED',
  'PYTHONDONTWRITEBYTECODE',
  'PYTEST_DISABLE_PLUGIN_AUTOLOAD',
  'PYTEST_DEBUG',
  'ANTHROPIC_API_KEY',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_TIME',
  'CHARSET',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'TZ',
  'LS_COLORS',
  'LSCOLORS',
  'GREP_COLOR',
  'GREP_COLORS',
  'GCC_COLORS',
  'TIME_STYLE',
  'BLOCK_SIZE',
  'BLOCKSIZE',
])

const SAFE_ENV_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/

const SAFE_WRAPPER_PATTERNS = [
  /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
  /^time[ \t]+(?:--[ \t]+)?/,
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
  /^stdbuf(?:(?:[ \t]+-[ioe][ \t]+[LN0-9]+|[ \t]+-[ioe][LN0-9]+|[ \t]+--(?:input|output|error)=[LN0-9]+))+[ \t]+(?:--[ \t]+)?/,
  /^nohup[ \t]+(?:--[ \t]+)?/,
] as const

function findFirstUnescapedChar(value: string, char: string): number {
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== char) continue
    let backslashCount = 0
    let j = i - 1
    while (j >= 0 && value[j] === '\\') {
      backslashCount++
      j--
    }
    if (backslashCount % 2 === 0) return i
  }
  return -1
}

function findLastUnescapedChar(value: string, char: string): number {
  for (let i = value.length - 1; i >= 0; i--) {
    if (value[i] !== char) continue
    let backslashCount = 0
    let j = i - 1
    while (j >= 0 && value[j] === '\\') {
      backslashCount++
      j--
    }
    if (backslashCount % 2 === 0) return i
  }
  return -1
}

export function unescapeRuleContent(content: string): string {
  return content
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
}

export function escapeRuleContent(content: string): string {
  return content
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
}

export function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
  const value = ruleString.trim()
  const openParenIndex = findFirstUnescapedChar(value, '(')
  if (openParenIndex === -1) return { toolName: value }

  const closeParenIndex = findLastUnescapedChar(value, ')')
  if (closeParenIndex === -1 || closeParenIndex <= openParenIndex || closeParenIndex !== value.length - 1) {
    return { toolName: value }
  }

  const toolName = value.slice(0, openParenIndex).trim()
  if (!toolName) return { toolName: value }

  const rawContent = value.slice(openParenIndex + 1, closeParenIndex)
  if (rawContent === '' || rawContent === '*') return { toolName }
  return { toolName, ruleContent: unescapeRuleContent(rawContent) }
}

export function permissionRuleValueToString(ruleValue: PermissionRuleValue): string {
  if (!ruleValue.ruleContent) return ruleValue.toolName
  return `${ruleValue.toolName}(${escapeRuleContent(ruleValue.ruleContent)})`
}

export function parseToolListFromCLI(values: string[] | undefined): string[] {
  const out: string[] = []
  for (const value of values ?? []) {
    let current = ''
    let parenDepth = 0
    let escaped = false
    for (const char of value) {
      if (escaped) {
        current += char
        escaped = false
        continue
      }
      if (char === '\\') {
        current += char
        escaped = true
        continue
      }
      if (char === '(') {
        parenDepth++
        current += char
        continue
      }
      if (char === ')' && parenDepth > 0) {
        parenDepth--
        current += char
        continue
      }
      if ((char === ',' || /\s/.test(char)) && parenDepth === 0) {
        if (current.trim()) out.push(current.trim())
        current = ''
        continue
      }
      current += char
    }
    if (current.trim()) out.push(current.trim())
  }
  return out
}

export function permissionRuleExtractPrefix(permissionRule: string): string | null {
  const match = permissionRule.match(/^(.+):\*$/)
  return match?.[1] ?? null
}

export function hasWildcards(pattern: string): boolean {
  if (pattern.endsWith(':*')) return false
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '*') continue
    let backslashCount = 0
    let j = i - 1
    while (j >= 0 && pattern[j] === '\\') {
      backslashCount++
      j--
    }
    if (backslashCount % 2 === 0) return true
  }
  return false
}

export function parseShellPermissionRule(permissionRule: string): ShellPermissionRule {
  const prefix = permissionRuleExtractPrefix(permissionRule)
  if (prefix !== null) return { type: 'prefix', prefix }
  if (hasWildcards(permissionRule)) return { type: 'wildcard', pattern: permissionRule }
  return { type: 'exact', command: permissionRule }
}

function stripCommentLines(command: string): string {
  const lines = command.split('\n')
  const nonCommentLines = lines.filter(line => {
    const trimmed = line.trim()
    return trimmed !== '' && !trimmed.startsWith('#')
  })
  return nonCommentLines.length === 0 ? command : nonCommentLines.join('\n')
}

export function stripSafeShellWrappers(command: string): string {
  let stripped = command.trim()
  let previous = ''

  while (stripped !== previous) {
    previous = stripped
    stripped = stripCommentLines(stripped)
    const envMatch = stripped.match(SAFE_ENV_PATTERN)
    if (envMatch && SAFE_ENV_VARS.has(envMatch[1]!)) stripped = stripped.replace(SAFE_ENV_PATTERN, '')
  }

  previous = ''
  while (stripped !== previous) {
    previous = stripped
    stripped = stripCommentLines(stripped)
    for (const pattern of SAFE_WRAPPER_PATTERNS) stripped = stripped.replace(pattern, '')
  }

  return stripped.trim()
}

// SECURITY: broad env-var pattern for DENY/ASK matching only. Unlike SAFE_ENV_PATTERN
// (safe-list gated), this strips ANY leading `VAR=value` prefix so a denied command
// stays denied even behind arbitrary env vars (`FOO=bar rm x`, `PATH=/tmp npm ...`).
// Excludes shell-injection chars ($, backtick, ; | & ( ) < >, quotes, backslash) from
// unquoted values, allows single-/double-quoted values. Ported from cc-haha
// stripAllLeadingEnvVars (bashPermissions.ts). NEVER use this on allow rules — that would
// let `DOCKER_HOST=evil docker ps` auto-match Bash(docker ps:*) (HackerOne #3543050).
const BROAD_ENV_VAR_PATTERN =
  /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\'"])*[ \t]+/

export function stripAllLeadingEnvVars(command: string): string {
  let stripped = command
  let previous = ''
  while (stripped !== previous) {
    previous = stripped
    stripped = stripCommentLines(stripped)
    const m = stripped.match(BROAD_ENV_VAR_PATTERN)
    if (!m) continue
    stripped = stripped.slice(m[0].length)
  }
  return stripped.trim()
}

// SECURITY: exec-wrappers that run their argument as a fresh command, so a deny rule on
// the wrapped command (Bash(rm:*)) must see through them (`sudo rm x`, `env FOO=1 rm x`,
// `xargs rm`). Mirrors cc-haha's checkSemantics wrapper-strip (env) + BARE_SHELL_PREFIXES
// (sudo/doas/pkexec/xargs). Used ONLY for deny/ask candidate generation — over-stripping
// here only ever makes a deny rule MORE aggressive (fail-closed), never auto-approves.
const EXEC_WRAPPER_COMMANDS = new Set(['sudo', 'doas', 'pkexec', 'env', 'xargs'])

function stripLeadingExecWrapper(command: string): string {
  const trimmed = command.trim()
  const headMatch = trimmed.match(/^(\S+)\s+([\s\S]+)$/)
  if (!headMatch || !EXEC_WRAPPER_COMMANDS.has(headMatch[1]!)) return trimmed
  // Drop the wrapper word, then any leading option flags. `env`'s VAR=val assignments are
  // peeled by stripAllLeadingEnvVars in the fixed-point loop below.
  let rest = headMatch[2]!.trim()
  let flagMatch = rest.match(/^-\S+\s+([\s\S]+)$/)
  while (flagMatch) {
    rest = flagMatch[1]!.trim()
    flagMatch = rest.match(/^-\S+\s+([\s\S]+)$/)
  }
  return rest
}

export function splitShellCommandsForPermission(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  const flush = () => {
    const value = current.trim()
    if (value) parts.push(value)
    current = ''
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!

    if (quote === "'") {
      current += char
      if (char === "'") quote = null
      continue
    }

    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      current += char
      escaped = true
      continue
    }

    if (quote === '"') {
      current += char
      if (char === '"') quote = null
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === '\n' || char === ';') {
      flush()
      continue
    }

    if (char === '&' && command[i + 1] === '&') {
      flush()
      i++
      continue
    }

    if (char === '|') {
      flush()
      if (command[i + 1] === '|') i++
      continue
    }

    current += char
  }

  flush()
  return parts
}

function commandCandidatesForPermissionRule(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return []
  const candidates = [trimmed]
  const seen = new Set(candidates)
  let index = 0

  while (index < candidates.length) {
    const candidate = candidates[index++]!
    const stripped = stripSafeShellWrappers(candidate)
    if (stripped && !seen.has(stripped)) {
      seen.add(stripped)
      candidates.push(stripped)
    }
  }

  return candidates
}

function candidateMatchesShellRule(rule: ShellPermissionRule, candidate: string): boolean {
  if (rule.type === 'exact') return candidate === rule.command
  if (rule.type === 'wildcard') return matchWildcardPattern(rule.pattern, candidate)
  // prefix: word-boundary match, plus bare `xargs <prefix>` (mirrors allow-side matching)
  if (candidate === rule.prefix || candidate.startsWith(`${rule.prefix} `)) return true
  const xargsPrefix = `xargs ${rule.prefix}`
  return candidate === xargsPrefix || candidate.startsWith(`${xargsPrefix} `)
}

function shellSingleCommandMatchesPermissionRule(command: string, ruleContent: string): boolean {
  const rule = parseShellPermissionRule(ruleContent.trim())
  return commandCandidatesForPermissionRule(command).some(candidate => candidateMatchesShellRule(rule, candidate))
}

// DENY/ASK candidate generation: fixed-point over safe-wrapper strip + broad env-var strip
// + exec-wrapper strip, so a denied command surfaces regardless of how it's wrapped
// (`nohup FOO=bar sudo timeout 5 rm x` → `rm x`). Intentionally more aggressive than the
// allow-side commandCandidatesForPermissionRule (safe wrappers only).
function denyAskCommandCandidates(command: string): string[] {
  const trimmed = command.trim()
  if (!trimmed) return []
  const candidates = [trimmed]
  const seen = new Set(candidates)
  let index = 0
  while (index < candidates.length && candidates.length <= 64) {
    const candidate = candidates[index++]!
    for (const stripped of [
      stripSafeShellWrappers(candidate),
      stripAllLeadingEnvVars(candidate),
      stripLeadingExecWrapper(candidate),
    ]) {
      if (stripped && stripped !== candidate && !seen.has(stripped)) {
        seen.add(stripped)
        candidates.push(stripped)
      }
    }
  }
  return candidates
}

function shellSingleCommandMatchesDenyOrAskRule(command: string, ruleContent: string): boolean {
  const rule = parseShellPermissionRule(ruleContent.trim())
  return denyAskCommandCandidates(command).some(candidate => candidateMatchesShellRule(rule, candidate))
}

/**
 * SECURITY: deny/ask matcher for run_command. Unlike shellCommandMatchesPermissionRule
 * (allow semantics — refuses to match compound commands), this splits the command into
 * subcommands and matches each one, so a denied command hidden in a compound/pipe/wrapper
 * (`true && rm x`, `echo hi | xargs rm`) still trips the rule. Any subcommand matching the
 * deny/ask rule → the whole command matches. Fail-closed direction throughout.
 */
export function shellCommandMatchesDenyOrAskRule(command: string, ruleContent: string): boolean {
  const normalizedCommand = command.trim()
  if (!normalizedCommand) return false
  // Full command first: catches exact rules on the whole (possibly compound) string and
  // simple single-command prefix/wildcard rules.
  if (shellSingleCommandMatchesDenyOrAskRule(normalizedCommand, ruleContent)) return true
  const subcommands = splitShellCommandsForPermission(normalizedCommand)
  if (subcommands.length <= 1) return false
  // No MAX_SUBCOMMANDS cap here (unlike the allow path): matching is cheap string ops, so
  // checking every subcommand is safe and skipping any would open a bypass window.
  return subcommands.some(subcommand => shellSingleCommandMatchesDenyOrAskRule(subcommand, ruleContent))
}

export function matchWildcardPattern(pattern: string, command: string, caseInsensitive = false): boolean {
  const trimmedPattern = pattern.trim()
  let processed = ''
  let i = 0
  while (i < trimmedPattern.length) {
    const char = trimmedPattern[i]
    if (char === '\\' && i + 1 < trimmedPattern.length) {
      const nextChar = trimmedPattern[i + 1]
      if (nextChar === '*') {
        processed += ESCAPED_STAR_PLACEHOLDER
        i += 2
        continue
      }
      if (nextChar === '\\') {
        processed += ESCAPED_BACKSLASH_PLACEHOLDER
        i += 2
        continue
      }
    }
    processed += char
    i++
  }

  const escaped = processed.replace(/[.+?^${}()|[\]\\'"]/g, '\\$&')
  const withWildcards = escaped.replace(/\*/g, '.*')
  let regexPattern = withWildcards
    .replace(ESCAPED_STAR_PLACEHOLDER_RE, '\\*')
    .replace(ESCAPED_BACKSLASH_PLACEHOLDER_RE, '\\\\')

  const unescapedStarCount = (processed.match(/\*/g) || []).length
  if (regexPattern.endsWith(' .*') && unescapedStarCount === 1) {
    regexPattern = `${regexPattern.slice(0, -3)}( .*)?`
  }

  return new RegExp(`^${regexPattern}$`, `s${caseInsensitive ? 'i' : ''}`).test(command)
}

export function shellCommandMatchesPermissionRule(command: string, ruleContent: string): boolean {
  const normalizedCommand = command.trim()
  if (!normalizedCommand) return false
  const rule = parseShellPermissionRule(ruleContent.trim())
  const isCompound = splitShellCommandsForPermission(normalizedCommand).length > 1
  if (isCompound && rule.type !== 'exact') return false
  return shellSingleCommandMatchesPermissionRule(normalizedCommand, ruleContent)
}

export function shellCommandAllowedByPermissionRules(command: string, ruleContents: string[]): boolean {
  const normalizedCommand = command.trim()
  if (!normalizedCommand || ruleContents.length === 0) return false
  if (ruleContents.some(rule => shellCommandMatchesPermissionRule(normalizedCommand, rule))) return true

  const subcommands = splitShellCommandsForPermission(normalizedCommand)
  if (subcommands.length <= 1) return false
  if (subcommands.length > MAX_SUBCOMMANDS_FOR_SECURITY_CHECK) return false
  return subcommands.every(subcommand =>
    ruleContents.some(rule => shellSingleCommandMatchesPermissionRule(subcommand, rule)),
  )
}
