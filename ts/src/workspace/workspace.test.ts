import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Workspace } from './workspace'
import { WorkspaceBoundaryError } from './pathBoundary'
import { PathValidationError } from './pathValidation'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('resolve() delegates to the workspace boundary', () => {
  const ws = new Workspace(root)
  expect(ws.resolve('a.txt')).toBe(resolve(root, 'a.txt'))
  expect(() => ws.resolve('../evil')).toThrow(WorkspaceBoundaryError)
})

test('resolve() blocks an in-workspace symlink that escapes the workspace', () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ws-ext-')))
  try {
    writeFileSync(join(externalRoot, 'secret.txt'), 'top secret')
    symlinkSync(externalRoot, join(root, 'link')) // <root>/link -> 工作区外目录
    const ws = new Workspace(root)
    // 读:跟随 symlink 会逃出工作区,应拒(纯字符串边界看不出,symlink 解析后拦下)
    expect(() => ws.resolve('link/secret.txt', 'read')).toThrow(WorkspaceBoundaryError)
    // 写:即使是新建文件,父级 symlink 逃逸也应拒
    expect(() => ws.resolve('link/new.txt', 'write')).toThrow(WorkspaceBoundaryError)
  } finally {
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('resolve() allows an in-workspace symlink that stays inside the workspace', () => {
  mkdirSync(join(root, 'real'))
  writeFileSync(join(root, 'real', 'a.txt'), 'x')
  symlinkSync(join(root, 'real'), join(root, 'inner')) // <root>/inner -> <root>/real(区内)
  const ws = new Workspace(root)
  expect(ws.resolve('inner/a.txt', 'read')).toBe(resolve(root, 'inner', 'a.txt'))
})

test('fullDiskAccess workspace does not apply the symlink-escape guard', () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ws-fda-')))
  try {
    writeFileSync(join(externalRoot, 'x.txt'), 'x')
    symlinkSync(externalRoot, join(root, 'link'))
    const ws = new Workspace(root, { fullDiskAccess: true })
    expect(ws.resolve('link/x.txt', 'read')).toBe(resolve(root, 'link', 'x.txt'))
  } finally {
    rmSync(externalRoot, { recursive: true, force: true })
  }
})

test('backup() copies an existing file into .backups before overwrite', async () => {
  const ws = new Workspace(root)
  const target = join(root, 'report.txt')
  writeFileSync(target, 'OLD')
  await ws.backup(target)
  const backups = readdirSync(join(root, '.backups'))
  expect(backups.length).toBe(1)
  expect(readFileSync(join(root, '.backups', backups[0]!), 'utf8')).toBe('OLD')
})

test('backup() is a no-op for a not-yet-existing file', async () => {
  const ws = new Workspace(root)
  await ws.backup(join(root, 'new.txt'))
  expect(existsSync(join(root, '.backups'))).toBe(false)
})

test('resolve 写操作拒 glob;读操作放行', () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-ws-'))))
  expect(() => ws.resolve('out/*.txt', 'write')).toThrow(PathValidationError)
  expect(ws.resolve('out/a.txt', 'read')).toBe(join(ws.root, 'out/a.txt'))
})

test('resolve 默认 read、a/../b 停区内合法(后向兼容 W2)', () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-ws-'))))
  expect(ws.resolve('a/../b.txt')).toBe(join(ws.root, 'b.txt'))
})

test('resolve allows explicitly selected external files and directories', () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ws-external-')))
  const file = join(externalRoot, 'picked.txt')
  const dir = join(externalRoot, 'picked-dir')
  writeFileSync(file, 'picked')
  writeFileSync(join(externalRoot, 'other.txt'), 'other')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'missing-parent.txt'), 'placeholder')
  const ws = new Workspace(root, { allowedPaths: [file, dir] })

  expect(ws.resolve(file)).toBe(file)
  expect(ws.resolve(join(dir, 'child.txt'), 'write')).toBe(join(dir, 'child.txt'))
  expect(() => ws.resolve(join(externalRoot, 'other.txt'))).toThrow(WorkspaceBoundaryError)
  rmSync(externalRoot, { recursive: true, force: true })
})

test('withAllowedPaths preserves existing external grants and adds new ones', () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ws-allowed-')))
  const first = join(externalRoot, 'first')
  const second = join(externalRoot, 'second')
  mkdirSync(first, { recursive: true })
  mkdirSync(second, { recursive: true })
  const ws = new Workspace(root, { allowedPaths: [first] })
  const widened = ws.withAllowedPaths([second])

  expect(widened.resolve(join(first, 'a.txt'), 'write')).toBe(join(first, 'a.txt'))
  expect(widened.resolve(join(second, 'b.txt'), 'write')).toBe(join(second, 'b.txt'))
  rmSync(externalRoot, { recursive: true, force: true })
})

test('fullDiskAccess 标记公开只读可读(Sandbox.isOsSandboxActive 要联动它,见 sandbox/sandbox.ts)', () => {
  expect(new Workspace(root).fullDiskAccess).toBe(false)
  expect(new Workspace(root, { fullDiskAccess: true }).fullDiskAccess).toBe(true)
})

test('resolve fullDiskAccess allows external paths but keeps TOCTOU write guards', () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ws-full-')))
  const ws = new Workspace(root, { fullDiskAccess: true })
  expect(ws.resolve(join(externalRoot, 'any.txt'), 'write')).toBe(join(externalRoot, 'any.txt'))
  expect(() => ws.resolve(join(externalRoot, '*.txt'), 'write')).toThrow(PathValidationError)
  rmSync(externalRoot, { recursive: true, force: true })
})
