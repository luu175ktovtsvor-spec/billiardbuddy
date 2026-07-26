import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { execFile as execFileCallback } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import {
  ProductCoreOperationBridge,
  ProductCoreOperationError,
  ProductCoreOperationTerminalError,
} from './productCoreOperationBridge.js'

const execFile = promisify(execFileCallback)
let temporaryDirectory = ''

beforeEach(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-product-core-'))
})

afterEach(async () => {
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
})

function bridge(): ProductCoreOperationBridge {
  return new ProductCoreOperationBridge({
    journalDirectory: path.join(temporaryDirectory, 'journal'),
    worktreeRoot: path.join(temporaryDirectory, 'worktrees'),
  })
}

describe('ProductCoreOperationBridge', () => {
  test('reserves one stable BilliardBuddy session and rejects operation-id input drift', async () => {
    const workspace = path.join(temporaryDirectory, 'workspace')
    await fs.mkdir(workspace)
    const instance = bridge()
    const canonical = JSON.stringify({ workDir: workspace, useWorktree: false })

    const first = await instance.ensureCreate('operation-create', 'task-1', canonical)
    const replay = await instance.ensureCreate('operation-create', 'task-1', canonical)

    expect(replay).toEqual(first)
    expect(first.branchWorkDir).toBe(await fs.realpath(workspace))
    await expect(instance.ensureCreate('operation-create', 'task-1', JSON.stringify({ workDir: temporaryDirectory })))
      .rejects.toBeInstanceOf(ProductCoreOperationError)
  })

  test('records terminal directory failures and reproduces them without silent fallback', async () => {
    const instance = bridge()
    const canonical = JSON.stringify({ workDir: path.join(temporaryDirectory, 'missing') })

    await expect(instance.ensureCreate('operation-missing', 'task-2', canonical))
      .rejects.toMatchObject({ terminalCode: 'PRODUCT_WORKDIR_INVALID' })
    await fs.mkdir(path.join(temporaryDirectory, 'missing'))
    await expect(instance.ensureCreate('operation-missing', 'task-2', canonical))
      .rejects.toBeInstanceOf(ProductCoreOperationTerminalError)
  })

  test('materializes and recovers an isolated git worktree for a continued task', async () => {
    const repository = path.join(temporaryDirectory, 'repository')
    await fs.mkdir(repository)
    await execFile('git', ['init', repository])
    await execFile('git', ['-C', repository, 'config', 'user.email', 'test@example.test'])
    await execFile('git', ['-C', repository, 'config', 'user.name', 'BilliardBuddy Test'])
    await fs.writeFile(path.join(repository, 'README.md'), 'BilliardBuddy\n')
    await execFile('git', ['-C', repository, 'add', 'README.md'])
    await execFile('git', ['-C', repository, 'commit', '-m', '初始化测试仓库'])
    const instance = bridge()
    const canonical = JSON.stringify({ sourceSessionId: 'source', sourceWorkDir: repository, title: '继续任务', target: 'new_worktree' })

    const first = await instance.ensureBranch('operation-branch', 'task-3', canonical)
    const replay = await instance.ensureBranch('operation-branch', 'task-3', canonical)

    expect(replay).toEqual(first)
    expect(first.branchWorkDir).toStartWith(await fs.realpath(path.join(temporaryDirectory, 'worktrees')))
    expect(await fs.readFile(path.join(first.branchWorkDir!, 'README.md'), 'utf8')).toBe('BilliardBuddy\n')
    expect((await execFile('git', ['-C', first.branchWorkDir!, 'rev-parse', '--is-inside-work-tree'])).stdout.trim()).toBe('true')
  })

  test('fails closed when a persisted operation record is modified', async () => {
    const workspace = path.join(temporaryDirectory, 'workspace')
    await fs.mkdir(workspace)
    const instance = bridge()
    await instance.ensureCreate('operation-tamper', 'task-4', JSON.stringify({ workDir: workspace }))
    const files = (await fs.readdir(path.join(temporaryDirectory, 'journal'))).filter(name => name.endsWith('.json'))
    const file = path.join(temporaryDirectory, 'journal', files[0]!)
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    record.taskId = 'task-other'
    await fs.writeFile(file, JSON.stringify(record))

    await expect(instance.ensureCreate('operation-tamper', 'task-4', JSON.stringify({ workDir: workspace })))
      .rejects.toMatchObject({ code: 'PRODUCT_OPERATION_JOURNAL_INVALID' })
  })

  test('purges only the deleted task operation journals and retains worktrees', async () => {
    const firstWorkspace = path.join(temporaryDirectory, 'first-workspace')
    const secondWorkspace = path.join(temporaryDirectory, 'second-workspace')
    await Promise.all([fs.mkdir(firstWorkspace), fs.mkdir(secondWorkspace)])
    const instance = bridge()
    await instance.ensureCreate('operation-first', 'task-delete', JSON.stringify({ workDir: firstWorkspace }))
    await instance.ensureCreate('operation-second', 'task-keep', JSON.stringify({ workDir: secondWorkspace }))

    expect(await instance.purgeTaskRecords('task-delete')).toBe(1)
    expect(await instance.purgeTaskRecords('task-delete')).toBe(0)
    await expect(instance.ensureCreate('operation-second', 'task-keep', JSON.stringify({ workDir: secondWorkspace })))
      .resolves.toMatchObject({ branchWorkDir: await fs.realpath(secondWorkspace) })
    expect(await fs.stat(firstWorkspace)).toBeTruthy()
  })
})
