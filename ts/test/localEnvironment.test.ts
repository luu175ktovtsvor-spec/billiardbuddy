import { afterEach, describe, expect, test } from 'bun:test'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { LocalEnvironmentHost } from '../desktop/electron/services/localEnvironment'

const execFileAsync = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-local-environment-'))
  roots.push(directory)
  await fs.mkdir(path.join(directory, '.codex', 'environments'), { recursive: true })
  return directory
}

async function git(cwd: string, args: string[]): Promise<string> {
  return (await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })).stdout
}

async function relatedWorkspaces(): Promise<{ sourceTree: string, worktreePath: string }> {
  const sourceTree = await workspace()
  await git(sourceTree, ['init'])
  await git(sourceTree, ['config', 'user.name', 'BilliardBuddy Test'])
  await git(sourceTree, ['config', 'user.email', 'test@example.test'])
  await fs.writeFile(path.join(sourceTree, 'README.md'), 'base\n')
  await git(sourceTree, ['add', 'README.md'])
  await git(sourceTree, ['commit', '-m', 'base'])
  const worktreePath = path.join(await workspace(), 'worktree')
  await git(sourceTree, ['worktree', 'add', '--detach', worktreePath])
  await fs.mkdir(path.join(worktreePath, '.codex', 'environments'), { recursive: true })
  return { sourceTree, worktreePath }
}

describe('LocalEnvironmentHost', () => {
  test('读取 nested [setup.darwin]，运行 setup 时只返回退出状态而不泄露脚本输出', async () => {
    const { sourceTree, worktreePath } = await relatedWorkspaces()
    await fs.writeFile(path.join(worktreePath, '.codex', 'environments', 'environment.toml'), [
      'version = 1',
      'name = "Local development"',
      '[setup.darwin]',
      'script = "printf secret-token-value; test -z \\\"$OPENAI_API_KEY\\\"; printf ready > \\\"$CODEX_WORKTREE_PATH/setup.marker\\\""',
      '[[actions]]',
      'name = "Check"',
      'icon = "check"',
      'command = "printf action > \\\"$CODEX_WORKTREE_PATH/action.marker\\\""',
      'platform = "darwin"',
      '',
    ].join('\n'))
    const host = new LocalEnvironmentHost({ platform: 'darwin', environment: { PATH: process.env.PATH, OPENAI_API_KEY: 'not-forwarded' } })

    expect(await host.read(worktreePath)).toEqual(expect.objectContaining({ name: 'Local development', actions: [expect.objectContaining({ name: 'Check' })] }))
    const setup = await host.runSetup({ sourceTree, worktreePath })
    expect(setup).toEqual(expect.objectContaining({ kind: 'setup', exitCode: 0 }))
    expect(setup).not.toHaveProperty('stdout')
    expect(await fs.readFile(path.join(worktreePath, 'setup.marker'), 'utf8')).toBe('ready')
    const action = await host.resolveAction({ worktreePath, name: 'Check' })
    expect(action).toEqual({ name: 'Check', icon: 'check', command: 'printf action > "$CODEX_WORKTREE_PATH/action.marker"', platforms: ['darwin'] })
    await expect(fs.access(path.join(worktreePath, 'action.marker'))).rejects.toThrow()
  })

  test('拒绝无效 schema 和不支持当前平台的 action', async () => {
    const { sourceTree, worktreePath } = await relatedWorkspaces()
    const file = path.join(worktreePath, '.codex', 'environments', 'environment.toml')
    await fs.writeFile(file, 'version = 2\nname = "bad"\n')
    const host = new LocalEnvironmentHost({ platform: 'darwin' })
    await expect(host.read(worktreePath)).rejects.toThrow('BILLIARDBUDDY_LOCAL_ENVIRONMENT_INVALID')

    await fs.writeFile(file, 'version = 1\nname = "ok"\n[[actions]]\nname = "Windows only"\ncommand = "echo ok"\nplatform = "win32"\n')
    await expect(host.resolveAction({ worktreePath, name: 'Windows only' })).rejects.toThrow('BILLIARDBUDDY_LOCAL_ENVIRONMENT_ACTION_INVALID')
  })

  test('空 setup 脚本表示未配置，不阻断同一环境的有效 action', async () => {
    const { sourceTree, worktreePath } = await relatedWorkspaces()
    const file = path.join(worktreePath, '.codex', 'environments', 'environment.toml')
    await fs.writeFile(file, [
      'version = 1',
      'name = "Codex source"',
      '[setup]',
      'script = ""',
      '[[actions]]',
      'name = "Run"',
      'command = "printf run"',
      '',
    ].join('\n'))
    const host = new LocalEnvironmentHost({ platform: 'darwin' })

    await expect(host.read(worktreePath)).resolves.toEqual(expect.objectContaining({
      name: 'Codex source',
      setup: undefined,
      actions: [expect.objectContaining({ name: 'Run' })],
    }))
    await expect(host.runSetup({ sourceTree, worktreePath })).resolves.toBeUndefined()
    await expect(host.resolveAction({ worktreePath, name: 'Run' })).resolves.toEqual(expect.objectContaining({ name: 'Run' }))
  })
})
