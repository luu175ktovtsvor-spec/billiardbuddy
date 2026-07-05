import { spawn } from 'node:child_process'
import type { Tool, ToolContext } from './Tool'
import type { WrappedCommand } from '../sandbox/sandbox'
import { isDangerousCommand } from './dangerousCommand'

const DEFAULT_TIMEOUT_MS = 30_000

export const runCommandTool: Tool<{ command: string }> = {
  name: 'run_command',
  description: 'Run a shell command with the workspace as the working directory. Input: { command }.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
  isReadOnly: false,
  async execute(input, ctx) {
    if (!input || typeof input.command !== 'string') throw new Error('run_command 需要 string 参数 command')
    if (isDangerousCommand(input.command)) throw new Error(`拒绝执行危险命令：${input.command}`)
    const wrapped = ctx.sandbox ? await ctx.sandbox.wrapCommand(input.command, { signal: ctx.signal }) : null
    return await runInWorkspace(input.command, ctx, wrapped)
  },
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
