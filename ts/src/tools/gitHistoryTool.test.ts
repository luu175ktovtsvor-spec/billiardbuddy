import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './Tool'
import { gitHistoryTool } from './gitHistoryTool'
import { Workspace } from '../workspace/workspace'

let root: string
let ctx: ToolContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-history-tool-'))
  ctx = { workspace: new Workspace(root) }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function git(args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function commit(file: string, content: string, message: string): void {
  writeFileSync(join(root, file), content)
  git(['add', file])
  git(['commit', '-m', message])
}

function initRepo(): void {
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  commit('tracked.ts', 'export const value = 1\n', 'init tracked')
}

test('git_history reports non-git workspaces without throwing', async () => {
  const out = await gitHistoryTool.execute({}, ctx)
  expect(out).toContain('<git_history is_git="false">')
})

test('git_history lists recent commits with metadata', async () => {
  initRepo()
  commit('tracked.ts', 'export const value = 2\n', 'update tracked')

  const out = await gitHistoryTool.execute({ max_count: 2 }, ctx)
  expect(out).toContain('<git_history is_git="true" status="completed" rev="HEAD" count="2" patch="false">')
  expect(out).toContain('<commit sha=')
  expect(out).toContain('author="Test User"')
  expect(out).toContain('<title>\nupdate tracked\n</title>')
  expect(out).toContain('<title>\ninit tracked\n</title>')
})

test('git_history scopes commits and patch to workspace-relative paths', async () => {
  initRepo()
  mkdirSync(join(root, 'src'), { recursive: true })
  commit('src/other.ts', 'export const other = 1\n', 'add other')
  commit('tracked.ts', 'export const value = 3\n', 'update tracked again')

  const scoped = await gitHistoryTool.execute({ paths: ['src/other.ts'], max_count: 5 }, ctx)
  expect(scoped).toContain('add other')
  expect(scoped).not.toContain('update tracked again')

  const patch = await gitHistoryTool.execute({ rev: 'HEAD', include_patch: true, paths: ['tracked.ts'], max_patch_bytes: 2000 }, ctx)
  expect(patch).toContain('<patch bytes=')
  expect(patch).toContain('tracked.ts')
  expect(patch).not.toContain('src/other.ts')
})

test('git_history truncates large patches with a clear marker', async () => {
  initRepo()
  commit('tracked.ts', `${'x'.repeat(1000)}\n`, 'large patch')

  const out = await gitHistoryTool.execute({ include_patch: true, max_patch_bytes: 120 }, ctx)
  expect(out).toContain('limit="120" truncated="true"')
})

test('git_history rejects option-like or whitespace revs', async () => {
  initRepo()

  const option = await gitHistoryTool.execute({ rev: '--all' }, ctx)
  expect(option).toContain('status="invalid_rev"')

  const spaced = await gitHistoryTool.execute({ rev: 'HEAD --all' }, ctx)
  expect(spaced).toContain('status="invalid_rev"')
})
