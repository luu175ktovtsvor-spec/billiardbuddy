import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import {
  getClaudeMds,
  getMemoryFiles,
  loadConditionalRulesForPath,
  loadMemoryInjection,
  stripHtmlComments,
  type MemoryType,
} from './claudemd'
import { getAutoMemDir, getAutoMemEntrypoint, MEMORY_DOT_DIR } from './memoryNames'
import { buildSystemPrompt } from './systemPrompt'

// 四层加载靠 env 覆盖把 User / Managed 目录指到临时目录,保证测试确定、不读真实 ~/.billiardbuddy。
const ENV_KEYS = [
  'BILLIARDBUDDY_CONFIG_DIR',
  'BILLIARDBUDDY_MANAGED_DIR',
  'BILLIARDBUDDY_DISABLE_MEMORY',
  'BILLIARDBUDDY_DISABLE_USER_MEMORY',
  'BILLIARDBUDDY_DISABLE_PROJECT_MEMORY',
  'BILLIARDBUDDY_DISABLE_LOCAL_MEMORY',
  'BILLIARDBUDDY_DISABLE_MANAGED_MEMORY',
  'BILLIARDBUDDY_DISABLE_AUTO_MEMORY',
] as const

let root: string
let userDir: string
let managedDir: string
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bb-ws-'))
  userDir = mkdtempSync(join(tmpdir(), 'bb-user-'))
  managedDir = mkdtempSync(join(tmpdir(), 'bb-managed-'))
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  // 默认把 User/Managed 指到临时目录(单测隔离);各测试按需写文件。
  process.env.BILLIARDBUDDY_CONFIG_DIR = userDir
  process.env.BILLIARDBUDDY_MANAGED_DIR = managedDir
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  rmSync(root, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
  rmSync(managedDir, { recursive: true, force: true })
})

function write(dir: string, rel: string, content: string): void {
  const abs = join(dir, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function typesOf(files: { type: MemoryType }[]): MemoryType[] {
  return files.map(f => f.type)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 四层加载顺序:Managed → User → Project(根到 CWD 逐级)→ Local
// ─────────────────────────────────────────────────────────────────────────────

test('四层全部加载,顺序 = Managed → User → Project → Local(反优先级)', async () => {
  writeFileSync(join(managedDir, 'BILLIARDBUDDY.md'), 'MANAGED-CONTENT')
  writeFileSync(join(userDir, 'BILLIARDBUDDY.md'), 'USER-CONTENT')
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'PROJECT-CONTENT')
  writeFileSync(join(root, 'BILLIARDBUDDY.local.md'), 'LOCAL-CONTENT')

  const files = await getMemoryFiles(new Workspace(root))
  expect(typesOf(files)).toEqual(['Managed', 'User', 'Project', 'Local'])

  const injected = getClaudeMds(files)
  // 越靠后优先级越高 → Local 在最后。
  expect(injected.indexOf('MANAGED-CONTENT')).toBeLessThan(injected.indexOf('USER-CONTENT'))
  expect(injected.indexOf('USER-CONTENT')).toBeLessThan(injected.indexOf('PROJECT-CONTENT'))
  expect(injected.indexOf('PROJECT-CONTENT')).toBeLessThan(injected.indexOf('LOCAL-CONTENT'))
})

test('Project 层从项目根到 CWD 逐级加载,根在前(低优先)子目录在后(高优先)', async () => {
  const sub = join(root, 'packages', 'app')
  mkdirSync(sub, { recursive: true })
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'ROOT-RULE')
  writeFileSync(join(sub, 'BILLIARDBUDDY.md'), 'APP-RULE')

  const files = await getMemoryFiles(new Workspace(root), { cwd: sub })
  const injected = getClaudeMds(files)
  expect(injected.indexOf('ROOT-RULE')).toBeLessThan(injected.indexOf('APP-RULE'))
})

test('.billiardbuddy/BILLIARDBUDDY.md 与根 BILLIARDBUDDY.md 都作 Project 层加载', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'FLAT-PROJECT')
  write(root, join(MEMORY_DOT_DIR, 'BILLIARDBUDDY.md'), 'DOTDIR-PROJECT')
  const files = await getMemoryFiles(new Workspace(root))
  const contents = files.map(f => f.content)
  expect(contents).toContain('FLAT-PROJECT')
  expect(contents).toContain('DOTDIR-PROJECT')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. @import 递归 + 循环去重 + 深度上限(5)
// ─────────────────────────────────────────────────────────────────────────────

test('@import 递归引入,被引入文件排在引入者之前(parent before children 顺序)', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'ROOT sees @./child.md here')
  writeFileSync(join(root, 'child.md'), 'CHILD-BODY')
  const files = await getMemoryFiles(new Workspace(root))
  const contents = files.map(f => f.content)
  expect(contents.some(c => c.includes('CHILD-BODY'))).toBe(true)
  // 主文件先入,child 紧随其后(cc:主文件先 push,再 push includes)。
  const rootIdx = files.findIndex(f => f.content.includes('ROOT sees'))
  const childIdx = files.findIndex(f => f.content.includes('CHILD-BODY'))
  expect(rootIdx).toBeGreaterThanOrEqual(0)
  expect(childIdx).toBe(rootIdx + 1)
  // child 带 parent 指回主文件。
  expect(files[childIdx]!.parent).toBe(join(root, 'BILLIARDBUDDY.md'))
})

test('@import 循环引用去重(A→B→A 只各加载一次)', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'A-BODY imports @./b.md')
  writeFileSync(join(root, 'b.md'), 'B-BODY imports @./BILLIARDBUDDY.md back')
  const files = await getMemoryFiles(new Workspace(root))
  const aCount = files.filter(f => f.content.includes('A-BODY')).length
  const bCount = files.filter(f => f.content.includes('B-BODY')).length
  expect(aCount).toBe(1)
  expect(bCount).toBe(1)
})

test('@import 深度上限 5:第 5 层(depth=5)不再加载', async () => {
  // 主(depth0)→ L1(1)→ L2(2)→ L3(3)→ L4(4)→ L5(5,应被丢)
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'MAIN @./l1.md')
  writeFileSync(join(root, 'l1.md'), 'LVL1 @./l2.md')
  writeFileSync(join(root, 'l2.md'), 'LVL2 @./l3.md')
  writeFileSync(join(root, 'l3.md'), 'LVL3 @./l4.md')
  writeFileSync(join(root, 'l4.md'), 'LVL4 @./l5.md')
  writeFileSync(join(root, 'l5.md'), 'LVL5-SHOULD-BE-DROPPED')
  const files = await getMemoryFiles(new Workspace(root))
  const contents = files.map(f => f.content).join('\n')
  expect(contents).toContain('LVL4')
  expect(contents).not.toContain('LVL5-SHOULD-BE-DROPPED')
})

test('@import 在代码围栏 / 行内代码里不被当作引入', async () => {
  writeFileSync(
    join(root, 'BILLIARDBUDDY.md'),
    ['normal @./real.md loads', '', '```', '@./fenced.md should NOT load', '```', '', 'inline `@./inline.md` should NOT load'].join('\n'),
  )
  writeFileSync(join(root, 'real.md'), 'REAL-LOADED')
  writeFileSync(join(root, 'fenced.md'), 'FENCED-NOPE')
  writeFileSync(join(root, 'inline.md'), 'INLINE-NOPE')
  const files = await getMemoryFiles(new Workspace(root))
  const contents = files.map(f => f.content).join('\n')
  expect(contents).toContain('REAL-LOADED')
  expect(contents).not.toContain('FENCED-NOPE')
  expect(contents).not.toContain('INLINE-NOPE')
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. 条件规则 paths glob(编辑匹配路径时按需加载;不随目录 eager 加载)
// ─────────────────────────────────────────────────────────────────────────────

test('带 paths frontmatter 的条件规则不进 eager 加载(getMemoryFiles 不含它)', async () => {
  write(root, join(MEMORY_DOT_DIR, 'rules', 'ts-only.md'), '---\npaths: src/**\n---\nTS-RULE-BODY')
  write(root, join(MEMORY_DOT_DIR, 'rules', 'always.md'), 'ALWAYS-RULE-BODY')
  const files = await getMemoryFiles(new Workspace(root))
  const contents = files.map(f => f.content).join('\n')
  // 无条件规则 eager 进;条件规则(有 paths)不进。
  expect(contents).toContain('ALWAYS-RULE-BODY')
  expect(contents).not.toContain('TS-RULE-BODY')
})

test('条件规则:目标路径命中 paths glob 时按需加载,不命中不加载', async () => {
  write(root, join(MEMORY_DOT_DIR, 'rules', 'ts-only.md'), '---\npaths: src/**\n---\nTS-RULE-BODY')
  const ws = new Workspace(root)

  const matched = await loadConditionalRulesForPath(ws, join(root, 'src', 'foo.ts'))
  expect(matched.map(f => f.content).join('\n')).toContain('TS-RULE-BODY')
  expect(matched[0]!.globs).toEqual(['src'])

  const unmatched = await loadConditionalRulesForPath(ws, join(root, 'docs', 'foo.md'))
  expect(unmatched.map(f => f.content).join('\n')).not.toContain('TS-RULE-BODY')
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. HTML 注释剥离(块级剥、代码内保留、行内保留、残余保留)
// ─────────────────────────────────────────────────────────────────────────────

test('stripHtmlComments:块级注释整段剥离', () => {
  const { content, stripped } = stripHtmlComments('before\n<!-- secret note -->\nafter')
  expect(stripped).toBe(true)
  expect(content).not.toContain('secret note')
  expect(content).toContain('before')
  expect(content).toContain('after')
})

test('stripHtmlComments:代码围栏内的注释保留', () => {
  const src = ['```', '<!-- keep me in code -->', '```'].join('\n')
  const { content } = stripHtmlComments(src)
  expect(content).toContain('keep me in code')
})

test('stripHtmlComments:段落内行内注释保留(只剥独占一行的块级注释)', () => {
  const { content } = stripHtmlComments('text before <!-- inline --> text after')
  expect(content).toContain('inline')
})

test('stripHtmlComments:块级注释同行 --> 之后的残余保留', () => {
  const { content } = stripHtmlComments('<!-- note --> Use bun test')
  expect(content).not.toContain('note')
  expect(content).toContain('Use bun test')
})

test('注入内容里块级注释被剥掉(getMemoryFiles 走 parseMemoryFileContent)', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'keep this\n<!-- DROP THIS COMMENT -->\nkeep that')
  const files = await getMemoryFiles(new Workspace(root))
  const content = files.find(f => f.type === 'Project')!.content
  expect(content).not.toContain('DROP THIS COMMENT')
  expect(content).toContain('keep this')
  expect(content).toContain('keep that')
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. frontmatter 剥离
// ─────────────────────────────────────────────────────────────────────────────

test('frontmatter 从注入内容里剥掉', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), '---\ndescription: meta\n---\nVISIBLE-BODY')
  const files = await getMemoryFiles(new Workspace(root))
  const content = files.find(f => f.type === 'Project')!.content
  expect(content).toContain('VISIBLE-BODY')
  expect(content).not.toContain('description: meta')
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. 注入格式(MEMORY_INSTRUCTION_PROMPT 前缀 + 每文件类型描述)
// ─────────────────────────────────────────────────────────────────────────────

test('getClaudeMds 格式:OVERRIDE 前缀 + 每层带类型描述', async () => {
  writeFileSync(join(userDir, 'BILLIARDBUDDY.md'), 'U')
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'P')
  writeFileSync(join(root, 'BILLIARDBUDDY.local.md'), 'L')
  const injected = getClaudeMds(await getMemoryFiles(new Workspace(root)))
  expect(injected).toContain('These instructions OVERRIDE any default behavior')
  expect(injected).toContain("(user's private global instructions for all projects)")
  expect(injected).toContain('(project instructions, checked into the codebase)')
  expect(injected).toContain("(user's private project instructions, not checked in)")
  expect(injected).toContain('Contents of ')
})

test('无任何记忆文件时 loadMemoryInjection 返回 null', async () => {
  const out = await loadMemoryInjection(new Workspace(root))
  expect(out).toBeNull()
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. User 层真的进主会话(核心缺口:~/.billiardbuddy/BILLIARDBUDDY.md → 系统提示)
// ─────────────────────────────────────────────────────────────────────────────

test('User 层全局指令真的进系统提示(核心缺口修复的证据)', async () => {
  writeFileSync(join(userDir, 'BILLIARDBUDDY.md'), 'USER-GLOBAL-MARKER-XYZ 全局规则')
  const prompt = await buildSystemPrompt(new Workspace(root))
  expect(prompt).toContain('USER-GLOBAL-MARKER-XYZ')
  expect(prompt).toContain('These instructions OVERRIDE any default behavior')
})

test('注入前缀/描述本身不含品牌字样(白标)', async () => {
  writeFileSync(join(userDir, 'BILLIARDBUDDY.md'), '纯中文全局规则,无敏感词')
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), '纯中文项目规则')
  const injected = (getClaudeMds(await getMemoryFiles(new Workspace(root)))).toLowerCase()
  expect(injected).not.toContain('claude')
  expect(injected).not.toContain('gpt')
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. excludes glob + 各层开关
// ─────────────────────────────────────────────────────────────────────────────

test('claudeMdExcludes:命中的 Project 文件被跳过', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'SHOULD-BE-EXCLUDED')
  const excluded = join(root, 'BILLIARDBUDDY.md').replaceAll('\\', '/')
  const files = await getMemoryFiles(new Workspace(root), { excludes: [excluded] })
  expect(files.map(f => f.content).join('\n')).not.toContain('SHOULD-BE-EXCLUDED')
})

test('各层可关:关掉 User 层则其内容不注入', async () => {
  writeFileSync(join(userDir, 'BILLIARDBUDDY.md'), 'USER-OFF-MARKER')
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'PROJECT-ON-MARKER')
  const files = await getMemoryFiles(new Workspace(root), { sources: { userSettings: false } })
  const contents = files.map(f => f.content).join('\n')
  expect(contents).not.toContain('USER-OFF-MARKER')
  expect(contents).toContain('PROJECT-ON-MARKER')
})

test('环境变量 BILLIARDBUDDY_DISABLE_MEMORY 全关', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'ANY-CONTENT')
  process.env.BILLIARDBUDDY_DISABLE_MEMORY = '1'
  const files = await getMemoryFiles(new Workspace(root))
  expect(files).toEqual([])
})

// ─────────────────────────────────────────────────────────────────────────────
// 9. 不认 CLAUDE.md / AGENTS.md(白标:运行时只认 BILLIARDBUDDY.md)
// ─────────────────────────────────────────────────────────────────────────────

test('运行时不加载 CLAUDE.md / AGENTS.md(只认 BILLIARDBUDDY.md)', async () => {
  writeFileSync(join(root, 'CLAUDE.md'), 'CLAUDE-SHOULD-NOT-LOAD')
  writeFileSync(join(root, 'AGENTS.md'), 'AGENTS-SHOULD-NOT-LOAD')
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'BILLIARDBUDDY-LOADS')
  const contents = (await getMemoryFiles(new Workspace(root))).map(f => f.content).join('\n')
  expect(contents).toContain('BILLIARDBUDDY-LOADS')
  expect(contents).not.toContain('CLAUDE-SHOULD-NOT-LOAD')
  expect(contents).not.toContain('AGENTS-SHOULD-NOT-LOAD')
})

// ─────────────────────────────────────────────────────────────────────────────
// 10. AutoMem:模型自主写的记忆池(memdir/MEMORY.md)读回注入(与 save_memory 工具读写对齐)
// ─────────────────────────────────────────────────────────────────────────────

test('AutoMem 索引(memdir/MEMORY.md)作为最后一层注入,描述为 auto-memory', async () => {
  const memDir = getAutoMemDir(root)
  mkdirSync(memDir, { recursive: true })
  writeFileSync(getAutoMemEntrypoint(root), '# MEMORY\n\n- [黄金档台费](golden.md) — 黄金档台费 68 元一小时\n')

  const files = await getMemoryFiles(new Workspace(root))
  expect(typesOf(files)).toContain('AutoMem')
  // AutoMem 永远在最后(优先级最高一侧,cc 头部注释顺序)。
  expect(files[files.length - 1]!.type).toBe('AutoMem')

  const injected = getClaudeMds(files)
  expect(injected).toContain("auto-memory, persists across conversations")
  expect(injected).toContain('黄金档台费 68 元一小时')
})

test('memdir 记忆目录在 getUserConfigHomeDir() 下的 projects/<slug>/memory(白标 .billiardbuddy,不落 .claude)', () => {
  const dir = getAutoMemDir(root)
  expect(dir).toContain(userDir) // = BILLIARDBUDDY_CONFIG_DIR
  expect(dir.endsWith(join('memory'))).toBe(true)
  expect(dir).not.toContain('.claude')
})

test('BILLIARDBUDDY_DISABLE_AUTO_MEMORY=1 时不注入 AutoMem,但主指令四层照常', async () => {
  writeFileSync(join(root, 'BILLIARDBUDDY.md'), 'PROJECT-STILL-LOADS')
  const memDir = getAutoMemDir(root)
  mkdirSync(memDir, { recursive: true })
  writeFileSync(getAutoMemEntrypoint(root), '# MEMORY\n\n- [x](x.md) — AUTOMEM-CONTENT\n')

  process.env.BILLIARDBUDDY_DISABLE_AUTO_MEMORY = '1'
  const files = await getMemoryFiles(new Workspace(root))
  expect(typesOf(files)).not.toContain('AutoMem')
  const injected = getClaudeMds(files)
  expect(injected).toContain('PROJECT-STILL-LOADS')
  expect(injected).not.toContain('AUTOMEM-CONTENT')
})
