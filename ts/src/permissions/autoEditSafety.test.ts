import { expect, test } from 'bun:test'
import { isAbsolute, join } from 'node:path'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { Tool, ToolContext } from '../tools/Tool'
import { Workspace } from '../workspace/workspace'
import { resolvePermission } from './resolve'
import { autoEditSafetyReason, checkPathSafetyForAutoEdit } from './autoEditSafety'
import { MEMORY_DOT_DIR } from '../harness/memoryNames'

const ROOT = '/ws'
const abs = (p: string) => (isAbsolute(p) ? p : join(ROOT, p))

// —— checkPathSafetyForAutoEdit:cc DANGEROUS_FILES/DIRECTORIES + 绕过特征的刁钻边界 ——

test('普通工作区文件可自动放行', () => {
  expect(checkPathSafetyForAutoEdit(abs('src/app.ts')).safe).toBe(true)
  expect(checkPathSafetyForAutoEdit(abs('docs/notes.md')).safe).toBe(true)
})

test('cc DANGEROUS_DIRECTORIES 段命中(白标等价:.claude → .billiardbuddy) → 不安全', () => {
  for (const p of ['.git/config', '.vscode/settings.json', '.idea/workspace.xml', `${MEMORY_DOT_DIR}/settings.json`, 'sub/.git/hooks/pre-commit']) {
    expect(checkPathSafetyForAutoEdit(abs(p)).safe).toBe(false)
  }
})

test('cc DANGEROUS_FILES 文件名命中(白标等价:.claude.json → .billiardbuddy.json) → 不安全', () => {
  for (const p of ['.bashrc', '.zshrc', '.gitconfig', '.gitmodules', '.mcp.json', `${MEMORY_DOT_DIR}.json`, 'nested/.profile']) {
    expect(checkPathSafetyForAutoEdit(abs(p)).safe).toBe(false)
  }
})

test('白标等价物真实命中我们的项目配置目录:.billiardbuddy/settings.json 触发 acceptEdits 敏感路径闸', () => {
  const r = checkPathSafetyForAutoEdit(abs(join(MEMORY_DOT_DIR, 'settings.json')))
  expect(r.safe).toBe(false)
  expect(r.safe === false && r.classifierApprovable).toBe(true)
})

test('确认文案不露出底层来源字面值(不含 claude/Claude/Anthropic 字样)', () => {
  const r = checkPathSafetyForAutoEdit(abs(join(MEMORY_DOT_DIR, 'settings.json')))
  expect(r.safe).toBe(false)
  const message = r.safe === false ? r.message : ''
  expect(/claude|anthropic/i.test(message)).toBe(false)
  expect(message).toContain(MEMORY_DOT_DIR)
})

test('不在 cc 清单里的相邻文件不误杀(.gitignore/.env/普通 json)', () => {
  // cc 的自动编辑闸不含 .gitignore/.env/.ssh —— 严格按 cc 清单,不擅自扩大
  for (const p of ['.gitignore', '.env', 'config.json', 'package.json', 'gitconfig']) {
    expect(checkPathSafetyForAutoEdit(abs(p)).safe).toBe(true)
  }
})

test('大小写绕过被拦(.GIT / .BashRC)', () => {
  expect(checkPathSafetyForAutoEdit(abs('.GIT/config')).safe).toBe(false)
  expect(checkPathSafetyForAutoEdit(abs('.BashRC')).safe).toBe(false)
})

test('.billiardbuddy/worktrees/ 结构性路径放行,内嵌 .git 仍拦', () => {
  expect(checkPathSafetyForAutoEdit(abs(`${MEMORY_DOT_DIR}/worktrees/w1/src/a.ts`)).safe).toBe(true)
  expect(checkPathSafetyForAutoEdit(abs(`${MEMORY_DOT_DIR}/worktrees/w1/.git/config`)).safe).toBe(false)
})

test('Windows 路径规范化绕过特征 → 不安全且不可分类器放行', () => {
  for (const p of ['.git.', 'foo/.billiardbuddy ', 'settings.json.CON', 'GIT~1/x', '.../secret']) {
    const r = checkPathSafetyForAutoEdit(abs(p))
    expect(r.safe).toBe(false)
    expect(r.safe === false && r.classifierApprovable).toBe(false)
  }
})

test('危险配置文件返回 classifierApprovable=true(可经审批放行)', () => {
  const r = checkPathSafetyForAutoEdit(abs('.bashrc'))
  expect(r.safe === false && r.classifierApprovable).toBe(true)
})

// —— autoEditSafetyReason:按工具输入形状提取路径 ——

function ctxFor(): ToolContext {
  return { workspace: new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'auto-edit-')))), permissionMode: 'acceptEdits' }
}

test('autoEditSafetyReason 按 write_file/patch_files/notebook 输入取路径', () => {
  const ctx = ctxFor()
  expect(autoEditSafetyReason('write_file', { path: 'src/a.ts', content: 'x' }, ctx)).toBeNull()
  expect(autoEditSafetyReason('write_file', { path: '.bashrc', content: 'x' }, ctx)).not.toBeNull()
  expect(autoEditSafetyReason('NotebookEdit', { notebook_path: '.git/x.ipynb' }, ctx)).not.toBeNull()
  expect(autoEditSafetyReason('patch_files', { patches: [{ path: 'ok.ts' }, { path: '.git/config' }] }, ctx)).not.toBeNull()
  expect(autoEditSafetyReason('patch_files', { patches: [{ path: 'ok.ts' }] }, ctx)).toBeNull()
})

// —— resolvePermission 集成:acceptEdits + file 类 + 敏感路径 → ask ——

function fileTool(name: string): Tool {
  return {
    name,
    description: '',
    inputSchema: { type: 'object' },
    isReadOnly: false,
    requiresApproval: true,
    approvalClass: 'file',
    async execute() { return 'ran' },
  }
}

test('acceptEdits 档:普通路径 file 类自动放行,敏感路径退回 ask(safetyCheck)', () => {
  const ctx = ctxFor()
  const write = fileTool('write_file')
  expect(resolvePermission(write, { path: 'notes.txt', content: 'x' }, ctx).behavior).toBe('allow')

  const guarded = resolvePermission(write, { path: '.git/config', content: 'x' }, ctx)
  expect(guarded.behavior).toBe('ask')
  expect(guarded.behavior === 'ask' && guarded.reason?.type).toBe('safetyCheck')
})

test('bypassPermissions 不受自动编辑安全闸约束(与 cc 一致)', () => {
  const ctx: ToolContext = { workspace: new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'auto-edit-bypass-')))), permissionMode: 'bypassPermissions' }
  expect(resolvePermission(fileTool('write_file'), { path: '.git/config', content: 'x' }, ctx).behavior).toBe('allow')
})
