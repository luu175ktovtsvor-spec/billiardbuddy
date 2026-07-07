import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import {
  applyPostToolUseHooks,
  applyPreToolUseHooks,
  applySessionStartHooks,
  applyStopHooks,
  applySubagentStartHooks,
  applyUserPromptSubmitHooks,
  mergeHookRegistries,
  parseHookDecisionJSON,
  runHookEvent,
  type HookRegistry,
} from './hooks'

const ctx = () => ({ workspace: new Workspace(mkdtempSync(join(tmpdir(), 'hooks-'))) })

test('parseHookDecisionJSON:解析 allow/deny/modify/context,非法返回 null', () => {
  expect(parseHookDecisionJSON('{"action":"allow"}')).toEqual({ action: 'allow', message: undefined })
  expect(parseHookDecisionJSON('{"action":"deny","message":"no"}')).toEqual({ action: 'deny', message: 'no' })
  expect(parseHookDecisionJSON('{"action":"modify","updatedInput":{"x":1}}')).toEqual({ action: 'modify', updatedInput: { x: 1 }, message: undefined })
  expect(parseHookDecisionJSON('{"action":"context","additionalContext":"note"}')).toEqual({ action: 'context', additionalContext: 'note' })
  expect(parseHookDecisionJSON('bad')).toBeNull()
})

test('runHookEvent:按事件和 matcher 执行,hook 抛错 fail-closed deny', async () => {
  const c = ctx()
  try {
    const decisions = await runHookEvent({
      rules: [
        { event: 'PreToolUse', matcher: 'read_file', handler: () => ({ action: 'allow' }) },
        { event: 'PreToolUse', matcher: 'write_file', handler: () => ({ action: 'deny', message: 'blocked' }) },
        { event: 'PostToolUse', handler: () => ({ action: 'context', additionalContext: 'skip' }) },
        { event: 'PreToolUse', matcher: 'read_file', handler: () => { throw new Error('boom') } },
      ],
    }, { event: 'PreToolUse', toolName: 'read_file', input: {} }, c)
    expect(decisions).toEqual([
      { action: 'allow', message: undefined },
      { action: 'deny', message: 'hook PreToolUse 执行失败:boom' },
    ])
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyPreToolUseHooks:modify 之后可追加 context;deny 立即停止', async () => {
  const c = ctx()
  try {
    const modified = await applyPreToolUseHooks({
      rules: [
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'modify', updatedInput: { path: 'b.txt' } }) },
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'context', additionalContext: '已改参' }) },
      ],
    }, 'read_file', { path: 'a.txt' }, c)
    expect(modified).toEqual({ input: { path: 'b.txt' }, additionalContext: ['已改参'] })

    const denied = await applyPreToolUseHooks({
      rules: [
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'deny', message: 'nope' }) },
        { event: 'PreToolUse', matcher: '*', handler: () => ({ action: 'modify', updatedInput: {} }) },
      ],
    }, 'read_file', { path: 'a.txt' }, c)
    expect(denied).toEqual({ input: { path: 'a.txt' }, deniedMessage: 'nope', additionalContext: [] })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applySessionStartHooks:context 注入,deny 退化为警告上下文', async () => {
  const c = ctx()
  try {
    const result = await applySessionStartHooks({
      rules: [
        { event: 'SessionStart', handler: payload => ({ action: 'context', additionalContext: `session:${payload.sessionId}` }) },
        { event: 'SessionStart', handler: () => ({ action: 'deny', message: 'bad startup hook' }) },
      ],
    }, { ...c, conversationId: 's1' })
    expect(result).toEqual({
      additionalContext: ['session:s1', '[SessionStart hook 警告] bad startup hook'],
    })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyUserPromptSubmitHooks:modify/context/deny', async () => {
  const c = ctx()
  try {
    const modified = await applyUserPromptSubmitHooks({
      rules: [
        { event: 'UserPromptSubmit', handler: payload => ({ action: 'modify', updatedInput: `${payload.userPrompt} + hook` }) },
        { event: 'UserPromptSubmit', handler: () => ({ action: 'context', additionalContext: '用户输入补充上下文' }) },
      ],
    }, '原始输入', c)
    expect(modified).toEqual({
      userPrompt: '原始输入 + hook',
      additionalContext: ['用户输入补充上下文'],
    })

    const denied = await applyUserPromptSubmitHooks({
      rules: [
        { event: 'UserPromptSubmit', handler: () => ({ action: 'deny', message: 'blocked prompt' }) },
        { event: 'UserPromptSubmit', handler: () => ({ action: 'modify', updatedInput: 'never' }) },
      ],
    }, '原始输入', c)
    expect(denied).toEqual({ userPrompt: '原始输入', deniedMessage: 'blocked prompt', additionalContext: [] })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyPostToolUseHooks:context 注入,deny 退化为警告上下文', async () => {
  const c = ctx()
  try {
    const result = await applyPostToolUseHooks({
      rules: [
        { event: 'PostToolUse', matcher: 'read_file', handler: payload => ({ action: 'context', additionalContext: `out:${payload.output}` }) },
        { event: 'PostToolUse', matcher: 'read_file', handler: () => ({ action: 'deny', message: 'post failed closed' }) },
      ],
    }, 'read_file', { path: 'a.txt' }, 'payload', c)
    expect(result).toEqual({
      additionalContext: ['out:payload', '[PostToolUse hook 警告] post failed closed'],
    })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('applyStopHooks:final output 可用于生成收尾上下文', async () => {
  const c = ctx()
  try {
    const result = await applyStopHooks({
      rules: [
        { event: 'Stop', handler: payload => ({ action: 'context', additionalContext: `final:${payload.output}` }) },
        { event: 'Stop', handler: () => ({ action: 'deny', message: 'stop warning' }) },
      ],
    }, '完成', c)
    expect(result).toEqual({
      additionalContext: ['final:完成', '[Stop hook 警告] stop warning'],
    })
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('SubagentStart/SubagentStop:按 agentType matcher 派发并携带 agent id', async () => {
  const c = ctx()
  try {
    const registry: HookRegistry = {
      rules: [
        { event: 'SubagentStart' as const, matcher: 'researcher', handler: payload => ({ action: 'context' as const, additionalContext: `start:${payload.agentId}:${payload.agentType}` }) },
        { event: 'SubagentStart' as const, matcher: 'writer', handler: () => ({ action: 'context' as const, additionalContext: 'skip' }) },
        { event: 'SubagentStop' as const, matcher: 'researcher', handler: payload => ({ action: 'context' as const, additionalContext: `stop:${payload.agentId}:${payload.output}` }) },
        { event: 'SubagentStop' as const, matcher: 'researcher', handler: () => ({ action: 'deny' as const, message: 'stop warn' }) },
      ],
    }
    const started = await applySubagentStartHooks(registry, 'agent-1', 'researcher', { ...c, conversationId: 'agent-1' })
    expect(started.additionalContext).toEqual(['start:agent-1:researcher'])
    const stopped = await applyStopHooks(registry, '完成', { ...c, conversationId: 'agent-1' }, { agentId: 'agent-1', agentType: 'researcher' })
    expect(stopped.additionalContext).toEqual(['stop:agent-1:完成', '[SubagentStop hook 警告] stop warn'])
  } finally {
    rmSync(c.workspace.root, { recursive: true, force: true })
  }
})

test('mergeHookRegistries:保留顺序合并规则', () => {
  const merged = mergeHookRegistries(
    { rules: [{ event: 'SessionStart', handler: () => ({ action: 'context', additionalContext: 'a' }) }] },
    undefined,
    { rules: [{ event: 'Stop', handler: () => ({ action: 'context', additionalContext: 'b' }) }] },
  )
  expect(merged?.rules.map(rule => rule.event)).toEqual(['SessionStart', 'Stop'])
})
