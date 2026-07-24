import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  type CoreOperationBridgeErrorCode,
  type CoreOperationKind,
} from '../../../shared/product/coreOperationBridge.js'
import {
  SessionService,
  sessionService,
  type DurableCoreSessionOperation,
} from '../services/sessionService.js'
import {
  buildDurableBranchPlan,
  createSessionBranch,
  installDurableBranchPlan,
  SessionBranchingError,
  type DurableBranchPlan,
} from '../../utils/sessionBranching.js'
import { lock } from '../../utils/lockfile.js'
import { cleanupPreparedSessionWorkspace, prepareSessionWorkspace } from '../services/repositoryLaunchService.js'

export type CoreOperationBinding = {
  /** Core-private identity. Keep this inside server-side product services. */
  coreSessionId: string
  branchProjectDirPath?: string
  branchWorkDir?: string
}

type TerminalFailure = {
  code: string
  message: string
}

type PersistedBranchPlan = {
  json: string
  digest: string
}

type OperationRecord = {
  version: 1
  clientOperationId: string
  productTaskId: string
  kind: CoreOperationKind
  canonicalInput: string
  binding: CoreOperationBinding
  branchPlan?: PersistedBranchPlan
  state: 'prepared' | 'succeeded' | 'failed'
  terminalFailure?: TerminalFailure
  branchTargetPath?: string
  /** Server-private HMAC over the complete record excluding this field. */
  integrity?: string
}

export class CoreOperationBridgeError extends Error {
  constructor(
    readonly code: CoreOperationBridgeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CoreOperationBridgeError'
  }
}

/** A failure that a Core backend has durably recorded and will reproduce. */
export class CoreOperationTerminalError extends Error {
  constructor(readonly terminalCode: string, message: string) {
    super(message)
    this.name = 'CoreOperationTerminalError'
  }
}

export type DurableCoreOperationBackend = {
  prepareBranch(input: {
    clientOperationId: string
    canonicalInput: string
    binding: CoreOperationBinding
  }): Promise<DurableBranchPlan>
  /**
   * Make the requested Core mutation idempotently.  The backend receives the
   * bridge-reserved binding before any side effect, so a retry after a process
   * crash can recover the same result rather than allocate a second session.
   */
  ensure(input: {
    clientOperationId: string
    productTaskId: string
    kind: CoreOperationKind
    canonicalInput: string
    binding: CoreOperationBinding
    branchPlan?: DurableBranchPlan
  }): Promise<CoreOperationBinding>
}

function canonicalObject(canonicalInput: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(canonicalInput)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new CoreOperationTerminalError('CORE_OPERATION_INPUT_INVALID', 'Canonical Core input is invalid')
  }
}

function requiredString(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || !value) {
    throw new CoreOperationTerminalError('CORE_OPERATION_INPUT_INVALID', `Canonical Core input requires ${field}`)
  }
  return value
}

/**
 * The built-in Core backend writes replay markers into the existing session
 * JSONL storage. It only receives server-side canonical input, so neither the
 * reserved Core binding nor a source session identity reaches a renderer.
 */
export class SessionCoreOperationBackend implements DurableCoreOperationBackend {
  constructor(private readonly sessions: SessionService = sessionService) {}

  async prepareBranch(input: {
    clientOperationId: string
    canonicalInput: string
    binding: CoreOperationBinding
  }): Promise<DurableBranchPlan> {
    const canonical = canonicalObject(input.canonicalInput)
    const sourceSessionId = requiredString(canonical, 'sourceSessionId')
    const title = requiredString(canonical, 'title')
    try {
      const launchInfo = await this.sessions.getSessionLaunchInfo(sourceSessionId)
      if (!launchInfo) {
        throw new CoreOperationTerminalError('CORE_SOURCE_NOT_FOUND', 'Source Core session is unavailable')
      }
      const targetSessionId = input.binding.coreSessionId as `${string}-${string}-${string}-${string}-${string}`
      const preparedWorkspace = canonical.target === 'new_worktree'
        ? await prepareSessionWorkspace(
            launchInfo.repository?.requestedWorkDir ?? launchInfo.workDir,
            { branch: launchInfo.repository?.branch, worktree: true },
            targetSessionId,
          )
        : undefined
      try {
        return await buildDurableBranchPlan({
          sourceSessionId,
          sourceTranscriptPath: launchInfo.filePath,
          title,
          ...(typeof canonical.targetMessageId === 'string' ? { targetMessageId: canonical.targetMessageId } : {}),
          sourceWorkDir: launchInfo.workDir,
          sourceRepository: launchInfo.repository,
          sourceWorktreeSession: launchInfo.worktreeSession,
          targetSessionId,
          ...(preparedWorkspace ? { targetWorkDir: preparedWorkspace.workDir, targetRepository: preparedWorkspace.repository } : {}),
          durableOperation: {
            clientOperationId: input.clientOperationId,
            canonicalInput: input.canonicalInput,
          },
        })
      } catch (error) {
        if (preparedWorkspace) await cleanupPreparedSessionWorkspace(preparedWorkspace).catch(() => false)
        throw error
      }
    } catch (error) {
      if (error instanceof CoreOperationTerminalError) throw error
      if (error instanceof SessionBranchingError) {
        throw new CoreOperationTerminalError(`CORE_BRANCH_${error.code}`, error.code === 'INVALID_TARGET' ? 'Requested branch target is unavailable' : 'Core branch operation failed')
      }
      throw new CoreOperationTerminalError('CORE_BRANCH_STORAGE_FAILURE', 'Core branch storage operation failed')
    }
  }

  async ensure(input: Parameters<DurableCoreOperationBackend['ensure']>[0]): Promise<CoreOperationBinding> {
    const canonical = canonicalObject(input.canonicalInput)
    const operation: DurableCoreSessionOperation = {
      clientOperationId: input.clientOperationId,
      canonicalInput: input.canonicalInput,
    }

    if (input.kind === 'create') {
      try {
        const replay = await this.sessions.inspectDurableCreateReplay(input.binding.coreSessionId, operation)
        if (replay === 'matching') {
          return input.binding
        }
        if (replay === 'conflict') {
          throw new CoreOperationTerminalError('CORE_SESSION_OPERATION_CONFLICT', 'Core session operation cannot be recovered')
        }
        await this.sessions.createSession(
          requiredString(canonical, 'workDir'),
          undefined,
          typeof canonical.permissionMode === 'string' ? canonical.permissionMode : undefined,
          { sessionId: input.binding.coreSessionId, operation },
        )
      } catch (error) {
        if (error instanceof CoreOperationTerminalError) throw error
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' ||
          (error as { code?: unknown }).code === 'WORKDIR_NOT_DIRECTORY' ||
          (error instanceof Error && error.message.startsWith('Working directory does not exist:'))
        ) {
          throw new CoreOperationTerminalError('CORE_WORKDIR_INVALID', 'Working directory is unavailable')
        }
        if ((error as { code?: unknown }).code === 'CORE_SESSION_OPERATION_CONFLICT') {
          throw new CoreOperationTerminalError('CORE_SESSION_OPERATION_CONFLICT', (error as Error).message)
        }
        throw new CoreOperationTerminalError('CORE_CREATE_STORAGE_FAILURE', 'Core session storage operation failed')
      }
      return input.binding
    }

    if (input.kind === 'branch') {
      if (!input.branchPlan) {
        throw new CoreOperationTerminalError('CORE_OPERATION_INPUT_INVALID', 'Branch plan is required')
      }
      try {
        await installDurableBranchPlan(input.branchPlan.forkPath, input.branchPlan)
      } catch (error) {
        if (error instanceof SessionBranchingError) {
          throw new CoreOperationTerminalError(`CORE_BRANCH_${error.code}`, error.code === 'INVALID_TARGET' ? 'Requested branch target is unavailable' : 'Core branch operation failed')
        }
        // Storage failures can contain absolute paths or reserved Core IDs in
        // platform-specific error text. They are durable terminal failures but
        // must remain opaque outside the server.
        throw new CoreOperationTerminalError('CORE_BRANCH_STORAGE_FAILURE', 'Core branch storage operation failed')
      }
      this.sessions.invalidateSessionList()
      return input.binding
    }

    try {
      await this.sessions.renameSession(
        requiredString(canonical, 'sessionId'),
        requiredString(canonical, 'title'),
        operation,
      )
    } catch (error) {
      if ((error as { statusCode?: unknown }).statusCode === 409) {
        throw new CoreOperationTerminalError('CORE_RENAME_TRANSCRIPT_INVALID', 'Core rename operation cannot be recovered')
      }
      if (error instanceof Error && error.message.startsWith('Session not found:')) {
        throw new CoreOperationTerminalError('CORE_TARGET_NOT_FOUND', 'Requested Core session is unavailable')
      }
      if (error instanceof CoreOperationTerminalError) throw error
      throw new CoreOperationTerminalError('CORE_RENAME_STORAGE_FAILURE', 'Core rename storage operation failed')
    }
    return input.binding
  }
}

type CoreOperationJournal = {
  reserve(record: OperationRecord): Promise<OperationRecord>
  replace(record: OperationRecord): Promise<void>
  withOperationLock?<T>(operationId: string, operation: () => Promise<T>): Promise<T>
}

function defaultJournalDirectory(): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  return path.join(configDir, 'billiardbuddy', 'core-operation-journal.v1')
}

function operationFileName(clientOperationId: string): string {
  return `${createHash('sha256').update(clientOperationId).digest('hex')}.json`
}

function bindingFor(
  kind: CoreOperationKind,
  operationId: string,
  canonicalInput: string,
): CoreOperationBinding {
  if (kind === 'rename') {
    const input = canonicalObject(canonicalInput)
    return { coreSessionId: requiredString(input, 'sessionId') }
  }
  const digest = createHash('sha256')
    .update('billiardbuddy/core-operation-bridge/v1\0')
    .update(operationId)
    .digest('hex')
  // UUID-shaped deterministic Core identity.  It is never returned by a
  // renderer-facing contract, and is reserved durably before Core execution.
  const value = digest.slice(0, 32)
  return {
    coreSessionId: `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`,
  }
}

function parsePersistedBranchPlan(value: unknown): DurableBranchPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan is invalid')
  }
  const persisted = value as Partial<PersistedBranchPlan>
  if (
    typeof persisted.json !== 'string' ||
    typeof persisted.digest !== 'string' ||
    createHash('sha256').update(persisted.json).digest('hex') !== persisted.digest
  ) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan is invalid')
  }
  let plan: unknown
  try {
    plan = JSON.parse(persisted.json)
  } catch {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan is invalid')
  }
  if (
    !plan || typeof plan !== 'object' || Array.isArray(plan) ||
    typeof (plan as Partial<DurableBranchPlan>).targetSessionId !== 'string' ||
    typeof (plan as Partial<DurableBranchPlan>).sourceSessionId !== 'string' ||
    typeof (plan as Partial<DurableBranchPlan>).sourceTranscriptPath !== 'string' ||
    !Array.isArray((plan as Partial<DurableBranchPlan>).sourceMessageIds) ||
    typeof (plan as Partial<DurableBranchPlan>).forkPath !== 'string' ||
    typeof (plan as Partial<DurableBranchPlan>).projectDirPath !== 'string' ||
    typeof (plan as Partial<DurableBranchPlan>).title !== 'string' ||
    typeof (plan as Partial<DurableBranchPlan>).body !== 'string' ||
    typeof (plan as Partial<DurableBranchPlan>).sha256 !== 'string'
  ) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan is invalid')
  }
  const durablePlan = plan as DurableBranchPlan
  if (!path.isAbsolute(durablePlan.sourceTranscriptPath) || durablePlan.sourceMessageIds.length === 0 || durablePlan.sourceMessageIds.some(id => typeof id !== 'string' || !id) || new Set(durablePlan.sourceMessageIds).size !== durablePlan.sourceMessageIds.length) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan source manifest is invalid')
  }
  if (!path.isAbsolute(durablePlan.forkPath) || !path.isAbsolute(durablePlan.projectDirPath) || path.dirname(durablePlan.forkPath) !== durablePlan.projectDirPath || path.basename(durablePlan.forkPath) !== `${durablePlan.targetSessionId}.jsonl`) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan fork path is invalid')
  }
  if (durablePlan.targetWorkDir !== undefined && (typeof durablePlan.targetWorkDir !== 'string' || !path.isAbsolute(durablePlan.targetWorkDir))) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch work directory is invalid')
  }
  if (createHash('sha256').update(durablePlan.body).digest('hex') !== durablePlan.sha256) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan is invalid')
  }
  return durablePlan
}

function validateBranchPlanBody(plan: DurableBranchPlan, record: Partial<OperationRecord>): void {
  if (!plan.body.endsWith('\n')) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan body is invalid')
  const lines = plan.body.slice(0, -1).split('\n')
  if (lines.length < 2 || lines.some(line => !line.trim())) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan body is invalid')
  let entries: Array<Record<string, unknown>>
  try { entries = lines.map(line => JSON.parse(line) as Record<string, unknown>) } catch { throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan body is invalid') }
  const operation = entries[0]?.coreOperation as Record<string, unknown> | undefined
  const last = entries.at(-1)
  if (entries[0]?.type !== 'session-meta' || operation?.clientOperationId !== record.clientOperationId || operation?.canonicalInput !== record.canonicalInput || last?.type !== 'custom-title' || last?.sessionId !== record.binding?.coreSessionId || last?.customTitle !== plan.title) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan body is invalid')
  }
  let sourceSessionId: string
  try {
    const canonical = JSON.parse(record.canonicalInput) as {
      sourceSessionId?: unknown
      title?: unknown
      targetMessageId?: unknown
      target?: unknown
    }
    if (typeof canonical.sourceSessionId !== 'string' || !canonical.sourceSessionId || typeof canonical.title !== 'string' || !canonical.title) throw new Error()
    if (canonical.targetMessageId !== undefined && (typeof canonical.targetMessageId !== 'string' || !canonical.targetMessageId)) throw new Error()
    sourceSessionId = canonical.sourceSessionId
    if (
      plan.sourceSessionId !== sourceSessionId ||
      plan.title !== canonical.title ||
      (canonical.targetMessageId !== undefined && plan.targetMessageId !== canonical.targetMessageId) ||
      (canonical.target === 'new_worktree' ? plan.targetWorkDir === undefined : plan.targetWorkDir !== undefined) ||
      typeof plan.targetMessageId !== 'string' ||
      plan.sourceMessageIds.at(-1) !== plan.targetMessageId
    ) throw new Error()
  } catch {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan source is invalid')
  }
  if (
    path.dirname(path.resolve(plan.sourceTranscriptPath)) !== plan.projectDirPath ||
    path.basename(plan.sourceTranscriptPath) !== `${sourceSessionId}.jsonl`
  ) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan source path is invalid')
  const transcriptEntries: Array<Record<string, unknown>> = []
  let parentUuid: string | null = null
  for (const entry of entries.slice(1, -1)) {
    const transcript = ['user', 'assistant', 'attachment', 'system'].includes(String(entry.type))
    if (transcript) {
      if (entry.sessionId !== record.binding?.coreSessionId || typeof entry.uuid !== 'string' || entry.parentUuid !== parentUuid) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan body is invalid')
      const forked = entry.forkedFrom as { sessionId?: unknown; messageUuid?: unknown } | undefined
      if (!forked || forked.sessionId !== sourceSessionId || forked.messageUuid !== entry.uuid) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan body is invalid')
      transcriptEntries.push(entry)
      parentUuid = entry.uuid
    } else if (['worktree-state', 'mode', 'pr-link', 'content-replacement'].includes(String(entry.type)) && entry.sessionId !== record.binding?.coreSessionId) {
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan body is invalid')
    }
  }
  if (transcriptEntries.length === 0 || transcriptEntries.length !== plan.sourceMessageIds.length || !transcriptEntries.every((entry, index) => ((entry.forkedFrom as { messageUuid?: unknown }).messageUuid === plan.sourceMessageIds[index]))) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan source manifest is invalid')
  }
}

function validateRecord(value: unknown): OperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
  }
  const record = value as Partial<OperationRecord>
  if (
    record.version !== 1 ||
    typeof record.clientOperationId !== 'string' ||
    typeof record.productTaskId !== 'string' ||
    (record.kind !== 'create' && record.kind !== 'branch' && record.kind !== 'rename') ||
    typeof record.canonicalInput !== 'string' ||
    !record.binding || typeof record.binding.coreSessionId !== 'string' ||
    (record.binding.branchProjectDirPath !== undefined && (typeof record.binding.branchProjectDirPath !== 'string' || !path.isAbsolute(record.binding.branchProjectDirPath))) ||
    (record.binding.branchWorkDir !== undefined && (typeof record.binding.branchWorkDir !== 'string' || !path.isAbsolute(record.binding.branchWorkDir))) ||
    (record.state !== 'prepared' && record.state !== 'succeeded' && record.state !== 'failed')
  ) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
  }
  if (record.kind !== 'branch' && record.branchTargetPath !== undefined) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch target path is invalid')
  if (record.branchPlan !== undefined) {
    const plan = parsePersistedBranchPlan(record.branchPlan)
    if (record.binding.branchProjectDirPath !== plan.projectDirPath || record.binding.branchWorkDir !== plan.targetWorkDir || record.branchTargetPath !== plan.forkPath || plan.targetSessionId !== record.binding.coreSessionId) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan project directory is invalid')
    validateBranchPlanBody(plan, record)
  }
  if (record.kind === 'branch' && record.state === 'succeeded' && !record.branchPlan) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core branch plan is missing')
  }
  if (
    record.state === 'failed' &&
    (!record.terminalFailure || typeof record.terminalFailure.code !== 'string' || typeof record.terminalFailure.message !== 'string')
  ) {
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
  }
  return record as OperationRecord
}

class FileCoreOperationJournal implements CoreOperationJournal {
  constructor(private readonly directory = defaultJournalDirectory()) {}

  private filePath(operationId: string): string {
    return path.join(this.directory, operationFileName(operationId))
  }

  private integrityKeyPath(): string {
    return path.join(this.directory, '.integrity-key')
  }

  /** Deterministic encoding prevents property insertion order from changing a MAC. */
  private stableJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
      return JSON.stringify(value)
    }
    if (Array.isArray(value)) return `[${value.map(entry => this.stableJson(entry)).join(',')}]`
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
      return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${this.stableJson(entry)}`).join(',')}}`
    }
    throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
  }

  private withoutIntegrity(record: OperationRecord): Omit<OperationRecord, 'integrity'> {
    const { integrity: _integrity, ...unsigned } = record
    return unsigned
  }

  private async readExistingIntegrityKey(): Promise<string | undefined> {
    const keyPath = this.integrityKeyPath()
    let key: string
    let stat: Awaited<ReturnType<typeof fs.stat>>
    try {
      [key, stat] = await Promise.all([fs.readFile(keyPath, 'utf8'), fs.stat(keyPath)])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
    }
    if ((stat.mode & 0o077) !== 0 || !/^[0-9a-f]{64}$/.test(key.trim())) {
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
    }
    return key.trim()
  }

  private async getIntegrityKey(allowLegacyPrepared = false): Promise<string> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const keyPath = this.integrityKeyPath()
    const migrationGuard = path.join(this.directory, '.integrity-migration.guard')
    await fs.writeFile(migrationGuard, '', { encoding: 'utf8', mode: 0o600, flag: 'a' })
    const release = await lock(migrationGuard, {
      realpath: false,
      stale: 30_000,
      update: 10_000,
      retries: { retries: 50, minTimeout: 10, maxTimeout: 100 },
    })
    try {
      const manifestPath = path.join(this.directory, '.integrity-migration.v1')
      const migrationPending = await fs.access(manifestPath).then(() => true, () => false)
      const existing = await this.readExistingIntegrityKey()
      if (existing && !migrationPending) return existing
      let generated: string
      let plannedRecords: string[]
      try {
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version?: unknown; key?: unknown; records?: unknown }
        if (manifest.version !== 1 || typeof manifest.key !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.key) || !Array.isArray(manifest.records) || !manifest.records.every(name => typeof name === 'string' && /^[0-9a-f]{64}\.json$/.test(name))) {
          throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
        }
        generated = manifest.key
        plannedRecords = [...manifest.records]
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          if (error instanceof CoreOperationBridgeError) throw error
          throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
        }
        generated = randomBytes(32).toString('hex')
        const records = (await fs.readdir(this.directory)).filter(name => name.endsWith('.json'))
        plannedRecords = records
        const temporaryManifestPath = `${manifestPath}.${randomUUID()}.tmp`
        try {
          await fs.writeFile(temporaryManifestPath, JSON.stringify({ version: 1, key: generated, records }), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
          await fs.rename(temporaryManifestPath, manifestPath)
        } catch (error) {
          await fs.unlink(temporaryManifestPath).catch(() => {})
          throw error
        }
      }
    // A lost key must never reset trust for signed records. Legacy migration
    // signs every prepared record in the directory as one locked transition.
    try {
      const entries = await Promise.all(
        (await fs.readdir(this.directory)).filter(name => name.endsWith('.json')).map(async name => {
          try { return { name, record: validateRecord(JSON.parse(await fs.readFile(path.join(this.directory, name), 'utf8'))) } } catch { return undefined }
        }),
      )
      const currentRecords = entries.map(entry => entry?.name).sort()
      if (currentRecords.length !== plannedRecords.length || currentRecords.some((name, index) => name !== [...plannedRecords].sort()[index])) {
        throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
      }
      if (entries.length > 0 && (!allowLegacyPrepared || entries.some(entry => !entry || entry.record.state !== 'prepared' || (entry.record.integrity !== undefined && (() => { try { this.verifyIntegrity(entry.record, generated); return false } catch { return true } })())))) {
        throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
      }
      if (entries.length > 0) {
        for (const entry of entries as Array<{ name: string; record: OperationRecord }>) {
          if (entry.record.integrity !== undefined) continue
          const filePath = path.join(this.directory, entry.name)
          const temporaryPath = `${filePath}.${randomUUID()}.migration.tmp`
          const signed = { ...this.withoutIntegrity(entry.record), integrity: this.mac(entry.record, generated) }
          try {
            await fs.writeFile(temporaryPath, JSON.stringify(signed), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
            await fs.rename(temporaryPath, filePath)
          } catch (error) {
            await fs.unlink(temporaryPath).catch(() => {})
            throw error
          }
        }
      }
    } catch (error) {
      if (error instanceof CoreOperationBridgeError) throw error
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
    }
    try {
      await fs.writeFile(keyPath, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await fs.unlink(manifestPath)
      return generated
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
      }
      const racedKey = await this.readExistingIntegrityKey()
      if (!racedKey || racedKey !== generated) throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
      await fs.unlink(manifestPath)
      return racedKey
    }
    } finally {
      await release()
    }
  }

  private mac(record: OperationRecord, key: string): string {
    return createHmac('sha256', Buffer.from(key, 'hex'))
      .update(this.stableJson(this.withoutIntegrity(record)))
      .digest('hex')
  }

  private verifyIntegrity(record: OperationRecord, key: string): void {
    if (typeof record.integrity !== 'string' || !/^[0-9a-f]{64}$/.test(record.integrity)) {
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
    }
    const expected = Buffer.from(this.mac(record, key), 'hex')
    const actual = Buffer.from(record.integrity, 'hex')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
    }
  }

  private async writeRecord(
    filePath: string,
    record: OperationRecord,
    flag: 'wx' | undefined,
    allowLegacyPrepared = false,
  ): Promise<void> {
    validateRecord(record)
    const key = await this.getIntegrityKey(allowLegacyPrepared)
    const signed: OperationRecord = { ...this.withoutIntegrity(record), integrity: this.mac(record, key) }
    await fs.writeFile(filePath, JSON.stringify(signed), { encoding: 'utf8', mode: 0o600, ...(flag ? { flag } : {}) })
  }

  async withOperationLock<T>(operationId: string, operation: () => Promise<T>): Promise<T> {
    let release: (() => Promise<void>)
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
      const lockTarget = path.join(this.directory, `.${operationFileName(operationId)}.guard`)
      // The guard is separate from the journal file, so the lock is acquired
      // before any process creates or reads the journal record itself.
      await fs.writeFile(lockTarget, '', { flag: 'a', mode: 0o600 })
      release = await lock(lockTarget, {
        realpath: false,
        stale: 30_000,
        update: 10_000,
        retries: { retries: 50, minTimeout: 10, maxTimeout: 100 },
      })
    } catch (error) {
      if (error instanceof CoreOperationBridgeError) throw error
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
    }
    try {
      return await operation()
    } finally {
      await release!()
    }
  }

  private async read(filePath: string): Promise<OperationRecord> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fs.readFile(filePath, 'utf8'))
    } catch {
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
    }
    let record: OperationRecord
    try {
      record = validateRecord(parsed)
    } catch (error) {
      if (error instanceof CoreOperationBridgeError) throw error
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
    }
    // Observe key existence before considering legacy migration. Once a key
    // exists, removing a record MAC is tampering, never an upgrade request.
    const existingKey = await this.readExistingIntegrityKey()
    if (record.integrity === undefined) {
      // Pre-MAC journals are only recoverable while no Core result has been
      // committed and no integrity root has previously been established.
      if (existingKey || record.state !== 'prepared') {
        throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is invalid')
      }
      await this.replace(record, true)
      return record
    }
    if (!existingKey) {
      // A signed record with no published key can only be recovered through a
      // valid migration manifest guarded by getIntegrityKey.
      const recoveredKey = await this.getIntegrityKey(true)
      this.verifyIntegrity(record, recoveredKey)
      return record
    }
    this.verifyIntegrity(record, existingKey)
    return record
  }

  async reserve(record: OperationRecord): Promise<OperationRecord> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const filePath = this.filePath(record.clientOperationId)
    // Read an existing record before initializing a key for a new one. This is
    // what permits exactly the prepared-only legacy migration without letting a
    // missing key silently reset trust for signed histories.
    try {
      await fs.access(filePath)
      return this.read(filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await this.writeRecord(filePath, record, 'wx')
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
      }
      return this.read(filePath)
    }
  }

  async replace(record: OperationRecord, allowLegacyPrepared = false): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const filePath = this.filePath(record.clientOperationId)
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`
    try {
      await this.writeRecord(temporaryPath, record, 'wx', allowLegacyPrepared)
      await fs.rename(temporaryPath, filePath)
    } catch (error) {
      await fs.unlink(temporaryPath).catch(() => {})
      if (error instanceof CoreOperationBridgeError) throw error
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation journal is unavailable')
    }
  }
}

export class CoreOperationBridge {
  private static readonly operationLocks = new Map<string, Promise<void>>()
  private readonly journal: CoreOperationJournal

  constructor(
    private readonly backend: DurableCoreOperationBackend,
    options: { journalDirectory?: string; journal?: CoreOperationJournal } = {},
  ) {
    this.journal = options.journal ?? new FileCoreOperationJournal(options.journalDirectory)
  }

  ensureCreate(clientOperationId: string, productTaskId: string, canonicalInput: string): Promise<CoreOperationBinding> {
    return this.ensure('create', clientOperationId, productTaskId, canonicalInput)
  }

  ensureBranch(clientOperationId: string, productTaskId: string, canonicalInput: string): Promise<CoreOperationBinding> {
    return this.ensure('branch', clientOperationId, productTaskId, canonicalInput)
  }

  ensureRename(clientOperationId: string, productTaskId: string, canonicalInput: string): Promise<CoreOperationBinding> {
    return this.ensure('rename', clientOperationId, productTaskId, canonicalInput)
  }

  private async prepareBranch(record: OperationRecord): Promise<OperationRecord> {
    if (record.branchPlan) return record
    const plan = await this.backend.prepareBranch({
      clientOperationId: record.clientOperationId,
      canonicalInput: record.canonicalInput,
      binding: record.binding,
    })
    if (plan.targetSessionId !== record.binding.coreSessionId) {
      throw new CoreOperationBridgeError(
        'CORE_OPERATION_BINDING_MISMATCH',
        'Core branch plan does not match its reserved identity',
      )
    }
    const json = JSON.stringify(plan)
    const prepared = {
      ...record,
      binding: { ...record.binding, branchProjectDirPath: plan.projectDirPath, ...(plan.targetWorkDir ? { branchWorkDir: plan.targetWorkDir } : {}) },
      branchTargetPath: plan.forkPath,
      branchPlan: {
        json,
        digest: createHash('sha256').update(json).digest('hex'),
      },
    }
    validateBranchPlanBody(parsePersistedBranchPlan(prepared.branchPlan), prepared)
    await this.journal.replace(prepared)
    return prepared
  }

  private async ensure(
    kind: CoreOperationKind,
    clientOperationId: string,
    productTaskId: string,
    canonicalInput: string,
  ): Promise<CoreOperationBinding> {
    if (!clientOperationId || !productTaskId || typeof canonicalInput !== 'string') {
      throw new CoreOperationBridgeError('CORE_OPERATION_JOURNAL_INVALID', 'Core operation arguments are invalid')
    }
    return this.withOperationLock(clientOperationId, async () => {
      const intended: OperationRecord = {
        version: 1,
        clientOperationId,
        productTaskId,
        kind,
        canonicalInput,
        binding: bindingFor(kind, clientOperationId, canonicalInput),
        state: 'prepared',
      }
      const execute = async (): Promise<CoreOperationBinding> => {
        const record = await this.journal.reserve(intended)
        this.assertSameOperation(record, intended)
        if (record.state === 'succeeded') {
          const actualBinding = await this.backend.ensure({
            clientOperationId,
            productTaskId,
            kind,
            canonicalInput,
            binding: record.binding,
            ...(record.branchPlan ? { branchPlan: parsePersistedBranchPlan(record.branchPlan) } : {}),
          })
          if (actualBinding.coreSessionId !== record.binding.coreSessionId) {
            throw new CoreOperationBridgeError('CORE_OPERATION_BINDING_MISMATCH', 'Core backend returned a different operation binding')
          }
          return record.binding
        }
        if (record.state === 'failed') {
          throw new CoreOperationTerminalError(
            record.terminalFailure!.code,
            record.terminalFailure!.message,
          )
        }

        let preparedRecord = record
        try {
          if (kind === 'branch') {
            preparedRecord = await this.prepareBranch(record)
          }
          const actualBinding = await this.backend.ensure({
            clientOperationId,
            productTaskId,
            kind,
            canonicalInput,
            binding: preparedRecord.binding,
            ...(preparedRecord.branchPlan
              ? { branchPlan: parsePersistedBranchPlan(preparedRecord.branchPlan) }
              : {}),
          })
          if (actualBinding.coreSessionId !== preparedRecord.binding.coreSessionId) {
            throw new CoreOperationBridgeError(
              'CORE_OPERATION_BINDING_MISMATCH',
              'Core backend returned a different operation binding',
            )
          }
          await this.journal.replace({ ...preparedRecord, state: 'succeeded' })
          return preparedRecord.binding
        } catch (error) {
          if (error instanceof CoreOperationTerminalError) {
            await this.journal.replace({
              ...preparedRecord,
              state: 'failed',
              terminalFailure: { code: error.terminalCode, message: error.message },
            })
          }
          throw error
        }
      }
      return this.journal.withOperationLock
        ? this.journal.withOperationLock(clientOperationId, execute)
        : execute()
    })
  }

  private assertSameOperation(actual: OperationRecord, expected: OperationRecord): void {
    if (
      actual.clientOperationId !== expected.clientOperationId ||
      actual.productTaskId !== expected.productTaskId ||
      actual.kind !== expected.kind ||
      actual.canonicalInput !== expected.canonicalInput
    ) {
      throw new CoreOperationBridgeError(
        'CORE_OPERATION_INPUT_CONFLICT',
        'client_operation_id must retain its original canonical input',
      )
    }
    if (actual.binding.coreSessionId !== expected.binding.coreSessionId) {
      throw new CoreOperationBridgeError(
        'CORE_OPERATION_BINDING_MISMATCH',
        'Core operation journal binding does not match its reserved identity',
      )
    }
  }

  private async withOperationLock<T>(operationId: string, operation: () => Promise<T>): Promise<T> {
    const key = `${this.journal.constructor.name}:${operationId}`
    const previous = CoreOperationBridge.operationLocks.get(key) ?? Promise.resolve()
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = previous.then(() => gate)
    CoreOperationBridge.operationLocks.set(key, queued)
    await previous
    try {
      return await operation()
    } finally {
      release?.()
      if (CoreOperationBridge.operationLocks.get(key) === queued) {
        CoreOperationBridge.operationLocks.delete(key)
      }
    }
  }
}
