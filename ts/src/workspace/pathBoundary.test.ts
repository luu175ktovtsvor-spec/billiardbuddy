import { test, expect } from 'bun:test'
import { resolve } from 'node:path'
import { resolveInWorkspace, WorkspaceBoundaryError } from './pathBoundary'

const ROOT = resolve('/tmp/ws-root')

test('resolves a relative path against the workspace root', () => {
  expect(resolveInWorkspace(ROOT, 'a/b.txt')).toBe(resolve(ROOT, 'a/b.txt'))
})

test('allows an absolute path that is inside the workspace', () => {
  expect(resolveInWorkspace(ROOT, resolve(ROOT, 'x.txt'))).toBe(resolve(ROOT, 'x.txt'))
})

test('allows internal ".." that stays inside the workspace', () => {
  expect(resolveInWorkspace(ROOT, 'a/../b.txt')).toBe(resolve(ROOT, 'b.txt'))
})

test('allows the root itself', () => {
  expect(resolveInWorkspace(ROOT, '.')).toBe(ROOT)
})

test('rejects ".." that escapes the workspace', () => {
  expect(() => resolveInWorkspace(ROOT, '../outside.txt')).toThrow(WorkspaceBoundaryError)
})

test('rejects an absolute path outside the workspace', () => {
  expect(() => resolveInWorkspace(ROOT, '/etc/passwd')).toThrow(WorkspaceBoundaryError)
})

test('rejects a sibling directory sharing a name prefix', () => {
  // root=/tmp/ws-root, target=/tmp/ws-root-evil must NOT be treated as inside
  expect(() => resolveInWorkspace(ROOT, resolve('/tmp/ws-root-evil/x'))).toThrow(WorkspaceBoundaryError)
})
