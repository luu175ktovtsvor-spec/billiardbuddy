import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 危险命令最小种子(红线 4:删根/提权/格式化直接拒)。W2 只挡灾难级;
 * 完整分类器(可逆性/爆炸半径/审批档)是 W4。宁可漏杀(交 W4)不可错放这几条。
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i, // rm -rf / | ~ | $HOME
  /\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r?[a-z]*\s+(\/|~|\$HOME)(\s|$)/i,
  /\bsudo\b/, // 提权
  /\bmkfs\b/, // 格式化
  /\bdd\s+.*\bof=\/dev\//, // 覆写块设备
  /:\(\)\s*\{.*\}\s*;/, // fork 炸弹 :(){ :|:& };:
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\brm\s+(-[a-z]*\s+)*(\*|\/\*)(\s|$)/i, // rm * | rm /*（通配删大片）
  /\brm\s+(-[a-z]*\s+)*[A-Za-z]:[\\/]?(\s|$)/i, // rm C:\ | rm D:/（盘符根）
]

export type CommandRisk = 'read' | 'file' | 'outreach' | 'destructive'

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(re => re.test(command))
}

const SHELL_EXPANSION_PATTERNS: RegExp[] = [
  /<\(/,
  />\(/,
  /=\(/,
  /(?:^|[\s;&|])=[a-zA-Z_]/,
  /\$\(/,
  /\$\{/,
  /\$\[/,
  /~\[/,
  /\(e:/,
  /\(\+/,
  /\}\s*always\s*\{/,
  /<#/,
]

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/
const UNICODE_WS_RE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]/
const SHELL_OPERATORS = new Set([';', '|', '&', '<', '>'])
const ZSH_DANGEROUS_COMMANDS = new Set([
  'zmodload',
  'emulate',
  'sysopen',
  'sysread',
  'syswrite',
  'sysseek',
  'zpty',
  'ztcp',
  'zsocket',
  'mapfile',
  'zf_rm',
  'zf_mv',
  'zf_ln',
  'zf_chmod',
  'zf_chown',
  'zf_mkdir',
  'zf_rmdir',
  'zf_chgrp',
])

export function hasShellExpansionRisk(command: string): boolean {
  const exposed = shellTextOutsideSingleQuotes(command)
  return SHELL_EXPANSION_PATTERNS.some(re => re.test(exposed))
}

export function hasShellParserRisk(command: string): boolean {
  const quoteViews = extractShellQuoteViews(command)
  const exposed = shellTextOutsideSingleQuotes(command)
  return CONTROL_CHAR_RE.test(command) ||
    hasShellQuoteSingleQuoteBug(command) ||
    hasCarriageReturnOutsideDoubleQuotes(command) ||
    hasSuspiciousNewline(quoteViews.fullyUnquoted) ||
    hasQuotedNewlineHash(command) ||
    /\$IFS|\$\{[^}]*IFS/.test(command) ||
    /\/proc\/.*\/environ/.test(command) ||
    hasUnescapedChar(exposed, '`') ||
    hasDangerousVariableUse(quoteViews.fullyUnquoted) ||
    hasQuotedShellMetacharacterRisk(command) ||
    hasObfuscatedFlagRisk(command) ||
    hasMalformedTokenInjectionRisk(command) ||
    hasBackslashEscapedWhitespace(command) ||
    hasBackslashEscapedOperator(command) ||
    UNICODE_WS_RE.test(command) ||
    hasMidWordHash(quoteViews.unquotedKeepQuoteChars) ||
    hasBraceExpansionRisk(quoteViews.fullyUnquoted, command) ||
    hasZshDangerousCommand(command)
}

function shellTextOutsideSingleQuotes(command: string): string {
  let out = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of command) {
    if (quote === "'") {
      if (char === "'") quote = null
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = quote === char ? null : quote ?? char
      if (char === '"') out += char
      continue
    }
    out += char
  }
  return out
}

function extractShellQuoteViews(command: string): { fullyUnquoted: string; unquotedKeepQuoteChars: string } {
  let fullyUnquoted = ''
  let unquotedKeepQuoteChars = ''
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (const char of command) {
    if (escaped) {
      escaped = false
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      if (!inSingleQuote && !inDoubleQuote) fullyUnquoted += char
      if (!inSingleQuote && !inDoubleQuote) unquotedKeepQuoteChars += char
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      unquotedKeepQuoteChars += char
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      unquotedKeepQuoteChars += char
      continue
    }
    if (!inSingleQuote && !inDoubleQuote) {
      fullyUnquoted += char
      unquotedKeepQuoteChars += char
    }
  }

  return { fullyUnquoted, unquotedKeepQuoteChars }
}

function hasUnescapedChar(content: string, char: string): boolean {
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\') {
      i++
      continue
    }
    if (content[i] === char) return true
  }
  return false
}

function hasShellQuoteSingleQuoteBug(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && !inSingleQuote) {
      i++
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      if (!inSingleQuote) {
        let backslashCount = 0
        let j = i - 1
        while (j >= 0 && command[j] === '\\') {
          backslashCount++
          j--
        }
        if (backslashCount > 0 && backslashCount % 2 === 1) return true
        if (backslashCount > 0 && command.indexOf("'", i + 1) !== -1) return true
      }
    }
  }

  return false
}

function hasCarriageReturnOutsideDoubleQuotes(command: string): boolean {
  if (!command.includes('\r')) return false
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (const char of command) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (char === '\r' && !inDoubleQuote) return true
  }

  return false
}

function hasSuspiciousNewline(content: string): boolean {
  for (let i = 0; i < content.length; i++) {
    const char = content[i]
    if (char !== '\n' && char !== '\r') continue
    let j = i + 1
    while (j < content.length && /[ \t]/.test(content[j] ?? '')) j++
    if (j >= content.length) continue
    const backslashContinuation = content[i - 1] === '\\' && /\s/.test(content[i - 2] ?? '')
    if (!backslashContinuation) return true
  }
  return false
}

function hasQuotedNewlineHash(command: string): boolean {
  if (!command.includes('\n') || !command.includes('#')) return false
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (char === '\n' && (inSingleQuote || inDoubleQuote)) {
      const lineStart = i + 1
      const nextNewline = command.indexOf('\n', lineStart)
      const lineEnd = nextNewline === -1 ? command.length : nextNewline
      if (command.slice(lineStart, lineEnd).trim().startsWith('#')) return true
    }
  }

  return false
}

function hasDangerousVariableUse(content: string): boolean {
  return /[<>|]\s*\$[A-Za-z_]/.test(content) || /\$[A-Za-z_][A-Za-z0-9_]*\s*[|<>]/.test(content)
}

function hasQuotedShellMetacharacterRisk(command: string): boolean {
  return /(?:^|\s)["'][^"']*[;&][^"']*["'](?:\s|$)/.test(command) ||
    /-(?:name|path|iname)\s+["'][^"']*[;|&][^"']*["']/.test(command) ||
    /-regex\s+["'][^"']*[;&][^"']*["']/.test(command)
}

function hasObfuscatedFlagRisk(command: string): boolean {
  const tokens = tokenizeShellWords(command.toLowerCase())
  const baseCommand = tokens[0] ?? ''
  if (baseCommand === 'echo' && !hasUnquotedShellOperator(command)) return false

  if (/\$'[^']*'/.test(command)) return true
  if (/\$"[^"]*"/.test(command)) return true
  if (/\$['"]{2}\s*-/.test(command)) return true
  if (/(?:^|\s)(?:''|"")+\s*-/.test(command)) return true
  if (/(?:""|'')+['"]-/.test(command)) return true
  if (/(?:^|\s)['"]{3,}/.test(command)) return true

  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (let i = 0; i < command.length - 1; i++) {
    const currentChar = command[i]
    const nextChar = command[i + 1]
    if (escaped) {
      escaped = false
      continue
    }
    if (currentChar === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (currentChar === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (currentChar === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (inSingleQuote || inDoubleQuote || !currentChar || !nextChar) continue

    if (/\s/.test(currentChar) && /['"`]/.test(nextChar) && quotedFlagStartsAt(command, i + 1)) return true
    if (/\s/.test(currentChar) && nextChar === '-' && flagWordContainsQuote(command, i + 1, baseCommand)) return true
  }

  return false
}

function hasUnquotedShellOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  for (const char of command) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (!inSingleQuote && !inDoubleQuote && SHELL_OPERATORS.has(char)) return true
  }
  return false
}

function quotedFlagStartsAt(command: string, quoteIndex: number): boolean {
  const quoteChar = command[quoteIndex]
  if (!quoteChar || !/['"`]/.test(quoteChar)) return false
  let j = quoteIndex + 1
  let insideQuote = ''
  while (j < command.length && command[j] !== quoteChar) {
    insideQuote += command[j]!
    j++
  }
  if (j >= command.length || command[j] !== quoteChar) return false

  const charAfterQuote = command[j + 1]
  if (/^-+[a-zA-Z0-9$`]/.test(insideQuote)) return true
  if (/^-+$/.test(insideQuote) && charAfterQuote !== undefined && /[a-zA-Z0-9\\${`-]/.test(charAfterQuote)) return true
  if ((insideQuote === '' || /^-+$/.test(insideQuote)) && charAfterQuote !== undefined && /['"`]/.test(charAfterQuote)) {
    return adjacentQuotedSegmentsFormFlag(command, j + 1, insideQuote)
  }
  return false
}

function adjacentQuotedSegmentsFormFlag(command: string, start: number, prefix: string): boolean {
  let pos = start
  let combined = prefix
  while (pos < command.length && /['"`]/.test(command[pos] ?? '')) {
    const quote = command[pos]!
    let end = pos + 1
    while (end < command.length && command[end] !== quote) end++
    const segment = command.slice(pos + 1, end)
    combined += segment
    if (/^-+[a-zA-Z0-9$`]/.test(combined)) return true
    if (/^-+$/.test(combined.slice(0, Math.max(0, combined.length - segment.length))) && /[a-zA-Z0-9$`]/.test(segment)) return true
    if (end >= command.length) break
    pos = end + 1
  }
  return pos < command.length && /^-/.test(combined) && /[a-zA-Z0-9\\${`-]/.test(command[pos] ?? '')
}

function flagWordContainsQuote(command: string, dashIndex: number, baseCommand: string): boolean {
  let j = dashIndex
  let flagContent = ''
  while (j < command.length) {
    const flagChar = command[j]
    if (!flagChar || /[\s=]/.test(flagChar)) break
    if (baseCommand === 'cut' && flagContent === '-d' && /['"`]/.test(flagChar)) break
    flagContent += flagChar
    j++
  }
  return flagContent.includes('"') || flagContent.includes("'")
}

function hasMalformedTokenInjectionRisk(command: string): boolean {
  const segments = splitSegments(command)
  return segments.length > 1 && segments.some(segment => hasUnbalancedTokenSyntax(segment))
}

function hasUnbalancedTokenSyntax(segment: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false
  let curly = 0
  let paren = 0
  let bracket = 0
  for (const char of segment) {
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && !inSingleQuote) {
      escaped = true
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (inSingleQuote || inDoubleQuote) continue
    if (char === '{') curly++
    else if (char === '}') curly--
    else if (char === '(') paren++
    else if (char === ')') paren--
    else if (char === '[') bracket++
    else if (char === ']') bracket--
    if (curly < 0 || paren < 0 || bracket < 0) return true
  }
  return inSingleQuote || inDoubleQuote || curly !== 0 || paren !== 0 || bracket !== 0
}

function hasBackslashEscapedWhitespace(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote && (command[i + 1] === ' ' || command[i + 1] === '\t')) return true
      i++
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    }
  }

  return false
}

function hasBackslashEscapedOperator(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === '\\' && !inSingleQuote) {
      if (!inDoubleQuote && SHELL_OPERATORS.has(command[i + 1] ?? '')) return true
      i++
      continue
    }
    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
      continue
    }
    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    }
  }

  return false
}

function hasMidWordHash(content: string): boolean {
  return hasMidWordHashIn(content) || hasMidWordHashIn(content.replace(/\\+\n/g, match => {
    const backslashCount = match.length - 1
    return backslashCount % 2 === 1 ? '\\'.repeat(backslashCount - 1) : match
  }))
}

function hasMidWordHashIn(content: string): boolean {
  for (let i = 1; i < content.length; i++) {
    if (content[i] !== '#') continue
    if (content.slice(i - 2, i) === '${') continue
    if (/\S/.test(content[i - 1] ?? '')) return true
  }
  return false
}

function isEscapedAtPosition(content: string, pos: number): boolean {
  let backslashCount = 0
  let i = pos - 1
  while (i >= 0 && content[i] === '\\') {
    backslashCount++
    i--
  }
  return backslashCount % 2 === 1
}

function hasBraceExpansionRisk(content: string, originalCommand: string): boolean {
  let unescapedOpenBraces = 0
  let unescapedCloseBraces = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{' && !isEscapedAtPosition(content, i)) unescapedOpenBraces++
    else if (content[i] === '}' && !isEscapedAtPosition(content, i)) unescapedCloseBraces++
  }

  if (unescapedOpenBraces > 0 && unescapedCloseBraces > unescapedOpenBraces) return true
  if (unescapedOpenBraces > 0 && /['"][{}]['"]/.test(originalCommand)) return true

  for (let i = 0; i < content.length; i++) {
    if (content[i] !== '{' || isEscapedAtPosition(content, i)) continue
    let depth = 1
    let matchingClose = -1
    for (let j = i + 1; j < content.length; j++) {
      const ch = content[j]
      if (ch === '{' && !isEscapedAtPosition(content, j)) depth++
      else if (ch === '}' && !isEscapedAtPosition(content, j)) {
        depth--
        if (depth === 0) {
          matchingClose = j
          break
        }
      }
    }
    if (matchingClose === -1) continue
    let innerDepth = 0
    for (let k = i + 1; k < matchingClose; k++) {
      const ch = content[k]
      if (ch === '{' && !isEscapedAtPosition(content, k)) innerDepth++
      else if (ch === '}' && !isEscapedAtPosition(content, k)) innerDepth--
      else if (innerDepth === 0 && (ch === ',' || (ch === '.' && content[k + 1] === '.'))) return true
    }
  }

  return false
}

function hasZshDangerousCommand(command: string): boolean {
  const tokens = tokenizeShellWords(command.toLowerCase())
  const modifiers = new Set(['command', 'builtin', 'noglob', 'nocorrect'])
  let baseCmd = ''
  for (const token of tokens) {
    if (/^[a-zA-Z_]\w*=/.test(token)) continue
    if (modifiers.has(token)) continue
    baseCmd = token
    break
  }
  return ZSH_DANGEROUS_COMMANDS.has(baseCmd) || (baseCmd === 'fc' && tokens.some(token => /^-\S*e/.test(token)))
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function splitSegments(command: string): string[] {
  return normalize(command).split(/\s*(?:&&|\|\||[;|])\s*/).map(x => x.trim()).filter(Boolean)
}

function hasWriteRedirection(command: string): boolean {
  return /(^|[^<])>>?[^&]/.test(command) || /\b\d>>?/.test(command)
}

function tokenizeShellWords(command: string): string[] {
  const words: string[] = []
  let i = 0
  while (i < command.length) {
    while (/\s/.test(command[i] ?? '')) i++
    if (i >= command.length) break
    const parsed = readShellWord(command, i)
    if (!parsed.word) {
      i++
      continue
    }
    words.push(parsed.word)
    i = parsed.end
  }
  return words
}

function classifyFindCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command.toLowerCase())
  if (tokens[0] !== 'find') return null
  if (tokens.some(token => token === '-delete')) return 'destructive'
  if (tokens.some(token => token === '-exec' || token === '-execdir' || token === '-ok' || token === '-okdir')) return 'outreach'
  if (tokens.some(token => token === '-fprint' || token === '-fprint0' || token === '-fls' || token === '-fprintf')) return 'file'
  return 'read'
}

function classifyJqCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'jq') return null
  if (/\bsystem\s*\(/.test(command)) return 'outreach'
  if (tokens.some(token => {
    const longFlag = token.toLowerCase()
    return token === '-f' ||
      longFlag === '--from-file' ||
      longFlag.startsWith('--from-file=') ||
      longFlag === '--rawfile' ||
      longFlag.startsWith('--rawfile=') ||
      longFlag === '--slurpfile' ||
      longFlag.startsWith('--slurpfile=') ||
      token === '-L' ||
      longFlag === '--library-path' ||
      longFlag.startsWith('--library-path=')
  })) return 'outreach'
  return 'read'
}

export function shellOutputRedirectionNeedsApproval(command: string, opts: { root: string; cwd?: string }): boolean {
  const targets = extractOutputRedirectionTargets(command)
  if (targets.length === 0) return false
  if (splitSegments(command).some(segment => /^cd(?:\s|$)/.test(normalize(segment).toLowerCase()))) return true
  return targets.some(target => redirectionTargetNeedsApproval(target, opts))
}

function extractOutputRedirectionTargets(command: string): string[] {
  const targets: string[] = []
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (escaped) escaped = false
      else if (char === '\\' && quote === '"') escaped = true
      else if (char === quote) quote = null
      continue
    }
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (char !== '>') continue
    if (command[i + 1] === '(' || command[i + 1] === '&') continue

    let j = i + 1
    if (command[j] === '>') j++
    if (command[j] === '|' || command[j] === '!') j++
    while (command[j] === ' ' || command[j] === '\t') j++
    const parsed = readShellWord(command, j)
    if (!parsed.word || parsed.word.startsWith('&')) continue
    targets.push(parsed.word)
    i = parsed.end - 1
  }

  return targets
}

function readShellWord(command: string, start: number): { word: string; end: number } {
  let word = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  let i = start

  for (; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      if (escaped) {
        word += char
        escaped = false
      } else if (char === '\\' && quote === '"') {
        escaped = true
      } else if (char === quote) {
        quote = null
      } else {
        word += char
      }
      continue
    }
    if (escaped) {
      word += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char) || /[;&|<>]/.test(char)) break
    word += char
  }

  return { word, end: i }
}

function redirectionTargetNeedsApproval(target: string, opts: { root: string; cwd?: string }): boolean {
  if (!target || target === '/dev/null') return false
  if (/[$%*?\[\]{}=~]/.test(target)) return true
  const abs = isAbsolute(target) ? resolve(target) : resolve(opts.cwd || opts.root, target)
  return !isInside(resolve(opts.root), abs)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function classifySegment(segment: string): CommandRisk {
  const rawCommand = normalize(segment)
  const command = rawCommand.toLowerCase()
  if (!command) return 'read'
  if (isDangerousCommand(command)) return 'destructive'
  if (hasWriteRedirection(command)) return 'file'

  if (/\bgit\s+clean\s+-/.test(command)) return 'destructive'
  if (/\brm\s+.*-[a-z]*r/.test(command)) return 'destructive'
  if (/^git\s+push\b.*\s--(?:force|force-with-lease|mirror)\b/.test(command)) return 'destructive'
  if (/^git\s+push\b.*\s-f(?:\s|$)/.test(command)) return 'destructive'
  if (/^git\s+reset\b.*\s--hard\b/.test(command)) return 'destructive'
  if (/^git\s+branch\s+-D\b/.test(command)) return 'destructive'

  if (/^(curl|wget|ssh|scp|sftp|ftp|telnet|nc|netcat|rsync)\b/.test(command)) return 'outreach'
  if (/^(gh|glab)\s+(api|auth|repo|pr|issue|release)\b/.test(command)) return 'outreach'
  if (/^(npm|pnpm|yarn|bun)\s+(install|add|upgrade|update|publish)\b/.test(command)) return 'outreach'
  if (/^(pip|pip3|uv|poetry)\s+(install|add|publish|update)\b/.test(command)) return 'outreach'
  if (/^(brew|apt|apt-get|dnf|yum|pacman|choco|winget)\s+(install|upgrade|update|remove)\b/.test(command)) return 'outreach'

  const findRisk = classifyFindCommand(rawCommand)
  if (findRisk) return findRisk

  const jqRisk = classifyJqCommand(rawCommand)
  if (jqRisk) return jqRisk

  if (/^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee)\b/.test(command)) return 'file'
  if (/\b(sed|perl)\s+.*\s-i\b/.test(command) || /\b(sed|perl)\s+-i\b/.test(command)) return 'file'
  if (/^git\s+(checkout|switch|restore|reset|merge|rebase|commit|tag|branch\s+(-d|-D)|apply|am|stash|pull|push)\b/.test(command)) return 'file'
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|generate|lint\s+--fix|format|test)\b/.test(command)) return 'file'

  if (/^(pwd|ls|cat|head|tail|wc|rg|grep|find|stat|du|df|date|whoami|uname|which|type|printenv|env|echo)\b/.test(command)) {
    return 'read'
  }
  if (/^git\s+(status|diff|log|show|branch|rev-parse|ls-files|grep|remote\s+-v)\b/.test(command)) return 'read'

  return 'file'
}

function maxRisk(a: CommandRisk, b: CommandRisk): CommandRisk {
  const rank: Record<CommandRisk, number> = { read: 0, file: 1, outreach: 2, destructive: 3 }
  return rank[b] > rank[a] ? b : a
}

export function classifyCommandRisk(command: string): CommandRisk {
  if (isDangerousCommand(command)) return 'destructive'
  const initialRisk: CommandRisk = hasShellExpansionRisk(command) || hasShellParserRisk(command) ? 'outreach' : 'read'
  return splitSegments(command).reduce<CommandRisk>((risk, segment) => maxRisk(risk, classifySegment(segment)), initialRisk)
}
