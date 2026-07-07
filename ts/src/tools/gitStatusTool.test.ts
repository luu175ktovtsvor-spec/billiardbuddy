import { afterEach, beforeEach, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from './Tool'
import { gitStatusTool } from './gitStatusTool'
import { Workspace } from '../workspace/workspace'

let root: string
let ctx: ToolContext

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-status-tool-'))
  ctx = { workspace: new Workspace(root) }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function git(args: string[]): void {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' })
}

function initRepo(): void {
  git(['init'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 1\n')
  git(['add', 'tracked.ts'])
  git(['commit', '-m', 'init'])
}

test('git_status reports non-git workspaces without throwing', async () => {
  const out = await gitStatusTool.execute({}, ctx)
  expect(out).toContain('<git_status is_git="false">')
})

test('git_status reports status, stat and bounded diff for workspace changes', async () => {
  initRepo()
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 2\n')
  writeFileSync(join(root, 'new.ts'), 'export const fresh = true\n')

  const out = await gitStatusTool.execute({ include_diff: true, max_diff_bytes: 200 }, ctx)
  expect(out).toContain('<git_status is_git="true"')
  expect(out).toContain('<summary files="2" staged="0" worktree="1" untracked="1" modified="1" added="0" deleted="0" renamed="0" copied="0" conflicted="0" clean="false" />')
  expect(out).toContain('<status>')
  expect(out).toContain(' M tracked.ts')
  expect(out).toContain('?? new.ts')
  expect(out).toContain('<diff_stat>')
  expect(out).toContain('tracked.ts')
  expect(out).toContain('<diff bytes=')
  expect(out).toContain('truncated="false"')
  expect(out).toContain('-export const value = 1')
  expect(out).toContain('+export const value = 2')
  expect(out).toContain('<untracked_files count="1"')
  expect(out).toContain('<file path="new.ts"')
  expect(out).toContain('export const fresh = true')
})

test('git_status can scope diff to workspace-relative paths and inspect staged changes', async () => {
  initRepo()
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 3\n')
  writeFileSync(join(root, 'src', 'other.ts'), 'export const other = 1\n')
  git(['add', 'tracked.ts'])

  const scoped = await gitStatusTool.execute({ include_diff: true, paths: ['tracked.ts'] }, ctx)
  expect(scoped).toContain('tracked.ts')
  expect(scoped).not.toContain('src/other.ts')

  const staged = await gitStatusTool.execute({ include_diff: true, staged: true }, ctx)
  expect(staged).toContain('staged="true"')
  expect(staged).toContain('+export const value = 3')
})

test('git_status accepts a single path string for scoped checks', async () => {
  initRepo()
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 4\n')
  writeFileSync(join(root, 'src', 'other.ts'), 'export const other = 1\n')

  const out = await gitStatusTool.execute({ include_diff: true, paths: 'tracked.ts' }, ctx)

  expect(out).toContain('tracked.ts')
  expect(out).not.toContain('src/other.ts')
  expect(out).toContain('+export const value = 4')
})

test('git_status can inspect staged and unstaged diffs together', async () => {
  initRepo()
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 2\n')
  git(['add', 'tracked.ts'])
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 3\n')

  const out = await gitStatusTool.execute({ include_diff: true, staged: 'both', max_diff_bytes: 1000 }, ctx)
  expect(out).toContain('staged="both"')
  expect(out).toContain('scope="both"')
  expect(out).toContain('<summary files="1" staged="1" worktree="1" untracked="0" modified="1"')
  expect(out).toContain('MM tracked.ts')
  expect(out).toContain('<diff_stat>')
  expect(out).toContain('<diff bytes=')
  expect(out).toContain('-export const value = 2')
  expect(out).toContain('+export const value = 3')
  expect(out).toContain('<staged_diff_stat>')
  expect(out).toContain('<staged_diff bytes=')
  expect(out).toContain('-export const value = 1')
  expect(out).toContain('+export const value = 2')
})

test('git_status truncates large diff bodies with a clear marker', async () => {
  initRepo()
  writeFileSync(join(root, 'tracked.ts'), `${readFileSync(join(root, 'tracked.ts'), 'utf8')}${'x'.repeat(1000)}\n`)

  const out = await gitStatusTool.execute({ include_diff: true, max_diff_bytes: 80 }, ctx)
  expect(out).toContain('<diff bytes="80" limit="80" truncated="true">')
})

test('git_status keeps a bounded diff prefix when git output exceeds process buffers', async () => {
  initRepo()
  writeFileSync(join(root, 'tracked.ts'), `export const value = "${'x'.repeat(450_000)}"\n`)

  const out = await gitStatusTool.execute({ include_diff: true, max_diff_bytes: 120 }, ctx)

  expect(out).toContain('<diff bytes="120" limit="120" truncated="true">')
  expect(out).toContain('diff --git')
  expect(out).not.toContain('stdout maxBuffer')
  expect(out).not.toContain('maxBuffer length exceeded')
})

test('git_status disables colored git diff output even when repo config forces color', async () => {
  initRepo()
  git(['config', 'color.ui', 'always'])
  writeFileSync(join(root, 'tracked.ts'), 'export const value = 5\n')

  const out = await gitStatusTool.execute({ include_diff: true, max_diff_bytes: 1000 }, ctx)

  expect(out).toContain('+export const value = 5')
  expect(out).not.toContain('\x1B')
})

test('git_status can disable or bound untracked file previews', async () => {
  initRepo()
  writeFileSync(join(root, 'new.ts'), `${'x'.repeat(100)}\n`)

  const disabled = await gitStatusTool.execute({ include_diff: true, include_untracked: false }, ctx)
  expect(disabled).not.toContain('<untracked_files')

  const bounded = await gitStatusTool.execute({ include_diff: true, max_untracked_bytes: 20 }, ctx)
  expect(bounded).toContain('<untracked_files count="1" bytes="20" limit="20" truncated="true">')
  expect(bounded).toContain('<file path="new.ts" size="101" bytes="20" truncated="true"')
})
