import { beforeEach, afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMORY_DOT_DIR } from './memoryNames'
import {
  PLANS_SUBDIR,
  clearAllPlanSlugs,
  generateWordSlug,
  getPlan,
  getPlanFilePath,
  getPlanSlug,
  getPlansDirectory,
  isSessionPlanFile,
} from './plans'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plans-'))
  clearAllPlanSlugs()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('计划文件白标落盘路径', () => {
  test('计划目录 = <root>/.billiardbuddy/plans(白标目录)且被建出来', () => {
    const dir = getPlansDirectory(root)
    expect(dir).toBe(join(root, MEMORY_DOT_DIR, PLANS_SUBDIR))
    expect(dir).toContain('.billiardbuddy')
    expect(dir).not.toContain('.claude')
    expect(existsSync(dir)).toBe(true)
  })

  test('主会话计划文件 = {plansDir}/{slug}.md;子代理带 -agent-<id>', () => {
    const main = getPlanFilePath(root, 'conv-1')
    expect(main.startsWith(getPlansDirectory(root))).toBe(true)
    expect(main.endsWith('.md')).toBe(true)
    const agent = getPlanFilePath(root, 'conv-1', 'agent-42')
    expect(agent).toContain('-agent-agent-42.md')
  })
})

describe('word slug', () => {
  test('generateWordSlug = 形容词-动词-名词', () => {
    const slug = generateWordSlug()
    expect(slug.split('-').length).toBe(3)
    expect(/^[a-z]+-[a-z]+-[a-z]+$/.test(slug)).toBe(true)
  })
})

describe('plan 写盘 + 从盘读 + 跨轮可引用', () => {
  test('模型写进计划文件后 getPlan 能从盘读回同一份正文', () => {
    const convId = 'conv-write-read'
    const filePath = getPlanFilePath(root, convId)
    const body = '# 计划\n1. 改 a.ts\n2. 跑测试'
    writeFileSync(filePath, body)
    expect(getPlan(root, convId)).toBe(body)
  })

  test('同一会话 slug 稳定:跨多轮拿到同一个计划文件路径(可跨轮引用)', () => {
    const convId = 'conv-stable'
    const p1 = getPlanFilePath(root, convId)
    const p2 = getPlanFilePath(root, convId)
    expect(p2).toBe(p1)
    const slug1 = getPlanSlug(root, convId)
    const slug2 = getPlanSlug(root, convId)
    expect(slug2).toBe(slug1)
  })

  test('不同会话拿到不同的计划文件(互不覆盖)', () => {
    const a = getPlanFilePath(root, 'conv-a')
    const b = getPlanFilePath(root, 'conv-b')
    expect(a).not.toBe(b)
  })

  test('计划文件不存在 → getPlan 返回 null(模型还没写计划)', () => {
    expect(getPlan(root, 'conv-empty')).toBeNull()
  })
})

describe('isSessionPlanFile(权限层 plan 写豁免用)', () => {
  test('绝对路径命中本会话计划文件 → true', () => {
    const convId = 'conv-perm'
    const filePath = getPlanFilePath(root, convId)
    expect(isSessionPlanFile(root, filePath, convId)).toBe(true)
  })

  test('相对路径解析到计划文件 → true;别的文件 → false', () => {
    const convId = 'conv-perm2'
    const filePath = getPlanFilePath(root, convId)
    const slug = getPlanSlug(root, convId)
    expect(isSessionPlanFile(root, join(MEMORY_DOT_DIR, PLANS_SUBDIR, `${slug}.md`), convId)).toBe(true)
    expect(isSessionPlanFile(root, 'src/index.ts', convId)).toBe(false)
    expect(filePath).toContain(slug)
  })
})
