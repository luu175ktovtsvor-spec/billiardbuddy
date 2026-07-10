import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveBundledDir } from './bundledRoot'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bundled-root-')) })
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  delete process.env.QF_BUNDLED_DIR
})

test('QF_BUNDLED_DIR 覆盖最高优先(存在即用)', () => {
  const envRoot = join(root, 'envbundled')
  mkdirSync(join(envRoot, 'skills'), { recursive: true })
  process.env.QF_BUNDLED_DIR = envRoot
  // dev 候选也存在,但 env 覆盖优先
  const devReal = join(root, 'dev')
  mkdirSync(devReal, { recursive: true })
  expect(resolveBundledDir('skills', [devReal])).toBe(join(envRoot, 'skills'))
})

test('无 env 时:dev 候选按序命中第一个存在的', () => {
  const devA = join(root, 'a')
  const devB = join(root, 'b')
  mkdirSync(devB, { recursive: true }) // 只有 b 存在
  expect(resolveBundledDir('agents', [devA, devB])).toBe(devB)
})

test('全都不存在时回落到第一个 dev 候选(不抛错)', () => {
  const devA = join(root, 'missing-a')
  const devB = join(root, 'missing-b')
  expect(resolveBundledDir('commands', [devA, devB])).toBe(devA)
})

test('env 指向的目录不存在时不误用,继续找 dev 候选', () => {
  process.env.QF_BUNDLED_DIR = join(root, 'nonexistent')
  const devReal = join(root, 'realdev')
  mkdirSync(devReal, { recursive: true })
  expect(resolveBundledDir('skills', [devReal])).toBe(devReal)
})
