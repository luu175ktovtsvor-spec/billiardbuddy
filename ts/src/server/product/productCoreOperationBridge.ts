import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { execFile as execFileCallback } from 'node:child_process'
import { lock } from '../../utils/lockfile.js'

const execFile = promisify(execFileCallback)
const MAX_CANONICAL_INPUT_BYTES = 64 * 1024

export type ProductCoreOperationBinding = {
  sessionId: string
  workDir?: string
}

type OperationKind = 'create' | 'branch' | 'rename'
type OperationState = 'prepared' | 'succeeded' | 'failed'

type OperationRecord = {
  version: 1
  operationId: string
  taskId: string
  kind: OperationKind
  canonicalInput: string
  binding: ProductCoreOperationBinding
  state: OperationState
  terminalFailure?: { code: string; message: string }
  integrity: string
}

export class ProductCoreOperationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProductCoreOperationError'
  }
}

export class ProductCoreOperationTerminalError extends Error {
  constructor(readonly terminalCode: string, message: string) {
    super(message)
    this.name = 'ProductCoreOperationTerminalError'
  }
}

function defaultConfigDirectory(): string {
  return process.env.BILLIARDBUDDY_CONFIG_DIR || path.join(os.homedir(), '.BilliardBuddy')
}

function canonicalObject(value: string): Record<string, unknown> {
  if (Buffer.byteLength(value, 'utf8') > MAX_CANONICAL_INPUT_BYTES) {
    throw new ProductCoreOperationTerminalError('PRODUCT_OPERATION_INPUT_INVALID', '操作输入超过允许大小')
  }
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new ProductCoreOperationTerminalError('PRODUCT_OPERATION_INPUT_INVALID', '操作输入格式无效')
  }
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProductCoreOperationTerminalError('PRODUCT_OPERATION_INPUT_INVALID', `操作输入缺少 ${field}`)
  }
  return value
}

function deterministicSessionId(operationId: string): string {
  const digest = createHash('sha256').update('billiardbuddy/product-session/v1\0').update(operationId).digest('hex')
  const value = digest.slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

function unsigned(record: OperationRecord): Omit<OperationRecord, 'integrity'> {
  const { integrity: _integrity, ...rest } = record
  return rest
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

async function realDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) {
    throw new ProductCoreOperationTerminalError('PRODUCT_WORKDIR_INVALID', '工作目录必须是绝对路径')
  }
  try {
    const [real, stats] = await Promise.all([fs.realpath(directory), fs.stat(directory)])
    if (!stats.isDirectory()) throw new Error()
    return real
  } catch {
    throw new ProductCoreOperationTerminalError('PRODUCT_WORKDIR_INVALID', '工作目录不存在或不可用')
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    return result.stdout.trim()
  } catch {
    throw new ProductCoreOperationTerminalError('PRODUCT_WORKTREE_FAILED', '无法建立独立工作树')
  }
}

async function worktreeMatches(target: string, repositoryRoot: string): Promise<boolean> {
  try {
    const [targetRoot, targetCommon, repositoryCommon, stats] = await Promise.all([
      git(target, ['rev-parse', '--show-toplevel']),
      git(target, ['rev-parse', '--git-common-dir']),
      git(repositoryRoot, ['rev-parse', '--git-common-dir']),
      fs.stat(target),
    ])
    const targetCommonPath = path.resolve(target, targetCommon)
    const repositoryCommonPath = path.resolve(repositoryRoot, repositoryCommon)
    const [realTargetRoot, realTarget, realTargetCommon, realRepositoryCommon] = await Promise.all([
      fs.realpath(targetRoot),
      fs.realpath(target),
      fs.realpath(targetCommonPath),
      fs.realpath(repositoryCommonPath),
    ])
    return stats.isDirectory() && realTargetRoot === realTarget
      && realTargetCommon === realRepositoryCommon
  } catch {
    return false
  }
}

async function ensureWorktree(sourceWorkDir: string, sessionId: string, worktreeRoot: string): Promise<string> {
  const source = await realDirectory(sourceWorkDir)
  let repositoryRoot: string
  try {
    repositoryRoot = await git(source, ['rev-parse', '--show-toplevel'])
  } catch {
    throw new ProductCoreOperationTerminalError('PRODUCT_WORKTREE_REPOSITORY_REQUIRED', '独立工作树需要 Git 仓库')
  }
  const root = path.resolve(worktreeRoot)
  const target = path.join(root, sessionId)
  if (!isInside(root, target) || target === root) {
    throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '工作树目标路径无效')
  }
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  try {
    await fs.access(target, fsConstants.F_OK)
    if (await worktreeMatches(target, repositoryRoot)) return await fs.realpath(target)
    throw new ProductCoreOperationTerminalError('PRODUCT_WORKTREE_TARGET_CONFLICT', '工作树目标已被其他文件占用')
  } catch (error) {
    if (error instanceof ProductCoreOperationTerminalError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const branch = `billiardbuddy/${sessionId.slice(0, 12)}`
  try {
    await git(repositoryRoot, ['worktree', 'add', '-b', branch, target, 'HEAD'])
  } catch {
    await git(repositoryRoot, ['worktree', 'add', target, branch])
  }
  if (!(await worktreeMatches(target, repositoryRoot))) {
    throw new ProductCoreOperationTerminalError('PRODUCT_WORKTREE_FAILED', '建立的工作树未通过校验')
  }
  return await fs.realpath(target)
}

export class ProductCoreOperationBridge {
  private static readonly processLocks = new Map<string, Promise<void>>()
  private readonly journalDirectory: string
  private readonly worktreeRoot: string

  constructor(options: { journalDirectory?: string; worktreeRoot?: string } = {}) {
    const config = defaultConfigDirectory()
    this.journalDirectory = options.journalDirectory ?? path.join(config, 'billiardbuddy', 'product-operation-journal.v1')
    this.worktreeRoot = options.worktreeRoot ?? path.join(config, 'billiardbuddy', 'worktrees')
  }

  ensureCreate(operationId: string, taskId: string, canonicalInput: string): Promise<{ coreSessionId: string; branchWorkDir?: string }> {
    return this.ensure('create', operationId, taskId, canonicalInput).then(binding => ({
      coreSessionId: binding.sessionId,
      ...(binding.workDir ? { branchWorkDir: binding.workDir } : {}),
    }))
  }

  ensureBranch(operationId: string, taskId: string, canonicalInput: string): Promise<{ coreSessionId: string; branchWorkDir?: string }> {
    return this.ensure('branch', operationId, taskId, canonicalInput).then(binding => ({
      coreSessionId: binding.sessionId,
      ...(binding.workDir ? { branchWorkDir: binding.workDir } : {}),
    }))
  }

  ensureRename(operationId: string, taskId: string, canonicalInput: string): Promise<{ coreSessionId: string }> {
    return this.ensure('rename', operationId, taskId, canonicalInput).then(binding => ({ coreSessionId: binding.sessionId }))
  }

  /**
   * Remove the private operation journal for a deleted ProductTask. Worktrees
   * are deliberately retained: task deletion must never delete user files.
   */
  async purgeTaskRecords(taskId: string): Promise<number> {
    let files: string[]
    try {
      files = (await fs.readdir(this.journalDirectory)).filter(file => file.endsWith('.json'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw error
    }

    let purged = 0
    for (const file of files) {
      const candidatePath = path.join(this.journalDirectory, file)
      let candidate: OperationRecord
      try {
        candidate = await this.validate(JSON.parse(await fs.readFile(candidatePath, 'utf8')))
      } catch (error) {
        if (error instanceof ProductCoreOperationError || error instanceof ProductCoreOperationTerminalError) throw error
        throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志不可读取')
      }
      if (path.basename(this.recordPath(candidate.operationId)) !== file) {
        throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志文件名无效')
      }
      if (candidate.taskId !== taskId) continue

      await this.withProcessLock(candidate.operationId, async () => {
        const guard = `${this.recordPath(candidate.operationId)}.guard`
        await fs.writeFile(guard, '', { flag: 'a', mode: 0o600 })
        const release = await lock(guard, { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 50, minTimeout: 10, maxTimeout: 100 } })
        try {
          const current = await this.read(candidate.operationId)
          if (current?.taskId === taskId) {
            await fs.unlink(this.recordPath(candidate.operationId))
            purged += 1
          }
        } finally {
          await release()
          await fs.unlink(guard).catch(() => {})
        }
      })
    }
    return purged
  }

  private recordPath(operationId: string): string {
    return path.join(this.journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
  }

  private keyPath(): string {
    return path.join(this.journalDirectory, '.integrity-key')
  }

  private async integrityKey(): Promise<Buffer> {
    await fs.mkdir(this.journalDirectory, { recursive: true, mode: 0o700 })
    try {
      const value = await fs.readFile(this.keyPath(), 'utf8')
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error()
      return Buffer.from(value, 'hex')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志密钥无效')
      }
      const value = randomBytes(32).toString('hex')
      try {
        await fs.writeFile(this.keyPath(), value, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        return Buffer.from(value, 'hex')
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError
        const raced = await fs.readFile(this.keyPath(), 'utf8')
        if (!/^[a-f0-9]{64}$/.test(raced)) throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志密钥无效')
        return Buffer.from(raced, 'hex')
      }
    }
  }

  private async sign(record: Omit<OperationRecord, 'integrity'>): Promise<OperationRecord> {
    const key = await this.integrityKey()
    return { ...record, integrity: createHmac('sha256', key).update(stableJson(record)).digest('hex') }
  }

  private async validate(value: unknown): Promise<OperationRecord> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志无效')
    const record = value as Partial<OperationRecord>
    if (record.version !== 1 || typeof record.operationId !== 'string' || typeof record.taskId !== 'string'
      || !['create', 'branch', 'rename'].includes(String(record.kind)) || typeof record.canonicalInput !== 'string'
      || !record.binding || typeof record.binding.sessionId !== 'string'
      || (record.binding.workDir !== undefined && (typeof record.binding.workDir !== 'string' || !path.isAbsolute(record.binding.workDir)))
      || !['prepared', 'succeeded', 'failed'].includes(String(record.state)) || typeof record.integrity !== 'string'
      || (record.state === 'failed' && (!record.terminalFailure || typeof record.terminalFailure.code !== 'string' || typeof record.terminalFailure.message !== 'string'))
      || (record.state !== 'failed' && record.terminalFailure !== undefined)) {
      throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志无效')
    }
    const complete = record as OperationRecord
    const key = await this.integrityKey()
    const expected = Buffer.from(createHmac('sha256', key).update(stableJson(unsigned(complete))).digest('hex'), 'hex')
    const actual = Buffer.from(complete.integrity, 'hex')
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志完整性校验失败')
    }
    canonicalObject(complete.canonicalInput)
    return complete
  }

  private async write(record: Omit<OperationRecord, 'integrity'>): Promise<OperationRecord> {
    const signed = await this.sign(record)
    const target = this.recordPath(record.operationId)
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify(signed), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await fs.rename(temporary, target)
      return signed
    } finally {
      await fs.unlink(temporary).catch(() => {})
    }
  }

  private async read(operationId: string): Promise<OperationRecord | undefined> {
    try {
      return await this.validate(JSON.parse(await fs.readFile(this.recordPath(operationId), 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      if (error instanceof ProductCoreOperationError || error instanceof ProductCoreOperationTerminalError) throw error
      throw new ProductCoreOperationError('PRODUCT_OPERATION_JOURNAL_INVALID', '操作日志不可读取')
    }
  }

  private async perform(record: OperationRecord): Promise<ProductCoreOperationBinding> {
    const input = canonicalObject(record.canonicalInput)
    if (record.kind === 'rename') {
      return { sessionId: requiredString(input, 'sessionId') }
    }
    const sourceWorkDir = requiredString(input, record.kind === 'create' ? 'workDir' : 'sourceWorkDir')
    const wantsWorktree = record.kind === 'branch' ? input.target === 'new_worktree' : input.useWorktree === true
    const workDir = wantsWorktree
      ? await ensureWorktree(sourceWorkDir, record.binding.sessionId, this.worktreeRoot)
      : await realDirectory(sourceWorkDir)
    return { sessionId: record.binding.sessionId, workDir }
  }

  private async ensure(kind: OperationKind, operationId: string, taskId: string, canonicalInput: string): Promise<ProductCoreOperationBinding> {
    if (!operationId || !taskId || typeof canonicalInput !== 'string') {
      throw new ProductCoreOperationError('PRODUCT_OPERATION_INPUT_INVALID', '操作参数无效')
    }
    canonicalObject(canonicalInput)
    return this.withProcessLock(operationId, async () => {
      await fs.mkdir(this.journalDirectory, { recursive: true, mode: 0o700 })
      const guard = `${this.recordPath(operationId)}.guard`
      await fs.writeFile(guard, '', { flag: 'a', mode: 0o600 })
      const release = await lock(guard, { realpath: false, stale: 30_000, update: 10_000, retries: { retries: 50, minTimeout: 10, maxTimeout: 100 } })
      try {
        let record = await this.read(operationId)
        if (!record) {
          const sessionId = kind === 'rename' ? requiredString(canonicalObject(canonicalInput), 'sessionId') : deterministicSessionId(operationId)
          record = await this.write({ version: 1, operationId, taskId, kind, canonicalInput, binding: { sessionId }, state: 'prepared' })
        }
        if (record.taskId !== taskId || record.kind !== kind || record.canonicalInput !== canonicalInput) {
          throw new ProductCoreOperationError('PRODUCT_OPERATION_INPUT_CONFLICT', '同一操作 ID 不能对应不同输入')
        }
        if (record.state === 'failed') throw new ProductCoreOperationTerminalError(record.terminalFailure!.code, record.terminalFailure!.message)
        if (record.state === 'succeeded') {
          const recovered = await this.perform(record)
          if (recovered.sessionId !== record.binding.sessionId || recovered.workDir !== record.binding.workDir) {
            throw new ProductCoreOperationError('PRODUCT_OPERATION_BINDING_MISMATCH', '已完成操作的资源绑定发生变化')
          }
          return record.binding
        }
        try {
          const binding = await this.perform(record)
          record = await this.write({ ...unsigned(record), binding, state: 'succeeded' })
          return record.binding
        } catch (error) {
          if (error instanceof ProductCoreOperationTerminalError) {
            await this.write({ ...unsigned(record), state: 'failed', terminalFailure: { code: error.terminalCode, message: error.message } })
          }
          throw error
        }
      } finally {
        await release()
      }
    })
  }

  private async withProcessLock<T>(operationId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${this.journalDirectory}:${operationId}`
    const previous = ProductCoreOperationBridge.processLocks.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const current = new Promise<void>(resolve => { unlock = resolve })
    const queued = previous.then(() => current)
    ProductCoreOperationBridge.processLocks.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      unlock()
      if (ProductCoreOperationBridge.processLocks.get(key) === queued) ProductCoreOperationBridge.processLocks.delete(key)
    }
  }
}
