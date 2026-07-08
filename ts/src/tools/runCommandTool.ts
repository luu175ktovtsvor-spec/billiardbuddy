import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { Tool, ToolContext } from './Tool'
import type { WrappedCommand } from '../sandbox/sandbox'
import { classifyCommandRisk, isDangerousCommand, shellOutputRedirectionNeedsApproval, type CommandRisk } from './dangerousCommand'
import type { ApprovalClass } from '../permissions/types'
import { StreamingOutputSanitizer } from './outputSanitize'
import { interpretCommandResult } from './commandSemantics'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_MAX_OUTPUT_BYTES = 64_000
const MAX_OUTPUT_BYTES = 1_000_000

export interface RunCommandInput {
  command: string
  cwd?: string
  timeout_ms?: number
  max_output_bytes?: number
}

export const runCommandTool: Tool<RunCommandInput> = {
  name: 'run_command',
  description:
    `Run a shell command with the workspace as the default working directory. Input: { command, cwd?, timeout_ms?, max_output_bytes? }. cwd must stay inside the workspace. Default timeout ${DEFAULT_TIMEOUT_MS}ms; output keeps the tail so final test/build errors remain visible.`,
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      cwd: { type: 'string', description: 'Optional workspace-relative working directory for the command. Defaults to workspace root.' },
      timeout_ms: { type: 'number', description: `Optional timeout in ms, capped at ${MAX_TIMEOUT_MS}.` },
      max_output_bytes: { type: 'number', description: `Optional combined stdout/stderr tail cap, capped at ${MAX_OUTPUT_BYTES}.` },
    },
    required: ['command'],
  },
  isReadOnly: false,
  isReadOnlyFor(input, ctx) {
    return typeof input?.command === 'string' && effectiveCommandRisk(input, ctx) === 'read'
  },
  requiresApprovalFor(input, ctx) {
    return typeof input?.command !== 'string' || effectiveCommandRisk(input, ctx) !== 'read'
  },
  approvalClassFor(input, ctx) {
    return commandApprovalClass(typeof input?.command === 'string' ? effectiveCommandRisk(input, ctx) : 'destructive')
  },
  fatalReasonFor(input) {
    if (typeof input?.command !== 'string') return 'run_command 缺少 command'
    return isDangerousCommand(input.command) ? `危险命令:${input.command}` : null
  },
  approvalReasonFor(input, ctx) {
    const command = typeof input?.command === 'string' ? input.command : ''
    const risk = effectiveCommandRisk(input, ctx)
    return {
      what: `执行命令:${command}`,
      why: commandRiskReason(risk),
      impact: commandRiskImpact(risk),
    }
  },
  async previewFor(input, ctx) {
    if (!input || typeof input.command !== 'string') return 'run_command 缺少 command'
    const risk = effectiveCommandRisk(input, ctx)
    let cwdLabel = '.'
    try {
      const cwd = await resolveCommandCwd(input.cwd, ctx)
      cwdLabel = relativePath(ctx, cwd)
    } catch (err) {
      cwdLabel = `无效:${err instanceof Error ? err.message : String(err)}`
    }
    return [
      '<run_command_preview>',
      `command: ${input.command}`,
      `cwd: ${cwdLabel}`,
      `risk: ${risk}`,
      `timeout_ms: ${clampNumber(input.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)}`,
      `max_output_bytes: ${clampNumber(input.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)}`,
      '</run_command_preview>',
    ].join('\n')
  },
  async execute(input, ctx) {
    if (!input || typeof input.command !== 'string') throw new Error('run_command 需要 string 参数 command')
    if (isDangerousCommand(input.command)) throw new Error(`拒绝执行危险命令：${input.command}`)
    const wrapped = ctx.sandbox ? await ctx.sandbox.wrapCommand(input.command, { signal: ctx.signal }) : null
    return await runInWorkspace(input, ctx, wrapped)
  },
}

function effectiveCommandRisk(input: RunCommandInput | undefined, ctx: ToolContext): CommandRisk {
  if (!input || typeof input.command !== 'string') return 'destructive'
  const risk = classifyCommandRisk(input.command)
  if (risk === 'destructive') return risk
  if (shellOutputRedirectionNeedsApproval(input.command, { root: ctx.workspace.root, cwd: resolveCommandCwdSync(input.cwd, ctx) })) {
    return 'outreach'
  }
  return risk
}

function resolveCommandCwdSync(cwd: unknown, ctx: ToolContext): string {
  if (cwd == null || cwd === '') return ctx.workspace.root
  if (typeof cwd !== 'string') return ctx.workspace.root
  try {
    return ctx.workspace.resolve(cwd, 'read')
  } catch {
    return ctx.workspace.root
  }
}

function commandApprovalClass(risk: CommandRisk): ApprovalClass | undefined {
  if (risk === 'read') return undefined
  if (risk === 'file') return 'file'
  if (risk === 'destructive') return 'destructive'
  return 'outreach'
}

function commandRiskReason(risk: CommandRisk): string {
  if (risk === 'read') return '这是只读查询命令。'
  if (risk === 'file') return '该命令可能修改工作区文件或生成构建产物。'
  if (risk === 'outreach') return '该命令可能访问网络、安装依赖或触达外部服务。'
  return '该命令可能造成不可逆删除或大范围改动。'
}

function commandRiskImpact(risk: CommandRisk): string {
  if (risk === 'read') return '只读取本机状态或文件内容。'
  if (risk === 'file') return '可能写入、移动、删除或格式化工作区内文件。'
  if (risk === 'outreach') return '可能产生网络访问、副作用或外部账号操作。'
  return '需要用户确认后才应执行;灾难级命令会被直接拒绝。'
}

async function runInWorkspace(input: RunCommandInput, ctx: ToolContext, wrapped: WrappedCommand | null): Promise<string> {
  const command = input.command
  const cwd = await resolveCommandCwd(input.cwd, ctx)
  const timeoutMs = clampNumber(input.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const maxOutputBytes = clampNumber(input.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
  const isWin = process.platform === 'win32'
  const useProcessGroup = !isWin
  // 包裹后:直接 spawn 沙箱给的 argv/env（免二次 shell）；未包裹:原明文 sh -c / cmd /c。
  const child = wrapped
    ? spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd,
        env: childEnv(wrapped.env),
        detached: useProcessGroup,
      })
    : isWin
      ? spawn('cmd', ['/c', command], { cwd, env: childEnv() })
      : spawn('sh', ['-c', command], { cwd, env: childEnv(), detached: true })
  return new Promise<string>(resolvePromise => {
    const startedAt = Date.now()
    const output = new StreamTailBuffer(maxOutputBytes)
    const liveProgress: LiveProgressState = { emittedBytes: 0, truncated: false }
    const streamSanitizers: Record<'stdout' | 'stderr', StreamingOutputSanitizer> = {
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
    child.stdout?.on('data', d => appendOutputChunk(ctx, output, liveProgress, streamSanitizers.stdout, 'stdout', d, maxOutputBytes))
    child.stderr?.on('data', d => appendOutputChunk(ctx, output, liveProgress, streamSanitizers.stderr, 'stderr', d, maxOutputBytes))
    const finish = (result: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onSignal)
      resolvePromise(result)
    }
    child.on('error', err => {
      finish(`命令启动失败：${err.message}`)
    })
    child.on('close', (code, signal) => {
      flushOutputChunk(ctx, output, liveProgress, streamSanitizers.stdout, 'stdout', maxOutputBytes)
      flushOutputChunk(ctx, output, liveProgress, streamSanitizers.stderr, 'stderr', maxOutputBytes)
      const elapsedMs = Date.now() - startedAt
      const exitCode = code ?? (timedOut || aborted || signal ? -1 : 0)
      finish(formatCommandResult({
        command,
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

async function resolveCommandCwd(cwd: unknown, ctx: ToolContext): Promise<string> {
  if (cwd == null || cwd === '') return ctx.workspace.root
  if (typeof cwd !== 'string') throw new Error('run_command.cwd 必须是字符串')
  const abs = ctx.workspace.resolve(cwd, 'read')
  const info = await stat(abs).catch(() => null)
  if (!info?.isDirectory()) throw new Error(`run_command.cwd 不是可用目录:${cwd}`)
  return abs
}

function relativePath(ctx: ToolContext, abs: string): string {
  const rel = relative(ctx.workspace.root, abs)
  if (!rel) return '.'
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel
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
      // 回退到只杀直接子进程。
    }
  }
  child.kill('SIGKILL')
}

interface LiveProgressState {
  emittedBytes: number
  truncated: boolean
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
    emit({ type: 'tool_progress', tool: 'run_command', stream, chunk: send.toString('utf8') })
  } catch {
    // 进度事件只服务 UI,不能影响命令本身。
  }
  if (buf.length > remaining) emitLiveTruncationNotice(emit, state)
}

function emitLiveTruncationNotice(emit: NonNullable<ToolContext['progressEmit']>, state: LiveProgressState): void {
  if (state.truncated) return
  state.truncated = true
  try {
    emit({
      type: 'tool_progress',
      tool: 'run_command',
      stream: 'stderr',
      chunk: '\n[实时输出过长,后续实时片段已省略;最终结果会保留尾部日志]\n',
    })
  } catch {
    // ignore
  }
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

function formatCommandResult(input: {
  command: string
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
  const semantic = interpretCommandResult(input.command, input.exitCode, input.stdout, input.stderr)
  const lines = [
    `命令：${input.command}`,
    `返回码：${input.exitCode}`,
    `耗时：${input.elapsedMs}ms`,
    `超时：${input.timedOut ? 'true' : 'false'}${input.timedOut ? ` (limit ${input.timeoutMs}ms)` : ''}`,
    `中止：${input.aborted ? 'true' : 'false'}`,
    `信号：${input.signal ?? ''}`,
    input.truncatedBytes > 0
      ? `输出截断：true（保留最后 ${input.capturedBytes}/${input.maxOutputBytes} bytes, 省略 ${input.truncatedBytes} bytes）`
      : '输出截断：false',
    ...(semantic.message ? [`语义：${semantic.message}`] : []),
    ...(semantic.isError ? [`[退出码 ${input.exitCode}]`] : []),
    '【标准输出】',
    input.stdout,
  ]
  if (input.stderr) lines.push('【错误输出】', input.stderr)
  return lines.join('\n').trimEnd()
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
    const chunks = this.chunks.filter(entry => entry.stream === stream).map(entry => entry.chunk)
    return Buffer.concat(chunks).toString('utf8')
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
