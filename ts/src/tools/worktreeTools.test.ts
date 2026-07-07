import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePermission } from '../permissions/resolve'
import { runAgentLoop } from '../harness/loop'
import { scriptedModel } from '../harness/fakeModel'
import { buildGeneralRegistry } from './generalTools'
import type { AgentEvent } from '../types/events'
import type { AssistantStep } from '../types/model'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from './Tool'
import { activateWorktreeSessionForContext, enterWorktreeTool, exitWorktreeTool, getWorktreePathsPortable, validateWorktreeSlug, workspaceForActiveWorktree } from './worktreeTools'

let root: string
let ctx: ToolContext

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-tool-')))
  initGitRepo(root)
  ctx = { workspace: new Workspace(root), conversationId: 'worktree-test' }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('CC-Haha EnterWorktree / ExitWorktree port', () => {
  test('validates CC-Haha worktree slugs', () => {
    expect(() => validateWorktreeSlug('feature/demo-1')).not.toThrow()
    expect(() => validateWorktreeSlug('../escape')).toThrow(/must not contain/)
    expect(() => validateWorktreeSlug('/absolute')).toThrow(/non-empty/)
    expect(() => validateWorktreeSlug('bad name')).toThrow(/letters/)
    expect(() => validateWorktreeSlug('x'.repeat(65))).toThrow(/64/)
  })

  test('EnterWorktree creates a git worktree, switches ctx.workspace, and lists it portably', async () => {
    const out = await enterWorktreeTool.execute({ name: 'agent/demo' }, ctx)

    expect(out).toContain('<enter_worktree>')
    expect(ctx.workspace.root).toBe(join(root, '.claude', 'worktrees', 'agent+demo'))
    expect(existsSync(join(ctx.workspace.root, '.git'))).toBe(true)
    expect(git(root, ['branch', '--list', 'worktree-agent+demo'])).toContain('worktree-agent+demo')
    expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toContain('.claude/worktrees/')
    expect(await getWorktreePathsPortable(root)).toContain(ctx.workspace.root)

    const exit = await exitWorktreeTool.execute({ action: 'keep' }, ctx)
    expect(exit).toContain('action="keep"')
    expect(ctx.workspace.root).toBe(root)
    expect(existsSync(join(root, '.claude', 'worktrees', 'agent+demo'))).toBe(true)
  })

  test('active worktree state restores a fresh ToolContext for the same conversation', async () => {
    await enterWorktreeTool.execute({ name: 'restore-context' }, ctx)
    const worktreePath = ctx.workspace.root
    const freshCtx: ToolContext = { workspace: new Workspace(root), conversationId: 'worktree-test' }

    const restored = activateWorktreeSessionForContext(freshCtx)
    expect(restored?.worktreePath).toBe(worktreePath)
    expect(freshCtx.workspace.root).toBe(worktreePath)
    expect(workspaceForActiveWorktree(new Workspace(root), 'worktree-test').root).toBe(worktreePath)

    await exitWorktreeTool.execute({ action: 'remove' }, freshCtx)
  })

  test('runAgentLoop keeps later turns in the active worktree workspace', async () => {
    const conversationId = 'loop-worktree'
    const firstSteps: AssistantStep[] = [
      { kind: 'tool_calls', calls: [{ id: 'wt1', name: 'EnterWorktree', input: { name: 'loop' } }] },
      { kind: 'final', text: 'entered' },
    ]
    await collect(runAgentLoop({
      model: scriptedModel(firstSteps),
      registry: buildGeneralRegistry(),
      workspace: new Workspace(root),
      systemPrompt: 'SYS',
      userMessage: 'enter worktree',
      conversationId,
      permissionMode: 'full',
    }))
    const worktreePath = join(root, '.claude', 'worktrees', 'loop')
    expect(existsSync(worktreePath)).toBe(true)

    const secondModel = scriptedModel([
      { kind: 'tool_calls', calls: [{ id: 'write1', name: 'write_file', input: { path: 'loop-only.txt', content: 'inside worktree' } }] },
      { kind: 'final', text: 'wrote' },
    ])
    await collect(runAgentLoop({
      model: secondModel,
      registry: buildGeneralRegistry(),
      workspace: new Workspace(root),
      systemPrompt: 'SYS',
      userMessage: 'write in active worktree',
      conversationId,
      permissionMode: 'full',
    }))

    expect(secondModel.received[0]?.system).toContain('Active EnterWorktree session restored')
    expect(existsSync(join(worktreePath, 'loop-only.txt'))).toBe(true)
    expect(existsSync(join(root, 'loop-only.txt'))).toBe(false)

    await exitWorktreeTool.execute({ action: 'remove', discard_changes: true }, { workspace: new Workspace(root), conversationId })
  })

  test('ExitWorktree remove deletes a clean worktree and branch', async () => {
    await enterWorktreeTool.execute({ name: 'remove-clean' }, ctx)
    const worktreePath = ctx.workspace.root
    const out = await exitWorktreeTool.execute({ action: 'remove' }, ctx)

    expect(out).toContain('action="remove"')
    expect(ctx.workspace.root).toBe(root)
    expect(existsSync(worktreePath)).toBe(false)
    expect(git(root, ['branch', '--list', 'worktree-remove-clean']).trim()).toBe('')
  })

  test('ExitWorktree refuses to remove dirty worktrees unless discard_changes is true', async () => {
    await enterWorktreeTool.execute({ name: 'dirty' }, ctx)
    const worktreePath = ctx.workspace.root
    writeFileSync(join(worktreePath, 'dirty.txt'), 'unsaved')

    await expect(exitWorktreeTool.execute({ action: 'remove' }, ctx)).rejects.toThrow(/uncommitted/)
    expect(ctx.workspace.root).toBe(worktreePath)
    expect(existsSync(worktreePath)).toBe(true)

    const out = await exitWorktreeTool.execute({ action: 'remove', discard_changes: true }, ctx)
    expect(out).toContain('discarded_files: 1')
    expect(ctx.workspace.root).toBe(root)
    expect(existsSync(worktreePath)).toBe(false)
  })

  test('permissions match worktree side effects and remove force-confirms', () => {
    expect(resolvePermission(enterWorktreeTool, { name: 'x' }, { ...ctx, permissionMode: 'ask' })).toMatchObject({
      behavior: 'ask',
      approvalClass: 'file',
    })
    expect(resolvePermission(enterWorktreeTool, { name: 'x' }, { ...ctx, permissionMode: 'auto_files' })).toMatchObject({
      behavior: 'allow',
    })
    expect(resolvePermission(exitWorktreeTool, { action: 'remove' }, { ...ctx, permissionMode: 'full' })).toMatchObject({
      behavior: 'ask',
      approvalClass: 'destructive',
      reason: { type: 'forceConfirm' },
    })
  })

  test('ExitWorktree is a no-op without an active EnterWorktree session', async () => {
    const out = await exitWorktreeTool.execute({ action: 'keep' }, { workspace: new Workspace(root), conversationId: 'none' })
    expect(out).toContain('No-op')
  })
})

function initGitRepo(cwd: string): void {
  git(cwd, ['init'])
  git(cwd, ['config', 'user.email', 'codex@example.test'])
  git(cwd, ['config', 'user.name', 'Codex Test'])
  writeFileSync(join(cwd, 'README.md'), 'hello\n')
  git(cwd, ['add', 'README.md'])
  git(cwd, ['commit', '-m', 'initial'])
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
    },
  })
}
