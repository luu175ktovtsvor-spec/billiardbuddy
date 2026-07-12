import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookIfConditionMatches } from './hookIf'
import { normalizeHookRegistry } from './hookConfig'
import { runHookEvent } from './hooks'
import { Workspace } from '../workspace/workspace'

const WS = '/tmp/ws'

test('hookIfConditionMatches:命令类按命令模式(规范名 Bash↔内部名 run_command 归一)', () => {
  // 工具名匹配(Bash 规范名 → run_command 内部名),命令前缀命中
  expect(hookIfConditionMatches('Bash(git *)', 'run_command', { command: 'git status' }, WS)).toBe(true)
  expect(hookIfConditionMatches('Bash(git *)', 'run_command', { command: 'npm run build' }, WS)).toBe(false)
  // 只有工具名、无内容 → 工具名匹配即真
  expect(hookIfConditionMatches('Bash', 'run_command', { command: 'anything' }, WS)).toBe(true)
  // 工具名不匹配 → 假
  expect(hookIfConditionMatches('Bash(git *)', 'write_file', { path: 'a.txt' }, WS)).toBe(false)
  // 通配工具名 * + 命令内容
  expect(hookIfConditionMatches('*', 'run_command', { command: 'x' }, WS)).toBe(true)
})

test('hookIfConditionMatches:文件类按路径 glob(Edit↔edit_file/write_file)', () => {
  expect(hookIfConditionMatches('Write(*.env)', 'write_file', { path: '.env' }, WS)).toBe(true)
  expect(hookIfConditionMatches('Write(*.env)', 'write_file', { path: 'src/app.ts' }, WS)).toBe(false)
  // 带内容但工具无命令/路径可匹配 → 保守 false
  expect(hookIfConditionMatches('Bash(git *)', 'run_command', {}, WS)).toBe(false)
})

test('runHookEvent:带 if 的 PreToolUse hook 按工具输入过滤(命中才跑,不命中不跑)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hookif-'))
  try {
    const ctx = { workspace: new Workspace(root), conversationId: 's1' }
    const reg = normalizeHookRegistry({
      hooks: { PreToolUse: [{ matcher: 'run_command', if: 'Bash(git *)', hooks: [{ decision: { action: 'deny', message: 'git 被拦' } }] }] },
    })
    // git 命令 → 命中 → hook 运行 → deny
    expect(await runHookEvent(reg, { event: 'PreToolUse', toolName: 'run_command', input: { command: 'git push' } }, ctx as never))
      .toEqual([{ action: 'deny', message: 'git 被拦' }])
    // 非 git 命令 → if 不命中 → hook 不运行
    expect(await runHookEvent(reg, { event: 'PreToolUse', toolName: 'run_command', input: { command: 'ls' } }, ctx as never))
      .toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test('fail-closed(对齐 cc):非工具事件带 if → 整条 hook 不跑(不是忽略 if 照跑)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hookif-nonevent-'))
  try {
    const ctx = { workspace: new Workspace(root), conversationId: 's1' }
    // 直接构造 HookRule(非工具事件 SessionStart/Notification/Stop + 带 if)
    for (const event of ['SessionStart', 'Notification', 'Stop'] as const) {
      const reg = { rules: [{ event, ifCondition: 'Bash(git *)', handler: () => ({ action: 'context' as const, additionalContext: 'SHOULD_NOT_RUN' }) }] }
      const decisions = await runHookEvent(reg, { event, sessionId: 's1', sessionSource: event === 'SessionStart' ? 'startup' : undefined }, ctx as never)
      expect(decisions).toEqual([]) // 非工具事件无法求值 if → 整条不跑
    }
    // 经真实 cc-schema hooks.json(if 挂单个 hook 对象)→ normalizeHookRegistry → SessionStart 也不跑
    const fromJson = normalizeHookRegistry({
      hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi', if: 'Bash(*)', decision: { action: 'context', additionalContext: 'MARKER' } }] }] },
    })
    const d = await runHookEvent(fromJson, { event: 'SessionStart', sessionSource: 'startup', sessionId: 's1' }, ctx as never)
    expect(d).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
