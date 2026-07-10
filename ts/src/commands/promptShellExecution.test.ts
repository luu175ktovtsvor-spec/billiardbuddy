import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from '../tools/Tool'
import { loadCommandFile } from './commandLoader'
import { loadSkillFile } from '../skills/skillLoader'
import { executeShellCommandsInPrompt, substitutePromptTemplateVars } from './promptShellExecution'

function makeCtx(root: string): ToolContext {
  return { workspace: new Workspace(root), conversationId: 'sess-42' }
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'prompt-shell-'))
}

// ─── 行为对齐 cc utils/promptShellExecution.ts ───

test('内联 !`命令`:只读命令自动放行、输出回填原位', async () => {
  const root = tempRoot()
  try {
    const out = await executeShellCommandsInPrompt('当前分支是 !`echo main-branch` 哦', makeCtx(root), '/test')
    expect(out).toBe('当前分支是 main-branch 哦')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('代码块 ```! 命令 ```:整块替换为输出', async () => {
  const root = tempRoot()
  try {
    const text = '状态:\n```!\necho line1 && echo line2\n```\n完'
    const out = await executeShellCommandsInPrompt(text, makeCtx(root), '/test')
    expect(out).toBe('状态:\nline1\nline2\n完')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('内联 lookbehind:行内代码 span 的 `!` 与 shell $! 不误触发(对齐 cc INLINE_PATTERN)', async () => {
  const root = tempRoot()
  try {
    // `foo`!`bar` 中 ! 前是反引号非空白 → 不匹配;文本无变化
    const tricky = '代码 `foo`!`bar` 与变量 $! 都不该执行'
    expect(await executeShellCommandsInPrompt(tricky, makeCtx(root), '/test')).toBe(tricky)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('嵌套引号命令能整条执行(对齐 cc 行为测试点)', async () => {
  const root = tempRoot()
  try {
    const out = await executeShellCommandsInPrompt(`值: !\`echo "he said 'hi'"\``, makeCtx(root), '/test')
    expect(out).toBe(`值: he said 'hi'`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('shell 输出含 $& 等替换记号不被 String.replace 腐蚀(对齐 cc 函数式 replacer)', async () => {
  const root = tempRoot()
  try {
    // 带 $ 的命令被替换风险分类保守判为 outreach(护栏行为),用 allowedTools 显式放行;输出为 $&$$pre$
    const out = await executeShellCommandsInPrompt("x: !`printf '\\044&\\044\\044pre\\044'`", makeCtx(root), '/test', {
      allowedTools: ['run_command(printf:*)'],
    })
    expect(out).toBe('x: $&$$pre$')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('非只读命令未被 allowedTools 覆盖 → 抛权限错误(展开失败,不静默)', async () => {
  const root = tempRoot()
  try {
    await expect(
      executeShellCommandsInPrompt('危险: !`touch newfile.txt`', makeCtx(root), '/test'),
    ).rejects.toThrow(/permission check failed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('frontmatter allowedTools 临时放行嵌入命令且不污染原 ctx(对齐 cc alwaysAllowRules 合并)', async () => {
  const root = tempRoot()
  try {
    const ctx = makeCtx(root)
    const out = await executeShellCommandsInPrompt('写文件: !`touch ok.txt`', ctx, '/test', {
      allowedTools: ['run_command(touch:*)'],
    })
    expect(out).toBe('写文件: ')
    const { existsSync } = await import('node:fs')
    expect(existsSync(join(root, 'ok.txt'))).toBe(true)
    expect(ctx.sessionAllowedToolRules ?? []).toHaveLength(0)
    expect(ctx.sessionAllowedTools).toBeUndefined()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('命令执行失败(非零退出码)→ 抛错让整次展开失败(对齐 cc formatBashError)', async () => {
  const root = tempRoot()
  try {
    await expect(
      executeShellCommandsInPrompt('坏: !`ls nonexistent-dir-xyz`', makeCtx(root), '/test'),
    ).rejects.toThrow(/Shell command failed/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('substitutePromptTemplateVars:${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID} 替换,缺值原样保留', () => {
  expect(substitutePromptTemplateVars('dir=${CLAUDE_SKILL_DIR} sess=${CLAUDE_SESSION_ID}', { skillDir: '/a/b', sessionId: 's1' }))
    .toBe('dir=/a/b sess=s1')
  expect(substitutePromptTemplateVars('dir=${CLAUDE_SKILL_DIR}', {})).toBe('dir=${CLAUDE_SKILL_DIR}')
})

// ─── 两个 loader 的端到端接线 ───

test('命令 loader:正文内嵌 !`…` 与 ${CLAUDE_SESSION_ID} 在 getPrompt 时真展开', async () => {
  const root = tempRoot()
  try {
    const cmdPath = join(root, 'branchinfo.md')
    writeFileSync(cmdPath, '---\ndescription: 测试\n---\n会话 ${CLAUDE_SESSION_ID} 里执行,输出 !`echo from-command`')
    const command = await loadCommandFile(cmdPath)
    const prompt = await command.getPrompt('', makeCtx(root))
    expect(prompt).toContain('会话 sess-42 里执行,输出 from-command')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('技能 loader:${CLAUDE_SKILL_DIR} 指向技能目录、内嵌命令执行;mcp 来源绝不执行(安全门)', async () => {
  const root = tempRoot()
  try {
    const skillDir = join(root, 'my-skill')
    const skillPath = join(skillDir, 'SKILL.md')
    writeFileSync(join(root, '.keep'), '')
    const { mkdirSync } = await import('node:fs')
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(skillPath, '---\nname: my-skill\ndescription: 测试\n---\n目录=${CLAUDE_SKILL_DIR}\n输出 !`echo from-skill`')
    const skill = await loadSkillFile(skillPath, 'skills')
    const prompt = await skill.getPrompt('', makeCtx(root))
    expect(prompt).toContain(`目录=${skillDir}`)
    expect(prompt).toContain('输出 from-skill')
    // 同一文件按 mcp 来源加载:内嵌命令原样保留、绝不执行(对齐 cc loadedFrom==='mcp' 安全门)
    const mcpSkill = await loadSkillFile(skillPath, 'mcp')
    const mcpPrompt = await mcpSkill.getPrompt('', makeCtx(root))
    expect(mcpPrompt).toContain('输出 !`echo from-skill`')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
