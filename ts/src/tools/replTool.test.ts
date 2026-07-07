import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signApproval } from '../permissions/approval'
import { resolvePermission } from '../permissions/resolve'
import { executeApproved } from '../harness/loop'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { buildGeneralRegistry } from './generalTools'

function fixture(): { root: string; ctx: ToolContext; registry: ReturnType<typeof buildGeneralRegistry> } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'repl-tool-')))
  return {
    root,
    ctx: { workspace: new Workspace(root), permissionMode: 'ask', conversationId: `repl-${Date.now()}-${Math.random()}` },
    registry: buildGeneralRegistry(),
  }
}

describe('REPL tool', () => {
  test('runs a read-only batch through existing primitive tools', async () => {
    const { root, ctx, registry } = fixture()
    writeFileSync(join(root, 'src.ts'), 'export const answer = 42\n', 'utf8')
    const repl = registry.get('REPL')!

    const output = await repl.execute({
      steps: [
        { id: 'read-src', tool: 'read_file', input: { path: 'src.ts' } },
        { id: 'grep-answer', tool: 'grep_files', input: { pattern: 'answer', path: '.' } },
      ],
    }, ctx)

    expect(output).toContain('<repl_result status="ok"')
    expect(output).toContain('read-src')
    expect(output).toContain('grep-answer')
    expect(output).toContain('answer = 42')
  })

  test('does not execute an approval-required inner command without approval', async () => {
    const { root, ctx, registry } = fixture()
    const repl = registry.get('REPL')!
    const args = { steps: [{ id: 'write', tool: 'run_command', input: { command: 'printf hi > made.txt' } }] }

    const decision = resolvePermission(repl, args, ctx)
    expect(decision.behavior).toBe('ask')

    const output = await repl.execute(args, ctx)
    expect(output).toContain('status="pending"')
    expect(existsSync(join(root, 'made.txt'))).toBe(false)
  })

  test('executes approved batch commands while preserving inner tool behavior', async () => {
    const { root, ctx, registry } = fixture()
    const args = { steps: [{ id: 'write', tool: 'run_command', input: { command: 'printf hi > made.txt' } }] }
    const result = await executeApproved(registry, 'REPL', args, signApproval('REPL', args), ctx)

    expect(result.ok).toBe(true)
    expect(result.output).toContain('<repl_result status="ok"')
    expect(readFileSync(join(root, 'made.txt'), 'utf8')).toBe('hi')
  })

  test('still rejects fatal inner commands even when REPL is approved', async () => {
    const { ctx, registry } = fixture()
    const args = { steps: [{ id: 'fatal', tool: 'run_command', input: { command: 'rm -rf /' } }] }
    const result = await executeApproved(registry, 'REPL', args, signApproval('REPL', args), ctx)

    expect(result.ok).toBe(false)
    expect(result.output).toContain('拒绝执行')
  })

  test('plan mode blocks mutating REPL batches before execution', () => {
    const { ctx, registry } = fixture()
    ctx.permissionMode = 'plan'
    const repl = registry.get('REPL')!
    const decision = resolvePermission(repl, {
      steps: [{ id: 'write', tool: 'write_file', input: { path: 'made.txt', content: 'hi' } }],
    }, ctx)

    expect(decision.behavior).toBe('deny')
    if (decision.behavior !== 'deny') throw new Error('expected plan mode denial')
    expect(decision.reason.type).toBe('planSkip')
  })
})
