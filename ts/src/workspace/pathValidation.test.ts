import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  expandTilde,
  isDangerousRemovalPath,
  isVulnerableUncPath,
  PathValidationError,
  validatePath,
} from './pathValidation'
import { WorkspaceBoundaryError } from './pathBoundary'

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'w3-pv-')))
const HOME = '/Users/tester'

describe('expandTilde', () => {
  test('~ 与 ~/ 展开到 home', () => {
    expect(expandTilde('~', HOME, 'darwin')).toBe(HOME)
    expect(expandTilde('~/a/b', HOME, 'darwin')).toBe(`${HOME}/a/b`)
  })
  test('~user 不展开(原样返回,交由 validatePath 拒)', () => {
    expect(expandTilde('~root/.ssh', HOME, 'darwin')).toBe('~root/.ssh')
  })
})

describe('isVulnerableUncPath', () => {
  test('win 上识别 \\\\server\\share 与 //server/share', () => {
    expect(isVulnerableUncPath('\\\\server\\share', 'win32')).toBe(true)
    expect(isVulnerableUncPath('//evil.com/x', 'win32')).toBe(true)
  })
  test('URL(https://)不误判为 UNC', () => {
    expect(isVulnerableUncPath('https://x.com/a', 'win32')).toBe(false)
  })
  test('非 win 平台一律 false(UNC 是 Windows 概念)', () => {
    expect(isVulnerableUncPath('\\\\server\\share', 'darwin')).toBe(false)
  })
})

describe('isDangerousRemovalPath', () => {
  test('根 / home / 盘符根 / 根直接子级 / * 命中', () => {
    expect(isDangerousRemovalPath('/', HOME)).toBe(true)
    expect(isDangerousRemovalPath(HOME, HOME)).toBe(true)
    expect(isDangerousRemovalPath('C:\\', HOME)).toBe(true)
    expect(isDangerousRemovalPath('/etc', HOME)).toBe(true)
    expect(isDangerousRemovalPath('*', HOME)).toBe(true)
    expect(isDangerousRemovalPath('/some/dir/*', HOME)).toBe(true)
  })
  test('工作区内深路径不命中', () => {
    expect(isDangerousRemovalPath(`${HOME}/proj/src/a.ts`, HOME)).toBe(false)
  })
})

describe('validatePath', () => {
  const base = { root: ROOT, home: HOME } as const

  test('普通相对路径放行,a/../b 停区内合法', () => {
    expect(validatePath('a/b.txt', { ...base, operation: 'read' })).toBe(join(ROOT, 'a/b.txt'))
    expect(validatePath('a/../b.txt', { ...base, operation: 'write' })).toBe(join(ROOT, 'b.txt'))
  })
  test('逃出工作区 → WorkspaceBoundaryError', () => {
    expect(() => validatePath('../escape', { ...base, operation: 'read' })).toThrow(WorkspaceBoundaryError)
  })
  test('UNC(win)→ PathValidationError', () => {
    expect(() => validatePath('\\\\srv\\c', { ...base, operation: 'read', platform: 'win32' })).toThrow(
      PathValidationError,
    )
  })
  test('~user 变体 → PathValidationError', () => {
    expect(() => validatePath('~root/.ssh/id_rsa', { ...base, operation: 'read' })).toThrow(PathValidationError)
  })
  test('shell 展开语法 $ % = → PathValidationError', () => {
    expect(() => validatePath('$HOME/x', { ...base, operation: 'read' })).toThrow(PathValidationError)
    expect(() => validatePath('%TEMP%\\x', { ...base, operation: 'read' })).toThrow(PathValidationError)
    expect(() => validatePath('=rg', { ...base, operation: 'read' })).toThrow(PathValidationError)
  })
  test('写/create 含 glob → 拒;读含 glob → 放行(工具按字面读)', () => {
    expect(() => validatePath('logs/*.txt', { ...base, operation: 'write' })).toThrow(PathValidationError)
    expect(validatePath('logs/a.txt', { ...base, operation: 'read' })).toBe(join(ROOT, 'logs/a.txt'))
  })
})
