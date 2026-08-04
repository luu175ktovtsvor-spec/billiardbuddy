import { afterEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { AgentWorkspaceHost } from '../desktop/electron/services/agentWorkspaceHost'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-worktree-host-'))
  roots.push(directory)
  return directory
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout
}

async function repository(): Promise<string> {
  const directory = await root()
  await git(directory, ['init'])
  await git(directory, ['config', 'user.name', 'BilliardBuddy Test'])
  await git(directory, ['config', 'user.email', 'test@example.test'])
  await fs.mkdir(path.join(directory, 'settings'), { recursive: true })
  await fs.writeFile(path.join(directory, 'README.md'), 'base\n')
  await fs.writeFile(path.join(directory, 'settings', 'local.json'), '{"safe":true}\n')
  await fs.writeFile(path.join(directory, 'AGENTS.override.md'), 'local agent instruction\n')
  await fs.writeFile(path.join(directory, '.gitignore'), 'settings/*.json\nAGENTS.override.md\n')
  await fs.writeFile(path.join(directory, '.worktreeinclude'), 'settings/*.json\n')
  await git(directory, ['add', 'README.md', '.gitignore', '.worktreeinclude'])
  await git(directory, ['commit', '-m', 'base'])
  return directory
}

describe('AgentWorkspaceHost', () => {
  test('在私有运行目录创建 detached 工作树，按 .worktreeinclude pattern 和自动规则复制忽略文件', async () => {
    const sourceTree = await repository()
    const userDataPath = await root()
    const host = new AgentWorkspaceHost({ userDataPath, now: () => 100 })

    const worktree = await host.create({ threadId: 'thread_one', sourceTree })

    expect(worktree.worktreePath).toStartWith(path.join(await fs.realpath(userDataPath), 'agent-runtime', 'worktrees'))
    expect((await git(worktree.worktreePath, ['branch', '--show-current'])).trim()).toBe('')
    expect(await fs.readFile(path.join(worktree.worktreePath, 'settings', 'local.json'), 'utf8')).toContain('safe')
    expect(await fs.readFile(path.join(worktree.worktreePath, 'AGENTS.override.md'), 'utf8')).toBe('local agent instruction\n')
    expect(await host.list()).toEqual([expect.objectContaining({ id: worktree.id, threadId: 'thread_one' })])
  })

  test('源工作区脏修改在创建时带入 worktree，同时不清理源工作区', async () => {
    const sourceTree = await repository()
    const host = new AgentWorkspaceHost({ userDataPath: await root() })
    await fs.writeFile(path.join(sourceTree, 'README.md'), 'staged\n')
    await git(sourceTree, ['add', 'README.md'])
    await fs.writeFile(path.join(sourceTree, 'README.md'), 'working\n')
    await fs.writeFile(path.join(sourceTree, 'draft.txt'), 'draft\n')

    const worktree = await host.create({ threadId: 'thread_one', sourceTree })

    expect(await fs.readFile(path.join(worktree.worktreePath, 'README.md'), 'utf8')).toBe('working\n')
    expect(await fs.readFile(path.join(worktree.worktreePath, 'draft.txt'), 'utf8')).toBe('draft\n')
    expect((await git(worktree.worktreePath, ['diff', '--cached'])).toString()).toContain('+staged')
    expect(await fs.readFile(path.join(sourceTree, 'README.md'), 'utf8')).toBe('working\n')
    expect(await fs.readFile(path.join(sourceTree, 'draft.txt'), 'utf8')).toBe('draft\n')
  })

  test('并发创建串行更新私有注册表，不丢失任一 Thread', async () => {
    const sourceTree = await repository()
    const host = new AgentWorkspaceHost({ userDataPath: await root() })

    const [first, second] = await Promise.all([
      host.create({ threadId: 'thread_one', sourceTree }),
      host.create({ threadId: 'thread_two', sourceTree }),
    ])

    expect(new Set((await host.list()).map(item => item.id))).toEqual(new Set([first.id, second.id]))
  })

  test('持久绑定 primary、Fork 与 Review Thread，恢复时不再采信 renderer cwd', async () => {
    const sourceTree = await repository()
    const userDataPath = await root()
    const host = new AgentWorkspaceHost({ userDataPath })
    const worktree = await host.create({ threadId: 'thread_primary', sourceTree })

    expect(await host.activeWorkspacePath('thread_primary')).toBe(await fs.realpath(sourceTree))
    await host.setActiveWorkspace(worktree.id, 'worktree')
    await host.attachThread(worktree.id, 'thread_fork')
    await host.attachThread(worktree.id, 'thread_review')

    const afterRestart = new AgentWorkspaceHost({ userDataPath })
    expect(await afterRestart.activeWorkspacePath('thread_primary')).toBe(worktree.worktreePath)
    expect(await afterRestart.activeWorkspacePath('thread_fork')).toBe(worktree.worktreePath)
    expect(await afterRestart.activeWorkspacePath('thread_review')).toBe(worktree.worktreePath)

    await afterRestart.setActiveWorkspace(worktree.id, 'source')
    expect(await afterRestart.activeWorkspacePath('thread_fork')).toBe(await fs.realpath(sourceTree))
    await afterRestart.detachThread('thread_fork')
    expect(await afterRestart.activeWorkspacePath('thread_fork')).toBeUndefined()
  })

  test('快照在写入目标前拒绝未跟踪符号链接', async () => {
    if (process.platform === 'win32') return
    const sourceTree = await repository()
    const host = new AgentWorkspaceHost({ userDataPath: await root() })
    const worktree = await host.create({ threadId: 'thread_one', sourceTree })
    const outside = path.join(await root(), 'outside.txt')
    await fs.writeFile(outside, 'outside\n')
    await fs.symlink(outside, path.join(worktree.worktreePath, 'linked.txt'))

    await expect(host.snapshot(worktree.id)).rejects.toThrow('BILLIARDBUDDY_WORKTREE_SNAPSHOT_UNTRACKED_UNSUPPORTED')
  })

  test('清理前保存快照，恢复工作树时恢复已修改与未跟踪文件', async () => {
    const sourceTree = await repository()
    const userDataPath = await root()
    const host = new AgentWorkspaceHost({ userDataPath })
    const worktree = await host.create({ threadId: 'thread_one', sourceTree })
    await fs.writeFile(path.join(worktree.worktreePath, 'README.md'), 'changed\n')
    await fs.writeFile(path.join(worktree.worktreePath, 'draft.txt'), 'draft\n')

    const removed = await host.cleanup(worktree.id)
    expect(removed.snapshot.workingPatch).toContain('changed')
    expect(removed.snapshot.untrackedFiles).toEqual(['draft.txt'])
    await expect(fs.access(worktree.worktreePath)).rejects.toThrow()
    expect(await host.snapshotSourceTree(removed.snapshot.id)).toBe(await fs.realpath(sourceTree))

    await fs.writeFile(path.join(sourceTree, 'README.md'), 'independent local change\n')
    const restored = await host.restore({ snapshotId: removed.snapshot.id, threadId: 'thread_two' })
    expect(await fs.readFile(path.join(restored.worktreePath, 'README.md'), 'utf8')).toBe('changed\n')
    expect(await fs.readFile(path.join(restored.worktreePath, 'draft.txt'), 'utf8')).toBe('draft\n')
    expect(await fs.readFile(path.join(sourceTree, 'README.md'), 'utf8')).toBe('independent local change\n')
  })

  test('交接仅写入干净目标，拒绝覆盖目标未提交内容', async () => {
    const sourceTree = await repository()
    const host = new AgentWorkspaceHost({ userDataPath: await root() })
    const source = await host.create({ threadId: 'source', sourceTree })
    const target = await host.create({ threadId: 'target', sourceTree })
    await fs.writeFile(path.join(source.worktreePath, 'README.md'), 'from source\n')
    await fs.writeFile(path.join(target.worktreePath, 'target.txt'), 'dirty\n')
    await expect(host.handoff({ sourceWorktreeId: source.id, targetWorktreeId: target.id })).rejects.toThrow('BILLIARDBUDDY_HANDOFF_TARGET_DIRTY')

    await fs.rm(path.join(target.worktreePath, 'target.txt'))
    const result = await host.handoff({ sourceWorktreeId: source.id, targetWorktreeId: target.id })
    expect(result.snapshot.id).toHaveLength(32)
    expect(await fs.readFile(path.join(target.worktreePath, 'README.md'), 'utf8')).toBe('from source\n')
  })

  test('在 Local 与 managed worktree 间交接，移动修改并清理原工作区', async () => {
    const sourceTree = await repository()
    const host = new AgentWorkspaceHost({ userDataPath: await root() })
    const worktree = await host.create({ threadId: 'thread_one', sourceTree })

    await fs.writeFile(path.join(worktree.worktreePath, 'README.md'), 'from worktree\n')
    await fs.writeFile(path.join(worktree.worktreePath, 'from-worktree.txt'), 'draft\n')
    const local = await host.handoffToSource(worktree.id)
    expect(local.workspacePath).toBe(await fs.realpath(sourceTree))
    expect(await fs.readFile(path.join(sourceTree, 'README.md'), 'utf8')).toBe('from worktree\n')
    expect(await fs.readFile(path.join(sourceTree, 'from-worktree.txt'), 'utf8')).toBe('draft\n')
    expect((await git(worktree.worktreePath, ['status', '--porcelain'])).trim()).toBe('')

    await fs.writeFile(path.join(sourceTree, 'README.md'), 'from local\n')
    const managed = await host.handoffFromSource(worktree.id)
    expect(managed.workspacePath).toBe(worktree.worktreePath)
    expect(await fs.readFile(path.join(worktree.worktreePath, 'README.md'), 'utf8')).toBe('from local\n')
    expect((await git(sourceTree, ['status', '--porcelain'])).trim()).toBe('')
  })
})
