/**
 * 顶层崩溃兜底的子进程级验证(P0 · 审计 16-trace-errors.md #6.1)。
 *
 * processCrashGuard.test.ts 用假 emitter 测的是"handler 逻辑对不对";这份补一层更贴近真相的验证——
 * 真起一个 Bun 子进程,在其中真实调用 `installSidecarCrashGuards()`(挂到真正的 `process`),故意抛一个
 * 真正未被任何 try/catch 兜住的异常 / 一个真正没人 await 的 rejected promise,断言:
 *   ① uncaughtException:crash-*.log 真的落盘到指定目录 + 子进程按 Node 惯例以 code=1 退出
 *   ② unhandledRejection:crash-*.log 真的落盘 + 子进程**没有**被杀、能跑到自己后面显式 exit(0)
 *
 * 子进程脚本临时生成在系统 tmp 目录(不落进仓库),import 用 processCrashGuard.ts 的绝对路径
 * (Bun 支持模块说明符为绝对路径)。
 */
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dirs: string[] = []
function freshDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop()!
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // 清理失败不影响断言
    }
  }
})

const processCrashGuardAbsPath = join(import.meta.dir, 'processCrashGuard.ts')

function writeFixture(scriptDir: string, body: string): string {
  const fixturePath = join(scriptDir, 'fixture.ts')
  writeFileSync(
    fixturePath,
    `import { installSidecarCrashGuards } from ${JSON.stringify(processCrashGuardAbsPath)}\n` +
      `const logDir = process.env.CRASH_TEST_LOG_DIR as string\n` +
      `installSidecarCrashGuards({ logDir })\n` +
      body,
    'utf8',
  )
  return fixturePath
}

test('子进程真抛 uncaughtException:crash 日志落盘 + 进程按 Node 惯例 exit(1)', async () => {
  const logDir = freshDir('bb-crashguard-sub-log-')
  const scriptDir = freshDir('bb-crashguard-sub-script-')
  const fixturePath = writeFixture(
    scriptDir,
    `setTimeout(() => { throw new Error('subprocess-uncaught-boom') }, 10)\n`,
  )

  const proc = Bun.spawn([process.execPath, fixturePath], {
    env: { ...process.env, CRASH_TEST_LOG_DIR: logDir },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const exitCode = await proc.exited

  expect(exitCode).toBe(1)
  const crashFiles = readdirSync(logDir).filter(f => f.startsWith('crash-'))
  expect(crashFiles.length).toBe(1)
  const content = readFileSync(join(logDir, crashFiles[0]!), 'utf8')
  expect(content).toContain('kind: uncaughtException')
  expect(content).toContain('message: subprocess-uncaught-boom')
}, 15_000)

test('子进程真触发 unhandledRejection:crash 日志落盘 + 进程不被杀、能跑到后面的 exit(0)', async () => {
  const logDir = freshDir('bb-crashguard-sub-log-')
  const scriptDir = freshDir('bb-crashguard-sub-script-')
  const fixturePath = writeFixture(
    scriptDir,
    `Promise.reject(new Error('subprocess-rejection-boom'))\n` +
      `setTimeout(() => { process.exit(0) }, 200)\n`,
  )

  const proc = Bun.spawn([process.execPath, fixturePath], {
    env: { ...process.env, CRASH_TEST_LOG_DIR: logDir },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  const exitCode = await proc.exited

  // 没被 unhandledRejection 默认行为杀掉 —— 活到了自己后面显式调的 exit(0)。
  expect(exitCode).toBe(0)
  const crashFiles = readdirSync(logDir).filter(f => f.startsWith('crash-'))
  expect(crashFiles.length).toBe(1)
  const content = readFileSync(join(logDir, crashFiles[0]!), 'utf8')
  expect(content).toContain('kind: unhandledRejection')
  expect(content).toContain('message: subprocess-rejection-boom')
}, 15_000)
