import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { runCommandTool } from './runCommandTool'
import { isDangerousCommand } from './dangerousCommand'

let root: string
let ctx: ToolContext
beforeEach(() => {
  // realpath:macOS 的 /tmp 是 /private/tmp 的软链,pwd 会返回真实路径
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ws-')))
  ctx = { workspace: new Workspace(root) }
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('run_command runs a command and captures stdout', async () => {
  const out = await runCommandTool.execute({ command: 'echo hello-w2' }, ctx)
  expect(out).toContain('hello-w2')
})

test('run_command runs with the workspace as cwd', async () => {
  const out = await runCommandTool.execute({ command: 'pwd' }, ctx)
  expect(out).toContain(root)
})

test('run_command reports a non-zero exit', async () => {
  const out = await runCommandTool.execute({ command: 'exit 3' }, ctx)
  expect(out).toContain('3')
})

test('isDangerousCommand flags catastrophic commands', () => {
  expect(isDangerousCommand('rm -rf /')).toBe(true)
  expect(isDangerousCommand('rm -rf ~')).toBe(true)
  expect(isDangerousCommand('sudo reboot')).toBe(true)
  expect(isDangerousCommand('ls -la')).toBe(false)
})

test('run_command refuses a dangerous command', async () => {
  await expect(runCommandTool.execute({ command: 'rm -rf /' }, ctx)).rejects.toThrow(/危险命令/)
})
