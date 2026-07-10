import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceNameError, createNamedWorkspace, validateWorkspaceName } from './workspaceProvision'

test('validateWorkspaceName:合法名(含中文/空格/连接符)通过并 trim', () => {
  expect(validateWorkspaceName('  门店 A-店 ')).toBe('门店 A-店')
  expect(validateWorkspaceName('project_1')).toBe('project_1')
})

test('validateWorkspaceName:非法名一律抛 WorkspaceNameError', () => {
  for (const bad of ['', '   ', '..', 'a..b', 'a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'con', 'PRN', 'x'.repeat(200), '结尾点.']) {
    expect(() => validateWorkspaceName(bad)).toThrow(WorkspaceNameError)
  }
  expect(() => validateWorkspaceName(123 as never)).toThrow(WorkspaceNameError)
})

test('createNamedWorkspace:建目录 + 初始化项目记忆(BILLIARDBUDDY.md + .billiardbuddy)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ws-base-'))
  try {
    const r = await createNamedWorkspace(base, '我的门店')
    expect(r.path).toBe(join(base, '我的门店'))
    expect(r.name).toBe('我的门店')
    expect(existsSync(r.path)).toBe(true)
    expect(existsSync(join(r.path, '.billiardbuddy'))).toBe(true)
    const memo = readFileSync(join(r.path, 'BILLIARDBUDDY.md'), 'utf8')
    expect(memo).toContain('我的门店')
    expect(memo).toContain('不会失忆')
    // 白标:欢迎记忆里绝不出现 Claude/.claude。
    expect(memo.toLowerCase()).not.toContain('claude')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('createNamedWorkspace:重名自动加序号(-2)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ws-base-'))
  try {
    const a = await createNamedWorkspace(base, '重名')
    const b = await createNamedWorkspace(base, '重名')
    expect(a.name).toBe('重名')
    expect(b.name).toBe('重名-2')
    expect(existsSync(b.path)).toBe(true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('createNamedWorkspace:防路径穿越(分隔符/.. 名字直接拒)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ws-base-'))
  try {
    await expect(createNamedWorkspace(base, '../逃逸')).rejects.toThrow(WorkspaceNameError)
    await expect(createNamedWorkspace(base, 'a/b')).rejects.toThrow(WorkspaceNameError)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
