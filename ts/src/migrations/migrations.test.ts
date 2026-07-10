/**
 * 版本化迁移器行为对齐测试(#36 地基)。锁死 5 条必测行为:
 *   ① 版本按序执行(不管注册顺序,严格按 version 升序跑)
 *   ② 幂等 —— 重跑不重复(第二次跑一条不动、副作用只发生一次)
 *   ③ 已应用版本持久化(记进 <stateRoot>/migrations.json,新进程读得到、据此续跑)
 *   ④ 空注册表 / 首启不报错
 *   ⑤ 只跑 version > 已应用版本 的那些;某条抛错则停在它、不推进、不拖垮启动;非法注册表尽早抛
 */
import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertValidRegistry,
  currentSchemaVersion,
  migrationRecordPath,
  readAppliedVersion,
  runMigrations,
  writeAppliedVersion,
  MIGRATIONS,
  type Migration,
} from './index'

const dirs: string[] = []
function freshRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'bb-migrations-'))
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

/** 造一条记录「跑到自己时把 id push 进 log」的迁移。 */
function tracer(version: number, id: string, log: string[], onRun?: () => void): Migration {
  return {
    version,
    id,
    run: () => {
      log.push(id)
      onRun?.()
    },
  }
}

test('① 版本按序执行:不论注册顺序,严格按 version 升序跑', () => {
  const root = freshRoot()
  const log: string[] = []
  // 故意乱序注册:3,1,2
  const migrations = [tracer(3, 'c', log), tracer(1, 'a', log), tracer(2, 'b', log)]
  const result = runMigrations(root, migrations)
  expect(log).toEqual(['a', 'b', 'c'])
  expect(result.ran).toEqual(['a', 'b', 'c'])
  expect(result.fromVersion).toBe(0)
  expect(result.toVersion).toBe(3)
  expect(result.error).toBeUndefined()
})

test('② 幂等 —— 重跑不重复:第二次跑不再执行任何一条,副作用只发生一次', () => {
  const root = freshRoot()
  const log: string[] = []
  const migrations = [tracer(1, 'a', log), tracer(2, 'b', log)]

  const first = runMigrations(root, migrations)
  expect(first.ran).toEqual(['a', 'b'])
  expect(log).toEqual(['a', 'b'])

  const second = runMigrations(root, migrations)
  expect(second.ran).toEqual([]) // 一条没跑
  expect(second.fromVersion).toBe(2)
  expect(second.toVersion).toBe(2)
  expect(log).toEqual(['a', 'b']) // 副作用没再叠加
})

test('③ 已应用版本持久化:写进 <stateRoot>/migrations.json,新进程读得到并据此续跑', () => {
  const root = freshRoot()
  const log: string[] = []

  // 先只有版本 1、2 存在时跑一遍
  runMigrations(root, [tracer(1, 'a', log), tracer(2, 'b', log)])

  // 版本记录落盘且值 = 2
  const recordPath = migrationRecordPath(root)
  expect(existsSync(recordPath)).toBe(true)
  expect(JSON.parse(readFileSync(recordPath, 'utf8')).version).toBe(2)
  expect(readAppliedVersion(root)).toBe(2) // 模拟「新进程」重新读盘

  // 后来注册表新增版本 3(1、2 仍在),模拟下次启动:只有 3 会跑
  const log2: string[] = []
  const next = runMigrations(root, [
    tracer(1, 'a', log2),
    tracer(2, 'b', log2),
    tracer(3, 'c', log2),
  ])
  expect(next.fromVersion).toBe(2)
  expect(next.ran).toEqual(['c'])
  expect(log2).toEqual(['c'])
  expect(readAppliedVersion(root)).toBe(3)
})

test('④ 空注册表 / 首启都不报错', () => {
  const root = freshRoot()
  // 空注册表
  const empty = runMigrations(root, [])
  expect(empty.error).toBeUndefined()
  expect(empty.fromVersion).toBe(0)
  expect(empty.toVersion).toBe(0)
  expect(empty.ran).toEqual([])
  // 空注册表不该无谓写记录文件
  expect(existsSync(migrationRecordPath(root))).toBe(false)

  // 首启(全新 stateRoot、无记录)读版本 = 0,不抛
  const otherRoot = freshRoot()
  expect(readAppliedVersion(otherRoot)).toBe(0)
  expect(() => runMigrations(otherRoot, [tracer(1, 'a', [])])).not.toThrow()
})

test('⑤a 只跑 version > 已应用版本 的那些', () => {
  const root = freshRoot()
  writeAppliedVersion(root, 2) // 预置已应用到 2
  const log: string[] = []
  const result = runMigrations(root, [
    tracer(1, 'a', log),
    tracer(2, 'b', log),
    tracer(3, 'c', log),
    tracer(4, 'd', log),
  ])
  expect(result.fromVersion).toBe(2)
  expect(result.ran).toEqual(['c', 'd'])
  expect(log).toEqual(['c', 'd'])
  expect(readAppliedVersion(root)).toBe(4)
})

test('⑤b 某条抛错:停在它、不推进版本、不往后跑、不抛出(启动不崩)', () => {
  const root = freshRoot()
  const log: string[] = []
  const migrations = [
    tracer(1, 'a', log),
    {
      version: 2,
      id: 'boom',
      run: () => {
        throw new Error('炸了')
      },
    } satisfies Migration,
    tracer(3, 'c', log),
  ]
  let result!: ReturnType<typeof runMigrations>
  expect(() => {
    result = runMigrations(root, migrations)
  }).not.toThrow()
  expect(result.ran).toEqual(['a']) // 只有 1 成功
  expect(result.toVersion).toBe(1) // 没推进过 2
  expect(result.error?.id).toBe('boom')
  expect(result.error?.version).toBe(2)
  expect(log).toEqual(['a']) // 3 没跑(停在错误处)
  expect(readAppliedVersion(root)).toBe(1) // 落盘版本停在 1

  // 修好后重跑(把 boom 换成正常迁移):从 1 续跑 2、3,且 1 因幂等不再跑
  const log2: string[] = []
  const fixed = runMigrations(root, [
    tracer(1, 'a', log2),
    tracer(2, 'boom-fixed', log2),
    tracer(3, 'c', log2),
  ])
  expect(fixed.fromVersion).toBe(1)
  expect(fixed.ran).toEqual(['boom-fixed', 'c'])
  expect(log2).toEqual(['boom-fixed', 'c'])
  expect(readAppliedVersion(root)).toBe(3)
})

test('⑤c 非法注册表(重复 version / 非法 version)尽早抛', () => {
  const log: string[] = []
  expect(() => assertValidRegistry([tracer(1, 'a', log), tracer(1, 'b', log)])).toThrow(/重复/)
  expect(() => assertValidRegistry([tracer(0, 'z', log)])).toThrow(/非法/)
  expect(() => assertValidRegistry([tracer(1.5, 'f', log)])).toThrow(/非法/)
  // runMigrations 也在跑前校验
  const root = freshRoot()
  expect(() => runMigrations(root, [tracer(2, 'x', log), tracer(2, 'y', log)])).toThrow(/重复/)
})

test('currentSchemaVersion = 注册表最高 version(空 = 0);生产注册表合法', () => {
  const log: string[] = []
  expect(currentSchemaVersion([])).toBe(0)
  expect(currentSchemaVersion([tracer(3, 'c', log), tracer(1, 'a', log)])).toBe(3)
  // 生产注册表现为空(cc 具体迁移器不适用),且必须永远合法 → 用户运行期 runMigrations 绝不抛
  expect(MIGRATIONS.length).toBe(0)
  expect(() => assertValidRegistry(MIGRATIONS)).not.toThrow()
})

test('坏 / 缺 migrations.json 一律当版本 0(首启),不抛', () => {
  const root = freshRoot()
  // 写一个坏 JSON(freshRoot 已用 mkdtempSync 建好目录)
  const p = migrationRecordPath(root)
  writeFileSync(p, 'not-json{')
  // 坏文件 → 0
  expect(readAppliedVersion(root)).toBe(0)
})
