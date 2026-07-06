import { spawn } from 'node:child_process'
import type { Tool, ToolContext } from './Tool'
import type { WrappedCommand } from '../sandbox/sandbox'
import { classifyCommandRisk, isDangerousCommand, type CommandRisk } from './dangerousCommand'
import type { ApprovalClass } from '../permissions/types'

const DEFAULT_TIMEOUT_MS = 30_000

export const runCommandTool: Tool<{ command: string }> = {
  name: 'run_command',
  description: 'Run a shell command with the workspace as the working directory. Input: { command }.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  isReadOnly: false,
  isReadOnlyFor(input) {
    return typeof input?.command === 'string' && classifyCommandRisk(input.command) === 'read'
  },
  requiresApprovalFor(input) {
    return typeof input?.command !== 'string' || classifyCommandRisk(input.command) !== 'read'
  },
  approvalClassFor(input) {
    return commandApprovalClass(typeof input?.command === 'string' ? classifyCommandRisk(input.command) : 'destructive')
  },
  fatalReasonFor(input) {
    if (typeof input?.command !== 'string') return 'run_command 缺少 command'
    return isDangerousCommand(input.command) ? `危险命令:${input.command}` : null
  },
  approvalReasonFor(input) {
    const command = typeof input?.command === 'string' ? input.command : ''
    const risk = classifyCommandRisk(command)
    return {
      what: `执行命令:${command}`,
      why: commandRiskReason(risk),
      impact: commandRiskImpact(risk),
    }
  },
  async execute(input, ctx) {
    if (!input || typeof input.command !== 'string') throw new Error('run_command 需要 string 参数 command')
    if (isDangerousCommand(input.command)) throw new Error(`拒绝执行危险命令：${input.command}`)
    const wrapped = ctx.sandbox ? await ctx.sandbox.wrapCommand(input.command, { signal: ctx.signal }) : null
    return await runInWorkspace(input.command, ctx, wrapped)
  },
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

function runInWorkspace(command: string, ctx: ToolContext, wrapped: WrappedCommand | null): Promise<string> {
  const isWin = process.platform === 'win32'
  // 包裹后:直接 spawn 沙箱给的 argv/env（免二次 shell）；未包裹:原明文 sh -c / cmd /c。
  const child = wrapped
    ? spawn(wrapped.argv[0]!, wrapped.argv.slice(1), {
        cwd: ctx.workspace.root,
        env: { ...process.env, ...wrapped.env },
      })
    : isWin
      ? spawn('cmd', ['/c', command], { cwd: ctx.workspace.root })
      : spawn('sh', ['-c', command], { cwd: ctx.workspace.root })
  return new Promise<string>(resolvePromise => {
    let out = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), DEFAULT_TIMEOUT_MS)
    const onSignal = () => child.kill('SIGKILL')
    ctx.signal?.addEventListener('abort', onSignal, { once: true })
    child.stdout?.on('data', d => (out += d.toString()))
    child.stderr?.on('data', d => (out += d.toString()))
    child.on('error', err => {
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onSignal)
      resolvePromise(`命令启动失败：${err.message}`)
    })
    child.on('close', code => {
      clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onSignal)
      resolvePromise(code === 0 ? out.trim() : `${out.trim()}\n[退出码 ${code}]`)
    })
  })
}
