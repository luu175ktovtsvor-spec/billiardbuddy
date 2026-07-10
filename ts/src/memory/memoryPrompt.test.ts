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
  expect(p).toContain('记忆的四种类型')
})

test('memory prompt has what-not-to-save, when-to-access, trusting-recall sections', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('不该存进记忆的东西')
  expect(p).toContain('何时去访问记忆')
  expect(p).toContain('据记忆给建议之前')
  // 不该存:代码/架构/git 派生
  expect(p).toContain('git log')
})

test('how-to-save points at the save_memory tool (not manual file writes)', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('save_memory')
  expect(p).toContain('怎么存记忆')
})

test('end-of-turn extraction fallback: prompt tells model to evaluate + save durable facts', () => {
  // 对齐 cc 后台 extractMemories 的意图(这轮没手写记忆时也别漏耐久事实)——轻量兜底走系统提示。
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).toContain('回合结束前')
  expect(p).toContain('耐久事实')
  expect(p).toContain('save_memory')
})

test('searching-past-context section greps the (white-label) memdir', () => {
  const p = buildMemorySystemPrompt(ROOT)
  const memdir = getAutoMemDir(ROOT)
  expect(p).toContain('搜索过往上下文')
  expect(p).toContain(memdir)
  expect(p).toContain('grep -rn')
})

test('white-label: no CLAUDE.md / .claude / Claude branding leaks', () => {
  const p = buildMemorySystemPrompt(ROOT)
  expect(p).not.toContain('CLAUDE.md')
  expect(p).not.toContain('.claude')
  expect(p).not.toContain('Claude')
})
