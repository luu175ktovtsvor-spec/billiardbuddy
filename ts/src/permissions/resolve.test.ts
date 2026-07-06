import { describe, expect, test } from 'bun:test'
import type { Tool, ToolContext } from '../tools/Tool'
import { Workspace } from '../workspace/workspace'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePermission } from './resolve'

function ws() {
  return new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w4a-'))))
}
function ctx(mode: ToolContext['permissionMode'], extra: Partial<ToolContext> = {}): ToolContext {
  return { workspace: ws(), permissionMode: mode, ...extra }
}
/** 造一个工具,只填测试关心的权限字段,其余给桩。 */
function tool(over: Partial<Tool>): Tool {
  return {
    name: over.name ?? 't',
    description: '',
    inputSchema: { type: 'object' },
    isReadOnly: over.isReadOnly ?? false,
    async execute() {
      return 'ran'
    },
    ...over,
  }
}

describe('resolvePermission 瀑布', () => {
  test('fatal → deny(永不执行)', () => {
    const d = resolvePermission(tool({ fatalReasonFor: () => '要删根目录' }), {}, ctx('full'))
    expect(d.behavior).toBe('deny')
    expect(d.behavior === 'deny' && d.reason.type).toBe('fatal')
  })

  test('plan 模式 + 非只读 → deny(planSkip)', () => {
    const d = resolvePermission(tool({ isReadOnly: false }), {}, ctx('plan'))
    expect(d.behavior).toBe('deny')
    expect(d.behavior === 'deny' && d.reason.type).toBe('planSkip')
  })

  test('plan 模式 + 只读工具 → allow(可探索)', () => {
    const d = resolvePermission(tool({ isReadOnly: true }), {}, ctx('plan'))
    expect(d.behavior).toBe('allow')
  })

  test('Delta A:本机可逆动作(无 requiresApproval)在任何档都直接 allow', () => {
    for (const m of ['ask', 'auto_files', 'full'] as const) {
      expect(resolvePermission(tool({}), {}, ctx(m)).behavior).toBe('allow')
    }
  })

  test('Delta B:forceConfirm 连 full(跳过确认)也弹卡', () => {
    const d = resolvePermission(tool({ requiresApproval: true, forceConfirm: true, approvalClass: 'destructive' }), {}, ctx('full'))
    expect(d.behavior).toBe('ask')
    expect(d.behavior === 'ask' && d.reason?.type).toBe('forceConfirm')
  })

  test('ask 档:requiresApproval 工具 → ask', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('ask')).behavior).toBe('ask')
  })

  test('auto_files 档:file 类放行、非 file 类仍 ask', () => {
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'file' }), {}, ctx('auto_files')).behavior).toBe('allow')
    expect(resolvePermission(tool({ requiresApproval: true, approvalClass: 'outreach' }), {}, ctx('auto_files')).behavior).toBe('ask')
  })

  test('full 档:spend 类未过闸放行、过闸弹卡', () => {
    const t = tool({ requiresApproval: true, approvalClass: 'spend' })
    expect(resolvePermission(t, {}, ctx('full', { autoSpendCount: 0 })).behavior).toBe('allow')
    expect(resolvePermission(t, {}, ctx('full', { autoSpendCount: 3 })).behavior).toBe('ask')
  })

  test('safePrefixFor 命中 → allow(即便 requiresApproval)', () => {
    const d = resolvePermission(tool({ requiresApproval: true, safePrefixFor: () => true }), {}, ctx('ask'))
    expect(d.behavior).toBe('allow')
    expect(d.behavior === 'allow' && d.reason?.type).toBe('safePrefix')
  })

  test('requiresApprovalFor 动态命中 → ask', () => {
    const d = resolvePermission(tool({ requiresApprovalFor: () => true, approvalClass: 'outreach' }), {}, ctx('ask'))
    expect(d.behavior).toBe('ask')
  })

  test('工具钩子抛异常 → 失败关闭到 ask(不崩、绝不静默放行)', () => {
    expect(resolvePermission(tool({ fatalReasonFor: () => { throw new Error('boom') } }), {}, ctx('full')).behavior).toBe('ask')
    expect(resolvePermission(tool({ requiresApprovalFor: () => { throw new Error('boom') } }), {}, ctx('ask')).behavior).toBe('ask')
  })
})
