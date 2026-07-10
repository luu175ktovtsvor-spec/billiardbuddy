/**
 * 集中式调试日志行为对齐测试(P0 · 审计 16-trace-errors.md #1.1)。锁死:
 *   ① 默认只落 warn/error,debug/info 被过滤
 *   ② env QF_DEBUG_LOG 真值时 debug/info 也落(verbose 开关)
 *   ③ 落盘格式含时间戳/级别/模块名/message
 *   ④ debug.log 按大小轮转、保留份数生效
 *   ⑤ 崩溃日志(writeCrashLog)独立成文件 + 裁剪只保留最近 N 份
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getLogger, writeCrashLog } from './logger'

const dirs: string[] = []
function freshLogDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'bb-logger-'))
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

test('默认只落 warn/error,debug/info 被过滤', () => {
  const logDir = freshLogDir()
  const log = getLogger('test-module', { logDir, env: {} })
  log.debug('不该出现')
  log.info('也不该出现')
  log.warn('该出现-warn')
  log.error('该出现-error')

  const content = readFileSync(join(logDir, 'debug.log'), 'utf8')
  expect(content).not.toContain('不该出现')
  expect(content).not.toContain('也不该出现')
  expect(content).toContain('该出现-warn')
  expect(content).toContain('该出现-error')
})

test('QF_DEBUG_LOG=1 时 debug/info 也落盘(verbose 开关)', () => {
  const logDir = freshLogDir()
  const log = getLogger('test-module', { logDir, env: { QF_DEBUG_LOG: '1' } })
  log.debug('verbose-debug')
  log.info('verbose-info')

  const content = readFileSync(join(logDir, 'debug.log'), 'utf8')
  expect(content).toContain('verbose-debug')
  expect(content).toContain('verbose-info')
})

test('兼容 BILLIARDBUDDY_DEBUG / DEBUG 触发 verbose(不破坏既有开发者习惯)', () => {
  const logDir1 = freshLogDir()
  getLogger('m', { logDir: logDir1, env: { BILLIARDBUDDY_DEBUG: '1' } }).debug('via-billiardbuddy-debug')
  expect(readFileSync(join(logDir1, 'debug.log'), 'utf8')).toContain('via-billiardbuddy-debug')

  const logDir2 = freshLogDir()
  getLogger('m', { logDir: logDir2, env: { DEBUG: '1' } }).debug('via-debug-env')
  expect(readFileSync(join(logDir2, 'debug.log'), 'utf8')).toContain('via-debug-env')
})

test('落盘格式含 ISO 时间戳/级别/模块名/message,meta 序列化附加', () => {
  const logDir = freshLogDir()
  const log = getLogger('my-module', { logDir, env: {} })
  log.error('出错了', { code: 42 })

  const content = readFileSync(join(logDir, 'debug.log'), 'utf8')
  expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
  expect(content).toContain('[ERROR]')
  expect(content).toContain('[my-module]')
  expect(content).toContain('出错了')
  expect(content).toContain('"code":42')
})

test('meta 不可序列化(循环引用)时不抛错,写入占位符', () => {
  const logDir = freshLogDir()
  const log = getLogger('m', { logDir, env: {} })
  const circular: Record<string, unknown> = {}
  circular.self = circular
  expect(() => log.error('循环引用 meta', circular)).not.toThrow()
  const content = readFileSync(join(logDir, 'debug.log'), 'utf8')
  expect(content).toContain('[unserializable meta]')
})

test('debug.log 超过阈值按大小轮转,保留份数生效', () => {
  const logDir = freshLogDir()
  // 阈值调到极小(20 字节)+ 只留 2 份历史,几行日志就能触发多次轮转,不用真写 5MB。
  const log = getLogger('m', { logDir, env: {}, maxLogBytes: 20, maxRotatedFiles: 2 })
  for (let i = 0; i < 6; i++) log.error(`line-${i}-填充到超过阈值触发轮转`)

  const debugLogPath = join(logDir, 'debug.log')
  expect(existsSync(debugLogPath)).toBe(true)
  // 轮转产生了 .1/.2,且不超过配置的保留份数(没有 .3)。
  expect(existsSync(`${debugLogPath}.1`)).toBe(true)
  expect(existsSync(`${debugLogPath}.2`)).toBe(true)
  expect(existsSync(`${debugLogPath}.3`)).toBe(false)
})

test('writeCrashLog:每次崩溃独立成文件,内容含 time/kind/message/stack', () => {
  const logDir = freshLogDir()
  const err = new Error('kaboom')
  const path = writeCrashLog('uncaughtException', { message: err.message, stack: err.stack }, { logDir })

  expect(path).toBeDefined()
  expect(existsSync(path!)).toBe(true)
  const content = readFileSync(path!, 'utf8')
  expect(content).toContain('kind: uncaughtException')
  expect(content).toContain('message: kaboom')
  expect(content).toContain('stack:')

  const files = readdirSync(logDir).filter(f => f.startsWith('crash-'))
  expect(files.length).toBe(1)
})

test('writeCrashLog:超过保留份数裁剪最旧的', () => {
  const logDir = freshLogDir()
  for (let i = 0; i < 5; i++) {
    writeCrashLog('unhandledRejection', { message: `err-${i}` }, { logDir, maxCrashFiles: 3 })
  }
  const files = readdirSync(logDir).filter(f => f.startsWith('crash-')).sort()
  expect(files.length).toBe(3)
  // 剩下的应是较晚写入的那几份(裁剪掉最旧的两份)。
  const contents = files.map(f => readFileSync(join(logDir, f), 'utf8'))
  expect(contents.some(c => c.includes('err-4'))).toBe(true)
  expect(contents.some(c => c.includes('err-0'))).toBe(false)
})

test('写失败(logDir 是不可写的文件而非目录)静默吞,不抛出', () => {
  const parent = freshLogDir()
  const notADir = join(parent, 'debug.log') // 制造:让 mkdirSync 目标路径撞上一个已存在的普通文件
  writeFileSync(notADir, 'occupied')
  const log = getLogger('m', { logDir: notADir, env: {} })
  expect(() => log.error('这行写不进去也不该抛')).not.toThrow()
})
