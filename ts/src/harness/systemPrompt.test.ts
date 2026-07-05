import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { buildSystemPrompt } from './systemPrompt'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ws-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

test('buildSystemPrompt injects the <env> block with the workspace root', async () => {
  const ws = new Workspace(root)
  const prompt = await buildSystemPrompt(ws)
  expect(prompt).toContain('<env>')
  expect(prompt).toContain(`Working directory: ${ws.root}`)
})

test('buildSystemPrompt never leaks a model name (白标)', async () => {
  const prompt = (await buildSystemPrompt(new Workspace(root))).toLowerCase()
  expect(prompt).not.toContain('claude')
  expect(prompt).not.toContain('gpt')
})
