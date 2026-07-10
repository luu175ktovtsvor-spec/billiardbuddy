import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { Tool, ToolContext } from './Tool'
import { createTaskTools } from '../tasks/taskTools'
import { TaskService } from '../tasks/taskService'
import { looksLikePrompt } from './backgroundCommandTool'

let root: string
let tasks: TaskService
let tools: Tool[]
let ctx: ToolContext

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'bg-')))
  tasks = new TaskService(root)
  tools = createTaskTools(tasks)
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function byName(name: string): Tool {
  const tool = tools.find(t => t.name === name)
  if (!tool) throw new Error(`missing tool ${name}`)
  return tool
}

function taskIdFrom(output: string): string {
  const match = output.match(/task_id="([^"]+)"/)
  if (!match) throw new Error(`no task_id in: ${output}`)
  return match[1]!
}

async function poll<T>(fn: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('poll timeout')
}

test('run_command_background is wired next to the BashOutput/TaskStop consumers', () => {
  const names = tools.map(t => t.name)
  expect(names).toContain('run_command_background')
  expect(names).toContain('BashOutputTool')
  expect(names).toContain('TaskStop')
})

test('spawn a background command, then BashOutput reads its output on completion', async () => {
  const bg = byName('run_command_background')
  const bashOut = byName('BashOutputTool')

  const started = await bg.execute({ command: 'echo hello-bg' }, ctx)
  const taskId = taskIdFrom(started)
  expect(started).toContain('background_command_started')

  const out = await bashOut.execute({ task_id: taskId, block: true, timeout: 5000 }, ctx)
  expect(out).toContain('hello-bg')
  expect(out).toContain('<status>completed</status>')
})

test('TaskStop kills a long-running background command', async () => {
  const bg = byName('run_command_background')
  const taskStop = byName('TaskStop')

  const started = await bg.execute({ command: 'sleep 30' }, ctx)
  const taskId = taskIdFrom(started)

  // 等任务真正进入 running 再停,避免竞态。
  await poll(async () => {
    const t = await tasks.get(taskId)
    return t && (t.status === 'running' || t.status === 'queued') ? t : null
  })

  const stopped = await taskStop.execute({ task_id: taskId }, ctx)
  expect(stopped).toContain('task_stopped')

  const cancelled = await poll(async () => {
    const t = await tasks.get(taskId)
    return t && t.status === 'cancelled' ? t : null
  })
  expect(cancelled.status).toBe('cancelled')
})

test('background command rejects dangerous commands before spawning', async () => {
  const bg = byName('run_command_background')
  await expect(bg.execute({ command: 'rm -rf /' }, ctx)).rejects.toThrow(/危险命令/)
})

test('run_command_background 把 ctx.additionalWorkingDirectories 转成 extraWritablePaths 传给 sandbox.wrapCommand(P1 §7 修复)', async () => {
  const bg = byName('run_command_background')
  const extDir = realpathSync(mkdtempSync(join(tmpdir(), 'bg-extdir-')))
  let capturedExtra: string[] | undefined
  const fakeSandbox = {
    async wrapCommand(_command: string, opts: { extraWritablePaths?: string[] }) {
      capturedExtra = opts.extraWritablePaths
      return null
    },
  }
  const started = await bg.execute({ command: 'echo hi' }, {
    ...ctx,
    sandbox: fakeSandbox as unknown as import('../sandbox/sandbox').Sandbox,
    additionalWorkingDirectories: new Map([[extDir, { path: extDir, source: 'session' }]]),
  })
  const taskId = taskIdFrom(started)
  await poll(async () => {
    const t = await tasks.get(taskId)
    return t && t.status !== 'queued' && t.status !== 'running' ? t : null
  })
  expect(capturedExtra).toEqual([extDir])
  rmSync(extDir, { recursive: true, force: true })
})

test('looksLikePrompt only flags interactive-looking tails', () => {
  expect(looksLikePrompt('Proceed? (y/n)')).toBe(true)
  expect(looksLikePrompt('Overwrite?')).toBe(true)
  expect(looksLikePrompt('Are you sure you want to continue?')).toBe(true)
  expect(looksLikePrompt('Compiling module 42/100')).toBe(false)
  expect(looksLikePrompt('git log -S searching...')).toBe(false)
})
