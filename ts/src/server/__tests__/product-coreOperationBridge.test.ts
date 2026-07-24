import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createHash, createHmac } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SessionService } from '../services/sessionService.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import type { DurableBranchPlan } from '../../utils/sessionBranching.js'
import {
  CoreOperationBridge,
  CoreOperationBridgeError,
  CoreOperationTerminalError,
  SessionCoreOperationBackend,
  type CoreOperationBinding,
  type DurableCoreOperationBackend,
} from '../product/coreOperationBridge.js'

type FakeOperation = Parameters<DurableCoreOperationBackend['ensure']>[0]

class FakeDurableCoreBackend implements DurableCoreOperationBackend {
  readonly bindings = new Map<string, CoreOperationBinding>()
  readonly calls = new Map<string, number>()
  readonly branchPlans: DurableBranchPlan[] = []
  crashBeforeEnsure = false
  crashAfterEnsure = false
  terminalFailure: CoreOperationTerminalError | null = null

  async prepareBranch(input: {
    clientOperationId: string
    canonicalInput: string
    binding: CoreOperationBinding
  }): Promise<DurableBranchPlan> {
    const targetSessionId = input.binding.coreSessionId as `${string}-${string}-${string}-${string}-${string}`
    const canonical = JSON.parse(input.canonicalInput) as { sourceSessionId?: string; title?: string }
    const title = canonical.title ?? 'Frozen branch'
    const body = [
      JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        coreOperation: {
          clientOperationId: input.clientOperationId,
          canonicalInput: input.canonicalInput,
        },
      }),
      JSON.stringify({
        type: 'user',
        sessionId: targetSessionId,
        uuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee',
        parentUuid: null,
        forkedFrom: {
          sessionId: canonical.sourceSessionId ?? 'source',
          messageUuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee',
        },
        message: { role: 'user', content: 'Frozen branch' },
      }),
      JSON.stringify({
        type: 'custom-title',
        sessionId: targetSessionId,
        customTitle: title,
      }),
    ].join('\n') + '\n'
    return {
      targetSessionId,
      sourceSessionId: canonical.sourceSessionId ?? 'source',
      sourceTranscriptPath: '/tmp/source.jsonl',
      sourceMessageIds: ['eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee'],
      forkPath: path.join('/tmp', `${targetSessionId}.jsonl`),
      projectDirPath: '/tmp',
      targetMessageId: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee',
      title,
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
    }
  }

  async ensure(input: FakeOperation): Promise<CoreOperationBinding> {
    if (input.branchPlan) this.branchPlans.push(input.branchPlan)
    this.calls.set(input.clientOperationId, (this.calls.get(input.clientOperationId) ?? 0) + 1)
    if (this.crashBeforeEnsure) {
      this.crashBeforeEnsure = false
      throw new Error('simulated process crash before Core mutation')
    }
    if (this.terminalFailure) throw this.terminalFailure
    const binding = this.bindings.get(input.clientOperationId) ?? input.binding
    this.bindings.set(input.clientOperationId, binding)
    if (this.crashAfterEnsure) {
      this.crashAfterEnsure = false
      throw new Error('simulated process crash after Core mutation')
    }
    return binding
  }
}

let journalDirectory: string

beforeEach(async () => {
  journalDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-bridge-'))
})

afterEach(async () => {
  await fs.rm(journalDirectory, { recursive: true, force: true })
})

function reservedCreateSessionId(operationId: string): string {
  const value = createHash('sha256')
    .update('billiardbuddy/core-operation-bridge/v1\0')
    .update(operationId)
    .digest('hex')
    .slice(0, 32)
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-5${value.slice(13, 16)}-a${value.slice(17, 20)}-${value.slice(20)}`
}

function stableJournalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJournalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJournalJson(entry)}`).join(',')}}`
}

function resignJournalRecord(record: Record<string, any>, key: string): void {
  const { integrity: _integrity, ...unsigned } = record
  record.integrity = createHmac('sha256', Buffer.from(key, 'hex')).update(stableJournalJson(unsigned)).digest('hex')
}

function bridge(backend: FakeDurableCoreBackend): CoreOperationBridge {
  return new CoreOperationBridge(backend, { journalDirectory })
}

function ensure(
  instance: CoreOperationBridge,
  kind: 'create' | 'branch' | 'rename',
  operationId: string,
  input?: string,
): Promise<CoreOperationBinding> {
  const canonicalInput = input ?? (kind === 'rename'
    ? '{"sessionId":"aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa","canonical":true}'
    : kind === 'branch'
      ? '{"canonical":true,"sourceSessionId":"source","title":"Frozen branch"}'
      : '{"canonical":true}')
  if (kind === 'create') return instance.ensureCreate(operationId, 'task_opaque', canonicalInput)
  if (kind === 'branch') return instance.ensureBranch(operationId, 'task_opaque', canonicalInput)
  return instance.ensureRename(operationId, 'task_opaque', canonicalInput)
}

describe('CoreOperationBridge', () => {
  for (const kind of ['create', 'branch', 'rename'] as const) {
    it(`${kind} reuses the reserved private binding across retries and crashes`, async () => {
      const backend = new FakeDurableCoreBackend()
      backend.crashBeforeEnsure = true
      const operationId = `${kind}-crash-before`

      await expect(ensure(bridge(backend), kind, operationId)).rejects.toThrow('before Core mutation')
      const afterBeforeCrash = await ensure(bridge(backend), kind, operationId)

      backend.crashAfterEnsure = true
      const postMutationOperation = `${kind}-crash-after`
      await expect(ensure(bridge(backend), kind, postMutationOperation)).rejects.toThrow('after Core mutation')
      // A fresh bridge represents the restarted server process. The fake Core
      // backend is durable and therefore returns its already-created binding.
      const afterMutationCrash = await ensure(bridge(backend), kind, postMutationOperation)
      const repeated = await ensure(bridge(backend), kind, postMutationOperation)

      expect(afterBeforeCrash).toEqual(backend.bindings.get(operationId))
      expect(afterMutationCrash).toEqual(backend.bindings.get(postMutationOperation))
      expect(repeated).toEqual(afterMutationCrash)
      expect(backend.bindings.size).toBe(2)
      if (kind === 'rename') {
        expect(afterMutationCrash.coreSessionId).toBe('aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa')
      }
    })

    it(`${kind} rejects a changed canonical input for the same operation id`, async () => {
      const backend = new FakeDurableCoreBackend()
      const instance = bridge(backend)
      const firstInput = kind === 'rename'
        ? '{"sessionId":"aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa","title":"first"}'
        : kind === 'branch'
          ? '{"sourceSessionId":"source","title":"first"}'
          : '{"title":"first"}'
      const secondInput = kind === 'rename'
        ? '{"sessionId":"aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa","title":"second"}'
        : kind === 'branch'
          ? '{"sourceSessionId":"source","title":"second"}'
          : '{"title":"second"}'
      await ensure(instance, kind, `${kind}-conflict`, firstInput)

      await expect(
        ensure(instance, kind, `${kind}-conflict`, secondInput),
      ).rejects.toMatchObject({ code: 'CORE_OPERATION_INPUT_CONFLICT' })
      expect(backend.calls.get(`${kind}-conflict`)).toBe(1)
    })

    it(`${kind} serializes concurrent retries to one durable Core mutation`, async () => {
      const backend = new FakeDurableCoreBackend()
      const instance = bridge(backend)
      const operationId = `${kind}-concurrent`
      const results = await Promise.all(
        Array.from({ length: 12 }, () => ensure(instance, kind, operationId)),
      )

      expect(new Set(results.map((result) => result.coreSessionId)).size).toBe(1)
      expect(backend.calls.get(operationId)).toBe(12)
      expect(backend.bindings.size).toBe(1)
    })

    it(`${kind} persists a known terminal failure`, async () => {
      const backend = new FakeDurableCoreBackend()
      backend.terminalFailure = new CoreOperationTerminalError('CORE_REJECTED', 'Core rejected operation')
      const operationId = `${kind}-terminal`

      await expect(ensure(bridge(backend), kind, operationId)).rejects.toMatchObject({ terminalCode: 'CORE_REJECTED' })
      backend.terminalFailure = null
      await expect(ensure(bridge(backend), kind, operationId)).rejects.toMatchObject({ terminalCode: 'CORE_REJECTED' })
      expect(backend.calls.get(operationId)).toBe(1)
    })
  }

  it('persists a frozen branch plan before ensure and reuses it after a crash', async () => {
    const backend = new FakeDurableCoreBackend()
    backend.crashAfterEnsure = true
    const operationId = 'branch-frozen-plan'
    const canonicalInput = '{"sourceSessionId":"source","title":"Frozen branch"}'

    await expect(ensure(bridge(backend), 'branch', operationId, canonicalInput)).rejects.toThrow('after Core mutation')
    const journalPath = path.join(
      journalDirectory,
      `${createHash('sha256').update(operationId).digest('hex')}.json`,
    )
    const record = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
      branchPlan: { json: string; digest: string }
    }
    expect(createHash('sha256').update(record.branchPlan.json).digest('hex')).toBe(record.branchPlan.digest)
    const persistedPlan = JSON.parse(record.branchPlan.json) as DurableBranchPlan
    expect(createHash('sha256').update(persistedPlan.body).digest('hex')).toBe(persistedPlan.sha256)

    await ensure(bridge(backend), 'branch', operationId, canonicalInput)
    expect(backend.branchPlans).toEqual([persistedPlan, persistedPlan])
  })

  it('rejects a hash-valid forged branch plan before installation', async () => {
    const operationId = 'forged-branch-plan'
    const targetSessionId = reservedCreateSessionId(operationId)
    const forkPath = path.join(journalDirectory, `${targetSessionId}.jsonl`)
    const body = '{"not":"transcript"}\n'
    let ensureCalls = 0
    const backend: DurableCoreOperationBackend = {
      prepareBranch: async () => ({
        targetSessionId,
        forkPath,
        projectDirPath: journalDirectory,
        title: 'Forged branch',
        body,
        sha256: createHash('sha256').update(body).digest('hex'),
      }),
      ensure: async input => {
        ensureCalls += 1
        return input.binding
      },
    }
    await expect(new CoreOperationBridge(backend, { journalDirectory }).ensureBranch(
      operationId,
      'task_opaque',
      '{"sourceSessionId":"source","title":"Forged branch"}',
    )).rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(await fs.access(forkPath).then(() => true, () => false)).toBeFalse()
    expect(ensureCalls).toBe(0)

    const otherDir = path.join(journalDirectory, 'other')
    const crossDirPlan = {
      targetSessionId,
      sourceTranscriptPath: '/tmp/source.jsonl',
      sourceMessageIds: ['eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee'],
      forkPath: path.join(otherDir, `${targetSessionId}.jsonl`),
      projectDirPath: otherDir,
      title: 'Forged branch',
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
    }
    const crossDirBackend: DurableCoreOperationBackend = {
      prepareBranch: async () => crossDirPlan,
      ensure: async input => input.binding,
    }
    await expect(new CoreOperationBridge(crossDirBackend, { journalDirectory: path.join(journalDirectory, 'cross-dir') }).ensureBranch(
      operationId,
      'task_opaque',
      '{"sourceSessionId":"source","title":"Forged branch"}',
    )).rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
  })


  it('rejects a branch plan with a forged intermediate fork provenance', async () => {
    const operationId = 'forged-branch-message'
    const targetSessionId = reservedCreateSessionId(operationId)
    const forkPath = path.join(journalDirectory, `${targetSessionId}.jsonl`)
    const canonicalInput = '{"sourceSessionId":"source","title":"Forged branch"}'
    const body = [
      JSON.stringify({ type: 'session-meta', isMeta: true, coreOperation: { clientOperationId: operationId, canonicalInput } }),
      JSON.stringify({ type: 'user', sessionId: targetSessionId, uuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee', parentUuid: null, forkedFrom: { sessionId: 'other-source', messageUuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee' }, message: { role: 'user', content: 'forged' } }),
      JSON.stringify({ type: 'custom-title', sessionId: targetSessionId, customTitle: 'Forged branch' }),
    ].join('\n') + '\n'
    let ensureCalls = 0
    const backend: DurableCoreOperationBackend = {
      prepareBranch: async () => ({ targetSessionId, forkPath, projectDirPath: journalDirectory, title: 'Forged branch', body, sha256: createHash('sha256').update(body).digest('hex') }),
      ensure: async input => { ensureCalls += 1; return input.binding },
    }
    await expect(new CoreOperationBridge(backend, { journalDirectory }).ensureBranch(operationId, 'task_opaque', canonicalInput))
      .rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(await fs.access(forkPath).then(() => true, () => false)).toBeFalse()
    expect(ensureCalls).toBe(0)
  })


  it('rejects a marker-and-title branch plan with no transcript entries', async () => {
    const operationId = 'empty-branch-manifest'
    const targetSessionId = reservedCreateSessionId(operationId)
    const canonicalInput = '{"sourceSessionId":"source","title":"Empty branch"}'
    const body = [
      JSON.stringify({ type: 'session-meta', isMeta: true, coreOperation: { clientOperationId: operationId, canonicalInput } }),
      JSON.stringify({ type: 'custom-title', sessionId: targetSessionId, customTitle: 'Empty branch' }),
    ].join('\n') + '\n'
    let ensureCalls = 0
    const backend: DurableCoreOperationBackend = {
      prepareBranch: async () => ({ targetSessionId, sourceTranscriptPath: '/tmp/source.jsonl', sourceMessageIds: ['eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee'], forkPath: path.join('/tmp', `${targetSessionId}.jsonl`), projectDirPath: '/tmp', title: 'Empty branch', body, sha256: createHash('sha256').update(body).digest('hex') }),
      ensure: async input => { ensureCalls += 1; return input.binding },
    }
    await expect(new CoreOperationBridge(backend, { journalDirectory }).ensureBranch(operationId, 'task_opaque', canonicalInput))
      .rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(ensureCalls).toBe(0)
  })


  it('rejects a branch plan whose source manifest disagrees with its body', async () => {
    const operationId = 'mismatched-branch-manifest'
    const targetSessionId = reservedCreateSessionId(operationId)
    const canonicalInput = '{"sourceSessionId":"source","title":"Manifest branch"}'
    const body = [
      JSON.stringify({ type: 'session-meta', isMeta: true, coreOperation: { clientOperationId: operationId, canonicalInput } }),
      JSON.stringify({ type: 'user', sessionId: targetSessionId, uuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee', parentUuid: null, forkedFrom: { sessionId: 'source', messageUuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee' }, message: { role: 'user', content: 'valid body' } }),
      JSON.stringify({ type: 'custom-title', sessionId: targetSessionId, customTitle: 'Manifest branch' }),
    ].join('\n') + '\n'
    let ensureCalls = 0
    const backend: DurableCoreOperationBackend = {
      prepareBranch: async () => ({ targetSessionId, sourceTranscriptPath: '/tmp/source.jsonl', sourceMessageIds: ['ffffffff-ffff-5fff-afff-ffffffffffff'], forkPath: path.join('/tmp', `${targetSessionId}.jsonl`), projectDirPath: '/tmp', title: 'Manifest branch', body, sha256: createHash('sha256').update(body).digest('hex') }),
      ensure: async input => { ensureCalls += 1; return input.binding },
    }
    await expect(new CoreOperationBridge(backend, { journalDirectory }).ensureBranch(operationId, 'task_opaque', canonicalInput)).rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(ensureCalls).toBe(0)
  })


  it('fails closed when a succeeded journal record is tampered', async () => {
    const backend = new FakeDurableCoreBackend()
    backend.crashBeforeEnsure = true
    const operationId = 'tampered-succeeded-replay'
    const instance = bridge(backend)
    await expect(instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')).rejects.toThrow('before Core mutation')
    const journalFile = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    const record = JSON.parse(await fs.readFile(journalFile, 'utf8')) as Record<string, unknown>
    record.state = 'succeeded'
    await fs.writeFile(journalFile, JSON.stringify(record), 'utf8')

    await expect(instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}'))
      .rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(backend.calls.get(operationId)).toBe(1)
  })


  it('serializes first journal reservation across independent bridge instances', async () => {
    const backend = new FakeDurableCoreBackend()
    const first = bridge(backend)
    const second = bridge(backend)
    const [left, right] = await Promise.all([
      first.ensureCreate('first-reserve-race', 'task_opaque', '{"workDir":"/safe"}'),
      second.ensureCreate('first-reserve-race', 'task_opaque', '{"workDir":"/safe"}'),
    ])

    expect(left).toEqual(right)
    expect(backend.calls.get('first-reserve-race')).toBe(2)
  })

  it('maps rename storage errors to a stable opaque terminal', async () => {
    const sessionId = 'aaaaaaaa-aaaa-5aaa-aaaa-aaaaaaaaaaaa'
    const backend = new SessionCoreOperationBackend({
      renameSession: async () => { throw Object.assign(new Error(`/private/secret/${sessionId}`), { code: 'EACCES' }) },
    } as unknown as SessionService)
    const instance = new CoreOperationBridge(backend, { journalDirectory })
    const operationId = 'rename-storage-failure'
    const input = JSON.stringify({ sessionId, title: 'Rename' })
    let failure: unknown
    try {
      await instance.ensureRename(operationId, 'task_opaque', input)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ terminalCode: 'CORE_RENAME_STORAGE_FAILURE', message: 'Core rename storage operation failed' })
    expect(JSON.stringify(failure)).not.toContain(sessionId)
    const journalPath = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    expect(JSON.parse(await fs.readFile(journalPath, 'utf8'))).toMatchObject({ state: 'failed', terminalFailure: { code: 'CORE_RENAME_STORAGE_FAILURE' } })
    await expect(instance.ensureRename(operationId, 'task_opaque', input)).rejects.toMatchObject({ terminalCode: 'CORE_RENAME_STORAGE_FAILURE' })
  })

  it('rejects incomplete and snapshot-only create targets without overwriting them', async () => {
    const configDir = path.join(journalDirectory, 'create-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-create-'))
    try {
      const operationId = 'real-create-half-written'
      const sessionId = reservedCreateSessionId(operationId)
      const projectDir = path.join(configDir, 'projects', sanitizePath(await fs.realpath(workDir)))
      await fs.mkdir(projectDir, { recursive: true })
      const targetPath = path.join(projectDir, `${sessionId}.jsonl`)
      await fs.writeFile(targetPath, '{"type":"file-history-snapshot"', 'utf8')
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), {
        journalDirectory: path.join(journalDirectory, 'create-journal'),
      })
      await expect(instance.ensureCreate(operationId, 'task_opaque', JSON.stringify({ workDir })))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
      await expect(instance.ensureCreate(operationId, 'task_opaque', JSON.stringify({ workDir })))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
      expect(await fs.readFile(targetPath, 'utf8')).toBe('{"type":"file-history-snapshot"')

      const snapshotOperationId = 'real-create-snapshot-only'
      const snapshotSessionId = reservedCreateSessionId(snapshotOperationId)
      const snapshotPath = path.join(projectDir, `${snapshotSessionId}.jsonl`)
      const snapshotOnly = JSON.stringify({
        type: 'file-history-snapshot',
        messageId: 'snapshot-only',
        snapshot: { messageId: 'snapshot-only', trackedFileBackups: {}, timestamp: new Date().toISOString() },
      }) + '\n'
      await fs.writeFile(snapshotPath, snapshotOnly, 'utf8')
      await expect(instance.ensureCreate(snapshotOperationId, 'task_opaque', JSON.stringify({ workDir })))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
      await expect(instance.ensureCreate(snapshotOperationId, 'task_opaque', JSON.stringify({ workDir })))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
      expect(await fs.readFile(snapshotPath, 'utf8')).toBe(snapshotOnly)

      const foreignOperationId = 'real-create-foreign'
      const foreignSessionId = reservedCreateSessionId(foreignOperationId)
      await fs.writeFile(path.join(projectDir, `${foreignSessionId}.jsonl`), JSON.stringify({
        type: 'session-meta',
        isMeta: true,
        workDir,
        coreOperation: { clientOperationId: 'other', canonicalInput: '{}' },
      }) + '\n', 'utf8')
      await expect(instance.ensureCreate(foreignOperationId, 'task_opaque', JSON.stringify({ workDir })))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
      await expect(instance.ensureCreate(foreignOperationId, 'task_opaque', JSON.stringify({ workDir })))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('rejects a create replay through a symlinked exact transcript target', async () => {
    const configDir = path.join(journalDirectory, 'create-symlink-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-create-symlink-'))
    const operationId = 'create-symlink-exact-replay'
    const canonicalInput = JSON.stringify({ workDir })
    const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), {
      journalDirectory: path.join(journalDirectory, 'create-symlink-journal'),
    })
    try {
      const binding = await instance.ensureCreate(operationId, 'task_opaque', canonicalInput)
      const targetPath = path.join(configDir, 'projects', sanitizePath(await fs.realpath(workDir)), `${binding.coreSessionId}.jsonl`)
      const expectedBody = await fs.readFile(targetPath, 'utf8')
      const externalPath = path.join(journalDirectory, 'external-create-transcript.jsonl')
      await fs.writeFile(externalPath, expectedBody, 'utf8')
      await fs.unlink(targetPath)
      await fs.symlink(externalPath, targetPath)

      await expect(instance.ensureCreate(operationId, 'task_opaque', canonicalInput))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
      expect((await fs.lstat(targetPath)).isSymbolicLink()).toBeTrue()
      expect(await fs.readFile(externalPath, 'utf8')).toBe(expectedBody)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('persists a file work directory create failure without leaking its path', async () => {
    const configDir = path.join(journalDirectory, 'file-workdir-config')
    const sessions = new SessionService(configDir)
    const workDir = path.join(journalDirectory, 'not-a-directory')
    await fs.writeFile(workDir, 'not a directory')
    const operationId = 'file-workdir-create'
    const journalPath = path.join(journalDirectory, 'file-workdir-journal')
    const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), { journalDirectory: journalPath })
    const canonicalInput = JSON.stringify({ workDir })
    let first: unknown
    try { await instance.ensureCreate(operationId, 'task_opaque', canonicalInput) } catch (error) { first = error }
    expect(first).toMatchObject({ terminalCode: 'CORE_WORKDIR_INVALID' })
    expect((first as Error).message).not.toContain(workDir)
    const journalFile = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    expect(JSON.parse(await fs.readFile(journalFile, 'utf8'))).toMatchObject({ state: 'failed', terminalFailure: { code: 'CORE_WORKDIR_INVALID' } })
    let second: unknown
    try { await instance.ensureCreate(operationId, 'task_opaque', canonicalInput) } catch (error) { second = error }
    expect(second).toMatchObject({ terminalCode: 'CORE_WORKDIR_INVALID' })
    expect((second as Error).message).toBe((first as Error).message)
    expect(await sessions.getSessionLaunchInfo(reservedCreateSessionId(operationId))).toBeNull()
  })


  it('persists a missing work directory create failure after the directory appears', async () => {
    const configDir = path.join(journalDirectory, 'missing-workdir-config')
    const sessions = new SessionService(configDir)
    const workDir = path.join(journalDirectory, 'later-created-workdir')
    const operationId = 'missing-workdir-create'
    const canonicalInput = JSON.stringify({ workDir })
    const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), {
      journalDirectory: path.join(journalDirectory, 'missing-workdir-journal'),
    })

    let failure: unknown
    try {
      await instance.ensureCreate(operationId, 'task_opaque', canonicalInput)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ terminalCode: 'CORE_WORKDIR_INVALID' })
    expect((failure as Error).message).not.toContain(workDir)
    const journalFile = path.join(
      journalDirectory,
      'missing-workdir-journal',
      `${createHash('sha256').update(operationId).digest('hex')}.json`,
    )
    expect(JSON.parse(await fs.readFile(journalFile, 'utf8'))).toMatchObject({
      state: 'failed',
      terminalFailure: { code: 'CORE_WORKDIR_INVALID' },
    })

    await fs.mkdir(workDir)
    await expect(instance.ensureCreate(operationId, 'task_opaque', canonicalInput))
      .rejects.toMatchObject({ terminalCode: 'CORE_WORKDIR_INVALID' })
    expect(await sessions.getSessionLaunchInfo(reservedCreateSessionId(operationId))).toBeNull()
  })


  it('maps a create storage configuration failure to a stable opaque terminal', async () => {
    const configFile = path.join(journalDirectory, 'not-a-config-directory')
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-create-storage-'))
    const journalPath = path.join(journalDirectory, 'create-storage-journal')
    const operationId = 'create-storage-failure'
    try {
      await fs.writeFile(configFile, 'not a directory')
      const instance = new CoreOperationBridge(
        new SessionCoreOperationBackend(new SessionService(configFile)),
        { journalDirectory: journalPath },
      )
      const input = JSON.stringify({ workDir })
      let failure: unknown
      try {
        await instance.ensureCreate(operationId, 'task_opaque', input)
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ terminalCode: 'CORE_CREATE_STORAGE_FAILURE', message: 'Core session storage operation failed' })
      expect(JSON.stringify(failure)).not.toContain(configFile)
      const recordPath = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      expect(JSON.parse(await fs.readFile(recordPath, 'utf8'))).toMatchObject({ state: 'failed', terminalFailure: { code: 'CORE_CREATE_STORAGE_FAILURE', message: 'Core session storage operation failed' } })
      await expect(instance.ensureCreate(operationId, 'task_opaque', input))
        .rejects.toMatchObject({ terminalCode: 'CORE_CREATE_STORAGE_FAILURE', message: 'Core session storage operation failed' })
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('maps a regular-file journal directory to an opaque journal error', async () => {
    const journalFile = path.join(journalDirectory, 'journal-is-a-file')
    await fs.writeFile(journalFile, 'not a directory')
    const backend = new FakeDurableCoreBackend()
    const operationId = 'journal-directory-file'
    let failure: unknown
    try {
      await new CoreOperationBridge(backend, { journalDirectory: journalFile })
        .ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID', message: 'Core operation journal is unavailable' })
    expect(JSON.stringify(failure)).not.toContain(journalFile)
    expect(JSON.stringify(failure)).not.toContain(operationId)
  })

  it('persists a source-missing branch terminal without leaking its source identity', async () => {
    const sourceSessionId = 'dddddddd-dddd-5ddd-addd-dddddddddddd'
    const operationId = 'source-missing-branch'
    const journalPath = path.join(journalDirectory, 'source-missing-journal')
    const instance = new CoreOperationBridge(new SessionCoreOperationBackend(new SessionService(path.join(journalDirectory, 'source-missing-config'))), {
      journalDirectory: journalPath,
    })
    let failure: unknown
    try {
      await instance.ensureBranch(operationId, 'task_opaque', JSON.stringify({ sourceSessionId, title: 'Missing source' }))
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ terminalCode: 'CORE_SOURCE_NOT_FOUND' })
    expect((failure as Error).message).not.toContain(sourceSessionId)
    const journalFile = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    expect(JSON.parse(await fs.readFile(journalFile, 'utf8'))).toMatchObject({
      state: 'failed',
      terminalFailure: { code: 'CORE_SOURCE_NOT_FOUND' },
    })
  })


  it('serializes a real rename across independent processes before first journal reservation', async () => {
    const configDir = path.join(journalDirectory, 'process-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-process-'))
    try {
      const created = await sessions.createSession(workDir)
      const operationId = 'process-first-reserve'
      const canonicalInput = JSON.stringify({ sessionId: created.sessionId, title: 'Process-safe rename' })
      const bridgeModule = path.resolve(import.meta.dir, '../product/coreOperationBridge.ts')
      const worker = [
        `import { CoreOperationBridge, SessionCoreOperationBackend } from ${JSON.stringify(bridgeModule)}`,
        `await new CoreOperationBridge(new SessionCoreOperationBackend(), { journalDirectory: ${JSON.stringify(path.join(journalDirectory, 'process-journal'))} }).ensureRename(${JSON.stringify(operationId)}, 'task_opaque', ${JSON.stringify(canonicalInput)})`,
      ].join('; ')
      const children = Array.from({ length: 2 }, () => Bun.spawn({
        cmd: [process.execPath, '-e', worker],
        env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        stdout: 'pipe',
        stderr: 'pipe',
      }))
      await Promise.all(children.map(async (child) => {
        const exitCode = await child.exited
        expect(exitCode).toBe(0)
      }))

      const launchInfo = await sessions.getSessionLaunchInfo(created.sessionId)
      const entries = (await fs.readFile(launchInfo!.filePath, 'utf8'))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(entries.filter((entry) =>
        entry.type === 'custom-title' &&
        (entry.coreOperation as { clientOperationId?: string } | undefined)?.clientOperationId === operationId,
      )).toHaveLength(1)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('replays an installed create after its work directory is deleted', async () => {
    const configDir = path.join(journalDirectory, 'deleted-workdir-create-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-deleted-workdir-'))
    try {
      const operationId = 'deleted-workdir-create'
      const journalPath = path.join(journalDirectory, 'deleted-workdir-create-journal')
      const real = new SessionCoreOperationBackend(sessions)
      let first = true
      const backend: DurableCoreOperationBackend = {
        ensure: async input => {
          const result = await real.ensure(input)
          if (first) { first = false; throw new Error('crash-after-create') }
          return result
        },
      }
      const canonicalInput = JSON.stringify({ workDir })
      const firstBridge = new CoreOperationBridge(backend, { journalDirectory: journalPath })
      await expect(firstBridge.ensureCreate(operationId, 'task_opaque', canonicalInput)).rejects.toThrow('crash-after-create')
      const binding = { coreSessionId: reservedCreateSessionId(operationId) }
      const launch = await sessions.getSessionLaunchInfo(binding.coreSessionId)
      const bytes = await fs.readFile(launch!.filePath, 'utf8')
      await fs.rm(workDir, { recursive: true, force: true })
      const replayed = await new CoreOperationBridge(backend, { journalDirectory: journalPath }).ensureCreate(operationId, 'task_opaque', canonicalInput)
      expect(replayed).toEqual(binding)
      expect(await fs.readFile(launch!.filePath, 'utf8')).toBe(bytes)
      const journalFile = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      expect(JSON.parse(await fs.readFile(journalFile, 'utf8'))).toMatchObject({ state: 'succeeded' })
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })


  it('replays an installed create through a deleted symlink work directory', async () => {
    const configDir = path.join(journalDirectory, 'symlink-create-config')
    const sessions = new SessionService(configDir)
    const targetWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-symlink-target-'))
    const retargetWorkDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-symlink-retarget-'))
    const symlinkWorkDir = path.join(journalDirectory, 'symlink-workdir')
    try {
      await fs.symlink(targetWorkDir, symlinkWorkDir)
      const operationId = 'deleted-symlink-create'
      const journalPath = path.join(journalDirectory, 'deleted-symlink-create-journal')
      const real = new SessionCoreOperationBackend(sessions)
      let first = true
      const backend: DurableCoreOperationBackend = {
        ensure: async input => {
          const result = await real.ensure(input)
          if (first) { first = false; throw new Error('crash-after-create') }
          return result
        },
      }
      const canonicalInput = JSON.stringify({ workDir: symlinkWorkDir })
      await expect(new CoreOperationBridge(backend, { journalDirectory: journalPath }).ensureCreate(operationId, 'task_opaque', canonicalInput))
        .rejects.toThrow('crash-after-create')
      const binding = { coreSessionId: reservedCreateSessionId(operationId) }
      await fs.unlink(symlinkWorkDir)
      await fs.symlink(retargetWorkDir, symlinkWorkDir)
      const replayed = await new CoreOperationBridge(backend, { journalDirectory: journalPath }).ensureCreate(operationId, 'task_opaque', canonicalInput)
      expect(replayed).toEqual(binding)
      const retargetTranscript = path.join(configDir, 'projects', sanitizePath(await fs.realpath(retargetWorkDir)), `${binding.coreSessionId}.jsonl`)
      expect(await fs.access(retargetTranscript).then(() => true, () => false)).toBeFalse()
      const journalFile = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      expect(JSON.parse(await fs.readFile(journalFile, 'utf8'))).toMatchObject({ state: 'succeeded' })
    } finally {
      await fs.rm(symlinkWorkDir, { force: true })
      await fs.rm(targetWorkDir, { recursive: true, force: true })
      await fs.rm(retargetWorkDir, { recursive: true, force: true })
    }
  })

  it('fails closed when a partial reserved create target survives symlink retargeting', async () => {
    const configDir = path.join(journalDirectory, 'symlink-conflict-config')
    const sessions = new SessionService(configDir)
    const targetA = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-symlink-conflict-a-'))
    const targetB = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-symlink-conflict-b-'))
    const linkPath = path.join(journalDirectory, 'symlink-conflict-workdir')
    const operationId = 'symlink-partial-conflict'
    const binding = reservedCreateSessionId(operationId)
    const journalPath = path.join(journalDirectory, 'symlink-conflict-journal')
    try {
      await fs.symlink(targetA, linkPath)
      const projectA = path.join(configDir, 'projects', sanitizePath(await fs.realpath(targetA)))
      await fs.mkdir(projectA, { recursive: true })
      await fs.writeFile(path.join(projectA, `${binding}.jsonl`), '{partial')
      await fs.unlink(linkPath)
      await fs.symlink(targetB, linkPath)
      const input = JSON.stringify({ workDir: linkPath })
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), { journalDirectory: journalPath })
      await expect(instance.ensureCreate(operationId, 'task_opaque', input))
        .rejects.toMatchObject({ terminalCode: 'CORE_SESSION_OPERATION_CONFLICT' })
      const recordPath = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      expect(JSON.parse(await fs.readFile(recordPath, 'utf8'))).toMatchObject({ state: 'failed', terminalFailure: { code: 'CORE_SESSION_OPERATION_CONFLICT' } })
      const projectB = path.join(configDir, 'projects', sanitizePath(await fs.realpath(targetB)))
      expect(await fs.access(path.join(projectB, `${binding}.jsonl`)).then(() => true, () => false)).toBeFalse()
    } finally {
      await fs.rm(linkPath, { force: true })
      await fs.rm(targetA, { recursive: true, force: true })
      await fs.rm(targetB, { recursive: true, force: true })
    }
  })

  it('persists a truncated durable rename as a public terminal failure', async () => {
    const configDir = path.join(journalDirectory, 'truncated-rename-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-truncated-rename-'))
    try {
      const created = await sessions.createSession(workDir)
      const operationId = 'truncated-durable-rename'
      const canonicalInput = JSON.stringify({ sessionId: created.sessionId, title: 'Recovered title' })
      const launchInfo = await sessions.getSessionLaunchInfo(created.sessionId)
      await fs.appendFile(launchInfo!.filePath, JSON.stringify({
        type: 'custom-title', customTitle: 'interrupted',
        coreOperation: { clientOperationId: operationId, canonicalInput },
      }).slice(0, -1), 'utf8')
      const journalPath = path.join(journalDirectory, 'truncated-rename-journal')
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), { journalDirectory: journalPath })
      let first: unknown
      try { await instance.ensureRename(operationId, 'task_opaque', canonicalInput) } catch (error) { first = error }
      expect(first).toMatchObject({ terminalCode: 'CORE_RENAME_TRANSCRIPT_INVALID' })
      expect((first as Error).message).not.toContain(created.sessionId)
      const journalFile = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      expect(JSON.parse(await fs.readFile(journalFile, 'utf8'))).toMatchObject({ state: 'failed', terminalFailure: { code: 'CORE_RENAME_TRANSCRIPT_INVALID' } })
      let second: unknown
      try { await instance.ensureRename(operationId, 'task_opaque', canonicalInput) } catch (error) { second = error }
      expect(second).toMatchObject({ terminalCode: 'CORE_RENAME_TRANSCRIPT_INVALID' })
      expect((second as Error).message).toBe((first as Error).message)
      expect(await sessions.getCustomTitle(created.sessionId)).toBeNull()
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })


  it('persists a missing rename terminal without leaking its session identity', async () => {
    const missingSessionId = 'cccccccc-cccc-5ccc-accc-cccccccccccc'
    const operationId = 'missing-rename-privacy'
    const journalPath = path.join(journalDirectory, 'missing-rename-privacy-journal')
    const instance = new CoreOperationBridge(
      new SessionCoreOperationBackend(new SessionService(path.join(journalDirectory, 'missing-rename-privacy-config'))),
      { journalDirectory: journalPath },
    )
    const canonicalInput = JSON.stringify({ sessionId: missingSessionId, title: 'Missing' })
    let first: unknown
    try { await instance.ensureRename(operationId, 'task_opaque', canonicalInput) } catch (error) { first = error }
    expect(first).toMatchObject({ terminalCode: 'CORE_TARGET_NOT_FOUND' })
    expect((first as Error).message).not.toContain(missingSessionId)
    const journalFile = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    const record = JSON.parse(await fs.readFile(journalFile, 'utf8')) as { terminalFailure: { message: string } }
    expect(record.terminalFailure.message).not.toContain(missingSessionId)
    let second: unknown
    try { await instance.ensureRename(operationId, 'task_opaque', canonicalInput) } catch (error) { second = error }
    expect((second as Error).message).toBe((first as Error).message)
    expect((second as Error).message).not.toContain(missingSessionId)
  })


  it('uses the real session backend for rename bindings and durable terminal failures', async () => {
    const configDir = path.join(journalDirectory, 'config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-session-'))
    try {
      const created = await sessions.createSession(workDir)
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), {
        journalDirectory: path.join(journalDirectory, 'real-journal'),
      })
      const canonicalRename = JSON.stringify({ sessionId: created.sessionId, title: 'Renamed once' })
      const renamed = await instance.ensureRename('real-rename', 'task_opaque', canonicalRename)
      expect(renamed.coreSessionId).toBe(created.sessionId)
      expect(await sessions.getCustomTitle(created.sessionId)).toBe('Renamed once')

      const missingCanonical = JSON.stringify({
        sessionId: 'cccccccc-cccc-5ccc-accc-cccccccccccc',
        title: 'Missing',
      })
      await expect(instance.ensureRename('real-missing', 'task_opaque', missingCanonical))
        .rejects.toMatchObject({ terminalCode: 'CORE_TARGET_NOT_FOUND' })
      await expect(instance.ensureRename('real-missing', 'task_opaque', missingCanonical))
        .rejects.toMatchObject({ terminalCode: 'CORE_TARGET_NOT_FOUND' })
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('persists a terminal invalid branch target from the real session backend', async () => {
    const configDir = path.join(journalDirectory, 'branch-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-branch-'))
    const sourceSessionId = 'dddddddd-dddd-5ddd-addd-dddddddddddd'
    try {
      const projectDir = path.join(configDir, 'projects', sanitizePath(workDir))
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, `${sourceSessionId}.jsonl`), [
        JSON.stringify({ type: 'session-meta', isMeta: true, workDir, timestamp: new Date().toISOString() }),
        JSON.stringify({
          type: 'user',
          uuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee',
          parentUuid: null,
          isSidechain: false,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'branch me' },
        }),
      ].join('\n') + '\n', 'utf8')
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), {
        journalDirectory: path.join(journalDirectory, 'branch-journal'),
      })
      const targetMessageId = 'ffffffff-ffff-5fff-afff-ffffffffffff'
      let failure: unknown
      try {
        await instance.ensureBranch('real-branch-invalid', 'task_opaque', JSON.stringify({
          sourceSessionId,
          title: 'Invalid branch',
          targetMessageId,
        }))
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ terminalCode: 'CORE_BRANCH_INVALID_TARGET' })
      expect((failure as Error).message).not.toContain(targetMessageId)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('persists an opaque terminal branch storage failure', async () => {
    const configDir = path.join(journalDirectory, 'branch-storage-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-branch-storage-'))
    const sourceSessionId = 'acacacac-acac-5cac-acac-acacacacacac'
    const operationId = 'branch-storage-failure'
    const canonicalInput = JSON.stringify({ sourceSessionId, title: 'Storage branch' })
    const journalPath = path.join(journalDirectory, 'branch-storage-journal')
    try {
      const projectDir = path.join(configDir, 'projects', sanitizePath(workDir))
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, `${sourceSessionId}.jsonl`), [
        JSON.stringify({ type: 'session-meta', isMeta: true, workDir, timestamp: new Date().toISOString() }),
        JSON.stringify({ type: 'user', uuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee', parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'branch me' } }),
      ].join('\n') + '\n')
      const realBackend = new SessionCoreOperationBackend(sessions)
      const backend: DurableCoreOperationBackend = {
        prepareBranch: async input => {
          const plan = await realBackend.prepareBranch(input)
          await fs.chmod(plan.projectDirPath, 0o500)
          return plan
        },
        ensure: async input => realBackend.ensure(input),
      }
      const instance = new CoreOperationBridge(backend, { journalDirectory: journalPath })
      const reservedId = reservedCreateSessionId(operationId)
      let failure: unknown
      try {
        await instance.ensureBranch(operationId, 'task_opaque', canonicalInput)
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ terminalCode: 'CORE_BRANCH_STORAGE_FAILURE', message: 'Core branch storage operation failed' })
      expect(JSON.stringify(failure)).not.toContain(reservedId)
      expect(JSON.stringify(failure)).not.toContain(projectDir)
      const recordPath = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      expect(JSON.parse(await fs.readFile(recordPath, 'utf8'))).toMatchObject({ state: 'failed', terminalFailure: { code: 'CORE_BRANCH_STORAGE_FAILURE', message: 'Core branch storage operation failed' } })
      await expect(instance.ensureBranch(operationId, 'task_opaque', canonicalInput))
        .rejects.toMatchObject({ terminalCode: 'CORE_BRANCH_STORAGE_FAILURE', message: 'Core branch storage operation failed' })
      expect(await fs.access(path.join(projectDir, `${reservedId}.jsonl`)).then(() => true, () => false)).toBeFalse()
    } finally {
      await fs.chmod(path.join(configDir, 'projects', sanitizePath(workDir)), 0o700).catch(() => {})
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('installs a real durable branch from its frozen title and target plan', async () => {
    const configDir = path.join(journalDirectory, 'branch-plan-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-branch-plan-'))
    const sourceSessionId = 'abababab-abab-5bab-abab-abababababab'
    const targetMessageId = 'cdcdcdcd-cdcd-5dcd-adcd-cdcdcdcdcdcd'
    try {
      const projectDir = path.join(configDir, 'projects', sanitizePath(workDir))
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, `${sourceSessionId}.jsonl`), [
        JSON.stringify({ type: 'session-meta', isMeta: true, workDir, timestamp: new Date().toISOString() }),
        JSON.stringify({
          type: 'user',
          uuid: targetMessageId,
          parentUuid: null,
          isSidechain: false,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'branch me' },
        }),
      ].join('\n') + '\n', 'utf8')
      const operationId = 'real-branch-plan'
      const canonicalInput = JSON.stringify({ sourceSessionId, title: 'Frozen branch' })
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), {
        journalDirectory: path.join(journalDirectory, 'branch-plan-journal'),
      })

      const binding = await instance.ensureBranch(operationId, 'task_opaque', canonicalInput)
      await instance.ensureBranch(operationId, 'task_opaque', canonicalInput)
      const forkPath = path.join(projectDir, `${binding.coreSessionId}.jsonl`)
      const journalPath = path.join(
        journalDirectory,
        'branch-plan-journal',
        `${createHash('sha256').update(operationId).digest('hex')}.json`,
      )
      const record = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
        branchPlan: { json: string }
      }
      const plan = JSON.parse(record.branchPlan.json) as DurableBranchPlan

      expect(plan.title).toBe('Frozen branch')
      expect(plan.targetMessageId).toBe(targetMessageId)
      expect(await fs.readFile(forkPath, 'utf8')).toBe(plan.body)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('materializes and replays one isolated worktree for a durable product fork', async () => {
    const configDir = path.join(journalDirectory, 'isolated-branch-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-isolated-branch-'))
    const sourceSessionId = 'dededede-dede-5ede-aede-dededededede'
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: workDir, stdout: 'pipe', stderr: 'pipe' })
    try {
      expect(git('init').exitCode).toBe(0)
      expect(git('config', 'user.email', 'test@example.com').exitCode).toBe(0)
      expect(git('config', 'user.name', 'Test').exitCode).toBe(0)
      await fs.writeFile(path.join(workDir, 'README.md'), 'source\n')
      expect(git('add', 'README.md').exitCode).toBe(0)
      expect(git('commit', '-m', 'source').exitCode).toBe(0)
      const projectDir = path.join(configDir, 'projects', sanitizePath(workDir))
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, `${sourceSessionId}.jsonl`), [
        JSON.stringify({ type: 'session-meta', isMeta: true, workDir, timestamp: new Date().toISOString() }),
        JSON.stringify({ type: 'user', uuid: 'efefefef-efef-5fef-afef-efefefefefef', parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'fork me' } }),
      ].join('\n') + '\n')
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), { journalDirectory: path.join(journalDirectory, 'isolated-branch-journal') })
      const canonical = JSON.stringify({ sourceSessionId, title: 'Isolated fork', target: 'new_worktree' })
      const first = await instance.ensureBranch('isolated-fork', 'task_opaque', canonical)
      const second = await instance.ensureBranch('isolated-fork', 'task_opaque', canonical)
      expect(second).toEqual(first)
      expect(first.branchWorkDir).toContain(`${path.sep}.claude${path.sep}worktrees${path.sep}`)
      expect((await fs.stat(first.branchWorkDir!)).isDirectory()).toBeTrue()
      expect(await fs.readFile(path.join(first.branchWorkDir!, 'README.md'), 'utf8')).toBe('source\n')
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('rejects a durable branch replay through a symlinked exact transcript target', async () => {
    const configDir = path.join(journalDirectory, 'branch-symlink-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-branch-symlink-'))
    const sourceSessionId = 'abababab-abab-5bab-abab-abababababab'
    const targetMessageId = 'cdcdcdcd-cdcd-5dcd-adcd-cdcdcdcdcdcd'
    const operationId = 'branch-symlink-exact-replay'
    const canonicalInput = JSON.stringify({ sourceSessionId, title: 'Frozen branch' })
    try {
      const projectDir = path.join(configDir, 'projects', sanitizePath(workDir))
      await fs.mkdir(projectDir, { recursive: true })
      await fs.writeFile(path.join(projectDir, `${sourceSessionId}.jsonl`), [
        JSON.stringify({ type: 'session-meta', isMeta: true, workDir, timestamp: new Date().toISOString() }),
        JSON.stringify({
          type: 'user',
          uuid: targetMessageId,
          parentUuid: null,
          isSidechain: false,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: 'branch me' },
        }),
      ].join('\n') + '\n', 'utf8')
      const instance = new CoreOperationBridge(new SessionCoreOperationBackend(sessions), {
        journalDirectory: path.join(journalDirectory, 'branch-symlink-journal'),
      })
      const binding = await instance.ensureBranch(operationId, 'task_opaque', canonicalInput)
      const targetPath = path.join(projectDir, `${binding.coreSessionId}.jsonl`)
      const expectedBody = await fs.readFile(targetPath, 'utf8')
      const externalPath = path.join(journalDirectory, 'external-branch-transcript.jsonl')
      await fs.writeFile(externalPath, expectedBody, 'utf8')
      await fs.unlink(targetPath)
      await fs.symlink(externalPath, targetPath)

      await expect(instance.ensureBranch(operationId, 'task_opaque', canonicalInput))
        .rejects.toMatchObject({ terminalCode: 'CORE_BRANCH_INVALID_TARGET' })
      expect((await fs.lstat(targetPath)).isSymbolicLink()).toBeTrue()
      expect(await fs.readFile(externalPath, 'utf8')).toBe(expectedBody)
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('replays an installed frozen branch after its source transcript is deleted', async () => {
    const configDir = path.join(journalDirectory, 'deleted-source-branch-config')
    const sessions = new SessionService(configDir)
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'core-operation-deleted-source-'))
    const sourceSessionId = 'abababab-abab-5bab-abab-abababababab'
    try {
      const projectDir = path.join(configDir, 'projects', sanitizePath(workDir))
      await fs.mkdir(projectDir, { recursive: true })
      const sourcePath = path.join(projectDir, `${sourceSessionId}.jsonl`)
      await fs.writeFile(sourcePath, [
        JSON.stringify({ type: 'session-meta', isMeta: true, workDir, timestamp: new Date().toISOString() }),
        JSON.stringify({ type: 'user', uuid: 'cdcdcdcd-cdcd-5dcd-adcd-cdcdcdcdcdcd', parentUuid: null, isSidechain: false, timestamp: new Date().toISOString(), message: { role: 'user', content: 'branch me' } }),
      ].join('\n') + '\n', 'utf8')
      const operationId = 'deleted-source-branch'
      const canonicalInput = JSON.stringify({ sourceSessionId, title: 'Frozen branch' })
      const journalPath = path.join(journalDirectory, 'deleted-source-branch-journal')
      const real = new SessionCoreOperationBackend(sessions)
      let first = true
      const backend: DurableCoreOperationBackend = {
        prepareBranch: real.prepareBranch.bind(real),
        ensure: async input => {
          const result = await real.ensure(input)
          if (first) { first = false; throw new Error('crash-after-install') }
          return result
        },
      }
      const firstBridge = new CoreOperationBridge(backend, { journalDirectory: journalPath })
      await expect(firstBridge.ensureBranch(operationId, 'task_opaque', canonicalInput)).rejects.toThrow('crash-after-install')
      const recordPath = path.join(journalPath, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      const prepared = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { binding: CoreOperationBinding; branchPlan: { json: string } }
      const plan = JSON.parse(prepared.branchPlan.json) as DurableBranchPlan
      const bytes = await fs.readFile(plan.forkPath, 'utf8')
      await fs.rm(sourcePath)
      const secondBridge = new CoreOperationBridge(backend, { journalDirectory: journalPath })
      const replayed = await secondBridge.ensureBranch(operationId, 'task_opaque', canonicalInput)
      expect(replayed).toEqual(prepared.binding)
      expect(await fs.readFile(plan.forkPath, 'utf8')).toBe(bytes)
      expect(JSON.parse(await fs.readFile(recordPath, 'utf8'))).toMatchObject({ state: 'succeeded' })
    } finally {
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })


  it('upgrades an unsigned prepared legacy record exactly once', async () => {
    const backend = new FakeDurableCoreBackend()
    backend.crashBeforeEnsure = true
    const operationId = 'legacy-prepared-upgrade'
    const instance = bridge(backend)
    await expect(instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')).rejects.toThrow('before Core mutation')
    const journalFile = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    const legacy = JSON.parse(await fs.readFile(journalFile, 'utf8')) as Record<string, unknown>
    delete legacy.integrity
    await fs.writeFile(journalFile, JSON.stringify(legacy), 'utf8')
    await fs.unlink(path.join(journalDirectory, '.integrity-key'))

    const binding = await instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')
    const upgraded = JSON.parse(await fs.readFile(journalFile, 'utf8')) as Record<string, unknown>
    expect(typeof upgraded.integrity).toBe('string')
    expect(upgraded.state).toBe('succeeded')
    expect(binding).toEqual(backend.bindings.get(operationId))
  })

  it('resumes a manifest-backed migration with an already signed prepared record', async () => {
    const backend = new FakeDurableCoreBackend()
    backend.crashBeforeEnsure = true
    const operationId = 'manifest-resume-signed-prepared'
    const instance = bridge(backend)
    await expect(instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')).rejects.toThrow('before Core mutation')
    const fileName = `${createHash('sha256').update(operationId).digest('hex')}.json`
    const keyPath = path.join(journalDirectory, '.integrity-key')
    const key = await fs.readFile(keyPath, 'utf8')
    await fs.unlink(keyPath)
    await fs.writeFile(path.join(journalDirectory, '.integrity-migration.v1'), JSON.stringify({ version: 1, key: key.trim(), records: [fileName] }), { mode: 0o600 })

    const binding = await instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')
    expect(binding).toEqual(backend.bindings.get(operationId))
    expect(await fs.readFile(keyPath, 'utf8')).toBe(key)
    expect(await fs.access(path.join(journalDirectory, '.integrity-migration.v1')).then(() => true, () => false)).toBeFalse()
  })

  it('fails closed on a malformed integrity migration manifest', async () => {
    const backend = new FakeDurableCoreBackend()
    backend.crashBeforeEnsure = true
    const operationId = 'manifest-malformed'
    const instance = bridge(backend)
    await expect(instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')).rejects.toThrow('before Core mutation')
    await fs.unlink(path.join(journalDirectory, '.integrity-key'))
    await fs.writeFile(path.join(journalDirectory, '.integrity-migration.v1'), '{invalid')

    await expect(instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}'))
      .rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(backend.calls.get(operationId)).toBe(1)
  })

  it('upgrades every unsigned prepared legacy record under one integrity root', async () => {
    const backend = new FakeDurableCoreBackend()
    const instance = bridge(backend)
    const operationIds = ['legacy-prepared-a', 'legacy-prepared-b']
    for (const operationId of operationIds) {
      backend.crashBeforeEnsure = true
      await expect(instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')).rejects.toThrow('before Core mutation')
    }
    for (const operationId of operationIds) {
      const filePath = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      const record = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>
      delete record.integrity
      await fs.writeFile(filePath, JSON.stringify(record), 'utf8')
    }
    await fs.unlink(path.join(journalDirectory, '.integrity-key'))

    for (const operationId of operationIds) {
      await instance.ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')
    }
    for (const operationId of operationIds) {
      const filePath = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
      expect(JSON.parse(await fs.readFile(filePath, 'utf8'))).toMatchObject({ state: 'succeeded', integrity: expect.any(String) })
    }
  })

  it('rejects a MAC-valid plan whose canonical source, title, and target manifest are forged', async () => {
    const backend = new FakeDurableCoreBackend()
    backend.crashBeforeEnsure = true
    const operationId = 'mac-valid-canonical-plan-forgery'
    const canonicalInput = '{"sourceSessionId":"source","title":"Expected title","targetMessageId":"eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee"}'
    await expect(bridge(backend).ensureBranch(operationId, 'task_opaque', canonicalInput)).rejects.toThrow('before Core mutation')
    const journalPath = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    const record = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Record<string, any>
    const forgedDirectory = path.join(journalDirectory, 'mac-valid-forged-target')
    const plan = JSON.parse(record.branchPlan.json) as DurableBranchPlan
    const forgedPlan = {
      ...plan,
      sourceSessionId: 'other-source',
      sourceTranscriptPath: path.join(forgedDirectory, 'other-source.jsonl'),
      sourceMessageIds: ['ffffffff-ffff-5fff-afff-ffffffffffff'],
      targetMessageId: 'ffffffff-ffff-5fff-afff-ffffffffffff',
      title: 'Forged title',
      projectDirPath: forgedDirectory,
      forkPath: path.join(forgedDirectory, `${plan.targetSessionId}.jsonl`),
    }
    record.binding.branchProjectDirPath = forgedDirectory
    record.branchTargetPath = forgedPlan.forkPath
    record.branchPlan = { json: JSON.stringify(forgedPlan), digest: createHash('sha256').update(JSON.stringify(forgedPlan)).digest('hex') }
    resignJournalRecord(record, await fs.readFile(path.join(journalDirectory, '.integrity-key'), 'utf8'))
    await fs.writeFile(journalPath, JSON.stringify(record), 'utf8')

    await expect(bridge(backend).ensureBranch(operationId, 'task_opaque', canonicalInput))
      .rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(backend.branchPlans).toHaveLength(1)
    expect(await fs.access(forgedPlan.forkPath).then(() => true, () => false)).toBeFalse()
  })

  it('rejects MAC removal from a forged prepared plan after key establishment', async () => {
    const backend = new FakeDurableCoreBackend()
    backend.crashBeforeEnsure = true
    const operationId = 'prepared-mac-removal'
    const canonicalInput = '{"sourceSessionId":"source","title":"Prepared MAC"}'
    await expect(bridge(backend).ensureBranch(operationId, 'task_opaque', canonicalInput)).rejects.toThrow('before Core mutation')
    const journalPath = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    const record = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Record<string, any>
    expect(typeof record.integrity).toBe('string')
    const plan = JSON.parse(record.branchPlan.json) as DurableBranchPlan
    const forgedDirectory = path.join(journalDirectory, 'mac-removed-forged')
    const forgedPlan = { ...plan, projectDirPath: forgedDirectory, sourceTranscriptPath: path.join(forgedDirectory, 'source.jsonl'), forkPath: path.join(forgedDirectory, `${plan.targetSessionId}.jsonl`) }
    record.binding.branchProjectDirPath = forgedDirectory
    record.branchTargetPath = forgedPlan.forkPath
    record.branchPlan = { json: JSON.stringify(forgedPlan), digest: createHash('sha256').update(JSON.stringify(forgedPlan)).digest('hex') }
    delete record.integrity
    await fs.writeFile(journalPath, JSON.stringify(record), 'utf8')

    await expect(bridge(backend).ensureBranch(operationId, 'task_opaque', canonicalInput))
      .rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(backend.branchPlans).toHaveLength(1)
    expect(await fs.access(forgedPlan.forkPath).then(() => true, () => false)).toBeFalse()
  })

  it('rejects a hash-valid journal plan fork-path rewrite without installation', async () => {
    const operationId = 'mac-protected-plan'
    const targetSessionId = reservedCreateSessionId(operationId)
    const canonicalInput = '{"sourceSessionId":"source","title":"MAC branch"}'
    const projectDirPath = path.join(journalDirectory, 'authorized-target')
    const forkPath = path.join(projectDirPath, `${targetSessionId}.jsonl`)
    const body = [
      JSON.stringify({ type: 'session-meta', isMeta: true, coreOperation: { clientOperationId: operationId, canonicalInput } }),
      JSON.stringify({ type: 'user', sessionId: targetSessionId, uuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee', parentUuid: null, forkedFrom: { sessionId: 'source', messageUuid: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee' }, message: { role: 'user', content: 'frozen' } }),
      JSON.stringify({ type: 'custom-title', sessionId: targetSessionId, customTitle: 'MAC branch' }),
    ].join('\n') + '\n'
    let crash = true
    let installs = 0
    const backend: DurableCoreOperationBackend = {
      prepareBranch: async () => ({ targetSessionId, sourceSessionId: 'source', sourceTranscriptPath: path.join(projectDirPath, 'source.jsonl'), sourceMessageIds: ['eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee'], forkPath, projectDirPath, targetMessageId: 'eeeeeeee-eeee-5eee-aeee-eeeeeeeeeeee', title: 'MAC branch', body, sha256: createHash('sha256').update(body).digest('hex') }),
      ensure: async input => {
        if (crash) { crash = false; throw new Error('crash before installation') }
        installs += 1
        await fs.mkdir(path.dirname(input.branchPlan!.forkPath), { recursive: true })
        await fs.writeFile(input.branchPlan!.forkPath, input.branchPlan!.body)
        return input.binding
      },
    }
    const instance = new CoreOperationBridge(backend, { journalDirectory })
    await expect(instance.ensureBranch(operationId, 'task_opaque', canonicalInput)).rejects.toThrow('crash before installation')

    const journalPath = path.join(journalDirectory, `${createHash('sha256').update(operationId).digest('hex')}.json`)
    const record = JSON.parse(await fs.readFile(journalPath, 'utf8')) as Record<string, any>
    const forgedDirectory = path.join(journalDirectory, 'forged-target')
    const plan = JSON.parse(record.branchPlan.json) as DurableBranchPlan
    const forgedPlan = { ...plan, forkPath: path.join(forgedDirectory, `${targetSessionId}.jsonl`), projectDirPath: forgedDirectory, sourceTranscriptPath: path.join(forgedDirectory, 'source.jsonl') }
    record.binding.branchProjectDirPath = forgedDirectory
    record.branchTargetPath = forgedPlan.forkPath
    record.branchPlan = { json: JSON.stringify(forgedPlan), digest: createHash('sha256').update(JSON.stringify(forgedPlan)).digest('hex') }
    await fs.writeFile(journalPath, JSON.stringify(record), 'utf8')

    await expect(new CoreOperationBridge(backend, { journalDirectory }).ensureBranch(operationId, 'task_opaque', canonicalInput))
      .rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(installs).toBe(0)
    expect(await fs.access(forgedPlan.forkPath).then(() => true, () => false)).toBeFalse()
  })

  it('fails closed when a stored successful binding does not match its reservation', async () => {
    const backend = new FakeDurableCoreBackend()
    const operationId = 'tampered-binding'
    await bridge(backend).ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}')
    const fileName = `${createHash('sha256').update(operationId).digest('hex')}.json`
    const journalPath = path.join(journalDirectory, fileName)
    const record = JSON.parse(await fs.readFile(journalPath, 'utf8')) as { binding: { coreSessionId: string } }
    record.binding.coreSessionId = 'bbbbbbbb-bbbb-5bbb-abbb-bbbbbbbbbbbb'
    await fs.writeFile(journalPath, JSON.stringify(record), 'utf8')

    await expect(
      bridge(backend).ensureCreate(operationId, 'task_opaque', '{"workDir":"/safe"}'),
    ).rejects.toMatchObject({ code: 'CORE_OPERATION_JOURNAL_INVALID' })
    expect(backend.calls.get(operationId)).toBe(1)
  })

  it('rejects cross-operation reuse and never puts a private binding in error data', async () => {
    const backend = new FakeDurableCoreBackend()
    const instance = bridge(backend)
    const binding = await instance.ensureCreate('shared-id', 'task_opaque', '{"workDir":"/safe"}')

    let failure: unknown
    try {
      await instance.ensureBranch('shared-id', 'task_opaque', '{"source":"private"}')
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(CoreOperationBridgeError)
    expect(failure).toMatchObject({ code: 'CORE_OPERATION_INPUT_CONFLICT' })
    expect(JSON.stringify(failure)).not.toContain(binding.coreSessionId)
  })
})
