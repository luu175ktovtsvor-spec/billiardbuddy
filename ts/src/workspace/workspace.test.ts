import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Workspace } from './workspace'
import { WorkspaceBoundaryError } from './pathBoundary'

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
