import { statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { stripSafeShellWrappers } from '../permissions/permissionRules'

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
const HEREDOC_IN_SUBSTITUTION_RE = /\$\(.*<</s
type SafeHeredocRange = { start: number; end: number }

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

type FlagArgKind = 'none' | 'number' | 'string' | 'char' | '{}' | 'EOF'
type ReadOnlyCommandConfig = {
  safeFlags: Record<string, FlagArgKind>
  respectsDoubleDash?: boolean
}

const READ_ONLY_COMMANDS: Record<string, ReadOnlyCommandConfig> = {
  file: {
    safeFlags: {
      '--brief': 'none',
      '-b': 'none',
      '--mime': 'none',
      '-i': 'none',
      '--mime-type': 'none',
      '--mime-encoding': 'none',
      '--apple': 'none',
      '--check-encoding': 'none',
      '-c': 'none',
      '--exclude': 'string',
      '--exclude-quiet': 'string',
      '--print0': 'none',
      '-0': 'none',
      '-f': 'string',
      '-F': 'string',
      '--separator': 'string',
      '--help': 'none',
      '--version': 'none',
      '-v': 'none',
      '--no-dereference': 'none',
      '-h': 'none',
      '--dereference': 'none',
      '-L': 'none',
      '--magic-file': 'string',
      '-m': 'string',
      '--keep-going': 'none',
      '-k': 'none',
      '--list': 'none',
      '-l': 'none',
      '--no-buffer': 'none',
      '-n': 'none',
      '--preserve-date': 'none',
      '-p': 'none',
      '--raw': 'none',
      '-r': 'none',
      '-s': 'none',
      '--special-files': 'none',
      '--uncompress': 'none',
      '-z': 'none',
    },
  },
  sort: {
    safeFlags: {
      '--ignore-leading-blanks': 'none',
      '-b': 'none',
      '--dictionary-order': 'none',
      '-d': 'none',
      '--ignore-case': 'none',
      '-f': 'none',
      '--general-numeric-sort': 'none',
      '-g': 'none',
      '--human-numeric-sort': 'none',
      '-h': 'none',
      '--ignore-nonprinting': 'none',
      '-i': 'none',
      '--month-sort': 'none',
      '-M': 'none',
      '--numeric-sort': 'none',
      '-n': 'none',
      '--random-sort': 'none',
      '-R': 'none',
      '--reverse': 'none',
      '-r': 'none',
      '--sort': 'string',
      '--stable': 'none',
      '-s': 'none',
      '--unique': 'none',
      '-u': 'none',
      '--version-sort': 'none',
      '-V': 'none',
      '--zero-terminated': 'none',
      '-z': 'none',
      '--key': 'string',
      '-k': 'string',
      '--field-separator': 'string',
      '-t': 'string',
      '--check': 'none',
      '-c': 'none',
      '--check-char-order': 'none',
      '-C': 'none',
      '--merge': 'none',
      '-m': 'none',
      '--buffer-size': 'string',
      '-S': 'string',
      '--parallel': 'number',
      '--batch-size': 'number',
      '--help': 'none',
      '--version': 'none',
    },
  },
  base64: {
    respectsDoubleDash: false,
    safeFlags: {
      '-d': 'none',
      '-D': 'none',
      '--decode': 'none',
      '-b': 'number',
      '--break': 'number',
      '-w': 'number',
      '--wrap': 'number',
      '-i': 'string',
      '--input': 'string',
      '--ignore-garbage': 'none',
      '-h': 'none',
      '--help': 'none',
      '--version': 'none',
    },
  },
  ps: {
    safeFlags: {
      '-e': 'none',
      '-A': 'none',
      '-a': 'none',
      '-d': 'none',
      '-N': 'none',
      '--deselect': 'none',
      '-f': 'none',
      '-F': 'none',
      '-l': 'none',
      '-j': 'none',
      '-y': 'none',
      '-w': 'none',
      '-c': 'none',
      '-H': 'none',
      '--forest': 'none',
      '--headers': 'none',
      '--no-headers': 'none',
      '-n': 'string',
      '--sort': 'string',
      '-L': 'none',
      '-T': 'none',
      '-m': 'none',
      '-C': 'string',
      '-G': 'string',
      '-g': 'string',
      '-p': 'string',
      '--pid': 'string',
      '-q': 'string',
      '--quick-pid': 'string',
      '-s': 'string',
      '--sid': 'string',
      '-t': 'string',
      '--tty': 'string',
      '-U': 'string',
      '-u': 'string',
      '--user': 'string',
      '--width': 'number',
      '--help': 'none',
      '--info': 'none',
      '-V': 'none',
      '--version': 'none',
    },
  },
}

export function hasShellExpansionRisk(command: string): boolean {
  const exposed = shellTextOutsideSingleQuotes(stripSafeHeredocSubstitutions(command) ?? command)
  return SHELL_EXPANSION_PATTERNS.some(re => re.test(exposed))
}

export function hasShellParserRisk(command: string): boolean {
  const commandForParser = stripSafeHeredocSubstitutions(command) ?? command
  const quoteViews = extractShellQuoteViews(commandForParser)
  const exposed = shellTextOutsideSingleQuotes(commandForParser)
  return CONTROL_CHAR_RE.test(command) ||
    hasIncompleteShellFragmentRisk(commandForParser) ||
    hasShellQuoteSingleQuoteBug(commandForParser) ||
    hasCarriageReturnOutsideDoubleQuotes(commandForParser) ||
    hasSuspiciousNewline(quoteViews.fullyUnquoted) ||
    hasQuotedNewlineHash(commandForParser) ||
    /\$IFS|\$\{[^}]*IFS/.test(commandForParser) ||
    /\/proc\/.*\/environ/.test(commandForParser) ||
    hasUnescapedChar(exposed, '`') ||
    hasDangerousVariableUse(quoteViews.fullyUnquoted) ||
    hasInputRedirectionRisk(commandForParser) ||
    hasGitCommitMessageRisk(commandForParser) ||
    (hasQuotedShellMetacharacterRisk(commandForParser) && classifySedCommand(commandForParser) !== 'read') ||
    hasObfuscatedFlagRisk(commandForParser) ||
    (hasMalformedTokenInjectionRisk(commandForParser) && classifySedCommand(commandForParser) !== 'read') ||
    hasBackslashEscapedWhitespace(commandForParser) ||
    hasBackslashEscapedOperator(commandForParser) ||
    UNICODE_WS_RE.test(commandForParser) ||
    hasMidWordHash(quoteViews.unquotedKeepQuoteChars) ||
    hasCommentQuoteDesyncRisk(commandForParser) ||
    hasBraceExpansionRisk(quoteViews.fullyUnquoted, commandForParser) ||
    hasZshDangerousCommand(commandForParser)
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

function hasIncompleteShellFragmentRisk(command: string): boolean {
  const trimmed = command.trim()
  if (/^\s*\t/.test(command)) return true
  if (trimmed.startsWith('-')) return true
  return /^\s*(?:&&|\|\||;|>>?|<)/.test(command)
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

function stripSafeHeredocSubstitutions(command: string): string | null {
  if (!HEREDOC_IN_SUBSTITUTION_RE.test(command)) return null
  const ranges = findSafeHeredocSubstitutionRanges(command)
  if (ranges === null || ranges.length === 0) return null

  let result = command
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, range.start) + result.slice(range.end)
  }
  return result
}

function findSafeHeredocSubstitutionRanges(command: string): SafeHeredocRange[] | null {
  const heredocPattern = /\$\(cat[ \t]*<<(-?)[ \t]*(?:'+([A-Za-z_]\w*)'+|\\([A-Za-z_]\w*))/g
  const ranges: SafeHeredocRange[] = []
  let match: RegExpExecArray | null

  while ((match = heredocPattern.exec(command)) !== null) {
    if (match.index > 0 && command[match.index - 1] === '\\') continue
    const delimiter = match[2] || match[3]
    if (!delimiter) continue
    const range = findSafeHeredocSubstitutionRange(command, {
      start: match.index,
      operatorEnd: match.index + match[0].length,
      delimiter,
      isDash: match[1] === '-',
    })
    if (!range) return null
    ranges.push(range)
  }

  if (ranges.length === 0) return null
  for (const outer of ranges) {
    for (const inner of ranges) {
      if (inner === outer) continue
      if (inner.start > outer.start && inner.start < outer.end) return null
    }
  }

  const remaining = stripRanges(command, ranges)
  if (!safeHeredocRemainingIsAllowed(command, remaining, ranges)) return null
  return ranges
}

function findSafeHeredocSubstitutionRange(
  command: string,
  match: { start: number; operatorEnd: number; delimiter: string; isDash: boolean },
): SafeHeredocRange | null {
  const afterOperator = command.slice(match.operatorEnd)
  const openLineEnd = afterOperator.indexOf('\n')
  if (openLineEnd === -1) return null
  if (!/^[ \t]*$/.test(afterOperator.slice(0, openLineEnd))) return null

  const bodyStart = match.operatorEnd + openLineEnd + 1
  const bodyLines = command.slice(bodyStart).split('\n')
  let closeParenLineIdx = -1
  let closeParenColIdx = -1

  for (let i = 0; i < bodyLines.length; i++) {
    const rawLine = bodyLines[i]!
    const line = match.isDash ? rawLine.replace(/^\t*/, '') : rawLine

    if (line === match.delimiter) {
      const nextLine = bodyLines[i + 1]
      if (nextLine === undefined) return null
      const parenMatch = nextLine.match(/^([ \t]*)\)/)
      if (!parenMatch) return null
      closeParenLineIdx = i + 1
      closeParenColIdx = parenMatch[1]!.length
      break
    }

    if (line.startsWith(match.delimiter)) {
      const afterDelimiter = line.slice(match.delimiter.length)
      const parenMatch = afterDelimiter.match(/^([ \t]*)\)/)
      if (parenMatch) {
        const tabPrefix = match.isDash ? (rawLine.match(/^\t*/)?.[0] ?? '') : ''
        closeParenLineIdx = i
        closeParenColIdx = tabPrefix.length + match.delimiter.length + parenMatch[1]!.length
        break
      }
      if (/^[)}`|&;(<>]/.test(afterDelimiter)) return null
    }
  }

  if (closeParenLineIdx === -1) return null
  let end = bodyStart
  for (let i = 0; i < closeParenLineIdx; i++) end += bodyLines[i]!.length + 1
  end += closeParenColIdx + 1
  return { start: match.start, end }
}

function stripRanges(command: string, ranges: SafeHeredocRange[]): string {
  let result = command
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, range.start) + result.slice(range.end)
  }
  return result
}

function safeHeredocRemainingIsAllowed(command: string, remaining: string, ranges: SafeHeredocRange[]): boolean {
  const firstStart = Math.min(...ranges.map(range => range.start))
  if (command.slice(0, firstStart).trim().length === 0) return false
  return /^[a-zA-Z0-9 \t"'.\-/_@=,:+~]*$/.test(remaining)
}

function hasInputRedirectionRisk(command: string): boolean {
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
    if (inSingleQuote || inDoubleQuote || char !== '<') continue
    const next = command[i + 1]
    if (next === '(') continue
    return true
  }
  return false
}

function hasGitCommitMessageRisk(command: string): boolean {
  return splitSegments(command).some(segment => {
    const tokens = tokenizeShellWordsWithQuote(stripSafeShellWrappers(segment))
    if (tokens[0]?.word.toLowerCase() !== 'git') return false
    if (tokens[1]?.word.toLowerCase() !== 'commit') return false

    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i]!
      if (token.word === '--') break
      if (token.word === '-m' || token.word === '--message') {
        if (gitCommitMessageTokenNeedsApproval(tokens[i + 1])) return true
        i++
        continue
      }
      if (token.word.startsWith('--message=')) {
        if (gitCommitMessageTokenNeedsApproval({ ...token, word: token.word.slice('--message='.length) })) return true
      }
    }
    return false
  })
}

function gitCommitMessageTokenNeedsApproval(token: ShellToken | undefined): boolean {
  if (!token?.word) return false
  if (token.word.startsWith('-')) return true
  return token.quote === '"' && /\$\(|`|\$\{/.test(token.word)
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
  const segments = splitPotentiallyMalformedSegments(command)
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

function hasCommentQuoteDesyncRisk(command: string): boolean {
  let inSingleQuote = false
  let inDoubleQuote = false
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inSingleQuote) {
      if (char === "'") inSingleQuote = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (inDoubleQuote) {
      if (char === '"') inDoubleQuote = false
      continue
    }
    if (char === "'") {
      inSingleQuote = true
      continue
    }
    if (char === '"') {
      inDoubleQuote = true
      continue
    }
    if (char === '#') {
      const lineEnd = command.indexOf('\n', i)
      const commentText = command.slice(i + 1, lineEnd === -1 ? command.length : lineEnd)
      if (/['"]/.test(commentText)) return true
      if (lineEnd === -1) break
      i = lineEnd
    }
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
  if (hasRuntimeEnvSplitStringRisk(command)) return true
  const tokens = tokenizeShellWords(stripRuntimeEnvWrapper(command).toLowerCase())
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

function hasRuntimeEnvSplitStringRisk(command: string): boolean {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'env') return false
  return tokens.some(token => token === '-S' || token === '--split-string' || token.startsWith('--split-string='))
}

function stripRuntimeEnvWrapper(command: string): string {
  let tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'env') return command

  tokens = tokens.slice(1)
  while (tokens.length > 0) {
    const token = tokens[0]!
    if (token === '--') {
      tokens = tokens.slice(1)
      break
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
      tokens = tokens.slice(1)
      continue
    }
    if (token === '-' || token === '-i' || token === '--ignore-environment' || token === '-0' || token === '--null') {
      tokens = tokens.slice(1)
      continue
    }
    if (token === '-u' || token === '--unset' || token === '-C' || token === '--chdir' || token === '-S' || token === '--split-string') {
      tokens = tokens.slice(2)
      continue
    }
    if (token.startsWith('-u') && token.length > 2) {
      tokens = tokens.slice(1)
      continue
    }
    if (token.startsWith('--unset=') || token.startsWith('--chdir=') || token.startsWith('--split-string=')) {
      tokens = tokens.slice(1)
      continue
    }
    break
  }

  return tokens.join(' ')
}

function normalize(command: string): string {
  return command.trim().replace(/\s+/g, ' ')
}

function splitSegments(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (quote) {
      current += char
      if (escaped) escaped = false
      else if (char === '\\' && quote === '"') escaped = true
      else if (char === quote) quote = null
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
    if (char === '"' || char === "'") {
      current += char
      quote = char
      continue
    }
    if ((char === '&' && command[i + 1] === '&') || (char === '|' && command[i + 1] === '|')) {
      if (current.trim()) segments.push(normalize(current))
      current = ''
      i++
      continue
    }
    if (char === ';' || char === '|') {
      if (current.trim()) segments.push(normalize(current))
      current = ''
      continue
    }
    current += char
  }

  if (current.trim()) segments.push(normalize(current))
  return segments
}

function splitPotentiallyMalformedSegments(command: string): string[] {
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

type ShellToken = { word: string; quote: '"' | "'" | 'mixed' | null }

function tokenizeShellWordsWithQuote(command: string): ShellToken[] {
  const tokens: ShellToken[] = []
  let i = 0
  while (i < command.length) {
    while (/\s/.test(command[i] ?? '')) i++
    if (i >= command.length) break

    const parsed = readShellToken(command, i)
    if (!parsed.word) {
      i++
      continue
    }
    tokens.push({ word: parsed.word, quote: parsed.quote })
    i = parsed.end
  }
  return tokens
}

function readShellToken(command: string, start: number): { word: string; quote: ShellToken['quote']; end: number } {
  let word = ''
  let quote: '"' | "'" | null = null
  let tokenQuote: ShellToken['quote'] = null
  let escaped = false
  let i = start

  const noteQuote = (nextQuote: '"' | "'") => {
    if (tokenQuote === null) tokenQuote = nextQuote
    else if (tokenQuote !== nextQuote) tokenQuote = 'mixed'
  }
  const noteUnquoted = () => {
    if (tokenQuote !== null) tokenQuote = 'mixed'
  }

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
      noteUnquoted()
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      noteUnquoted()
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      noteQuote(char)
      continue
    }
    if (/\s/.test(char) || /[;&|<>]/.test(char)) break
    word += char
    noteUnquoted()
  }

  return { word, quote: tokenQuote, end: i }
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
  if (/\benv\b|\$ENV\b/.test(command)) return 'outreach'
  if (tokens.some(token => {
    const longFlag = token.toLowerCase()
    return token === '-f' ||
      longFlag === '--from-file' ||
      longFlag.startsWith('--from-file=') ||
      longFlag === '--rawfile' ||
      longFlag.startsWith('--rawfile=') ||
      longFlag === '--slurpfile' ||
      longFlag.startsWith('--slurpfile=') ||
      longFlag === '--run-tests' ||
      longFlag.startsWith('--run-tests=') ||
      token === '-L' ||
      longFlag === '--library-path' ||
      longFlag.startsWith('--library-path=')
  })) return 'outreach'
  return 'read'
}

function classifyDateCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'date') return null

  const safeFlagsWithArgs = new Set(['-d', '--date', '-r', '--reference', '--iso-8601', '--rfc-3339'])
  const safeFlagsWithoutArgs = new Set([
    '-u',
    '--utc',
    '--universal',
    '-I',
    '-R',
    '--rfc-email',
    '--debug',
    '--help',
    '--version',
  ])

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (!token) continue
    if (token === '--') continue

    if (token.startsWith('--')) {
      const [flag, inlineValue] = splitLongFlag(token)
      if (safeFlagsWithoutArgs.has(flag)) {
        if (inlineValue !== undefined) return 'outreach'
        continue
      }
      if (safeFlagsWithArgs.has(flag)) {
        if (inlineValue !== undefined) {
          if (!inlineValue) return 'outreach'
          continue
        }
        i++
        if (i >= tokens.length || !tokens[i]) return 'outreach'
        continue
      }
      return 'outreach'
    }

    if (token.startsWith('-') && token !== '-') {
      const parsed = validateDateShortFlag(token, tokens, i, safeFlagsWithArgs, safeFlagsWithoutArgs)
      if (!parsed.ok) return 'outreach'
      i = parsed.index
      continue
    }

    if (!token.startsWith('+')) return 'outreach'
  }

  return 'read'
}

function validateDateShortFlag(
  token: string,
  args: string[],
  index: number,
  safeFlagsWithArgs: Set<string>,
  safeFlagsWithoutArgs: Set<string>,
): { ok: boolean; index: number } {
  for (let pos = 1; pos < token.length; pos++) {
    const flag = `-${token[pos]}`
    if (safeFlagsWithoutArgs.has(flag)) continue
    if (!safeFlagsWithArgs.has(flag)) return { ok: false, index }

    const attached = token.slice(pos + 1)
    if (attached) return { ok: true, index }
    const nextIndex = index + 1
    return { ok: nextIndex < args.length && !!args[nextIndex], index: nextIndex }
  }
  return { ok: true, index }
}

function classifyNodeCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'node') return null
  const args = tokens.slice(1).map(token => token.toLowerCase())
  if (args.some(token => token === '--run' || token.startsWith('--run='))) return 'outreach'
  if (args.length === 1 && (args[0] === '-v' || args[0] === '--version')) return 'read'
  return 'file'
}

function classifyHostnameCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'hostname') return null
  const safeFlags = new Set([
    '-f',
    '--fqdn',
    '--long',
    '-s',
    '--short',
    '-i',
    '--ip-address',
    '-I',
    '--all-ip-addresses',
    '-a',
    '--alias',
    '-d',
    '--domain',
    '-A',
    '--all-fqdns',
    '-v',
    '--verbose',
    '-h',
    '--help',
    '-V',
    '--version',
  ])

  for (const token of tokens.slice(1)) {
    if (!safeFlags.has(token)) return 'outreach'
  }
  return 'read'
}

function classifyInfoCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'info') return null

  const safeFlags: Record<string, FlagArgKind> = {
    '-f': 'string',
    '--file': 'string',
    '-d': 'string',
    '--directory': 'string',
    '-n': 'string',
    '--node': 'string',
    '-a': 'none',
    '--all': 'none',
    '-k': 'string',
    '--apropos': 'string',
    '-w': 'none',
    '--where': 'none',
    '--location': 'none',
    '--show-options': 'none',
    '--vi-keys': 'none',
    '--subnodes': 'none',
    '-h': 'none',
    '--help': 'none',
    '--usage': 'none',
    '--version': 'none',
  }

  return validateSafeFlags(tokens.slice(1), { safeFlags }) ? 'read' : 'outreach'
}

function classifyLsofCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'lsof') return null
  const args = tokens.slice(1)
  if (args.some(token => token === '+m' || token.startsWith('+m'))) return 'outreach'

  const safeFlags: Record<string, FlagArgKind> = {
    '-?': 'none',
    '-h': 'none',
    '-v': 'none',
    '-a': 'none',
    '-b': 'none',
    '-C': 'none',
    '-l': 'none',
    '-n': 'none',
    '-N': 'none',
    '-O': 'none',
    '-P': 'none',
    '-Q': 'none',
    '-R': 'none',
    '-t': 'none',
    '-U': 'none',
    '-V': 'none',
    '-X': 'none',
    '-H': 'none',
    '-E': 'none',
    '-F': 'none',
    '-g': 'none',
    '-i': 'none',
    '-K': 'none',
    '-L': 'none',
    '-o': 'none',
    '-r': 'none',
    '-s': 'none',
    '-S': 'none',
    '-T': 'none',
    '-x': 'none',
    '-A': 'string',
    '-c': 'string',
    '-d': 'string',
    '-e': 'string',
    '-k': 'string',
    '-p': 'string',
    '-u': 'string',
  }

  return validateSafeFlags(args, { safeFlags }) ? 'read' : 'outreach'
}

function classifyPgrepCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'pgrep') return null
  const safeFlags: Record<string, FlagArgKind> = {
    '-d': 'string',
    '--delimiter': 'string',
    '-l': 'none',
    '--list-name': 'none',
    '-a': 'none',
    '--list-full': 'none',
    '-v': 'none',
    '--inverse': 'none',
    '-w': 'none',
    '--lightweight': 'none',
    '-c': 'none',
    '--count': 'none',
    '-f': 'none',
    '--full': 'none',
    '-g': 'string',
    '--pgroup': 'string',
    '-G': 'string',
    '--group': 'string',
    '-i': 'none',
    '--ignore-case': 'none',
    '-n': 'none',
    '--newest': 'none',
    '-o': 'none',
    '--oldest': 'none',
    '-O': 'string',
    '--older': 'string',
    '-P': 'string',
    '--parent': 'string',
    '-s': 'string',
    '--session': 'string',
    '-t': 'string',
    '--terminal': 'string',
    '-u': 'string',
    '--euid': 'string',
    '-U': 'string',
    '--uid': 'string',
    '-x': 'none',
    '--exact': 'none',
    '-F': 'string',
    '--pidfile': 'string',
    '-L': 'none',
    '--logpidfile': 'none',
    '-r': 'string',
    '--runstates': 'string',
    '--ns': 'string',
    '--nslist': 'string',
    '--help': 'none',
    '-V': 'none',
    '--version': 'none',
  }
  return validateSafeFlags(tokens.slice(1), { safeFlags }) ? 'read' : 'outreach'
}

function classifyTreeCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'tree') return null
  const safeFlags: Record<string, FlagArgKind> = {
    '-a': 'none',
    '-d': 'none',
    '-l': 'none',
    '-f': 'none',
    '-x': 'none',
    '-L': 'number',
    '-P': 'string',
    '-I': 'string',
    '--gitignore': 'none',
    '--gitfile': 'string',
    '--ignore-case': 'none',
    '--matchdirs': 'none',
    '--metafirst': 'none',
    '--prune': 'none',
    '--info': 'none',
    '--infofile': 'string',
    '--noreport': 'none',
    '--charset': 'string',
    '--filelimit': 'number',
    '-q': 'none',
    '-N': 'none',
    '-Q': 'none',
    '-p': 'none',
    '-u': 'none',
    '-g': 'none',
    '-s': 'none',
    '-h': 'none',
    '--si': 'none',
    '--du': 'none',
    '-D': 'none',
    '--timefmt': 'string',
    '-F': 'none',
    '--inodes': 'none',
    '--device': 'none',
    '-v': 'none',
    '-t': 'none',
    '-c': 'none',
    '-U': 'none',
    '-r': 'none',
    '--dirsfirst': 'none',
    '--filesfirst': 'none',
    '--sort': 'string',
    '-i': 'none',
    '-A': 'none',
    '-S': 'none',
    '-n': 'none',
    '-C': 'none',
    '-X': 'none',
    '-J': 'none',
    '-H': 'string',
    '--nolinks': 'none',
    '--hintro': 'string',
    '--houtro': 'string',
    '-T': 'string',
    '--hyperlink': 'none',
    '--scheme': 'string',
    '--authority': 'string',
    '--fromfile': 'none',
    '--fromtabfile': 'none',
    '--fflinks': 'none',
    '--help': 'none',
    '--version': 'none',
  }
  return validateSafeFlags(tokens.slice(1), { safeFlags }) ? 'read' : 'outreach'
}

function classifyNamedReadOnlyCommand(
  command: string,
  name: string,
  safeFlags: Record<string, FlagArgKind>,
): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== name) return null
  return validateSafeFlags(tokens.slice(1), { safeFlags }) ? 'read' : 'outreach'
}

function classifyManCommand(command: string): CommandRisk | null {
  return classifyNamedReadOnlyCommand(command, 'man', {
    '-a': 'none',
    '--all': 'none',
    '-d': 'none',
    '-f': 'none',
    '--whatis': 'none',
    '-h': 'none',
    '-k': 'none',
    '--apropos': 'none',
    '-l': 'string',
    '-w': 'none',
    '-S': 'string',
    '-s': 'string',
  })
}

function classifyHelpCommand(command: string): CommandRisk | null {
  return classifyNamedReadOnlyCommand(command, 'help', {
    '-d': 'none',
    '-m': 'none',
    '-s': 'none',
  })
}

function classifyNetstatCommand(command: string): CommandRisk | null {
  return classifyNamedReadOnlyCommand(command, 'netstat', {
    '-a': 'none',
    '-L': 'none',
    '-l': 'none',
    '-n': 'none',
    '-f': 'string',
    '-g': 'none',
    '-i': 'none',
    '-I': 'string',
    '-s': 'none',
    '-r': 'none',
    '-m': 'none',
    '-v': 'none',
  })
}

function classifyChecksumCommand(command: string): CommandRisk | null {
  const safeFlags: Record<string, FlagArgKind> = {
    '-b': 'none',
    '--binary': 'none',
    '-t': 'none',
    '--text': 'none',
    '-c': 'none',
    '--check': 'none',
    '--ignore-missing': 'none',
    '--quiet': 'none',
    '--status': 'none',
    '--strict': 'none',
    '-w': 'none',
    '--warn': 'none',
    '--tag': 'none',
    '-z': 'none',
    '--zero': 'none',
    '--help': 'none',
    '--version': 'none',
  }
  for (const name of ['sha256sum', 'sha1sum', 'md5sum']) {
    const risk = classifyNamedReadOnlyCommand(command, name, safeFlags)
    if (risk) return risk
  }
  return null
}

function classifySsCommand(command: string): CommandRisk | null {
  return classifyNamedReadOnlyCommand(command, 'ss', {
    '-h': 'none',
    '--help': 'none',
    '-V': 'none',
    '--version': 'none',
    '-n': 'none',
    '--numeric': 'none',
    '-r': 'none',
    '--resolve': 'none',
    '-a': 'none',
    '--all': 'none',
    '-l': 'none',
    '--listening': 'none',
    '-o': 'none',
    '--options': 'none',
    '-e': 'none',
    '--extended': 'none',
    '-m': 'none',
    '--memory': 'none',
    '-p': 'none',
    '--processes': 'none',
    '-i': 'none',
    '--info': 'none',
    '-s': 'none',
    '--summary': 'none',
    '-4': 'none',
    '--ipv4': 'none',
    '-6': 'none',
    '--ipv6': 'none',
    '-0': 'none',
    '--packet': 'none',
    '-t': 'none',
    '--tcp': 'none',
    '-M': 'none',
    '--mptcp': 'none',
    '-S': 'none',
    '--sctp': 'none',
    '-u': 'none',
    '--udp': 'none',
    '-d': 'none',
    '--dccp': 'none',
    '-w': 'none',
    '--raw': 'none',
    '-x': 'none',
    '--unix': 'none',
    '--tipc': 'none',
    '--vsock': 'none',
    '-f': 'string',
    '--family': 'string',
    '-A': 'string',
    '--query': 'string',
    '--socket': 'string',
    '-Z': 'none',
    '--context': 'none',
    '-z': 'none',
    '--contexts': 'none',
    '-b': 'none',
    '--bpf': 'none',
    '-E': 'none',
    '--events': 'none',
    '-H': 'none',
    '--no-header': 'none',
    '-O': 'none',
    '--oneline': 'none',
    '--tipcinfo': 'none',
    '--tos': 'none',
    '--cgroup': 'none',
    '--inet-sockopt': 'none',
  })
}

function classifyTputCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'tput') return null
  const safeFlags: Record<string, FlagArgKind> = {
    '-T': 'string',
    '-V': 'none',
    '-x': 'none',
  }
  if (!validateSafeFlags(tokens.slice(1), { safeFlags })) return 'outreach'

  const dangerousCapabilities = new Set([
    'init',
    'reset',
    'rs1',
    'rs2',
    'rs3',
    'is1',
    'is2',
    'is3',
    'iprog',
    'if',
    'rf',
    'clear',
    'flash',
    'mc0',
    'mc4',
    'mc5',
    'mc5i',
    'mc5p',
    'pfkey',
    'pfloc',
    'pfx',
    'pfxl',
    'smcup',
    'rmcup',
  ])
  let skipNext = false
  let afterDoubleDash = false
  for (const token of tokens.slice(1)) {
    if (skipNext) {
      skipNext = false
      continue
    }
    if (!afterDoubleDash && token === '--') {
      afterDoubleDash = true
      continue
    }
    if (!afterDoubleDash && token.startsWith('-')) {
      if (token === '-S' || (!token.startsWith('--') && token.length > 2 && token.includes('S'))) return 'outreach'
      if (token === '-T') skipNext = true
      continue
    }
    if (dangerousCapabilities.has(token)) return 'outreach'
  }
  return 'read'
}

function classifyFdCommand(command: string): CommandRisk | null {
  const safeFlags: Record<string, FlagArgKind> = {
    '-h': 'none',
    '--help': 'none',
    '-V': 'none',
    '--version': 'none',
    '-H': 'none',
    '--hidden': 'none',
    '-I': 'none',
    '--no-ignore': 'none',
    '--no-ignore-vcs': 'none',
    '--no-ignore-parent': 'none',
    '-s': 'none',
    '--case-sensitive': 'none',
    '-i': 'none',
    '--ignore-case': 'none',
    '-g': 'none',
    '--glob': 'none',
    '--regex': 'none',
    '-F': 'none',
    '--fixed-strings': 'none',
    '-a': 'none',
    '--absolute-path': 'none',
    '-L': 'none',
    '--follow': 'none',
    '-p': 'none',
    '--full-path': 'none',
    '-0': 'none',
    '--print0': 'none',
    '-d': 'number',
    '--max-depth': 'number',
    '--min-depth': 'number',
    '--exact-depth': 'number',
    '-t': 'string',
    '--type': 'string',
    '-e': 'string',
    '--extension': 'string',
    '-S': 'string',
    '--size': 'string',
    '--changed-within': 'string',
    '--changed-before': 'string',
    '-o': 'string',
    '--owner': 'string',
    '-E': 'string',
    '--exclude': 'string',
    '--ignore-file': 'string',
    '-c': 'string',
    '--color': 'string',
    '-j': 'number',
    '--threads': 'number',
    '--max-buffer-time': 'string',
    '--max-results': 'number',
    '-1': 'none',
    '-q': 'none',
    '--quiet': 'none',
    '--show-errors': 'none',
    '--strip-cwd-prefix': 'none',
    '--one-file-system': 'none',
    '--prune': 'none',
    '--search-path': 'string',
    '--base-directory': 'string',
    '--path-separator': 'string',
    '--batch-size': 'number',
    '--no-require-git': 'none',
    '--hyperlink': 'string',
    '--and': 'string',
    '--format': 'string',
  }
  for (const name of ['fd', 'fdfind']) {
    const risk = classifyNamedReadOnlyCommand(command, name, safeFlags)
    if (risk) return risk
  }
  return null
}

function classifyProcessActionCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  const base = tokens[0]?.toLowerCase()
  if (!base) return null
  return base === 'kill' || base === 'pkill' || base === 'killall' ? 'destructive' : null
}

function classifySedCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  if (tokens[0]?.toLowerCase() !== 'sed') return null
  if (tokens.some(token => token === '-i' || token.startsWith('-i') || token === '--in-place' || token.startsWith('--in-place='))) {
    return 'file'
  }
  return sedCommandIsReadOnly(tokens) ? 'read' : 'file'
}

function classifyReadOnlyAllowlistedCommand(command: string): CommandRisk | null {
  const tokens = tokenizeShellWords(command)
  const base = tokens[0]?.toLowerCase()
  if (!base) return null
  if (base === 'sed') return classifySedCommand(command)
  if (base === 'ps' && tokens.slice(1).some(token => !token.startsWith('-') && /^[a-zA-Z]*e[a-zA-Z]*$/.test(token))) {
    return 'outreach'
  }

  const config = READ_ONLY_COMMANDS[base]
  if (!config) return null
  return validateSafeFlags(tokens.slice(1), config) ? 'read' : 'file'
}

function validateSafeFlags(args: string[], config: ReadOnlyCommandConfig): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg || arg === '-' || !arg.startsWith('-')) continue
    if (arg === '--' && config.respectsDoubleDash !== false) break

    if (arg.startsWith('--')) {
      const [flag, inlineValue] = splitLongFlag(arg)
      const kind = config.safeFlags[flag]
      if (!kind) return false
      if (kind === 'none') {
        if (inlineValue !== undefined) return false
        continue
      }
      if (inlineValue !== undefined) {
        if (!flagArgMatches(kind, inlineValue)) return false
        continue
      }
      i++
      if (i >= args.length || !flagArgMatches(kind, args[i]!)) return false
      continue
    }

    const parsedShort = validateShortFlags(arg, args, i, config)
    if (!parsedShort.ok) return false
    i = parsedShort.index
  }
  return true
}

function splitLongFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=')
  if (eq === -1) return [arg, undefined]
  return [arg.slice(0, eq), arg.slice(eq + 1)]
}

function validateShortFlags(
  token: string,
  args: string[],
  index: number,
  config: ReadOnlyCommandConfig,
): { ok: boolean; index: number } {
  if (!token.startsWith('-') || token.startsWith('--') || token.length < 2) return { ok: false, index }
  for (let pos = 1; pos < token.length; pos++) {
    const flag = `-${token[pos]}`
    const kind = config.safeFlags[flag]
    if (!kind) return { ok: false, index }
    if (kind === 'none') continue

    const attached = token.slice(pos + 1)
    if (attached) return { ok: flagArgMatches(kind, attached), index }
    const nextIndex = index + 1
    return {
      ok: nextIndex < args.length && flagArgMatches(kind, args[nextIndex]!),
      index: nextIndex,
    }
  }
  return { ok: true, index }
}

function flagArgMatches(kind: FlagArgKind, value: string): boolean {
  if (!value) return false
  if (kind === 'string') return true
  if (kind === 'number') return /^\d+$/.test(value)
  if (kind === 'char') return value.length === 1
  if (kind === '{}') return value === '{}'
  if (kind === 'EOF') return value === 'EOF'
  return kind === 'none'
}

function sedCommandIsReadOnly(tokens: string[]): boolean {
  const expressions: string[] = []
  const files: string[] = []
  let hasQuiet = false
  let sawExpressionFlag = false

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token === '--') {
      files.push(...tokens.slice(i + 1))
      break
    }
    if (token === '-n' || token === '--quiet' || token === '--silent') {
      hasQuiet = true
      continue
    }
    if (token === '-E' || token === '-r' || token === '--regexp-extended' || token === '--posix' || token === '-z' || token === '--zero-terminated') {
      continue
    }
    if (/^-[Ernz]+$/.test(token)) {
      if (token.includes('n')) hasQuiet = true
      continue
    }
    if (token === '-e' || token === '--expression') {
      sawExpressionFlag = true
      i++
      if (i >= tokens.length) return false
      expressions.push(tokens[i]!)
      continue
    }
    if (token.startsWith('-e') && token.length > 2) {
      sawExpressionFlag = true
      expressions.push(token.slice(2))
      continue
    }
    if (token.startsWith('--expression=')) {
      sawExpressionFlag = true
      expressions.push(token.slice('--expression='.length))
      continue
    }
    if (token.startsWith('-')) return false

    if (!sawExpressionFlag && expressions.length === 0) {
      expressions.push(token)
    } else {
      files.push(token)
    }
  }

  if (expressions.length === 0) return false
  if (hasQuiet && expressions.every(expr => sedExpressionIsPrintOnly(expr))) return true
  if (files.length === 0 && expressions.length === 1 && sedExpressionIsStdoutSubstitution(expressions[0]!)) return true
  return false
}

function sedExpressionIsPrintOnly(expression: string): boolean {
  return expression.split(';').every(part => /^(?:\d+|\d+,\d+)?p$/.test(part.trim()))
}

function sedExpressionIsStdoutSubstitution(expression: string): boolean {
  const expr = expression.trim()
  if (!expr.startsWith('s/')) return false
  let slashCount = 0
  let lastSlash = -1
  for (let i = 2; i < expr.length; i++) {
    if (expr[i] === '\\') {
      i++
      continue
    }
    if (expr[i] === '/') {
      slashCount++
      lastSlash = i
    }
  }
  if (slashCount !== 2 || lastSlash < 0) return false
  return /^[gpimIM]*[1-9]?[gpimIM]*$/.test(expr.slice(lastSlash + 1))
}

export function shellOutputRedirectionNeedsApproval(command: string, opts: { root: string; cwd?: string }): boolean {
  const targets = extractOutputRedirectionTargets(command)
  if (targets.length === 0) return false
  if (splitSegments(command).some(segment => /^cd(?:\s|$)/.test(normalize(segment).toLowerCase()))) return true
  return targets.some(target => redirectionTargetNeedsApproval(target, opts))
}

export function shellCdGitNeedsApproval(command: string): boolean {
  const segments = splitSegments(command)
  return segments.some(segment => isCdLikeCommand(segment)) && segments.some(segment => isGitLikeCommand(segment))
}

export function shellGitInternalWriteNeedsApproval(command: string): boolean {
  const segments = splitSegments(command)
  if (!segments.some(segment => isGitLikeCommand(segment))) return false
  return segments.some(segment => segmentWritesGitInternalPath(segment))
}

export function shellBareGitRepoCwdNeedsApproval(command: string, cwd: string): boolean {
  return splitSegments(command).some(segment => isGitLikeCommand(segment)) && cwdLooksLikeBareGitRepo(cwd)
}

export function shellSandboxedGitCwdNeedsApproval(command: string, opts: { root: string; cwd: string; sandboxActive: boolean }): boolean {
  if (!opts.sandboxActive) return false
  if (resolve(opts.cwd) === resolve(opts.root)) return false
  return splitSegments(command).some(segment => isGitLikeCommand(segment))
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

function isCdLikeCommand(segment: string): boolean {
  const tokens = tokenizeShellWords(stripSafeShellWrappers(segment).toLowerCase())
  const first = tokens[0]
  return first === 'cd' || first === 'pushd' || first === 'popd'
}

function isGitLikeCommand(segment: string): boolean {
  const tokens = tokenizeShellWords(stripSafeShellWrappers(segment).toLowerCase())
  if (tokens[0] === 'git') return true
  return tokens[0] === 'xargs' && tokens.includes('git')
}

function segmentWritesGitInternalPath(segment: string): boolean {
  const stripped = stripSafeShellWrappers(segment)
  for (const target of extractOutputRedirectionTargets(stripped)) {
    if (isGitInternalPath(target)) return true
  }

  const tokens = tokenizeShellWords(stripped)
  const command = tokens[0]?.toLowerCase()
  if (!command || !['mkdir', 'touch', 'cp', 'mv'].includes(command)) return false
  return tokens.slice(1).filter(token => token !== '--' && !token.startsWith('-')).some(isGitInternalPath)
}

function isGitInternalPath(target: string): boolean {
  const normalized = target.replace(/^\.?\//, '')
  return normalized === 'HEAD' ||
    normalized === 'objects' ||
    normalized.startsWith('objects/') ||
    normalized === 'refs' ||
    normalized.startsWith('refs/') ||
    normalized === 'hooks' ||
    normalized.startsWith('hooks/')
}

function cwdLooksLikeBareGitRepo(cwd: string): boolean {
  try {
    const dotGit = statSync(join(cwd, '.git'))
    if (dotGit.isFile()) return false
    if (dotGit.isDirectory()) {
      try {
        if (statSync(join(cwd, '.git', 'HEAD')).isFile()) return false
      } catch {
        // fall through to bare repo indicators
      }
    }
  } catch {
    // no .git reference, check cwd indicators below
  }

  try {
    if (statSync(join(cwd, 'HEAD')).isFile()) return true
  } catch {
    // no HEAD
  }
  try {
    if (statSync(join(cwd, 'objects')).isDirectory()) return true
  } catch {
    // no objects
  }
  try {
    if (statSync(join(cwd, 'refs')).isDirectory()) return true
  } catch {
    // no refs
  }
  return false
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
  const rawCommand = normalize(stripRuntimeEnvWrapper(segment))
  const command = rawCommand.toLowerCase()
  if (!command) return 'read'
  if (isDangerousCommand(command)) return 'destructive'
  if (hasRuntimeEnvSplitStringRisk(segment)) return 'outreach'
  const segmentBaseRisk: CommandRisk = hasWriteRedirection(command) ? 'file' : 'read'
  const withSegmentBaseRisk = (risk: CommandRisk): CommandRisk => maxRisk(segmentBaseRisk, risk)

  if (/\bgit\s+clean\s+-/.test(command)) return withSegmentBaseRisk('destructive')
  if (/\brm\s+.*-[a-z]*r/.test(command)) return withSegmentBaseRisk('destructive')
  const processActionRisk = classifyProcessActionCommand(rawCommand)
  if (processActionRisk) return withSegmentBaseRisk(processActionRisk)
  if (/^git\s+push\b.*\s--(?:force|force-with-lease|mirror)\b/.test(command)) return withSegmentBaseRisk('destructive')
  if (/^git\s+push\b.*\s-f(?:\s|$)/.test(command)) return withSegmentBaseRisk('destructive')
  if (/^git\s+reset\b.*\s--hard\b/.test(command)) return withSegmentBaseRisk('destructive')
  if (/^git\s+branch\s+-D\b/.test(command)) return withSegmentBaseRisk('destructive')

  if (/^(curl|wget|ssh|scp|sftp|ftp|telnet|nc|netcat|rsync)\b/.test(command)) return withSegmentBaseRisk('outreach')
  if (/^(gh|glab)\s+(api|auth|repo|pr|issue|release)\b/.test(command)) return withSegmentBaseRisk('outreach')
  if (/^(npm|pnpm|yarn|bun)\s+(install|add|upgrade|update|publish)\b/.test(command)) return withSegmentBaseRisk('outreach')
  if (/^(pip|pip3|uv|poetry)\s+(install|add|publish|update)\b/.test(command)) return withSegmentBaseRisk('outreach')
  if (/^(brew|apt|apt-get|dnf|yum|pacman|choco|winget)\s+(install|upgrade|update|remove)\b/.test(command)) return withSegmentBaseRisk('outreach')

  const findRisk = classifyFindCommand(rawCommand)
  if (findRisk) return withSegmentBaseRisk(findRisk)

  const jqRisk = classifyJqCommand(rawCommand)
  if (jqRisk) return withSegmentBaseRisk(jqRisk)

  const dateRisk = classifyDateCommand(rawCommand)
  if (dateRisk) return withSegmentBaseRisk(dateRisk)

  const nodeRisk = classifyNodeCommand(rawCommand)
  if (nodeRisk) return withSegmentBaseRisk(nodeRisk)

  const hostnameRisk = classifyHostnameCommand(rawCommand)
  if (hostnameRisk) return withSegmentBaseRisk(hostnameRisk)

  const infoRisk = classifyInfoCommand(rawCommand)
  if (infoRisk) return withSegmentBaseRisk(infoRisk)

  const lsofRisk = classifyLsofCommand(rawCommand)
  if (lsofRisk) return withSegmentBaseRisk(lsofRisk)

  const pgrepRisk = classifyPgrepCommand(rawCommand)
  if (pgrepRisk) return withSegmentBaseRisk(pgrepRisk)

  const treeRisk = classifyTreeCommand(rawCommand)
  if (treeRisk) return withSegmentBaseRisk(treeRisk)

  const manRisk = classifyManCommand(rawCommand)
  if (manRisk) return withSegmentBaseRisk(manRisk)

  const helpRisk = classifyHelpCommand(rawCommand)
  if (helpRisk) return withSegmentBaseRisk(helpRisk)

  const netstatRisk = classifyNetstatCommand(rawCommand)
  if (netstatRisk) return withSegmentBaseRisk(netstatRisk)

  const checksumRisk = classifyChecksumCommand(rawCommand)
  if (checksumRisk) return withSegmentBaseRisk(checksumRisk)

  const ssRisk = classifySsCommand(rawCommand)
  if (ssRisk) return withSegmentBaseRisk(ssRisk)

  const tputRisk = classifyTputCommand(rawCommand)
  if (tputRisk) return withSegmentBaseRisk(tputRisk)

  const fdRisk = classifyFdCommand(rawCommand)
  if (fdRisk) return withSegmentBaseRisk(fdRisk)

  const readOnlyAllowlistRisk = classifyReadOnlyAllowlistedCommand(rawCommand)
  if (readOnlyAllowlistRisk) return withSegmentBaseRisk(readOnlyAllowlistRisk)

  if (/^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee)\b/.test(command)) return withSegmentBaseRisk('file')
  if (/\b(sed|perl)\s+.*\s-i\b/.test(command) || /\b(sed|perl)\s+-i\b/.test(command)) return withSegmentBaseRisk('file')
  if (/^git\s+(checkout|switch|restore|reset|merge|rebase|commit|tag|branch\s+(-d|-D)|apply|am|stash|pull|push)\b/.test(command)) return withSegmentBaseRisk('file')
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile|generate|lint\s+--fix|format|test)\b/.test(command)) return withSegmentBaseRisk('file')

  if (/^(pwd|ls|cat|head|tail|wc|rg|grep|find|stat|du|df|whoami|uname|which|type|printenv|env|echo)\b/.test(command)) {
    return withSegmentBaseRisk('read')
  }
  if (/^git\s+(status|diff|log|show|branch|rev-parse|ls-files|grep|remote\s+-v)\b/.test(command)) return withSegmentBaseRisk('read')

  return withSegmentBaseRisk('file')
}

function maxRisk(a: CommandRisk, b: CommandRisk): CommandRisk {
  const rank: Record<CommandRisk, number> = { read: 0, file: 1, outreach: 2, destructive: 3 }
  return rank[b] > rank[a] ? b : a
}

export function classifyCommandRisk(command: string): CommandRisk {
  if (isDangerousCommand(command)) return 'destructive'
  const commandForClassification = stripSafeHeredocSubstitutions(command) ?? command
  const initialRisk: CommandRisk = hasShellExpansionRisk(command) || hasShellParserRisk(command) || shellCdGitNeedsApproval(commandForClassification) || shellGitInternalWriteNeedsApproval(commandForClassification) ? 'outreach' : 'read'
  return splitSegments(commandForClassification).reduce<CommandRisk>((risk, segment) => maxRisk(risk, classifySegment(segment)), initialRisk)
}
