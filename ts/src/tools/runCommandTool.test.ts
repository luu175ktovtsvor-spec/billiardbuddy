import { test, expect, beforeEach, afterEach, describe } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { runCommandTool } from './runCommandTool'
import { classifyCommandRisk, isDangerousCommand } from './dangerousCommand'
import { resolvePermission } from '../permissions/resolve'

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

test('classifyCommandRisk separates read/file/outreach/destructive commands', () => {
  expect(classifyCommandRisk('ls -la')).toBe('read')
  expect(classifyCommandRisk('git status --short')).toBe('read')
  expect(classifyCommandRisk('echo hi > note.txt')).toBe('file')
  expect(classifyCommandRisk('npm run build')).toBe('file')
  expect(classifyCommandRisk('curl https://example.com')).toBe('outreach')
  expect(classifyCommandRisk('npm install left-pad')).toBe('outreach')
  expect(classifyCommandRisk('rm -rf build')).toBe('destructive')
})

test('run_command dynamic permission allows reads and classifies approval', () => {
  expect(resolvePermission(runCommandTool, { command: 'ls -la' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'ls -la' }, { ...ctx, permissionMode: 'plan' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'echo hi > note.txt' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({ behavior: 'allow' })
  expect(resolvePermission(runCommandTool, { command: 'curl https://example.com' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'outreach',
  })
  expect(resolvePermission(runCommandTool, { command: 'rm -rf build' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
    behavior: 'ask',
    approvalClass: 'destructive',
  })
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
  test('命令内「双反斜杠」文本不是 UNC,不误杀(behavior-align fix:命令内 UNC 正则已删)', () => {
    // \\ 是 JSON / 双引号 shell / sed 里表示"一个字面反斜杠"的标准转义,和 UNC 的双反斜杠前缀肉眼无法区分;
    // 命令内 UNC 检测本身就难做到不误杀、非灾难级,已删除该正则,推迟到 W4 完整分类器(路径级 UNC 已由 Task1 的 isVulnerableUncPath 兜底,不受影响)
    expect(isDangerousCommand(`curl -d '{"path":"C:\\\\Users\\\\test"}' http://api/save`)).toBe(false)
    expect(isDangerousCommand(`echo "C:\\\\Users\\\\foo"`)).toBe(false)
    expect(isDangerousCommand(`sed -i 's#C:\\\\old\\\\path#C:\\\\new\\\\path#' file.txt`)).toBe(false)
  })
  test('rm 大写/混合大小写标志位命中(behavior-align fix:补 /i,catch -RF)', () => {
    expect(isDangerousCommand('rm -RF *')).toBe(true)
    expect(isDangerousCommand('rm -RF /')).toBe(true)
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

describe('run_command × Sandbox 接线(Task 6)', () => {
  test('run_command 用 sandbox 包裹后的 argv 跑(返回 {argv,env})', async () => {
    const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-rc-'))))
    const fakeSandbox = {
      async wrapCommand() {
        return { argv: ['printf', 'WRAPPED'], env: {} as NodeJS.ProcessEnv }
      },
    }
    const out = await runCommandTool.execute({ command: 'echo IGNORED' }, {
      workspace: ws,
      sandbox: fakeSandbox as unknown as import('../sandbox/sandbox').Sandbox,
    })
    expect(out).toContain('WRAPPED')
  })

  test('run_command 无 sandbox 时按明文命令跑(W2 行为不回归)', async () => {
    const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-rc-'))))
    const out = await runCommandTool.execute({ command: 'echo PLAIN' }, { workspace: ws })
    expect(out).toContain('PLAIN')
  })
})
