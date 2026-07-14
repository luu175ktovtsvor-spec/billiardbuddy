import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  scanMemoryFiles,
  formatMemoryManifest,
  parseSelectedFilenames,
  findRelevantMemories,
  readMemoriesForSurfacing,
  buildRelevantMemoriesReminder,
  collectSurfacedMemories,
  computeRelevantMemoryInjection,
  SELECT_MEMORIES_SYSTEM_PROMPT,
  type MemorySelector,
} from './relevantMemories'

let memdir: string
beforeEach(() => {
  memdir = mkdtempSync(join(tmpdir(), 'memdir-'))
})
afterEach(() => {
  rmSync(memdir, { recursive: true, force: true })
})

test('memory selector mechanics use English', () => {
  expect(SELECT_MEMORIES_SYSTEM_PROMPT).toContain('Return at most 5 memory file names')
  expect(SELECT_MEMORIES_SYSTEM_PROMPT).not.toContain('请返回最多')
})

function writeMemory(name: string, description: string, type: string, body: string): void {
  const content = `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`
  writeFileSync(join(memdir, `${name}.md`), content, 'utf8')
}

test('scanMemoryFiles reads frontmatter headers and excludes MEMORY.md', async () => {
  writeMemory('golden_hours', '黄金档台费与时段', 'project', '晚7-11点台费每小时TESTFEE。')
  writeMemory('owner_profile', '店主画像', 'user', '社区台球房店主,最看重晚间获客。')
  writeFileSync(join(memdir, 'MEMORY.md'), '# MEMORY\n- [x](golden_hours.md) — 黄金档台费\n', 'utf8')

  const headers = await scanMemoryFiles(memdir)
  const names = headers.map(h => h.filename).sort()
  expect(names).toEqual(['golden_hours.md', 'owner_profile.md'])
  const golden = headers.find(h => h.filename === 'golden_hours.md')!
  expect(golden.description).toBe('黄金档台费与时段')
  expect(golden.type).toBe('project')
})

test('scanMemoryFiles returns [] for missing dir', async () => {
  expect(await scanMemoryFiles(join(memdir, 'does-not-exist'))).toEqual([])
})

test('formatMemoryManifest renders one line per file with type + description', async () => {
  writeMemory('golden_hours', '黄金档台费', 'project', 'x')
  const headers = await scanMemoryFiles(memdir)
  const manifest = formatMemoryManifest(headers)
  expect(manifest).toContain('[project] golden_hours.md')
  expect(manifest).toContain('黄金档台费')
})

test('parseSelectedFilenames extracts JSON array; falls back to substring match', () => {
  const valid = new Set(['golden_hours.md', 'owner_profile.md'])
  expect(parseSelectedFilenames('["golden_hours.md"]', valid)).toEqual(['golden_hours.md'])
  expect(parseSelectedFilenames('好的,我选 ["owner_profile.md","golden_hours.md"]', valid)).toEqual(['owner_profile.md', 'golden_hours.md'])
  // 无 JSON 时按出现顺序子串匹配
  expect(parseSelectedFilenames('我觉得 golden_hours.md 最相关', valid)).toEqual(['golden_hours.md'])
  // 只返回合法文件名(过滤幻觉)
  expect(parseSelectedFilenames('["ghost.md"]', valid)).toEqual([])
})

test('findRelevantMemories: side model picks top files, mapped to abs paths', async () => {
  writeMemory('golden_hours', '黄金档台费', 'project', '晚7-11点台费每小时TESTFEE。')
  writeMemory('owner_profile', '店主画像', 'user', 'x')
  const select: MemorySelector = async ({ manifest }) => {
    // 断言小模型确实拿到清单(含描述),然后选一个
    expect(manifest).toContain('黄金档台费')
    return '["golden_hours.md"]'
  }
  const relevant = await findRelevantMemories('今晚黄金档定价多少', memdir, select)
  expect(relevant.length).toBe(1)
  expect(relevant[0]!.path).toBe(join(memdir, 'golden_hours.md'))
})

test('readMemoriesForSurfacing reads body; truncates by bytes with note', async () => {
  const big = 'A'.repeat(9000)
  writeMemory('golden_hours', '黄金档台费', 'project', big)
  const relevant = await findRelevantMemories('黄金档台费多少', memdir, async () => '["golden_hours.md"]')
  const surfaced = await readMemoriesForSurfacing(relevant)
  expect(surfaced.length).toBe(1)
  expect(surfaced[0]!.content).toContain('This memory was truncated')
  expect(Buffer.byteLength(surfaced[0]!.content, 'utf8')).toBeLessThan(9000)
})

test('buildRelevantMemoriesReminder wraps each with a de-dup marker', () => {
  const reminder = buildRelevantMemoriesReminder([
    { path: '/mem/golden_hours.md', content: '台费TESTFEE', mtimeMs: Date.parse('2026-07-01') },
  ])
  expect(reminder).toContain('The system recalled the following entries from persistent memory')
  expect(reminder).toContain('<recalled-memory path="/mem/golden_hours.md"')
  expect(reminder).toContain('台费TESTFEE')
})

test('collectSurfacedMemories finds prior injected paths for cross-turn de-dup', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\n<recalled-memory path="/mem/golden_hours.md" saved="2026-07-01">\n台费\n</recalled-memory>\n</system-reminder>' }] },
  ]
  const { paths } = collectSurfacedMemories(messages)
  expect(paths.has('/mem/golden_hours.md')).toBe(true)
})

test('computeRelevantMemoryInjection: end-to-end recall, skips already-surfaced', async () => {
  writeMemory('golden_hours', '黄金档台费', 'project', '晚7-11点台费每小时TESTFEE。')
  const select: MemorySelector = async () => '["golden_hours.md"]'

  const first = await computeRelevantMemoryInjection({
    query: '今晚黄金档定价多少',
    memoryDir: memdir,
    select,
    messages: [{ role: 'user', content: [{ type: 'text', text: '今晚黄金档定价多少' }] }],
  })
  expect(first).not.toBeNull()
  expect(first!.reminder).toContain('TESTFEE')
  expect(first!.surfaced[0]!.path).toBe(join(memdir, 'golden_hours.md'))

  // 第二轮:历史里已注入该路径 → 不再重复召回
  const historyWithInjection = [
    { role: 'user', content: [{ type: 'text', text: '今晚黄金档定价多少' }] },
    { role: 'user', content: [{ type: 'text', text: first!.reminder }] },
  ]
  const second = await computeRelevantMemoryInjection({
    query: '再确认下黄金档台费',
    memoryDir: memdir,
    select,
    messages: historyWithInjection,
  })
  expect(second).toBeNull()
})

test('computeRelevantMemoryInjection skips too-short queries', async () => {
  writeMemory('golden_hours', '黄金档台费', 'project', 'x')
  const out = await computeRelevantMemoryInjection({
    query: '?',
    memoryDir: memdir,
    select: async () => '["golden_hours.md"]',
    messages: [],
  })
  expect(out).toBeNull()
})
