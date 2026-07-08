export interface PermissionRuleValue {
  toolName: string
  ruleContent?: string
}

type ShellPermissionRule =
  | { type: 'exact'; command: string }
  | { type: 'prefix'; prefix: string }
  | { type: 'wildcard'; pattern: string }

const ESCAPED_STAR_PLACEHOLDER = '\x00ESCAPED_STAR\x00'
const ESCAPED_BACKSLASH_PLACEHOLDER = '\x00ESCAPED_BACKSLASH\x00'
const ESCAPED_STAR_PLACEHOLDER_RE = new RegExp(ESCAPED_STAR_PLACEHOLDER, 'g')
const ESCAPED_BACKSLASH_PLACEHOLDER_RE = new RegExp(ESCAPED_BACKSLASH_PLACEHOLDER, 'g')

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
  if (rule.type === 'exact') return normalizedCommand === rule.command
  if (rule.type === 'wildcard') return matchWildcardPattern(rule.pattern, normalizedCommand)
  return normalizedCommand === rule.prefix || normalizedCommand.startsWith(`${rule.prefix} `)
}
