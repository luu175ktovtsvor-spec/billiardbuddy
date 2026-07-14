import { test, expect } from 'bun:test'
import { buildMemorySystemPrompt } from './memoryPrompt'
import { getAutoMemDir } from '../harness/memoryNames'

const ROOT = '/tmp/some-workspace-root'

test('memory prompt contains the four-type taxonomy', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('<name>user')
  expect(p).toContain('<name>feedback')
  expect(p).toContain('<name>project')
  expect(p).toContain('<name>reference')
  expect(p).toContain('Types of memory')
})

test('memory prompt has what-not-to-save, when-to-access, trusting-recall sections', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('What not to save in memory')
  expect(p).toContain('When to access memory')
  expect(p).toContain('Before giving advice from memory')
  // 不该存:代码/架构/git 派生
  expect(p).toContain('git log')
})

test('how-to-save points at the save_memory tool (not manual file writes)', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('save_memory')
  expect(p).toContain('How to save memories')
})

test('end-of-turn extraction fallback: prompt tells model to evaluate + save durable facts', () => {
  // 对齐 cc 后台 extractMemories 的意图(这轮没手写记忆时也别漏耐久事实)——轻量兜底走系统提示。
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('Before ending a turn')
  expect(p).toContain('durable user, feedback, project, or reference fact')
  expect(p).toContain('save_memory')
})

test('searching-past-context section greps the (white-label) memdir', () => {
  const p = buildMemorySystemPrompt(ROOT)
  const memdir = getAutoMemDir(ROOT)
  expect(p).toContain('Searching past context')
  expect(p).toContain(memdir)
  expect(p).toContain('grep -rn')
})

test('white-label: no CLAUDE.md / .claude / Claude branding leaks', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).not.toContain('CLAUDE.md')
  expect(p).not.toContain('.claude')
  expect(p).not.toContain('Claude')
})

test('memory mechanics are English-first and project memory is domain-neutral', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('# Persistent memory (across sessions)')
  expect(p).toContain('<name>project</name>')
  expect(p).toContain('ongoing work, goals, initiatives, bugs, incidents, or decisions')
  expect(p).not.toContain('门店近况')
  expect(p).not.toContain('台球')
})
