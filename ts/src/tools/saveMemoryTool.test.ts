import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { getAutoMemDir, getAutoMemEntrypoint } from '../harness/memoryNames'
import { loadMemoryInjection } from '../harness/claudemd'
import type { ToolContext } from './Tool'
import { saveMemoryTool } from './saveMemoryTool'

const ENV_KEYS = ['BILLIARDBUDDY_CONFIG_DIR', 'BILLIARDBUDDY_DISABLE_AUTO_MEMORY'] as const

let root: string
let userDir: string
let saved: Record<string, string | undefined>

function ctx(): ToolContext {
  return { workspace: new Workspace(root) } as ToolContext
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bb-mem-ws-'))
  userDir = mkdtempSync(join(tmpdir(), 'bb-mem-cfg-'))
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.BILLIARDBUDDY_CONFIG_DIR = userDir
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(root, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
})

test('保存记忆:写带 frontmatter 的 .md + MEMORY.md 一行索引,落在 memdir', async () => {
  const out = await saveMemoryTool.execute(
    { name: '黄金档台费', type: 'project', content: '黄金档台费 68 元一小时,会员充值满 1000 送 120。', description: '黄金档定价' },
    ctx(),
  )
  expect(out).toContain('已记住')

  const memDir = getAutoMemDir(root)
  const topic = readFileSync(join(memDir, '黄金档台费.md'), 'utf8')
  expect(topic).toContain('name: 黄金档台费')
  expect(topic).toContain('type: project')
  expect(topic).toContain('黄金档台费 68 元一小时')

  const index = readFileSync(getAutoMemEntrypoint(root), 'utf8')
  expect(index).toContain('- [黄金档台费](黄金档台费.md) — 黄金档定价')
})

test('读写对齐:save_memory 写的记忆能被 loadMemoryInjection 读回并注入', async () => {
  await saveMemoryTool.execute(
    { name: '店主偏好', type: 'feedback', content: '文案别写太长,别用绝对化广告词。' },
    ctx(),
  )
  const injected = await loadMemoryInjection(new Workspace(root))
  expect(injected).not.toBeNull()
  expect(injected!).toContain("auto-memory, persists across conversations")
  expect(injected!).toContain('店主偏好')
})

test('同名覆盖更新:不产生重复索引行', async () => {
  await saveMemoryTool.execute({ name: '台费', type: 'project', content: '旧:60 元' }, ctx())
  await saveMemoryTool.execute({ name: '台费', type: 'project', content: '新:68 元' }, ctx())
  const index = readFileSync(getAutoMemEntrypoint(root), 'utf8')
  const hits = index.split('\n').filter(l => l.includes('](台费.md)'))
  expect(hits.length).toBe(1)
  const topic = readFileSync(join(getAutoMemDir(root), '台费.md'), 'utf8')
  expect(topic).toContain('新:68 元')
  expect(topic).not.toContain('旧:60 元')
})

test('forget=true 删除记忆文件与索引行', async () => {
  await saveMemoryTool.execute({ name: '临时', type: 'project', content: '要删掉的' }, ctx())
  expect(existsSync(join(getAutoMemDir(root), '临时.md'))).toBe(true)

  const out = await saveMemoryTool.execute({ name: '临时', forget: true }, ctx())
  expect(out).toContain('已忘掉')
  expect(existsSync(join(getAutoMemDir(root), '临时.md'))).toBe(false)
  const index = readFileSync(getAutoMemEntrypoint(root), 'utf8')
  expect(index).not.toContain('](临时.md)')
})

test('缺 content(非 forget)拒绝保存,给出可自救的错误文本', async () => {
  const out = await saveMemoryTool.execute({ name: '空的', type: 'project' }, ctx())
  expect(out).toContain('必须给出 content')
  expect(existsSync(getAutoMemEntrypoint(root))).toBe(false)
})

test('非法 type 兜底为 project(不失败)', async () => {
  await saveMemoryTool.execute({ name: 'x', type: '乱写的', content: '内容' }, ctx())
  const topic = readFileSync(join(getAutoMemDir(root), 'x.md'), 'utf8')
  expect(topic).toContain('type: project')
})

test('恶意 name(路径穿越)不逃出 memdir', async () => {
  const out = await saveMemoryTool.execute({ name: '../../evil', type: 'project', content: 'x' }, ctx())
  // slug 会剥掉分隔符与前后点,落在 memdir 内;绝不写到父目录。
  expect(existsSync(join(root, '..', 'evil.md'))).toBe(false)
  expect(out).toContain('已记住')
  const memDir = getAutoMemDir(root)
  const index = readFileSync(getAutoMemEntrypoint(root), 'utf8')
  expect(index).toContain('](')
  expect(readFileSync(getAutoMemEntrypoint(root), 'utf8')).toBeDefined()
  expect(existsSync(memDir)).toBe(true)
})
