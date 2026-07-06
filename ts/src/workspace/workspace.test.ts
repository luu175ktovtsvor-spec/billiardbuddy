import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
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

test('resolve fullDiskAccess allows external paths but keeps TOCTOU write guards', () => {
  const externalRoot = realpathSync(mkdtempSync(join(tmpdir(), 'ws-full-')))
  const ws = new Workspace(root, { fullDiskAccess: true })
  expect(ws.resolve(join(externalRoot, 'any.txt'), 'write')).toBe(join(externalRoot, 'any.txt'))
  expect(() => ws.resolve(join(externalRoot, '*.txt'), 'write')).toThrow(PathValidationError)
  rmSync(externalRoot, { recursive: true, force: true })
})
