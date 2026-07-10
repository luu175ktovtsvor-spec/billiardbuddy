/**
 * backend-sidecar 顶层崩溃兜底行为对齐测试(P0 · 审计 16-trace-errors.md #6.1)。
 * 用假 emitter + 假 exit 单测(对齐 desktop/electron/services/crashGuard.test.ts 的做法),锁死:
 *   ① 两类 handler 都挂上
 *   ② uncaughtException:写崩溃日志 + 调 exit(1)
 *   ③ unhandledRejection:写崩溃日志 + 绝不调 exit(避免误杀正常会话)
 *   ④ 非 Error 值(字符串/其它)也能兜住不抛
 * 子进程级验证见 processCrashGuard.subprocess.test.ts(更贴近真实场景)。
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installSidecarCrashGuards } from './processCrashGuard'

const dirs: string[] = []
function freshLogDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bb-crashguard-'))
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

/** 极简假 emitter:记录 on() 注册的 handler,可手动触发(同 crashGuard.test.ts 的 makeEmitter)。 */
function makeEmitter() {
  const handlers = new Map<string, (...a: unknown[]) => void>()
  return {
    on(event: string, listener: (...a: unknown[]) => void) {
      handlers.set(event, listener)
    },
    emit(event: string, ...args: unknown[]) {
      handlers.get(event)?.(...args)
    },
    registered: () => [...handlers.keys()],
  }
}

test('两类 handler 都挂上', () => {
  const proc = makeEmitter()
  const logDir = freshLogDir()
  installSidecarCrashGuards({ proc, logDir, exit: () => {} })
  expect(proc.registered()).toContain('uncaughtException')
  expect(proc.registered()).toContain('unhandledRejection')
})

test('uncaughtException:写崩溃日志 + 调 exit(1)', () => {
  const proc = makeEmitter()
  const logDir = freshLogDir()
  const exitCalls: number[] = []
  installSidecarCrashGuards({ proc, logDir, exit: code => exitCalls.push(code) })

  proc.emit('uncaughtException', new Error('顶层炸了'))

  expect(exitCalls).toEqual([1])
  const crashFiles = readdirSync(logDir).filter(f => f.startsWith('crash-'))
  expect(crashFiles.length).toBe(1)
  const content = readFileSync(join(logDir, crashFiles[0]!), 'utf8')
  expect(content).toContain('kind: uncaughtException')
  expect(content).toContain('message: 顶层炸了')
  expect(content).toContain('stack:')
  // debug.log 也该有一条面包屑(集中式日志要求 #1.1)。
  expect(existsSync(join(logDir, 'debug.log'))).toBe(true)
  expect(readFileSync(join(logDir, 'debug.log'), 'utf8')).toContain('uncaughtException: 顶层炸了')
})

test('unhandledRejection:写崩溃日志,但绝不调 exit(避免误杀正常会话)', () => {
  const proc = makeEmitter()
  const logDir = freshLogDir()
  const exitCalls: number[] = []
  installSidecarCrashGuards({ proc, logDir, exit: code => exitCalls.push(code) })

  proc.emit('unhandledRejection', new Error('rejection 没人接'))

  expect(exitCalls).toEqual([]) // 一次都不该调
  const crashFiles = readdirSync(logDir).filter(f => f.startsWith('crash-'))
  expect(crashFiles.length).toBe(1)
  expect(readFileSync(join(logDir, crashFiles[0]!), 'utf8')).toContain('kind: unhandledRejection')
})

test('非 Error 值(字符串)也能兜住,不抛出、正常记录', () => {
  const proc = makeEmitter()
  const logDir = freshLogDir()
  const exitCalls: number[] = []
  installSidecarCrashGuards({ proc, logDir, exit: code => exitCalls.push(code) })

  expect(() => proc.emit('unhandledRejection', 'plain string reason')).not.toThrow()
  const crashFiles = readdirSync(logDir).filter(f => f.startsWith('crash-'))
  expect(readFileSync(join(logDir, crashFiles[0]!), 'utf8')).toContain('message: plain string reason')
  expect(exitCalls).toEqual([])
})

test('默认不传 exit 时用真实 process.exit(仅验证不传参会走到 process.exit 分支——这里不实际调用,只测类型/装配)', () => {
  // 不触发真崩溃(会真的杀掉测试进程),只验证 installSidecarCrashGuards 在缺省 exit 时不会在“安装阶段”报错。
  const proc = makeEmitter()
  const logDir = freshLogDir()
  expect(() => installSidecarCrashGuards({ proc, logDir })).not.toThrow()
})
