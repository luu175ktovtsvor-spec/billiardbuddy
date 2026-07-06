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

test('系统提示含白标 anti-reveal(不点名任何模型)', async () => {
  const prompt = await buildSystemPrompt(new Workspace(root))
  expect(prompt).toContain('不报任何模型名') // anti-reveal 在
  expect(prompt).toContain('模型') // 有"绝不透露…模型…"这类话
  // 仍守 W2 白标硬约束:整段不出现 claude/gpt 字面
  const lower = prompt.toLowerCase()
  expect(lower).not.toContain('claude')
  expect(lower).not.toContain('gpt')
})

test('系统提示含"谨慎执行动作" + 拒绝处理', async () => {
  const prompt = await buildSystemPrompt(new Workspace(root))
  expect(prompt).toContain('可不可逆') // actions section
  expect(prompt).toContain('波及面') // blast radius
  expect(prompt).toContain('别用完全一样的参数再试') // denial rule
})
