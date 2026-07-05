import { test, expect, beforeEach, afterEach } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeEnvInfo, getIsGit, getGitStatus } from './env'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('computeEnvInfo emits an <env> block with workspace/platform/OS', () => {
  const block = computeEnvInfo({ workspaceRoot: '/tmp/demo', isGit: true })
  expect(block).toContain('<env>')
  expect(block).toContain('</env>')
  expect(block).toContain('Working directory: /tmp/demo')
  expect(block).toContain('Is directory a git repo: Yes')
  expect(block).toContain(`Platform: ${process.platform}`)
})

test('computeEnvInfo never leaks a model name (白标)', () => {
  const block = computeEnvInfo({ workspaceRoot: '/tmp/demo', isGit: false })
  expect(block.toLowerCase()).not.toContain('claude')
  expect(block.toLowerCase()).not.toContain('gpt')
  expect(block.toLowerCase()).not.toContain('mimo')
})

test('getIsGit/getGitStatus reflect a real git repo', async () => {
  execFileSync('git', ['init'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 't@t.co'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 't'], { cwd: root })
  writeFileSync(join(root, 'f.txt'), 'x')
  execFileSync('git', ['add', '.'], { cwd: root })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: root })
  expect(await getIsGit(root)).toBe(true)
  const status = await getGitStatus(root)
  expect(status).toContain('git status at the start of the conversation')
  expect(status).toContain('Current branch:')
  expect(status).toContain('init') // 近提交里有 init
})

test('getGitStatus returns null outside a git repo', async () => {
  expect(await getIsGit(root)).toBe(false)
  expect(await getGitStatus(root)).toBeNull()
})
