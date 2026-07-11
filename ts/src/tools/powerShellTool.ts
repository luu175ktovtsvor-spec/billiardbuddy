import { spawn } from 'node:child_process'
import { access, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import type { ApprovalClass } from '../permissions/types'
import type { Tool, ToolContext } from './Tool'
import { StreamingOutputSanitizer } from './outputSanitize'

const POWERSHELL_TOOL_NAME = 'PowerShell'
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_BYTES = 64_000
const MAX_OUTPUT_BYTES = 1_000_000

export interface PowerShellToolInput {
  command: string
  cwd?: string
  timeout_ms?: number
  max_output_bytes?: number
  description?: string
}

export type PowerShellRisk = 'read' | 'file' | 'outreach' | 'destructive'

const COMMON_ALIASES: Record<string, string> = {
  cat: 'get-content',
  cd: 'set-location',
  chdir: 'set-location',
  copy: 'copy-item',
  cp: 'copy-item',
  cpi: 'copy-item',
  del: 'remove-item',
  dir: 'get-childitem',
  erase: 'remove-item',
  gci: 'get-childitem',
  gc: 'get-content',
  gi: 'get-item',
  gl: 'get-location',
  gp: 'get-itemproperty',
  iwr: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  ls: 'get-childitem',
  md: 'new-item',
  mi: 'move-item',
  mkdir: 'new-item',
  move: 'move-item',
  mv: 'move-item',
  ni: 'new-item',
  pwd: 'get-location',
  rd: 'remove-item',
  ren: 'rename-item',
  ri: 'remove-item',
  rm: 'remove-item',
  rmdir: 'remove-item',
  sc: 'set-content',
  sl: 'set-location',
  sls: 'select-string',
  wget: 'invoke-webrequest',
}

const READONLY_CMDLETS = new Set([
  'compare-object',
  'convertfrom-json',
  'convertto-csv',
  'convertto-json',
  'format-hex',
  'format-list',
  'format-table',
  'format-wide',
  'get-acl',
  'get-childitem',
  'get-command',
  'get-content',
  'get-filehash',
  'get-help',
  'get-item',
  'get-itemproperty',
  'get-location',
  'get-process',
  'get-service',
  'measure-object',
  'out-string',
  'resolve-path',
  'select-object',
  'select-string',
  'sort-object',
  'test-path',
  'where-object',
  'write-host',
  'write-output',
])

const WRITE_CMDLETS = new Set([
  'add-content',
  'clear-content',
  'copy-item',
  'export-clixml',
  'export-csv',
  'expand-archive',
  'move-item',
  'new-item',
  'out-file',
  'remove-item',
  'rename-item',
  'set-acl',
  'set-content',
  'set-item',
  'set-itemproperty',
  'start-process',
  'tee-object',
])

const OUTREACH_CMDLETS = new Set([
  'invoke-restmethod',
  'invoke-webrequest',
  'send-mailmessage',
  'start-bitstransfer',
])

const EXTERNAL_READONLY: Record<string, Set<string> | 'all'> = {
  git: new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'grep', 'remote']),
  gh: new Set(['pr', 'issue', 'repo', 'run', 'workflow', 'release', 'api']),
  glab: new Set(['mr', 'issue', 'repo', 'ci', 'release', 'api']),
  rg: 'all',
  grep: 'all',
  findstr: 'all',
  where: 'all',
  'where.exe': 'all',
  node: new Set(['--version', '-v']),
  npm: new Set(['--version', '-v', 'view', 'ls', 'list']),
  pnpm: new Set(['--version', '-v', 'view', 'ls', 'list']),
  yarn: new Set(['--version', '-v', 'info', 'list']),
  bun: new Set(['--version', '-v']),
  python: new Set(['--version', '-V']),
  python3: new Set(['--version', '-V']),
}

const OUTREACH_EXTERNAL = new Set([
  'certutil',
  'certutil.exe',
  'choco',
  'curl',
  'curl.exe',
  'ftp',
  'gh',
  'glab',
  'iwr',
  'nc',
  'netcat',
  'npm',
  'pnpm',
  'scp',
  'sftp',
  'ssh',
  'telnet',
  'wget',
  'winget',
  'yarn',
])

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  {
    pattern: /(?:^|[|;&\n({])\s*(remove-item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-recurse\b[^|;&\n}]*-force\b/i,
    warning: 'may recursively force-remove files',
  },
  {
    pattern: /(?:^|[|;&\n({])\s*(remove-item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-force\b[^|;&\n}]*-recurse\b/i,
    warning: 'may recursively force-remove files',
  },
  {
    pattern: /(?:^|[|;&\n({])\s*(remove-item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*-recurse\b/i,
    warning: 'may recursively remove files',
  },
  { pattern: /\bclear-content\b[^|;&\n]*\*/i, warning: 'may clear content of multiple files' },
  { pattern: /\bformat-volume\b/i, warning: 'may format a disk volume' },
  { pattern: /\bclear-disk\b/i, warning: 'may clear a disk' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, warning: 'may discard uncommitted changes' },
  { pattern: /\bgit\s+push\b[^|;&\n]*\s+(--force|--force-with-lease|-f)\b/i, warning: 'may overwrite remote history' },
  { pattern: /\bgit\s+clean\b(?![^|;&\n]*(?:-[a-zA-Z]*n|--dry-run))[^|;&\n]*-[a-zA-Z]*f/i, warning: 'may permanently delete untracked files' },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/i, warning: 'may permanently remove stashed changes' },
  { pattern: /\b(drop|truncate)\s+(table|database|schema)\b/i, warning: 'may drop or truncate database objects' },
  { pattern: /\bstop-computer\b/i, warning: 'will shut down the computer' },
  { pattern: /\brestart-computer\b/i, warning: 'will restart the computer' },
  { pattern: /\bclear-recyclebin\b/i, warning: 'permanently deletes recycled files' },
]

const SECURITY_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /\b(invoke-expression|iex)\b/i, warning: 'uses Invoke-Expression' },
  { pattern: /\b(pwsh|pwsh\.exe|powershell|powershell\.exe)\b[^|;&\n]*(?:-e|-ec|-enc|-encodedcommand)\b/i, warning: 'uses encoded PowerShell parameters' },
  { pattern: /\b(pwsh|pwsh\.exe|powershell|powershell\.exe)\b/i, warning: 'spawns a nested PowerShell process' },
  { pattern: /\b(invoke-webrequest|iwr|invoke-restmethod|irm|new-object)\b[^|;&\n]*\|\s*(invoke-expression|iex)\b/i, warning: 'downloads and executes remote code' },
  { pattern: /\bstart-bitstransfer\b/i, warning: 'downloads files via BITS transfer' },
  { pattern: /\bcertutil(?:\.exe)?\b[^|;&\n]*(?:-|\/)urlcache\b/i, warning: 'uses certutil to download from a URL' },
  { pattern: /\bbitsadmin(?:\.exe)?\b[^|;&\n]*\/transfer\b/i, warning: 'downloads files via BITS transfer' },
  { pattern: /\badd-type\b/i, warning: 'compiles and loads .NET code' },
  { pattern: /\bnew-object\b[^|;&\n]*-comobject\b/i, warning: 'instantiates a COM object' },
  { pattern: /\bstart-process\b[^|;&\n]*(?:-|\/)v(?:erb)?\s*:?\s*['"]?runas\b/i, warning: 'requests elevated privileges' },
  { pattern: /\bforeach-object\b[^|;&\n]*(?:-|\/)m(?:embername)?\b/i, warning: 'invokes methods by string name' },
  { pattern: /\bimport-module\b|\busing\s+(module|assembly)\b|#requires\b/i, warning: 'loads external PowerShell code' },
]

const FATAL_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\b(clear-disk|format-volume|stop-computer|restart-computer)\b/i, reason: 'PowerShell command targets disk formatting or machine power state' },
  { pattern: /(?:^|[|;&\n({])\s*(remove-item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*(?:^|\s)([a-z]:[\\/]?|\/|~|\$home)(?:\s|$)/i, reason: 'PowerShell command attempts to remove a filesystem root or home directory' },
  { pattern: /(?:^|[|;&\n({])\s*(remove-item|rm|del|rd|rmdir|ri)\b[^|;&\n}]*(?:^|\s)(\*|\/\*)(?:\s|$)/i, reason: 'PowerShell command attempts broad wildcard removal' },
]

export const powerShellTool: Tool<PowerShellToolInput> = {
  name: POWERSHELL_TOOL_NAME,
  description:
    'Run a PowerShell command with the workspace as the default working directory. Ported from CC-Haha PowerShellTool: use for Windows/PowerShell-specific terminal work, with PowerShell-aware read-only classification, security warnings, and destructive-command approval.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The PowerShell command to execute.' },
      cwd: { type: 'string', description: 'Optional workspace-relative working directory. Defaults to workspace root.' },
      timeout_ms: { type: 'number', description: `Optional timeout in ms, capped at ${MAX_TIMEOUT_MS}.` },
      max_output_bytes: { type: 'number', description: `Optional combined stdout/stderr tail cap, capped at ${MAX_OUTPUT_BYTES}.` },
      description: { type: 'string', description: 'Clear, concise description of what this command does.' },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isReadOnlyFor(input) {
    return typeof input?.command === 'string' && classifyPowerShellRisk(input.command) === 'read'
  },
  requiresApprovalFor(input) {
    return typeof input?.command !== 'string' || classifyPowerShellRisk(input.command) !== 'read'
  },
  approvalClassFor(input) {
    const risk = typeof input?.command === 'string' ? classifyPowerShellRisk(input.command) : 'destructive'
    return powerShellApprovalClass(risk)
  },
  forceConfirmFor(input) {
    if (typeof input?.command !== 'string') return true
    // 灾难级命令(clear-disk/format-volume/remove-item 打盘符根)交 dangerous 档处理——对齐 cc:完全访问档放行,
    // 不在此 forceConfirm(否则 bypass 免疫会拦住,与「灾难命令完全访问档放行」的口径冲突)。
    if (fatalPowerShellReason(input.command)) return false
    const risk = classifyPowerShellRisk(input.command)
    return risk === 'destructive' || powerShellSecurityWarnings(input.command).length > 0
  },
  fatalReasonFor(input) {
    if (typeof input?.command !== 'string') return 'PowerShell command is missing'
    return null
  },
  // 危险 PowerShell 命令(clear-disk/format-volume/remove-item 打盘符根等)走 dangerous 档
  //(对齐 cc:default 弹卡问、完全访问档放行),不再无条件硬拒。
  dangerousReasonFor(input) {
    if (typeof input?.command !== 'string') return null
    return fatalPowerShellReason(input.command)
  },
  approvalReasonFor(input) {
    const command = typeof input?.command === 'string' ? input.command : ''
    const risk = classifyPowerShellRisk(command)
    const warnings = [...powerShellDestructiveWarnings(command), ...powerShellSecurityWarnings(command)]
    return {
      what: `执行 PowerShell:${command}`,
      why: powerShellRiskReason(risk, warnings),
      impact: powerShellRiskImpact(risk),
    }
  },
  async previewFor(input, ctx) {
    if (!input || typeof input.command !== 'string') return 'PowerShell 缺少 command'
    const risk = classifyPowerShellRisk(input.command)
    const warnings = [...powerShellDestructiveWarnings(input.command), ...powerShellSecurityWarnings(input.command)]
    let cwdLabel = '.'
    try {
      cwdLabel = relativePath(ctx, await resolvePowerShellCwd(input.cwd, ctx))
    } catch (err) {
      cwdLabel = `invalid:${err instanceof Error ? err.message : String(err)}`
    }
    return [
      '<powershell_preview>',
      `command: ${input.command}`,
      `cwd: ${cwdLabel}`,
      `risk: ${risk}`,
      warnings.length ? `warnings: ${warnings.join('; ')}` : 'warnings: none',
      `timeout_ms: ${clampNumber(input.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)}`,
      `max_output_bytes: ${clampNumber(input.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)}`,
      '</powershell_preview>',
    ].join('\n')
  },
  async execute(input, ctx) {
    if (!input || typeof input.command !== 'string') throw new Error('PowerShell 需要 string 参数 command')
    // 危险 PowerShell 命令不再执行层硬拒(对齐 cc):放行与否已由权限闸按档位决定,走到 execute 说明已过闸。
    const blockedSleep = detectBlockedPowerShellSleep(input.command)
    if (blockedSleep) throw new Error(`Blocked PowerShell sleep: ${blockedSleep}. Use a background task or a short polling command instead.`)
    return await runPowerShellInWorkspace(input, ctx)
  },
}

export function classifyPowerShellRisk(command: string): PowerShellRisk {
  const fatal = fatalPowerShellReason(command)
  if (fatal) return 'destructive'
  if (powerShellDestructiveWarnings(command).length > 0 || powerShellSecurityWarnings(command).length > 0) return 'destructive'
  return splitPowerShellStatements(command).reduce<PowerShellRisk>((risk, segment) => maxRisk(risk, classifyPowerShellSegment(segment)), 'read')
}

export function powerShellDestructiveWarnings(command: string): string[] {
  return uniqueWarnings(DESTRUCTIVE_PATTERNS.filter(item => item.pattern.test(command)).map(item => item.warning))
}

export function powerShellSecurityWarnings(command: string): string[] {
  return uniqueWarnings(SECURITY_PATTERNS.filter(item => item.pattern.test(command)).map(item => item.warning))
}

export function fatalPowerShellReason(command: string): string | null {
  for (const item of FATAL_PATTERNS) {
    if (item.pattern.test(command)) return item.reason
  }
  return null
}

export function detectBlockedPowerShellSleep(command: string): string | null {
  const first = command.trim().split(/[;|&\r\n]/)[0]?.trim() ?? ''
  const match = /^(?:start-sleep|sleep)(?:\s+-s(?:econds)?)?\s+(\d+)\s*$/i.exec(first)
  if (!match) return null
  const seconds = Number.parseInt(match[1]!, 10)
  if (seconds < 2) return null
  const rest = command.trim().slice(first.length).replace(/^[\s;|&]+/, '')
  return rest ? `Start-Sleep ${seconds} followed by: ${rest}` : `standalone Start-Sleep ${seconds}`
}

export async function findPowerShellExecutable(): Promise<string | null> {
  const candidates = process.platform === 'win32'
    ? ['pwsh.exe', 'pwsh', 'powershell.exe', 'powershell']
    : ['pwsh', 'powershell']
  for (const candidate of candidates) {
    const found = await findExecutableOnPath(candidate)
    if (found) return found
  }
  return null
}

function classifyPowerShellSegment(segment: string): PowerShellRisk {
  const tokens = tokenizePowerShell(segment)
  if (tokens.length === 0) return 'read'
  const canonical = canonicalCommandName(tokens[0]!)
  const args = tokens.slice(1)

  if (isGitDestructive(canonical, args)) return 'destructive'
  if (canonical === 'git') return isGitReadOnly(args) ? 'read' : 'file'
  if (OUTREACH_CMDLETS.has(canonical)) return 'outreach'
  if (WRITE_CMDLETS.has(canonical)) return canonical === 'start-process' ? 'destructive' : 'file'
  if (READONLY_CMDLETS.has(canonical)) return segmentHasWriteRedirection(segment) ? 'file' : 'read'
  if (isExternalOutreach(canonical, args)) return 'outreach'
  if (isExternalReadOnly(canonical, args)) return segmentHasWriteRedirection(segment) ? 'file' : 'read'
  if (segmentHasWriteRedirection(segment)) return 'file'
  return 'file'
}

function canonicalCommandName(raw: string): string {
  const stripped = stripQuotes(raw.trim().replace(/^[&.]\s*/, '')).split(/[\\/]/).pop() ?? raw
  const lower = stripped.toLowerCase()
  return COMMON_ALIASES[lower] ?? lower
}

function splitPowerShellStatements(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!
    const prev = command[i - 1]
    if ((ch === '"' || ch === "'") && prev !== '`') {
      quote = quote === ch ? null : quote ?? ch
      current += ch
      continue
    }
    if (!quote && (ch === ';' || ch === '|' || ch === '\n' || ch === '\r')) {
      if (current.trim()) parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function tokenizePowerShell(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!
    const prev = segment[i - 1]
    if ((ch === '"' || ch === "'") && prev !== '`') {
      quote = quote === ch ? null : quote ?? ch
      current += ch
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        tokens.push(stripQuotes(current))
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(stripQuotes(current))
  return tokens
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '')
}

function segmentHasWriteRedirection(segment: string): boolean {
  return /(^|[^<])>>?[^&]/.test(segment) || /\b\d>>?/.test(segment)
}

function isGitDestructive(command: string, args: string[]): boolean {
  if (command !== 'git') return false
  const joined = args.join(' ').toLowerCase()
  return /^reset\b.*\s--hard\b/.test(joined) ||
    /^push\b.*\s(--force|--force-with-lease|-f)(\s|$)/.test(joined) ||
    /^clean\b(?!.*(?:-[a-z]*n|--dry-run)).*-[a-z]*f/.test(joined) ||
    /^stash\s+(drop|clear)\b/.test(joined) ||
    /^branch\s+-D\b/.test(joined)
}

function isGitReadOnly(args: string[]): boolean {
  const sub = (args[0] ?? '').toLowerCase()
  return ['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'grep', 'remote'].includes(sub)
}

function isExternalOutreach(command: string, args: string[]): boolean {
  if (!OUTREACH_EXTERNAL.has(command)) return false
  if (['npm', 'pnpm', 'yarn'].includes(command)) {
    const sub = args[0]?.toLowerCase()
    return ['install', 'add', 'upgrade', 'update', 'publish'].includes(sub ?? '')
  }
  if (['gh', 'glab'].includes(command)) {
    const joined = args.join(' ').toLowerCase()
    return /\b(api|auth|repo|pr|issue|release)\b/.test(joined)
  }
  return true
}

function isExternalReadOnly(command: string, args: string[]): boolean {
  const config = EXTERNAL_READONLY[command]
  if (!config) return false
  if (config === 'all') return true
  const first = args[0] ?? ''
  return config.has(first)
}

function maxRisk(a: PowerShellRisk, b: PowerShellRisk): PowerShellRisk {
  const rank: Record<PowerShellRisk, number> = { read: 0, file: 1, outreach: 2, destructive: 3 }
  return rank[b] > rank[a] ? b : a
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings)]
}

function powerShellApprovalClass(risk: PowerShellRisk): ApprovalClass | undefined {
  if (risk === 'read') return undefined
  if (risk === 'file') return 'file'
  if (risk === 'outreach') return 'outreach'
  return 'destructive'
}

function powerShellRiskReason(risk: PowerShellRisk, warnings: string[]): string {
  if (warnings.length > 0) return `该命令触发 PowerShell 专用风险提示:${warnings.join('; ')}。`
  if (risk === 'read') return '这是 PowerShell 只读查询命令。'
  if (risk === 'file') return '该 PowerShell 命令可能修改工作区文件或生成产物。'
  if (risk === 'outreach') return '该 PowerShell 命令可能访问网络、下载内容或触达外部服务。'
  return '该 PowerShell 命令可能造成不可逆改动。'
}

function powerShellRiskImpact(risk: PowerShellRisk): string {
  if (risk === 'read') return '只读取本机状态或文件内容。'
  if (risk === 'file') return '可能写入、移动、删除或格式化工作区内文件。'
  if (risk === 'outreach') return '可能产生网络访问、副作用或外部账号操作。'
  return '需要用户确认后才应执行;灾难级命令会被直接拒绝。'
}

async function runPowerShellInWorkspace(input: PowerShellToolInput, ctx: ToolContext): Promise<string> {
  const executable = await findPowerShellExecutable()
  if (!executable) {
    return [
      `PowerShell executable not found for command: ${input.command}`,
      'Install PowerShell 7 (`pwsh`) or run this tool on Windows with Windows PowerShell available.',
    ].join('\n')
  }
  const cwd = await resolvePowerShellCwd(input.cwd, ctx)
  const timeoutMs = clampNumber(input.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxOutputBytes = clampNumber(input.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', input.command]
  const child = spawn(executable, args, { cwd, env: childEnv(), detached: process.platform !== 'win32' })

  return new Promise<string>(resolvePromise => {
    const startedAt = Date.now()
    const output = new StreamTailBuffer(maxOutputBytes)
    const liveProgress: LiveProgressState = { emittedBytes: 0, truncated: false }
    const sanitizers: Record<'stdout' | 'stderr', StreamingOutputSanitizer> = {
      stdout: new StreamingOutputSanitizer(),
      stderr: new StreamingOutputSanitizer(),
    }
    let timedOut = false
    let aborted = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
    }, timeoutMs)
    const onSignal = () => {
      aborted = true
      killChildTree(child)
    }
    ctx.signal?.addEventListener('abort', onSignal, { once: true })
    child.stdout?.on('data', d => appendOutputChunk(ctx, output, liveProgress, sanitizers.stdout, 'stdout', d, maxOutputBytes))
    child.stderr?.on('data', d => appendOutputChunk(ctx, output, liveProgress, sanitizers.stderr, 'stderr', d, maxOutputBytes))
    const finish = (result: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onSignal)
      resolvePromise(result)
    }
    child.on('error', err => {
      finish(`PowerShell 启动失败:${err.message}`)
    })
    child.on('close', (code, signal) => {
      flushOutputChunk(ctx, output, liveProgress, sanitizers.stdout, 'stdout', maxOutputBytes)
      flushOutputChunk(ctx, output, liveProgress, sanitizers.stderr, 'stderr', maxOutputBytes)
      const elapsedMs = Date.now() - startedAt
      const exitCode = code ?? (timedOut || aborted || signal ? -1 : 0)
      finish(formatPowerShellResult({
        command: input.command,
        executable,
        exitCode,
        elapsedMs,
        timeoutMs,
        timedOut,
        aborted,
        signal,
        stdout: output.toString('stdout').trim(),
        stderr: output.toString('stderr').trim(),
        capturedBytes: output.bytes,
        maxOutputBytes,
        truncatedBytes: output.truncatedBytes,
      }))
    })
  })
}

async function resolvePowerShellCwd(cwd: unknown, ctx: ToolContext): Promise<string> {
  if (cwd == null || cwd === '') return ctx.workspace.root
  if (typeof cwd !== 'string') throw new Error('PowerShell.cwd must be a string')
  const abs = ctx.workspace.resolve(cwd, 'read')
  const info = await stat(abs).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`PowerShell.cwd is not a directory:${cwd}`)
  return abs
}

function relativePath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.workspace.root, abs)
  if (!rel) return '.'
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel
}

async function findExecutableOnPath(command: string): Promise<string | null> {
  const hasDir = command.includes('/') || command.includes('\\')
  const pathExts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
    : ['']
  const dirs = hasDir ? [''] : (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of pathExts) {
      const candidate = hasDir ? command : join(dir, command.endsWith(ext.toLowerCase()) || command.endsWith(ext) ? command : `${command}${ext}`)
      try {
        await access(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // Try next PATH entry.
      }
    }
  }
  return null
}

function appendOutputChunk(
  ctx: ToolContext,
  output: StreamTailBuffer,
  liveProgress: LiveProgressState,
  sanitizer: StreamingOutputSanitizer,
  stream: 'stdout' | 'stderr',
  chunk: Buffer,
  maxOutputBytes: number,
): void {
  const sanitized = sanitizer.push(chunk)
  if (!sanitized) return
  output.append(stream, sanitized)
  emitLiveProgress(ctx, stream, sanitized, maxOutputBytes, liveProgress)
}

function flushOutputChunk(
  ctx: ToolContext,
  output: StreamTailBuffer,
  liveProgress: LiveProgressState,
  sanitizer: StreamingOutputSanitizer,
  stream: 'stdout' | 'stderr',
  maxOutputBytes: number,
): void {
  const sanitized = sanitizer.flush()
  if (!sanitized) return
  output.append(stream, sanitized)
  emitLiveProgress(ctx, stream, sanitized, maxOutputBytes, liveProgress)
}

function emitLiveProgress(ctx: ToolContext, stream: string, chunk: Buffer | string, maxBytes: number, state: LiveProgressState): void {
  const emit = ctx.progressEmit
  if (!emit) return
  const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
  if (!buf.length) return
  const remaining = Math.max(0, maxBytes - state.emittedBytes)
  if (remaining <= 0) {
    emitLiveTruncationNotice(emit, state)
    return
  }
  const send = buf.length <= remaining ? buf : buf.subarray(0, remaining)
  state.emittedBytes += send.length
  try {
    emit({ type: 'tool_progress', tool: POWERSHELL_TOOL_NAME, stream, chunk: send.toString('utf8') })
  } catch {
    // UI progress cannot affect command execution.
  }
  if (buf.length > remaining) emitLiveTruncationNotice(emit, state)
}

function emitLiveTruncationNotice(emit: NonNullable<ToolContext['progressEmit']>, state: LiveProgressState): void {
  if (state.truncated) return
  state.truncated = true
  try {
    emit({
      type: 'tool_progress',
      tool: POWERSHELL_TOOL_NAME,
      stream: 'stderr',
      chunk: '\n[PowerShell live output truncated; final result keeps the tail]\n',
    })
  } catch {
    // ignore
  }
}

function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...sanitizedProcessEnv(), ...extra }
}

function sanitizedProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isSecretEnvName(key)) continue
    env[key] = value
  }
  return env
}

function isSecretEnvName(key: string): boolean {
  return /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|COOKIE|SESSION)$/i.test(key) ||
    /^(OPENAI|ANTHROPIC|ARK|QF_GATEWAY|VIDEO|IMAGE)_/i.test(key)
}

function killChildTree(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // Fall back to killing only the direct child.
    }
  }
  child.kill('SIGKILL')
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

function formatPowerShellResult(input: {
  command: string
  executable: string
  exitCode: number
  elapsedMs: number
  timeoutMs: number
  timedOut: boolean
  aborted: boolean
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  capturedBytes: number
  maxOutputBytes: number
  truncatedBytes: number
}): string {
  const lines = [
    `PowerShell:${input.executable}`,
    `命令:${input.command}`,
    `返回码:${input.exitCode}`,
    `耗时:${input.elapsedMs}ms`,
    `超时:${input.timedOut ? 'true' : 'false'}${input.timedOut ? ` (limit ${input.timeoutMs}ms)` : ''}`,
    `中止:${input.aborted ? 'true' : 'false'}`,
    `信号:${input.signal ?? ''}`,
    input.truncatedBytes > 0
      ? `输出截断:true (kept tail ${input.capturedBytes}/${input.maxOutputBytes} bytes, omitted ${input.truncatedBytes} bytes)`
      : '输出截断:false',
    ...(input.exitCode !== 0 ? [`[退出码 ${input.exitCode}]`] : []),
    '【标准输出】',
    input.stdout,
  ]
  if (input.stderr) lines.push('【错误输出】', input.stderr)
  return lines.join('\n').trimEnd()
}

interface LiveProgressState {
  emittedBytes: number
  truncated: boolean
}

class StreamTailBuffer {
  private readonly chunks: Array<{ stream: 'stdout' | 'stderr'; chunk: Buffer }> = []
  bytes = 0
  truncatedBytes = 0

  constructor(private readonly maxBytes: number) {}

  append(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if (!buf.length || this.maxBytes <= 0) return
    if (buf.length >= this.maxBytes) {
      this.truncatedBytes += this.bytes + buf.length - this.maxBytes
      this.chunks.length = 0
      this.chunks.push({ stream, chunk: buf.subarray(buf.length - this.maxBytes) })
      this.bytes = this.maxBytes
      return
    }
    this.chunks.push({ stream, chunk: buf })
    this.bytes += buf.length
    this.trim()
  }

  toString(stream: 'stdout' | 'stderr'): string {
    return Buffer.concat(this.chunks.filter(entry => entry.stream === stream).map(entry => entry.chunk)).toString('utf8')
  }

  private trim(): void {
    let overflow = this.bytes - this.maxBytes
    while (overflow > 0 && this.chunks.length) {
      const first = this.chunks[0]!
      if (first.chunk.length <= overflow) {
        this.chunks.shift()
        this.bytes -= first.chunk.length
        this.truncatedBytes += first.chunk.length
        overflow -= first.chunk.length
        continue
      }
      this.chunks[0] = { stream: first.stream, chunk: first.chunk.subarray(overflow) }
      this.bytes -= overflow
      this.truncatedBytes += overflow
      overflow = 0
    }
  }
}
