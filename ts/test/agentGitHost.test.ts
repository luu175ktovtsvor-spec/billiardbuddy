import { afterEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { AgentGitHost } from '../desktop/electron/services/agentGitHost'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-git-host-'))
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
  await fs.writeFile(path.join(directory, 'README.md'), 'base\n')
  await git(directory, ['add', 'README.md'])
  await git(directory, ['commit', '-m', 'base'])
  return directory
}

describe('AgentGitHost', () => {
  test('只在 canonical 工作区执行状态、暂存、差异、还原与提交', async () => {
    const workspace = await repository()
    const host = new AgentGitHost({ userDataPath: await root() })
    await fs.writeFile(path.join(workspace, 'README.md'), 'changed\n')

    expect((await host.status(workspace)).entries).toEqual([expect.objectContaining({ path: 'README.md', worktree: 'M' })])
    expect(await host.diff(workspace)).toContain('-base')
    await host.stageFiles(workspace, ['README.md'])
    expect(await host.diff(workspace, { staged: true })).toContain('+changed')
    const committed = await host.commit(workspace, '保存修改')
    expect(committed.commit).toMatch(/^[0-9a-f]{40}$/)

    await fs.writeFile(path.join(workspace, 'README.md'), 'discard me\n')
    await host.revertFiles(workspace, ['README.md'])
    expect(await fs.readFile(path.join(workspace, 'README.md'), 'utf8')).toBe('changed\n')
    await expect(host.stageFiles(workspace, ['../outside'])).rejects.toThrow('BILLIARDBUDDY_GIT_PATH_INVALID')

    await fs.writeFile(path.join(workspace, 'README.md'), 'pathspec attack\n')
    await expect(host.stageFiles(workspace, [':(top)README.md'])).rejects.toThrow('BILLIARDBUDDY_GIT_STAGE_FAILED')
    expect((await host.status(workspace)).entries).toEqual([expect.objectContaining({ path: 'README.md', index: ' ', worktree: 'M' })])
  })

  test('补丁和分支受到受限 Git 命令约束，切换分支不覆盖脏工作树', async () => {
    const workspace = await repository()
    const host = new AgentGitHost({ userDataPath: await root() })
    await fs.writeFile(path.join(workspace, 'README.md'), 'patch\n')
    const patch = await host.diff(workspace)
    await host.stagePatch(workspace, patch)
    expect(await host.diff(workspace, { staged: true })).toContain('+patch')
    await host.revertPatch(workspace, patch)
    expect(await fs.readFile(path.join(workspace, 'README.md'), 'utf8')).toBe('base\n')

    await host.createBranch(workspace, 'feature/host')
    expect((await host.listBranches(workspace)).find(branch => branch.name === 'feature/host')).toEqual(expect.objectContaining({ current: true }))
    await fs.writeFile(path.join(workspace, 'README.md'), 'dirty\n')
    await expect(host.switchBranch(workspace, 'master')).rejects.toThrow('BILLIARDBUDDY_GIT_WORKTREE_DIRTY')
    await expect(host.push(workspace, { branch: 'feature/host', remote: '--force' })).rejects.toThrow('BILLIARDBUDDY_GIT_REMOTE_INVALID')
  })
})
