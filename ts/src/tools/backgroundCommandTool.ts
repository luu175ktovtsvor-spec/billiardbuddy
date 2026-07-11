// 后台命令原语 —— 抄 cc-haha src/tasks/LocalShellTask/LocalShellTask.tsx(spawnShellTask):
// 「丢后台、立刻返回 task id」的 shell 执行。后台跑 + 输出流入任务事件(tailFile 等价)+
// startStallWatchdog(输出停滞且尾部像交互提示 → 一次性通知模型改非交互)+ 完成/失败/killed 通知。
// 生产者补齐:BashOutputTool(TaskOutput 别名)读、TaskStop 停的「半条链」原本缺产出侧,这里补上。
// 复用 run_command 的 spawn/沙箱/危险命令口径(见 runCommandTool.ts 导出的辅助)。
import type { Tool, ToolContext } from './Tool'
import type { TaskService } from '../tasks/taskService'
import { classifyCommandRisk, isDangerousCommand, type CommandRisk } from './dangerousCommand'
import type { ApprovalClass } from '../permissions/types'
import { additionalWorkingDirectoryPaths } from '../permissions/filePathRules'
import {
  clampNumber,
  DEFAULT_MAX_OUTPUT_BYTES,
  killChildTree,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  resolveCommandCwd,
  spawnShellChild,
  StreamTailBuffer,
} from './runCommandTool'

// 停滞看门狗参数(对齐 cc LocalShellTask 常量)。
const STALL_CHECK_INTERVAL_MS = 5_000
const STALL_THRESHOLD_MS = 45_000
const OUTPUT_FLUSH_INTERVAL_MS = 250
const DEFAULT_BG_TIMEOUT_MS = 600_000 // 后台默认 10 分钟(远长于同步的 30s),仍受 MAX_TIMEOUT_MS 封顶。

// 尾行像「等键盘输入」的交互提示时才通知(纯慢命令保持安静),移植自 cc LocalShellTask.PROMPT_PATTERNS。
const PROMPT_PATTERNS: RegExp[] = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:Do you|Would you|Shall I|Are you sure|Ready to)\b.*\? *$/i,
  /Press (any key|Enter)/i,
  /Continue\?/i,
  /Overwrite\?/i,
]

export function looksLikePrompt(tail: string): boolean {
  const lastLine = tail.trimEnd().split('\n').pop() ?? ''
  return PROMPT_PATTERNS.some(p => p.test(lastLine))
}

interface BackgroundCommandInput {
  command: string
  cwd?: string
  timeout_ms?: number
  description?: string
}

export function createBackgroundCommandTool(tasks: TaskService): Tool<BackgroundCommandInput> {
  return {
    name: 'run_command_background',
    description: [
      'Run a shell command in the background and immediately return a task id (does not block).',
      'Input: { command, cwd?, timeout_ms?, description? }. Use for long-running processes (dev servers, watchers, long builds).',
      'Read its streamed output with BashOutputTool/TaskOutput({task_id}), and stop it with TaskStop({task_id}).',
      `Default background timeout ${DEFAULT_BG_TIMEOUT_MS}ms, capped at ${MAX_TIMEOUT_MS}ms.`,
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Optional working directory (workspace-relative or an allowed absolute path).' },
        timeout_ms: { type: 'number', description: `Optional timeout in ms, capped at ${MAX_TIMEOUT_MS}.` },
        description: { type: 'string', description: 'Optional short label shown in the task list.' },
      },
      required: ['command'],
    },
    isReadOnly: false,
    requiresApprovalFor(input) {
      return typeof input?.command !== 'string' || commandRisk(input.command) !== 'read'
    },
    approvalClassFor(input) {
      return backgroundApprovalClass(typeof input?.command === 'string' ? commandRisk(input.command) : 'destructive')
    },
    fatalReasonFor(input) {
      if (typeof input?.command !== 'string' || !input.command.trim()) return 'run_command_background 缺少 command'
      return null
    },
    // 危险命令走 dangerous 档(对齐 cc:default 弹卡问、完全访问档放行),不再无条件硬拒。
    dangerousReasonFor(input) {
      if (typeof input?.command !== 'string') return null
      return isDangerousCommand(input.command) ? `危险命令:${input.command}` : null
    },
    approvalReasonFor(input) {
      const command = typeof input?.command === 'string' ? input.command : ''
      return {
        what: `后台执行命令:${command}`,
        why: '会在后台启动一个持续运行的进程(如开发服务器/长构建)。',
        impact: '确认后进程会一直运行到自然结束或被 TaskStop 停止;输出可用 BashOutputTool 读取。',
      }
    },
    async execute(input, ctx) {
      if (!input || typeof input.command !== 'string' || !input.command.trim()) throw new Error('run_command_background 需要 string 参数 command')
      // 危险命令不再执行层硬拒(对齐 cc):放行与否已由权限闸按档位决定,走到 execute 说明已过闸。
      const command = input.command
      const cwd = await resolveCommandCwd(input.cwd, ctx)
      const timeoutMs = clampNumber(input.timeout_ms, DEFAULT_BG_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const wrapped = ctx.sandbox
        ? await ctx.sandbox.wrapCommand(command, { signal: ctx.signal, extraWritablePaths: additionalWorkingDirectoryPaths(ctx) })
        : null
      const title = (input.description?.trim() || command).slice(0, 120)

      const task = await tasks.create({
        title,
        kind: 'background_command',
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
        params: { command, cwd, timeout_ms: timeoutMs },
      })

      tasks.start(task.id, taskCtx => runBackgroundShell({ command, cwd, wrapped, timeoutMs, taskCtx }))

      return [
        `<background_command_started task_id="${xmlAttr(task.id)}" status="queued">`,
        `command: ${command}`,
        `cwd: ${cwd}`,
        `用 BashOutputTool/TaskOutput({task_id:"${task.id}"}) 读输出,用 TaskStop({task_id:"${task.id}"}) 停止。`,
        '</background_command_started>',
      ].join('\n')
    },
  }
}

interface RunBackgroundShellArgs {
  command: string
  cwd: string
  wrapped: Awaited<ReturnType<NonNullable<ToolContext['sandbox']>['wrapCommand']>> | null
  timeoutMs: number
  taskCtx: { signal: AbortSignal; emit: (event: { type: 'context_note'; text: string }) => Promise<unknown> }
}

async function runBackgroundShell(args: RunBackgroundShellArgs): Promise<string> {
  const { command, cwd, wrapped, timeoutMs, taskCtx } = args
  const child = spawnShellChild(command, cwd, wrapped)
  const maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES
  const tail = new StreamTailBuffer(maxOutputBytes)
  const startedAt = Date.now()
  let pending = ''
  let timedOut = false
  let stallNotified = false
  let lastBytes = 0
  let lastGrowth = Date.now()

  const flush = (): void => {
    if (!pending) return
    const text = pending
    pending = ''
    void taskCtx.emit({ type: 'context_note', text }).catch(() => {})
  }
  const onData = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    tail.append(stream, chunk)
    pending += chunk.toString('utf8')
    if (pending.length > maxOutputBytes) pending = pending.slice(pending.length - maxOutputBytes)
  }
  child.stdout?.on('data', d => onData('stdout', d))
  child.stderr?.on('data', d => onData('stderr', d))

  const flushTimer = setInterval(flush, OUTPUT_FLUSH_INTERVAL_MS)
  maybeUnref(flushTimer)
  const watchdog = setInterval(() => {
    if (tail.bytes > lastBytes) {
      lastBytes = tail.bytes
      lastGrowth = Date.now()
      return
    }
    if (stallNotified || Date.now() - lastGrowth < STALL_THRESHOLD_MS) return
    const combinedTail = `${tail.toString('stdout')}\n${tail.toString('stderr')}`
    if (!looksLikePrompt(combinedTail)) {
      lastGrowth = Date.now()
      return
    }
    stallNotified = true
    void taskCtx.emit({
      type: 'context_note',
      text: `后台命令 "${command}" 似乎卡在交互提示上等待输入。请 TaskStop 停掉它,再用非交互方式重跑(例如 echo y | 命令,或加 --yes/--non-interactive 之类的参数)。\n最近输出:\n${combinedTail.trimEnd()}`,
    }).catch(() => {})
  }, STALL_CHECK_INTERVAL_MS)
  maybeUnref(watchdog)

  const timer = setTimeout(() => {
    timedOut = true
    killChildTree(child)
  }, timeoutMs)
  maybeUnref(timer)

  const onAbort = (): void => killChildTree(child)
  if (taskCtx.signal.aborted) killChildTree(child)
  else taskCtx.signal.addEventListener('abort', onAbort, { once: true })

  const cleanup = (): void => {
    clearInterval(flushTimer)
    clearInterval(watchdog)
    clearTimeout(timer)
    taskCtx.signal.removeEventListener('abort', onAbort)
    flush()
  }

  return await new Promise<string>(resolve => {
    child.on('error', err => {
      cleanup()
      resolve(summarize(command, 'failed', undefined, null, tail, Date.now() - startedAt, `命令启动失败：${err.message}`))
    })
    child.on('close', (code, signal) => {
      cleanup()
      const status: SettleStatus = taskCtx.signal.aborted
        ? 'killed'
        : timedOut
          ? 'timeout'
          : code === 0
            ? 'completed'
            : 'failed'
      resolve(summarize(command, status, code ?? undefined, signal, tail, Date.now() - startedAt))
    })
  })
}

type SettleStatus = 'completed' | 'failed' | 'killed' | 'timeout'

function summarize(
  command: string,
  status: SettleStatus,
  exitCode: number | undefined,
  signal: NodeJS.Signals | null,
  tail: StreamTailBuffer,
  elapsedMs: number,
  note?: string,
): string {
  const stdout = tail.toString('stdout').trim()
  const stderr = tail.toString('stderr').trim()
  const lines = [
    `命令：${command}`,
    `状态：${status}`,
    ...(exitCode !== undefined ? [`返回码：${exitCode}`] : []),
    ...(signal ? [`信号：${signal}`] : []),
    `耗时：${elapsedMs}ms`,
    ...(note ? [`说明：${note}`] : []),
    '【标准输出】',
    stdout,
  ]
  if (stderr) lines.push('【错误输出】', stderr)
  return lines.join('\n').trimEnd()
}

function commandRisk(command: string): CommandRisk {
  return classifyCommandRisk(command)
}

function backgroundApprovalClass(risk: CommandRisk): ApprovalClass | undefined {
  if (risk === 'read') return undefined
  if (risk === 'file') return 'file'
  if (risk === 'destructive') return 'destructive'
  return 'outreach'
}

function maybeUnref(timer: ReturnType<typeof setInterval>): void {
  const maybe = timer as { unref?: () => void }
  if (typeof maybe.unref === 'function') maybe.unref()
}

function xmlAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
