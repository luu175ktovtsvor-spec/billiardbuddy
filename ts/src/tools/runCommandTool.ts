import { spawn } from 'node:child_process'
import type { Tool, ToolContext } from './Tool'
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
    return await runInWorkspace(input.command, ctx)
  },
}

function runInWorkspace(command: string, ctx: ToolContext): Promise<string> {
  const isWin = process.platform === 'win32'
  const child = isWin
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
