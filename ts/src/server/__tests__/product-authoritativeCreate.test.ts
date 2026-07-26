import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskService } from '../product/taskService.js'
import { ProductCoreOperationTerminalError } from '../product/productCoreOperationBridge.js'
import { ProductTaskAuthorityRepository } from '../product/authorityRepository.js'
import { SessionAdmissionBarrier } from '../product/sessionAdmissionBarrier.js'
import { ProductHarnessSessionRepository } from '../agent-worker/harnessSessionRepository.js'
import { createProductUserMessage } from '../agent-worker/productMessages.js'
import { ProductAutoMemoryRepository } from '../services/productAutoMemory.js'

class ActiveTurnFlag {
  private active = false
  markActive(): void { this.active = true }
  markInactive(): void { this.active = false }
  hasActive(): boolean { return this.active }
}

test('authoritative create prepares before bridge, never writes legacy, and replays after finalize crash', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-create-')); const legacy = path.join(root, 'product-tasks.json'); await fs.writeFile(legacy, '{"version":4,"tasks":{}}'); const before = await fs.readFile(legacy); const authority = path.join(root, 'product-task-authority.v1.json'); let calls = 0; let observedPrepared = false; const bridge = { ensureCreate: async () => { calls++; observedPrepared = Boolean((await fs.readFile(authority, 'utf8')).includes('"prepared"')); return { coreSessionId: 'private-core' } } }; const service = new ProductTaskService({ storagePath: legacy }); const input = { workDir: root, title: 'hello', expected_revision: 0, client_operation_id: 'op-create' }; await expect(service.createTaskAuthoritatively(input, { authorityPath: authority, bridge, afterEnsure: () => { throw new Error('crash-after-bridge') } })).rejects.toThrow('crash-after-bridge'); const result = await new ProductTaskService({ storagePath: legacy }).createTaskAuthoritatively(input, { authorityPath: authority, bridge }); expect(observedPrepared).toBeTrue(); expect(calls).toBe(2); expect(result.receipt.outcome).toBe('accepted'); expect(JSON.stringify(result.task)).not.toContain('private-core'); expect(await fs.readFile(legacy)).toEqual(before) })
test('authoritative create rejects input reuse conflict', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-create-conflict-')); const authority = path.join(root, 'product-task-authority.v1.json'); const bridge = { ensureCreate: async () => ({ coreSessionId: 'private' }) }; const s = new ProductTaskService(); await s.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'same' }, { authorityPath: authority, bridge }); const second = await s.createTaskAuthoritatively({ workDir: `${root}/other`, expected_revision: 0, client_operation_id: 'same' }, { authorityPath: authority, bridge }); expect(second.receipt.outcome).toBe('conflict') })
test('legacy task projection is one-time, byte-preserving, and starts at revision one', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-projection-')); const legacy = path.join(root, 'product-tasks.json'); const body = '{"version":4,"tasks":{"task-legacy":{"coreSessionId":"private-core","title":"legacy","lifecycle":"active","kind":"main","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}},"sideTasks":{"side-1":{"parentTaskId":"task-parent"}}}'; await fs.writeFile(legacy, body); const authority = path.join(root, 'authority.json'); const service = new ProductTaskService({ storagePath: legacy }); const first = await service.ensureAuthorityProjectionForLegacyTask('task-legacy', { authorityPath: authority }); const again = await service.ensureAuthorityProjectionForLegacyTask('task-legacy', { authorityPath: authority }); expect(first.revision).toBe(1); expect(again.revision).toBe(1); expect(await fs.readFile(legacy, 'utf8')).toBe(body); await fs.writeFile(legacy, body.replace('"title":"legacy"','"title":"changed"')); await expect(service.ensureAuthorityProjectionForLegacyTask('task-legacy', { authorityPath: authority })).rejects.toThrow('LEGACY_SOURCE_CHANGED') })
test('legacy projection serializes concurrent initialization and supports CAS branch lifecycle', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-projection-cas-')); const legacy = path.join(root, 'product-tasks.json'); const body = '{"version":4,"tasks":{"task-parent":{"coreSessionId":"private-core","title":"legacy","lifecycle":"active","kind":"main","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}},"sideTasks":{"side-1":{"parentTaskId":"task-parent"}}}'; await fs.writeFile(legacy, body); const authority = path.join(root, 'authority.json'); const service = new ProductTaskService({ storagePath: legacy }); const [left, right] = await Promise.all([service.ensureAuthorityProjectionForLegacyTask('task-parent', { authorityPath: authority }), service.ensureAuthorityProjectionForLegacyTask('task-parent', { authorityPath: authority })]); expect([left.revision, right.revision]).toEqual([1, 1]); const pin = await service.mutateTaskAuthoritatively({ taskId: 'task-parent', patch: { pinned: true }, expected_revision: 0, client_operation_id: 'pin' }, { authorityPath: authority }); expect(pin.receipt.outcome).toBe('accepted'); const stale = await service.mutateTaskAuthoritatively({ taskId: 'task-parent', patch: { pinned: false }, expected_revision: 0, client_operation_id: 'stale' }, { authorityPath: authority }); expect(stale.receipt.outcome).toBe('conflict'); const bridge = { ensureBranch: async () => ({ coreSessionId: 'private-child' }) }; const continued = await service.continueTaskAuthoritatively({ taskId: 'task-parent', expected_revision: 1, client_operation_id: 'continue', canonical_input: '{"target":"new_worktree"}' }, { authorityPath: authority, bridge }); expect(continued.outcome).toBe('accepted'); const side = await service.createSideTaskAuthoritatively({ taskId: 'task-parent', sideTaskId: 'task-side', expected_revision: 2, client_operation_id: 'side', canonical_input: '{}' }, { authorityPath: authority, bridge }); expect(side.outcome).toBe('accepted'); const closed = await service.closeSideTaskAuthoritatively({ taskId: 'task-parent', sideTaskId: 'task-side', expected_revision: 2, client_operation_id: 'close', canonical_input: '{}' }, { authorityPath: authority }); expect(closed.outcome).toBe('accepted'); expect(await fs.readFile(legacy, 'utf8')).toBe(body) })


test('task entity CAS is independent of root revision advances by another task', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-entity-cas-'))
  const legacy = path.join(root, 'product-tasks.json')
  await fs.writeFile(legacy, JSON.stringify({ version: 4, tasks: {
    a: { coreSessionId: 'core-a', title: 'A', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    b: { coreSessionId: 'core-b', title: 'B', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  } }))
  const authority = path.join(root, 'authority.json')
  const service = new ProductTaskService({ storagePath: legacy })
  await service.ensureAuthorityProjectionForLegacyTask('a', { authorityPath: authority })
  await service.ensureAuthorityProjectionForLegacyTask('b', { authorityPath: authority })
  expect((await service.mutateTaskAuthoritatively({ taskId: 'b', patch: { pinned: true }, expected_revision: 0, client_operation_id: 'b-1' }, { authorityPath: authority })).receipt.outcome).toBe('accepted')
  const a = await service.mutateTaskAuthoritatively({ taskId: 'a', patch: { pinned: true }, expected_revision: 0, client_operation_id: 'a-1' }, { authorityPath: authority })
  expect(a.receipt.outcome).toBe('accepted')
  expect(a.task.revision).toBe(1)
  expect((await service.mutateTaskAuthoritatively({ taskId: 'a', patch: { pinned: false }, expected_revision: 0, client_operation_id: 'a-stale' }, { authorityPath: authority })).receipt.outcome).toBe('conflict')
})


test('relocate workspace operation is durable, entity-CAS fenced, and no-op stable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-relocate-op-'))
  const storagePath = path.join(root, 'product-tasks.json')
  const authority = path.join(root, 'product-task-authority.v1.json')
  const workspaceFs = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'volume', file_id: 'file' }, availability: 'available' as const }) }
  const service = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install-test' })
  const registered = await service.registerWorkspaceOperation({ root: '/root', expected_revision: 0, client_operation_id: 'register' })
  const workspaceId = registered.workspace.workspace_id
  const beforeNoop = await new ProductTaskAuthorityRepository(authority).read().catch(() => undefined)
  const noOp = await service.relocateWorkspaceOperation({ workspace_id: workspaceId, root: '/root', expected_workspace_revision: 0, client_operation_id: 'relocate-noop' })
  expect(noOp.receipt.outcome).toBe('accepted')
  expect(noOp.workspace.revision).toBe(0)
  const accepted = await service.relocateWorkspaceOperation({ workspace_id: workspaceId, root: '/moved', expected_workspace_revision: 0, client_operation_id: 'relocate' })
  expect(accepted.receipt.outcome).toBe('accepted')
  expect(accepted.workspace).toMatchObject({ canonical_root: '/moved', revision: 1, availability: 'available' })
  expect((await service.relocateWorkspaceOperation({ workspace_id: workspaceId, root: '/moved', expected_workspace_revision: 0, client_operation_id: 'relocate' })).receipt.outcome).toBe('duplicate')
  await expect(service.relocateWorkspaceOperation({ workspace_id: workspaceId, root: '/other', expected_workspace_revision: 0, client_operation_id: 'relocate' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  expect((await service.relocateWorkspaceOperation({ workspace_id: workspaceId, root: '/stale', expected_workspace_revision: 0, client_operation_id: 'stale' })).receipt.outcome).toBe('conflict')
  const restarted = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install-test' })
  expect((await restarted.relocateWorkspaceOperation({ workspace_id: workspaceId, root: '/moved', expected_workspace_revision: 0, client_operation_id: 'relocate' })).receipt.outcome).toBe('duplicate')
  void beforeNoop
})


test('relink workspace operation is state-gated, durable, and entity-CAS fenced', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-relink-op-'))
  const storagePath = path.join(root, 'product-tasks.json')
  const authority = path.join(root, 'product-task-authority.v1.json')
  const workspaceFs = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'new-volume', file_id: 'new-file' }, availability: 'available' as const }) }
  const service = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install-test' })
  const registered = await service.registerWorkspaceOperation({ root: '/old', expected_revision: 0, client_operation_id: 'register' })
  const workspaceId = registered.workspace.workspace_id
  await new ProductTaskAuthorityRepository(authority).mutateCapabilities((state) => { const workspace = state.workspaces[workspaceId] as { availability: string; revision: number }; state.workspaces[workspaceId] = { ...workspace, availability: 'relink_required', revision: 1 } })
  const accepted = await service.relinkWorkspaceOperation({ workspace_id: workspaceId, root: '/new', expected_workspace_revision: 1, client_operation_id: 'relink' })
  expect(accepted).toMatchObject({ receipt: { outcome: 'accepted' }, workspace: { canonical_root: '/new', availability: 'available', revision: 2 } })
  expect((await service.relinkWorkspaceOperation({ workspace_id: workspaceId, root: '/new', expected_workspace_revision: 1, client_operation_id: 'relink' })).receipt.outcome).toBe('duplicate')
  await expect(service.relinkWorkspaceOperation({ workspace_id: workspaceId, root: '/other', expected_workspace_revision: 1, client_operation_id: 'relink' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  expect((await service.relinkWorkspaceOperation({ workspace_id: workspaceId, root: '/stale', expected_workspace_revision: 1, client_operation_id: 'stale' })).receipt.outcome).toBe('conflict')
  const restarted = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install-test' })
  expect((await restarted.relinkWorkspaceOperation({ workspace_id: workspaceId, root: '/new', expected_workspace_revision: 1, client_operation_id: 'relink' })).receipt.outcome).toBe('duplicate')
  expect((await restarted.relinkWorkspaceOperation({ workspace_id: workspaceId, root: '/new', expected_workspace_revision: 2, client_operation_id: 'available-state' })).receipt.outcome).toBe('rejected')
})


test('register workspace operation is durable and same-identity no-op stable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-register-op-'))
  const storagePath = path.join(root, 'product-tasks.json')
  const workspaceFs = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'volume', file_id: 'file' }, availability: 'available' as const }) }
  const service = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install-test' })
  const accepted = await service.registerWorkspaceOperation({ root: '/root', expected_revision: 0, client_operation_id: 'register' })
  expect(accepted).toMatchObject({ receipt: { outcome: 'accepted' }, workspace: { revision: 0 } })
  const duplicate = await service.registerWorkspaceOperation({ root: '/root', expected_revision: 0, client_operation_id: 'register' })
  expect(duplicate).toMatchObject({ receipt: { outcome: 'duplicate' }, workspace: { revision: 0 } })
  await expect(service.registerWorkspaceOperation({ root: '/other', expected_revision: 0, client_operation_id: 'register' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  await expect(service.registerWorkspaceOperation({ root: '/root', expected_revision: 1, client_operation_id: 'register' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const noOp = await service.registerWorkspaceOperation({ root: '/root', expected_revision: 0, client_operation_id: 'register-noop' })
  expect(noOp).toMatchObject({ receipt: { outcome: 'accepted' }, workspace: { revision: 0 } })
  const restarted = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install-test' })
  expect((await restarted.registerWorkspaceOperation({ root: '/root', expected_revision: 0, client_operation_id: 'register' })).receipt.outcome).toBe('duplicate')
})


test('bind workspace is dual-CAS and durable-identity fenced', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-bind-op-'))
  const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const workspaceFs = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'volume', file_id: 'file' }, availability: 'available' as const }) }
  const blockers = { inspect: async () => ({ ok: true as const }) }
  const service = new ProductTaskService({ storagePath, workspaceFs, workspaceBindBlockers: blockers, installationId: 'install-test' })
  const authorityPath = path.join(root, 'product-task-authority.v1.json')
  await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
  const workspace = await service.registerWorkspaceOperation({ root: '/root', expected_revision: 0, client_operation_id: 'register' })
  const first = await service.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' })
  expect(first).toMatchObject({ outcome: 'accepted', entity_revisions: { task: 1, workspace: 1 } })
  expect((await service.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' })).outcome).toBe('duplicate')
  await expect(service.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace.workspace_id, expected_task_revision: 1, expected_workspace_revision: 1, client_operation_id: 'bind' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  expect((await service.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 1, client_operation_id: 'stale-task' })).outcome).toBe('conflict')
  expect((await service.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace.workspace_id, expected_task_revision: 1, expected_workspace_revision: 0, client_operation_id: 'stale-workspace' })).outcome).toBe('conflict')
  const restarted = new ProductTaskService({ storagePath, workspaceFs, workspaceBindBlockers: blockers, installationId: 'install-test' })
  expect((await restarted.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' })).outcome).toBe('duplicate')
})

test('BB-09A pending task queue blocks workspace rebinding with a durable queue receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-09a-bind-queue-'))
  const storagePath = path.join(root, 'product-tasks.json')
  const authorityPath = path.join(root, 'product-task-authority.v1.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const workspaceFs = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'volume', file_id: 'file' }, availability: 'available' as const }) }
  const service = new ProductTaskService({ storagePath, workspaceFs, workspaceBindBlockers: { inspect: async () => ({ ok: true as const }) }, installationId: 'install' })
  await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
  await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
  await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'submit', text: 'queued', attachment_ids: [] })
  const workspace = await service.registerWorkspaceOperation({ root: '/next', expected_revision: 0, client_operation_id: 'workspace' })
  const result = await service.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace.workspace_id, expected_task_revision: 2, expected_workspace_revision: 0, client_operation_id: 'bind' })
  expect(result).toMatchObject({ outcome: 'rejected', error: 'QUEUE', participant_receipts: expect.arrayContaining([{ participant: 'queue', status: 'BLOCKED', code: 'QUEUE' }]) })
  await new ProductTaskAuthorityRepository(authorityPath).transactSubmit((state) => {
    const stored = state.tasks.task as { task: Record<string, unknown> }
    stored.task = { ...stored.task, lifecycle: 'archived', archivedAt: '2026-01-01T00:00:00.000Z', actions: ['restore', 'continue'] }
  })
  expect(await service.mutateTaskDeletion('task', { action: 'begin', expected_revision: 2, client_operation_id: 'delete' })).toMatchObject({ outcome: 'rejected', blockers: [{ participant: 'task_run_queue', code: 'QUEUE', action: 'resolve' }] })
})

test('bind blockers reject without authority mutation and duplicates bypass inspection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-bind-blockers-'))
  const legacy = path.join(root, 'product-tasks.json'); await fs.writeFile(legacy, '{"version":4,"tasks":{}}')
  const authority = path.join(root, 'product-task-authority.v1.json')
  const fsPort = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'vol', file_id: value }, availability: 'available' as const }) }
  const blocked = ['ACTIVE_RUN', 'QUEUE', 'PTY', 'PREVIEW', 'WORKSPACE_WRITE', 'BLOCKER_UNKNOWN'] as const
  for (const code of blocked) {
    const service = new ProductTaskService({ storagePath: legacy, workspaceFs: fsPort, workspaceBindBlockers: { inspect: async () => ({ ok: false as const, code }) } })
    const task = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: `create-${code}` }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: `private-${code}` }) } })
    const workspace = await service.registerWorkspace(`/${code}`)
    const before = await fs.readFile(authority)
    const result = await service.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: `bind-${code}` })
    expect(result).toMatchObject({ outcome: 'rejected', error: code }); expect(result.participant_receipts).toHaveLength(5)
    const blockedBytes = await fs.readFile(authority); expect(blockedBytes).not.toEqual(before)
    const restarted = new ProductTaskService({ storagePath: legacy, workspaceFs: fsPort, workspaceBindBlockers: { inspect: async () => { throw new Error('duplicate must not inspect') } } })
    const replay = await restarted.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: `bind-${code}` })
    expect(replay).toMatchObject({ outcome: 'duplicate', error: code }); expect(replay.receipt).toMatchObject({ result: { blocker_error: code } }); expect(replay.participant_receipts).toEqual(result.participant_receipts); expect(await fs.readFile(authority)).toEqual(blockedBytes)
    await expect(restarted.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 1, expected_workspace_revision: 0, client_operation_id: `bind-${code}` })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  }
  const throwing = new ProductTaskService({ storagePath: legacy, workspaceFs: fsPort, workspaceBindBlockers: { inspect: async () => { throw new Error('timeout') } } })
  const throwingTask = await throwing.createTaskAuthoritatively({ workDir: root, expected_revision: (await new ProductTaskAuthorityRepository(authority).read()).revision, client_operation_id: 'create-throw' }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: 'private-throw' }) } })
  const throwingWorkspace = await throwing.registerWorkspace('/throw')
  const beforeThrow = await fs.readFile(authority)
  await expect(throwing.bindTaskWorkspace({ task_id: throwingTask.task.id, workspace_id: throwingWorkspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind-throw' })).resolves.toMatchObject({ outcome: 'rejected', error: 'BLOCKER_UNAVAILABLE' })
  expect(await fs.readFile(authority)).not.toEqual(beforeThrow)
  let inspected = 0
  const ok = new ProductTaskService({
    storagePath: legacy,
    workspaceFs: fsPort,
    workspaceBindBlockers: { inspect: async () => { inspected++; return { ok: true as const } } },
  })
  const task = await ok.createTaskAuthoritatively({ workDir: root, expected_revision: (await new ProductTaskAuthorityRepository(authority).read()).revision, client_operation_id: 'create-ok' }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: 'private-ok' }) } })
  const workspace = await ok.registerWorkspace('/ok')
  const accepted = await ok.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind-ok' })
  expect(accepted.outcome).toBe('accepted'); expect(accepted.participant_receipts).toHaveLength(5)
  const acceptedBytes = await fs.readFile(authority)
  const duplicate = await ok.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind-ok' })
  expect(duplicate.outcome).toBe('duplicate'); expect(duplicate.participant_receipts).toEqual(accepted.participant_receipts); expect(await fs.readFile(authority)).toEqual(acceptedBytes); expect(inspected).toBe(1)
  const restartedOk = new ProductTaskService({ storagePath: legacy, workspaceFs: fsPort, workspaceBindBlockers: { inspect: async () => { throw new Error('restart duplicate must not inspect') } } })
  const restartDuplicate = await restartedOk.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind-ok' })
  expect(restartDuplicate).toMatchObject({ outcome: 'duplicate' }); expect(restartDuplicate.participant_receipts).toEqual(accepted.participant_receipts); expect(await fs.readFile(authority)).toEqual(acceptedBytes)
})

test('workspace binding uses fake identity, entity CAS, and duplicate-before-CAS', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-workspace-'))
  const legacy = path.join(root, 'product-tasks.json'); await fs.writeFile(legacy, '{"version":4,"tasks":{}}')
  const authority = path.join(root, 'product-task-authority.v1.json')
  const fsPort = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'vol-a', file_id: value }, availability: 'available' as const }) }
  const service = new ProductTaskService({ storagePath: legacy, workspaceFs: fsPort, workspaceBindBlockers: { inspect: async () => ({ ok: true }) }, installationId: 'install-a' })
  const created = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'create' }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: 'private' }) } })
  const workspace = await service.registerWorkspace('/one')
  const bound = await service.bindTaskWorkspace({ task_id: created.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' })
  expect(bound.outcome).toBe('accepted')
  const duplicate = await service.bindTaskWorkspace({ task_id: created.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' })
  expect(duplicate.outcome).toBe('duplicate')
  await expect(service.requireWorkspaceCapability(created.task.id, 'agent')).resolves.toMatchObject({ workspace_id: workspace.workspace_id })
  const relocated = await service.relocateWorkspace(workspace.workspace_id, 1, '/two')
  expect(relocated.availability).toBe('relink_required')
})

test('draft expiry and ready attachment binding are deterministic and raw-free', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-draft-attachment-')); const legacy = path.join(root, 'product-tasks.json'); await fs.writeFile(legacy, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  let now = new Date('2026-01-01T00:00:00.000Z'); const service = new ProductTaskService({ storagePath: legacy, installationId: 'install', now: () => now }); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath: path.join(root, 'product-task-authority.v1.json') })
  await expect(service.createComposerDraft({ target_task_id: 'missing', ttl_ms: 1, client_operation_id: 'missing-target' })).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' })
  await expect(service.createComposerDraft({ target_task_id: 'task', workspace_id: 'missing', ttl_ms: 1, client_operation_id: 'missing-workspace' })).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' })
  for (const ttl_ms of [0, -1, Number.MAX_SAFE_INTEGER + 1]) await expect(service.createComposerDraft({ target_task_id: 'task', ttl_ms, client_operation_id: `bad-ttl-${ttl_ms}` })).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' })
  const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1000, client_operation_id: 'draft-create' })
  expect((await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1000, client_operation_id: 'draft-create' })).outcome).toBe('duplicate')
  await expect(service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1001, client_operation_id: 'draft-create' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const id = draft.draft.draft_id as string; expect(await service.mutateComposerDraft({ draft_id: id, expected_revision: 0, client_operation_id: 'draft-consume', action: 'consume' })).toMatchObject({ outcome: 'accepted' })
  expect(await service.mutateComposerDraft({ draft_id: id, expected_revision: 1, client_operation_id: 'draft-again', action: 'update' })).toMatchObject({ outcome: 'rejected' })
  const attachment = await service.registerAttachmentIdentity({ kind: 'composer_draft', id }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 3 }, 1000, 'attachment-register')
  expect(JSON.stringify(await new ProductTaskAuthorityRepository(path.join(root, 'product-task-authority.v1.json')).read())).not.toContain(root)
  expect(await service.bindAttachment(attachment.attachment_id, 0, { kind: 'product_task', id: 'task' }, 'attachment-early')).toMatchObject({ outcome: 'rejected' })
  await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
  expect(await service.bindAttachment(attachment.attachment_id, 1, { kind: 'product_task', id: 'task' }, 'attachment-bind')).toMatchObject({ outcome: 'accepted' })
  const expired = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1, client_operation_id: 'draft-expired' }); now = new Date('2026-01-01T00:00:04.000Z'); expect(await service.mutateComposerDraft({ draft_id: expired.draft.draft_id as string, expected_revision: 0, client_operation_id: 'expired-update', action: 'update' })).toMatchObject({ outcome: 'rejected' })
})

test('draft create operation identity fences target workspace and TTL across restart', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-create-identity-'))
  const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: {
    a: { coreSessionId: 'core-a', title: 'A', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    b: { coreSessionId: 'core-b', title: 'B', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  } }))
  const workspaceFs = { inspect: async (value: string) => ({ canonical_root: value, identity: { platform: 'test', volume_id: value, file_id: value }, availability: 'available' as const }) }
  const service = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install' })
  const authorityPath = path.join(root, 'product-task-authority.v1.json')
  await service.ensureAuthorityProjectionForLegacyTask('a', { authorityPath }); await service.ensureAuthorityProjectionForLegacyTask('b', { authorityPath })
  const w1 = await service.registerWorkspaceOperation({ root: '/w1', expected_revision: 0, client_operation_id: 'w1' })
  const w2 = await service.registerWorkspaceOperation({ root: '/w2', expected_revision: 0, client_operation_id: 'w2' })
  const input = { target_task_id: 'a', workspace_id: w1.workspace.workspace_id, ttl_ms: 1000, client_operation_id: 'opX' }
  expect((await service.createComposerDraft(input)).outcome).toBe('accepted')
  for (const changed of [
    { ...input, target_task_id: 'b' },
    { ...input, workspace_id: w2.workspace.workspace_id },
    { ...input, ttl_ms: 1001 },
  ]) await expect(service.createComposerDraft(changed)).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const restarted = new ProductTaskService({ storagePath, workspaceFs, installationId: 'install' })
  expect((await restarted.createComposerDraft(input)).outcome).toBe('duplicate')
})

test('draft consume rejection table never partially writes authority domain maps', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-consume-'))
  const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  let now = new Date('2026-01-01T00:00:00.000Z')
  const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => now })
  const authorityPath = path.join(root, 'product-task-authority.v1.json')
  await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
  const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1000, client_operation_id: 'draft' })
  const draftId = draft.draft.draft_id as string
  const attachment = await service.registerAttachmentIdentity({ kind: 'composer_draft', id: draftId }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 1 }, 1000, 'attachment')
  await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
  const accepted = await service.consumeDraftWithAttachments({ draft_id: draftId, expected_draft_revision: 0, attachment_ids: [attachment.attachment_id], target_task_id: 'task', client_operation_id: 'consume' })
  expect(accepted.outcome).toBe('accepted')
  expect((await service.consumeDraftWithAttachments({ draft_id: draftId, expected_draft_revision: 0, attachment_ids: [attachment.attachment_id], target_task_id: 'task', client_operation_id: 'consume' })).outcome).toBe('duplicate')
  await expect(service.consumeDraftWithAttachments({ draft_id: draftId, expected_draft_revision: 0, attachment_ids: [], target_task_id: 'task', client_operation_id: 'consume' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  expect((await service.consumeDraftWithAttachments({ draft_id: draftId, expected_draft_revision: 1, attachment_ids: [attachment.attachment_id], target_task_id: 'task', client_operation_id: 'consume-again' })).outcome).toBe('rejected')
  const restarted = new ProductTaskService({ storagePath, installationId: 'install', now: () => now })
  expect((await restarted.consumeDraftWithAttachments({ draft_id: draftId, expected_draft_revision: 0, attachment_ids: [attachment.attachment_id], target_task_id: 'task', client_operation_id: 'consume' })).outcome).toBe('duplicate')
})

test('draft consume rejection cases leave domain maps and revisions unchanged', async () => {
  async function setup() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-consume-reject-'))
    const storagePath = path.join(root, 'product-tasks.json')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
    const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => new Date('2026-01-01T00:00:00.000Z') })
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1000, client_operation_id: 'draft' })
    const draftId = draft.draft.draft_id as string
    const attachment = await service.registerAttachmentIdentity({ kind: 'composer_draft', id: draftId }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 1 }, 1000, 'attachment')
    await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
    return { service, authorityPath, draftId, attachmentId: attachment.attachment_id }
  }
  for (const mutate of [
    (file: any, draftId: string, attachmentId: string) => { delete file.tasks.task },
    (file: any, draftId: string, attachmentId: string) => { file.task_attachments[attachmentId].owner_id = 'other' },
    (file: any, draftId: string, attachmentId: string) => { file.task_attachments[attachmentId].state = 'staged' },
    (file: any, draftId: string, attachmentId: string) => { file.task_attachments[attachmentId].expires_at = '2020-01-01T00:00:00.000Z' },
  ]) {
    const { service, authorityPath, draftId, attachmentId } = await setup()
    const repository = new ProductTaskAuthorityRepository(authorityPath)
    await repository.mutateCapabilities((file) => mutate(file, draftId, attachmentId))
    const before = await repository.read()
    const snapshot = JSON.stringify({ revision: before.revision, tasks: before.tasks, workspaces: before.workspaces, drafts: before.composer_drafts, attachments: before.task_attachments, lineages: before.conversation_lineages })
    const result = await service.consumeDraftWithAttachments({ draft_id: draftId, expected_draft_revision: 0, attachment_ids: [attachmentId], target_task_id: 'task', client_operation_id: `reject-${attachmentId}` })
    expect(result.outcome).toBe('rejected')
    const after = await repository.read()
    expect(JSON.stringify({ revision: after.revision, tasks: after.tasks, workspaces: after.workspaces, drafts: after.composer_drafts, attachments: after.task_attachments, lineages: after.conversation_lineages })).toBe(snapshot)
  }
  const { service, authorityPath, draftId, attachmentId } = await setup()
  const before = await new ProductTaskAuthorityRepository(authorityPath).read()
  const mismatch = await service.consumeDraftWithAttachments({ draft_id: draftId, expected_draft_revision: 0, attachment_ids: [attachmentId], target_task_id: 'other', client_operation_id: 'target-mismatch' })
  expect(mismatch.outcome).toBe('rejected')
  const after = await new ProductTaskAuthorityRepository(authorityPath).read()
  expect(JSON.stringify({ revision: after.revision, tasks: after.tasks, workspaces: after.workspaces, drafts: after.composer_drafts, attachments: after.task_attachments, lineages: after.conversation_lineages })).toBe(JSON.stringify({ revision: before.revision, tasks: before.tasks, workspaces: before.workspaces, drafts: before.composer_drafts, attachments: before.task_attachments, lineages: before.conversation_lineages }))
})

test('draft consume operation identity conflicts before consumed-state validation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-consume-identity-'))
  const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: {
    a: { coreSessionId: 'core-a', title: 'A', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    b: { coreSessionId: 'core-b', title: 'B', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  } }))
  const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => new Date('2026-01-01T00:00:00.000Z') })
  const authorityPath = path.join(root, 'product-task-authority.v1.json')
  await service.ensureAuthorityProjectionForLegacyTask('a', { authorityPath }); await service.ensureAuthorityProjectionForLegacyTask('b', { authorityPath })
  const one = await service.createComposerDraft({ target_task_id: 'a', ttl_ms: 1000, client_operation_id: 'draft-a' })
  const two = await service.createComposerDraft({ target_task_id: 'b', ttl_ms: 1000, client_operation_id: 'draft-b' })
  const draftA = one.draft.draft_id as string; const draftB = two.draft.draft_id as string
  const attachment = async (id: string, op: string, fingerprint: string) => { const item = await service.registerAttachmentIdentity({ kind: 'composer_draft', id }, { source_fingerprint: fingerprint.repeat(64), content_hash: 'c'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 1 }, 1000, op); await service.setAttachmentReadyForTest(item.attachment_id, 0); return item.attachment_id }
  const a1 = await attachment(draftA, 'a1', 'a'); const a2 = await attachment(draftA, 'a2', 'b'); const b1 = await attachment(draftB, 'b1', 'd')
  const input = { draft_id: draftA, expected_draft_revision: 0, attachment_ids: [a1, a2], target_task_id: 'a', client_operation_id: 'opX' }
  expect((await service.consumeDraftWithAttachments(input)).outcome).toBe('accepted')
  for (const changed of [
    { ...input, draft_id: draftB, attachment_ids: [b1] },
    { ...input, target_task_id: 'b' },
    { ...input, expected_draft_revision: 1 },
    { ...input, attachment_ids: [a2, a1] },
  ]) await expect(service.consumeDraftWithAttachments(changed)).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
})

test('attachment transitions enforce public state graph and durable identity', async () => {
  async function fixture() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-transition-'))
    const storagePath = path.join(root, 'product-tasks.json')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
    let now = new Date('2026-01-01T00:00:00.000Z')
    const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => now })
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1000, client_operation_id: 'draft' })
    const attachment = await service.registerAttachmentIdentity({ kind: 'composer_draft', id: draft.draft.draft_id as string }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 1 }, 1000, 'attachment')
    return { service, authorityPath, id: attachment.attachment_id, setNow: (value: Date) => { now = value } }
  }
  for (const path of [
    ['inspecting'] as const,
    ['failed'] as const,
    ['cancelled'] as const,
    ['discarded'] as const,
    ['inspecting', 'ready'] as const,
    ['inspecting', 'failed'] as const,
  ]) {
    const { service, id } = await fixture(); let revision = 0
    for (const target_state of path) { const result = await service.transitionAttachment({ attachment_id: id, expected_revision: revision, target_state, client_operation_id: `${target_state}-${revision}` }); expect(result).toMatchObject({ outcome: 'accepted', attachment_revision: revision + 1 }); revision += 1 }
  }
  const { service, authorityPath, id, setNow } = await fixture()
  const invalidBefore = await new ProductTaskAuthorityRepository(authorityPath).read()
  expect((await service.transitionAttachment({ attachment_id: id, expected_revision: 0, target_state: 'ready', client_operation_id: 'invalid' })).outcome).toBe('rejected')
  const invalidAfter = await new ProductTaskAuthorityRepository(authorityPath).read()
  expect(JSON.stringify({ revision: invalidAfter.revision, attachments: invalidAfter.task_attachments })).toBe(JSON.stringify({ revision: invalidBefore.revision, attachments: invalidBefore.task_attachments }))
  const accepted = await service.transitionAttachment({ attachment_id: id, expected_revision: 0, target_state: 'inspecting', client_operation_id: 'op' })
  expect(accepted.outcome).toBe('accepted')
  expect((await service.transitionAttachment({ attachment_id: id, expected_revision: 0, target_state: 'inspecting', client_operation_id: 'op' })).outcome).toBe('duplicate')
  await expect(service.transitionAttachment({ attachment_id: id, expected_revision: 0, target_state: 'failed', client_operation_id: 'op' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  expect((await service.transitionAttachment({ attachment_id: id, expected_revision: 0, target_state: 'ready', client_operation_id: 'stale' })).outcome).toBe('conflict')
  const restart = new ProductTaskService({ storagePath: path.join(path.dirname(authorityPath), 'product-tasks.json'), installationId: 'install', now: () => new Date('2026-01-01T00:00:00.000Z') })
  expect((await restart.transitionAttachment({ attachment_id: id, expected_revision: 0, target_state: 'inspecting', client_operation_id: 'op' })).outcome).toBe('duplicate')
  setNow(new Date('2026-01-02T00:00:00.000Z'))
  expect((await service.transitionAttachment({ attachment_id: id, expected_revision: 1, target_state: 'ready', client_operation_id: 'expired-ready' })).outcome).toBe('rejected')
  expect((await service.transitionAttachment({ attachment_id: id, expected_revision: 1, target_state: 'discarded', client_operation_id: 'expired-discard' })).outcome).toBe('accepted')
})

test('attachment create and bind enforce owner transfer identity matrix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-bind-matrix-'))
  const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => new Date('2026-01-01T00:00:00.000Z') })
  const authorityPath = path.join(root, 'product-task-authority.v1.json')
  await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
  const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1000, client_operation_id: 'draft' }); const draftId = draft.draft.draft_id as string
  const metadata = { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference' as const, byte_size: 1 }
  await expect(service.registerAttachmentIdentity({ kind: 'product_task', id: 'missing' }, metadata, 1, 'missing-owner')).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' })
  for (const ttl of [0, -1]) await expect(service.registerAttachmentIdentity({ kind: 'composer_draft', id: draftId }, metadata, ttl, `ttl-${ttl}`)).rejects.toMatchObject({ code: 'AUTHORITY_INVALID' })
  const created = await service.registerAttachmentIdentity({ kind: 'composer_draft', id: draftId }, metadata, 1000, 'create')
  expect((await service.registerAttachmentIdentity({ kind: 'composer_draft', id: draftId }, metadata, 1000, 'create')).outcome).toBe('duplicate')
  const restartedCreate = new ProductTaskService({ storagePath, installationId: 'install', now: () => new Date('2026-01-01T00:00:00.000Z') })
  expect((await restartedCreate.registerAttachmentIdentity({ kind: 'composer_draft', id: draftId }, metadata, 1000, 'create')).outcome).toBe('duplicate')
  await expect(service.registerAttachmentIdentity({ kind: 'composer_draft', id: draftId }, { ...metadata, byte_size: 2 }, 1000, 'create')).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  await service.setAttachmentReadyForTest(created.attachment_id, 0)
  expect((await service.bindAttachment(created.attachment_id, 1, { kind: 'product_task', id: 'task' }, 'bind')).outcome).toBe('accepted')
  expect((await service.bindAttachment(created.attachment_id, 1, { kind: 'product_task', id: 'task' }, 'bind')).outcome).toBe('duplicate')
  await expect(service.bindAttachment(created.attachment_id, 1, { kind: 'composer_draft', id: draftId }, 'bind')).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const after = await new ProductTaskAuthorityRepository(authorityPath).read()
  expect(after.task_attachments[created.attachment_id]).toMatchObject({ owner_kind: 'product_task', owner_id: 'task', state: 'accepted_bound', revision: 2 })
})

test('attachment bind rejects illegal transfers without partial authority writes', async () => {
  async function setup(owner: 'composer_draft' | 'product_task' = 'composer_draft', ready = true) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-bind-reject-')); const storagePath = path.join(root, 'product-tasks.json')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core-a', title: 'A', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, other: { coreSessionId: 'core-b', title: 'B', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
    let now = new Date('2026-01-01T00:00:00.000Z'); const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => now }); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); await service.ensureAuthorityProjectionForLegacyTask('other', { authorityPath })
    const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1000, client_operation_id: 'draft' }); const draftId = draft.draft.draft_id as string
    const attachment = await service.registerAttachmentIdentity(owner === 'composer_draft' ? { kind: owner, id: draftId } : { kind: owner, id: 'task' }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 1 }, 1000, 'create'); if (ready) await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
    return { service, authorityPath, id: attachment.attachment_id, draftId, setNow: (v: Date) => { now = v } }
  }
  for (const [owner, ready, target] of [
    ['composer_draft', true, { kind: 'product_task', id: 'other' }],
    ['composer_draft', true, { kind: 'product_task', id: 'missing' }],
    ['product_task', true, { kind: 'composer_draft', id: 'x' }],
    ['product_task', true, { kind: 'product_task', id: 'other' }],
    ['composer_draft', false, { kind: 'product_task', id: 'task' }],
  ] as const) {
    const { service, authorityPath, id } = await setup(owner, ready); const before = await new ProductTaskAuthorityRepository(authorityPath).read(); const result = await service.bindAttachment(id, ready ? 1 : 0, target, `reject-${owner}-${ready}-${target.id}`); expect(['rejected', 'conflict']).toContain(result.outcome); const after = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(JSON.stringify({ revision: after.revision, attachments: after.task_attachments, drafts: after.composer_drafts, tasks: after.tasks })).toBe(JSON.stringify({ revision: before.revision, attachments: before.task_attachments, drafts: before.composer_drafts, tasks: before.tasks }))
  }
  const expired = await setup(); expired.setNow(new Date('2026-01-02T00:00:00.000Z')); const beforeExpired = await new ProductTaskAuthorityRepository(expired.authorityPath).read(); expect((await expired.service.bindAttachment(expired.id, 1, { kind: 'product_task', id: 'task' }, 'expired')).outcome).toBe('rejected'); const afterExpired = await new ProductTaskAuthorityRepository(expired.authorityPath).read(); expect(JSON.stringify(afterExpired.task_attachments)).toBe(JSON.stringify(beforeExpired.task_attachments))
  const stale = await setup(); expect((await stale.service.bindAttachment(stale.id, 0, { kind: 'product_task', id: 'task' }, 'stale')).outcome).toBe('conflict')
  const same = await setup(); expect((await same.service.bindAttachment(same.id, 1, { kind: 'composer_draft', id: same.draftId }, 'same-owner')).outcome).toBe('accepted')
  const restart = new ProductTaskService({ storagePath: path.join(path.dirname(same.authorityPath), 'product-tasks.json'), installationId: 'install', now: () => new Date('2026-01-01T00:00:00.000Z') }); expect((await restart.bindAttachment(same.id, 1, { kind: 'composer_draft', id: same.draftId }, 'same-owner')).outcome).toBe('duplicate')
})

test('lineage service persists private resume bindings while enforcing public identity CAS', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lineage-service-'))
  const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { a: { coreSessionId: 'core-a', title: 'A', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, b: { coreSessionId: 'core-b', title: 'B', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const service = new ProductTaskService({ storagePath, installationId: 'install' }); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await service.ensureAuthorityProjectionForLegacyTask('a', { authorityPath }); await service.ensureAuthorityProjectionForLegacyTask('b', { authorityPath })
  const created = await service.createConversationLineage({ task_id: 'a', client_operation_id: 'create' }); const lineageId = created.lineage.lineage_id as string
  expect(JSON.stringify(created.lineage)).not.toContain('resume_binding_id')
  const authority = new ProductTaskAuthorityRepository(authorityPath); expect((await authority.read()).conversation_lineages[lineageId]).toHaveProperty('resume_binding_id')
  expect((await service.createConversationLineage({ task_id: 'a', client_operation_id: 'create' })).outcome).toBe('duplicate')
  await expect(service.createConversationLineage({ task_id: 'b', client_operation_id: 'create' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const mutated = await service.mutateConversationLineage({ lineage_id: lineageId, expected_revision: 0, client_operation_id: 'advance', action: 'advance', head_entry_id: 'entry' }); expect(mutated).toMatchObject({ outcome: 'accepted', lineage_revision: 1 })
  expect((await service.mutateConversationLineage({ lineage_id: lineageId, expected_revision: 0, client_operation_id: 'advance', action: 'advance', head_entry_id: 'entry' })).outcome).toBe('duplicate')
  await expect(service.mutateConversationLineage({ lineage_id: lineageId, expected_revision: 0, client_operation_id: 'advance', action: 'park' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  expect((await service.setConversationLineageCurrent({ task_id: 'a', lineage_id: lineageId, expected_task_revision: 1, expected_lineage_revision: 1, client_operation_id: 'current' })).outcome).toBe('accepted')
  expect((await service.setConversationLineageCurrent({ task_id: 'a', lineage_id: lineageId, expected_task_revision: 1, expected_lineage_revision: 1, client_operation_id: 'current' })).outcome).toBe('duplicate')
  await expect(service.setConversationLineageCurrent({ task_id: 'b', lineage_id: lineageId, expected_task_revision: 0, expected_lineage_revision: 1, client_operation_id: 'current' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  expect(JSON.stringify(await service.getConversationLineage(lineageId))).not.toContain('resume_binding_id')
})

test('lineage create parent checkpoint identity and owner validation matrix', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lineage-create-matrix-')); const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { a: { coreSessionId: 'core-a', title: 'A', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, b: { coreSessionId: 'core-b', title: 'B', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const service = new ProductTaskService({ storagePath, installationId: 'install' }); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await service.ensureAuthorityProjectionForLegacyTask('a', { authorityPath }); await service.ensureAuthorityProjectionForLegacyTask('b', { authorityPath })
  const parent = await service.createConversationLineage({ task_id: 'a', client_operation_id: 'parent' }); const parentId = parent.lineage.lineage_id as string
  const input = { task_id: 'a', parent_lineage_id: parentId, fork_checkpoint_id: 'checkpoint', client_operation_id: 'child' }
  expect((await service.createConversationLineage(input)).outcome).toBe('accepted')
  for (const changed of [{ ...input, parent_lineage_id: undefined }, { ...input, fork_checkpoint_id: 'other' }]) await expect(service.createConversationLineage(changed)).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const restarted = new ProductTaskService({ storagePath, installationId: 'install' }); expect((await restarted.createConversationLineage(input)).outcome).toBe('duplicate')
  const before = await new ProductTaskAuthorityRepository(authorityPath).read(); await expect(service.createConversationLineage({ task_id: 'a', parent_lineage_id: 'missing', client_operation_id: 'missing' })).rejects.toThrow(); const after = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(JSON.stringify({ revision: after.revision, lineages: after.conversation_lineages, tasks: after.tasks })).toBe(JSON.stringify({ revision: before.revision, lineages: before.conversation_lineages, tasks: before.tasks }))
  await expect(service.createConversationLineage({ task_id: 'b', parent_lineage_id: parentId, client_operation_id: 'cross' })).rejects.toThrow()
})

test('lineage mutate action matrix advances only valid action states', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lineage-mutate-matrix-')); const storagePath = path.join(root, 'product-tasks.json'); await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const service = new ProductTaskService({ storagePath, installationId: 'install' }); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); const created = await service.createConversationLineage({ task_id: 'task', client_operation_id: 'create' }); const id = created.lineage.lineage_id as string
  let revision = 0
  for (const [action, head] of [['advance', 'head'], ['park', undefined], ['recovery', undefined]] as const) { const result = await service.mutateConversationLineage({ lineage_id: id, expected_revision: revision, client_operation_id: `${action}-${revision}`, action, ...(head ? { head_entry_id: head } : {}) }); expect(result).toMatchObject({ outcome: 'accepted', lineage_revision: revision + 1 }); revision += 1 }
  const before = await new ProductTaskAuthorityRepository(authorityPath).read(); expect((await service.mutateConversationLineage({ lineage_id: id, expected_revision: 0, client_operation_id: 'stale', action: 'recovery' })).outcome).toBe('conflict'); const after = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(JSON.stringify({ revision: after.revision, lineages: after.conversation_lineages })).toBe(JSON.stringify({ revision: before.revision, lineages: before.conversation_lineages }))
})

test('lineage current switch is unique and dual-CAS identity fenced', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lineage-current-matrix-')); const storagePath = path.join(root, 'product-tasks.json'); await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }, other: { coreSessionId: 'core2', title: 'other', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const service = new ProductTaskService({ storagePath, installationId: 'install' }); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); await service.ensureAuthorityProjectionForLegacyTask('other', { authorityPath })
  const a = await service.createConversationLineage({ task_id: 'task', client_operation_id: 'a' }); const aId = a.lineage.lineage_id as string; const b = await service.createConversationLineage({ task_id: 'task', parent_lineage_id: aId, client_operation_id: 'b' }); const bId = b.lineage.lineage_id as string
  expect((await service.setConversationLineageCurrent({ task_id: 'task', lineage_id: aId, expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'current-a' })).outcome).toBe('accepted')
  expect((await service.setConversationLineageCurrent({ task_id: 'task', lineage_id: bId, expected_task_revision: 2, expected_lineage_revision: 0, client_operation_id: 'current-b' })).outcome).toBe('accepted')
  const authority = new ProductTaskAuthorityRepository(authorityPath); const current = await authority.read(); expect((current.tasks.task as { task: { current_lineage_id: string; revision: number } }).task).toMatchObject({ current_lineage_id: bId, revision: 3 })
  expect((await service.setConversationLineageCurrent({ task_id: 'task', lineage_id: bId, expected_task_revision: 2, expected_lineage_revision: 0, client_operation_id: 'current-b' })).outcome).toBe('duplicate')
  for (const changed of [
    { task_id: 'task', lineage_id: aId, expected_task_revision: 3, expected_lineage_revision: 0 },
    { task_id: 'other', lineage_id: bId, expected_task_revision: 0, expected_lineage_revision: 0 },
    { task_id: 'task', lineage_id: bId, expected_task_revision: 2, expected_lineage_revision: 1 },
  ]) await expect(service.setConversationLineageCurrent({ ...changed, client_operation_id: 'current-b' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const before = await authority.read(); expect((await service.setConversationLineageCurrent({ task_id: 'task', lineage_id: 'missing', expected_task_revision: 3, expected_lineage_revision: 0, client_operation_id: 'missing' })).outcome).toBe('conflict'); const after = await authority.read(); expect(JSON.stringify({ revision: after.revision, tasks: after.tasks, lineages: after.conversation_lineages })).toBe(JSON.stringify({ revision: before.revision, tasks: before.tasks, lineages: before.conversation_lineages }))
  const restarted = new ProductTaskService({ storagePath, installationId: 'install' }); expect((await restarted.setConversationLineageCurrent({ task_id: 'task', lineage_id: bId, expected_task_revision: 2, expected_lineage_revision: 0, client_operation_id: 'current-b' })).outcome).toBe('duplicate')
})

test('lineage mutate operation identity is checked before mutated domain state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lineage-mutate-identity-')); const storagePath = path.join(root, 'product-tasks.json'); await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
  const service = new ProductTaskService({ storagePath, installationId: 'install' }); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); const first = await service.createConversationLineage({ task_id: 'task', client_operation_id: 'first' }); const second = await service.createConversationLineage({ task_id: 'task', parent_lineage_id: first.lineage.lineage_id as string, client_operation_id: 'second' }); const input = { lineage_id: first.lineage.lineage_id as string, expected_revision: 0, client_operation_id: 'op', action: 'advance' as const, head_entry_id: 'head' }
  expect((await service.mutateConversationLineage(input)).outcome).toBe('accepted')
  expect((await service.mutateConversationLineage(input)).outcome).toBe('duplicate')
  for (const changed of [
    { ...input, lineage_id: second.lineage.lineage_id as string },
    { ...input, action: 'park' as const, head_entry_id: undefined },
    { ...input, head_entry_id: 'other' },
    { ...input, expected_revision: 1 },
  ]) await expect(service.mutateConversationLineage(changed)).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const restarted = new ProductTaskService({ storagePath, installationId: 'install' }); expect((await restarted.mutateConversationLineage(input)).outcome).toBe('duplicate')
})

test('terminal Core create failure is finalized as a durable rejected receipt', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-rejected-'))
  const authority = path.join(root, 'authority.json')
  const service = new ProductTaskService()
  const result = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'terminal-create' }, { authorityPath: authority, bridge: { ensureCreate: async () => { throw new ProductCoreOperationTerminalError('PRODUCT_OPERATION_INPUT_INVALID', 'bad') } } })
  expect(result.receipt.outcome).toBe('rejected')
  const persisted = await new ProductTaskAuthorityRepository(authority).read()
  expect(persisted.prepared['terminal-create']).toBeUndefined()
  expect(persisted.receipts['terminal-create']?.outcome).toBe('rejected')
})


test('root lineage uses task entity CAS and duplicate is byte-stable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lineage-root-cas-')); const storagePath = path.join(root, 'store.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'Task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } })); const service = new ProductTaskService({ storagePath, installationId: 'install' }); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
  const before = await new ProductTaskAuthorityRepository(authorityPath).read(); const expected = (before.tasks.task as { task: { revision?: number } }).task.revision ?? 0
  const first = await service.createConversationLineage({ task_id: 'task', expected_task_revision: expected, client_operation_id: 'root-a' })
  await expect(service.createConversationLineage({ task_id: 'task', expected_task_revision: expected, client_operation_id: 'root-b' })).rejects.toThrow('AUTHORITY_CONFLICT')
  const bytes = await fs.readFile(authorityPath); const duplicate = await service.createConversationLineage({ task_id: 'task', expected_task_revision: expected, client_operation_id: 'root-a' })
  expect(duplicate).toMatchObject({ lineage: first.lineage, outcome: 'duplicate' }); expect(await fs.readFile(authorityPath)).toEqual(bytes)
  await expect(service.createConversationLineage({ task_id: 'task', expected_task_revision: expected + 1, client_operation_id: 'root-a' })).rejects.toMatchObject({ code: 'AUTHORITY_CONFLICT' })
  const after = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(Object.keys(after.conversation_lineages)).toHaveLength(1); expect((after.tasks.task as { task: { revision: number; current_lineage_id: string } }).task.revision).toBe(expected + 1)
})

test('admission gate queues run start behind workspace mutation', async () => {
  const barrier = new SessionAdmissionBarrier(); const registry = new ActiveTurnFlag(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }); const order: string[] = []
  const mutation = barrier.withWorkspaceMutation('core', async () => { order.push('bind-inspect-clear'); await held; order.push('bind-commit') })
  await Bun.sleep(5)
  const run = barrier.withRunStart('core', async () => { registry.markActive(); order.push('run-active') })
  await Bun.sleep(5); expect(order).toEqual(['bind-inspect-clear']); expect(registry.hasActive()).toBeFalse()
  release(); await Promise.all([mutation, run]); expect(order).toEqual(['bind-inspect-clear', 'bind-commit', 'run-active']); registry.markInactive()
})

test('real bind waits for active run admission then rejects without workspace mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bind-active-admission-')); const storagePath = path.join(root, 'tasks.json'); await fs.writeFile(storagePath, '{"version":4,"tasks":{}}'); const barrier = new SessionAdmissionBarrier(); const registry = new ActiveTurnFlag(); const authority = path.join(root, 'product-task-authority.v1.json'); let inspectCalls = 0
  const receipts = (active: boolean) => active ? [{ participant: 'active_core_run', status: 'BLOCKED', code: 'ACTIVE_RUN' }, { participant: 'queue', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'pty', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'preview', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'workspace_write', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }] as const : [{ participant: 'active_core_run', status: 'CLEAR' }, { participant: 'queue', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'pty', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'preview', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'workspace_write', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }] as const
  const service = new ProductTaskService({ storagePath, admissionBarrier: barrier, workspaceFs: { inspect: async (value) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'v', file_id: value }, availability: 'available' as const }) }, workspaceBindBlockers: { inspect: async () => { inspectCalls++; return { receipts: receipts(registry.hasActive()) } } } })
  const task = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'create' }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: 'core' }) } }); const workspace = await service.registerWorkspace('/workspace'); const before = await new ProductTaskAuthorityRepository(authority).read()
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }); const run = barrier.withRunStart(task.task.id, async () => { registry.markActive(); await held }); await Bun.sleep(5)
  let settled = false; const bind = service.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' }).then(value => { settled = true; return value }); await Bun.sleep(5); expect(settled).toBeFalse(); expect(inspectCalls).toBe(0)
  release(); await run; const result = await bind; expect(result).toMatchObject({ outcome: 'rejected', error: 'ACTIVE_RUN' }); const after = await new ProductTaskAuthorityRepository(authority).read(); expect((after.tasks[task.task.id] as { task: { revision: number } }).task.revision).toBe((before.tasks[task.task.id] as { task: { revision: number } }).task.revision); expect(after.workspaces[workspace.workspace_id].revision).toBe(before.workspaces[workspace.workspace_id].revision); expect(after.task_scopes[task.task.id]).toBeUndefined(); registry.markInactive()
})

test('real bind commit keeps a same-session run start queued until clear inspection commits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bind-clear-admission-')); const storagePath = path.join(root, 'tasks.json'); await fs.writeFile(storagePath, '{"version":4,"tasks":{}}'); const barrier = new SessionAdmissionBarrier(); const registry = new ActiveTurnFlag(); const authority = path.join(root, 'product-task-authority.v1.json'); let inspected!: () => void; const inspectStarted = new Promise<void>(resolve => { inspected = resolve }); let releaseInspect!: () => void; const inspectHeld = new Promise<void>(resolve => { releaseInspect = resolve })
  const disabled = [{ participant: 'queue', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'pty', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'preview', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'workspace_write', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }] as const
  const service = new ProductTaskService({ storagePath, admissionBarrier: barrier, workspaceFs: { inspect: async value => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'v', file_id: value }, availability: 'available' as const }) }, workspaceBindBlockers: { inspect: async () => { inspected(); await inspectHeld; return { receipts: [{ participant: 'active_core_run', status: 'CLEAR' }, ...disabled] } } } })
  const task = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'create' }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: 'core' }) } }); const workspace = await service.registerWorkspace('/workspace')
  const bind = service.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' }); await inspectStarted
  let runEntered = false; const run = barrier.withRunStart(task.task.id, async () => { runEntered = true; registry.markActive() }); await Bun.sleep(5); expect(runEntered).toBeFalse(); expect(registry.hasActive()).toBeFalse()
  releaseInspect(); const result = await bind; expect(result.outcome).toBe('accepted'); expect(result.participant_receipts).toHaveLength(5); await run; expect(runEntered).toBeTrue(); const after = await new ProductTaskAuthorityRepository(authority).read(); expect((after.tasks[task.task.id] as { task: { revision: number } }).task.revision).toBe(1); expect(after.workspaces[workspace.workspace_id].revision).toBe(1); expect(after.task_scopes[task.task.id]).toMatchObject({ kind: 'workspace', workspace_id: workspace.workspace_id }); registry.markInactive()
})

describe('BB-02C atomic homepage submit', () => {
  const now = () => new Date('2026-01-01T00:00:00.000Z')
  const input = (draft_id: string, client_operation_id = 'submit') => ({ draft_id, expected_draft_revision: 0, client_operation_id, text: 'homepage text', attachment_ids: [], permission_mode: 'ask_for_approval' as const })

  test('commits all submit maps, upgrades revision, and replays canonically without bytes changing', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-homepage-')); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    const service = new ProductTaskService({ storagePath, installationId: 'install', now }); const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1000, client_operation_id: 'draft' }); const first = await service.createAndSubmitTask(input(draft.draft.draft_id as string)); expect(first).toMatchObject({ outcome: 'accepted', entity_revisions: { task: 1, lineage: 1, draft: 1 } })
    const state = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(state.authority_schema_revision).toBe(7); for (const map of [state.tasks, state.conversation_lineages, state.thread_entries, state.task_runs, state.dispatch_records, state.task_events, state.receipts, state.events]) expect(Object.keys(map).length).toBeGreaterThan(0)
    const bytes = await fs.readFile(authorityPath); const duplicate = await service.createAndSubmitTask({ attachment_ids: [], text: 'homepage text', client_operation_id: 'submit', expected_draft_revision: 0, draft_id: draft.draft.draft_id as string, permission_mode: 'ask_for_approval' }); expect(duplicate).toMatchObject({ outcome: 'duplicate', result: first.result, entity_revisions: first.entity_revisions }); expect(await fs.readFile(authorityPath)).toEqual(bytes)
    expect(await service.createAndSubmitTask({ ...input(draft.draft.draft_id as string), text: 'changed' })).toMatchObject({ outcome: 'rejected', error: 'OPERATION_INPUT_CONFLICT' }); expect(await fs.readFile(authorityPath)).toEqual(bytes)
  })

  test('freezes each final permission profile on both task and accepted run', async () => {
    const profiles = [
      ['ask_for_approval', 'workspace-write', 'on-request', 'user'],
      ['approve_for_me', 'workspace-write', 'on-request', 'automatic'],
      ['full_access', 'danger-full-access', 'never', 'none'],
    ] as const
    for (const [mode, sandbox, approval, reviewer] of profiles) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `bb-08a-${mode}-`))
      const storagePath = path.join(root, 'product-tasks.json')
      const authorityPath = path.join(root, 'product-task-authority.v1.json')
      await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
      const service = new ProductTaskService({ storagePath, installationId: 'install', now })
      const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1000, client_operation_id: `draft-${mode}` })
      const accepted = await service.createAndSubmitTask({ ...input(draft.draft.draft_id as string, `submit-${mode}`), permission_mode: mode })
      const state = await new ProductTaskAuthorityRepository(authorityPath).read()
      const task = (state.tasks[accepted.result!.task_id] as { task: { permission_snapshot: unknown } }).task
      const run = state.task_runs[accepted.result!.run_id] as { permission_mode: string; permission_snapshot: unknown }
      const expected = { version: 1, mode, sandbox, approval, reviewer }
      expect(task.permission_snapshot).toEqual(expected)
      expect(run).toMatchObject({ permission_mode: mode, permission_snapshot: expected })
    }
  })

  test('persists one approval request and reviewer receipt across restart before resuming Core', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-08b-approval-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    const first = new ProductTaskService({ storagePath, installationId: 'install', now })
    const draft = await first.createNewTaskComposerDraft({ ttl_ms: 1_000, client_operation_id: 'draft' })
    const accepted = await first.createAndSubmitTask(input(draft.draft.draft_id as string))
    const run = accepted.result!
    expect(await first.claimTaskRunDispatch(run.run_id, 1)).toMatchObject({ outcome: 'claimed' })
    const action = { what: '运行一条受限命令', scope: '当前任务工作区之外的本机资源或网络边界', consequence: '命令可能修改文件、启动进程或访问外部服务。' }
    const review = { category: 'command' as const, read_only: false, destructive: false, open_world: false }
    expect(await first.recordTaskRunApprovalRequest(run.run_id, 1, 'approval-1', action, review)).toMatchObject({ task_id: run.task_id, reviewer: 'user', event: { type: 'approval_required', requestId: 'approval-1', action } })
    expect(await first.readPendingTaskApproval(run.task_id)).toMatchObject({ requestId: 'approval-1', action })

    const delivered: unknown[] = []
    const restarted = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async () => 'started', approve: async (...args) => { delivered.push(args); return true } } })
    expect(await restarted.respondToTaskApproval(run.task_id, 'approval-1', true)).toBeTrue()
    expect(delivered).toEqual([[run.run_id, 1, 'approval-1', true]])
    expect(await restarted.readPendingTaskApproval(run.task_id)).toBeNull()
    expect(await restarted.respondToTaskApproval(run.task_id, 'approval-1', true)).toBeTrue()
    expect(await restarted.respondToTaskApproval(run.task_id, 'approval-1', false)).toBeFalse()
    expect(delivered).toHaveLength(1)
    const state = await new ProductTaskAuthorityRepository(authorityPath).read()
    expect(state.dispatch_records[run.run_id]).toMatchObject({ approvals: [{ request_id: 'approval-1', review, status: 'resolved', decision: 'allowed', reviewer: 'user', resolution_reason: 'user_decision' }] })
    expect(Object.values(state.task_events).filter((event: any) => event.type === 'approval')).toMatchObject([
      { request_id: 'approval-1', phase: 'requested', action },
      { request_id: 'approval-1', phase: 'resolved', action, decision: 'allowed', reviewer: 'user' },
    ])
  })

  test('binds approve-for-me requests only to an automatic reviewer receipt', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-08c-auto-review-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    const delivered: unknown[] = []
    const service = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async () => 'started', approve: async (...args) => { delivered.push(args); return true } } })
    const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1_000, client_operation_id: 'draft-auto' })
    const accepted = await service.createAndSubmitTask({ ...input(draft.draft.draft_id as string, 'submit-auto'), permission_mode: 'approve_for_me' })
    const run = accepted.result!
    await service.claimTaskRunDispatch(run.run_id, 1)
    const action = { what: '读取受保护的文件', scope: '当前任务工作区之外的文件位置', consequence: '允许后会读取本次任务所需的文件。' }
    const review = { category: 'filesystem' as const, read_only: true, destructive: false, open_world: false }
    expect(await service.recordTaskRunApprovalRequest(run.run_id, 1, 'approval-auto', action, review)).toMatchObject({ reviewer: 'automatic' })
    expect(await service.respondToTaskApproval(run.task_id, 'approval-auto', true)).toBeFalse()
    expect(await service.resolveTaskRunApproval(run.task_id, 'approval-auto', true, 'automatic', 'read_only_local')).toBeTrue()
    expect(delivered).toEqual([[run.run_id, 1, 'approval-auto', true]])
    const state = await new ProductTaskAuthorityRepository(authorityPath).read()
    expect(state.dispatch_records[run.run_id]).toMatchObject({ approvals: [{ request_id: 'approval-auto', status: 'resolved', decision: 'allowed', reviewer: 'automatic', resolution_reason: 'read_only_local' }] })
  })

  test('full access has no routine Core reviewer surface', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-08c-full-access-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    const service = new ProductTaskService({ storagePath, installationId: 'install', now })
    const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1_000, client_operation_id: 'draft-full' })
    const accepted = await service.createAndSubmitTask({ ...input(draft.draft.draft_id as string, 'submit-full'), permission_mode: 'full_access' })
    const run = accepted.result!
    await service.claimTaskRunDispatch(run.run_id, 1)
    await expect(service.recordTaskRunApprovalRequest(run.run_id, 1, 'unexpected-approval', { what: '受限操作', scope: '本机', consequence: '未知' }, { category: 'other', read_only: false, destructive: true, open_world: true })).rejects.toThrow('AUTHORITY_INVALID')
    expect((await new ProductTaskAuthorityRepository(authorityPath).read()).dispatch_records[run.run_id]).not.toHaveProperty('approvals')
  })

  test('replays the durable ledger by cursor and grants exactly one dispatch claim', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-dispatch-'))
    const storagePath = path.join(root, 'product-tasks.json')
    await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    const service = new ProductTaskService({ storagePath, installationId: 'install', now })
    const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1000, client_operation_id: 'draft' })
    const accepted = await service.createAndSubmitTask(input(draft.draft.draft_id as string))
    const run = accepted.result!
    const first = await service.listTaskEvents(run.task_id, 0)
    expect(first.events).toEqual([expect.objectContaining({ task_id: run.task_id, run_id: run.run_id, text: 'homepage text' })])
    expect(await service.listTaskEvents(run.task_id, first.cursor)).toEqual({ events: [], cursor: first.cursor })
    const claims = await Promise.all([
      service.claimTaskRunDispatch(run.run_id, run.dispatch_generation),
      service.claimTaskRunDispatch(run.run_id, run.dispatch_generation),
    ])
    expect(claims.map((claim) => claim.outcome).sort()).toEqual(['claimed', 'duplicate'])
    const claimedState = await new ProductTaskAuthorityRepository(path.join(root, 'product-task-authority.v1.json')).read()
    expect(claimedState.dispatch_records[run.run_id]).toMatchObject({ state: 'claimed', dispatch_generation: 1 })
    expect(claimedState.task_runs[run.run_id]).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash' })
  })

  test('persists assistant activity and terminal items with cursor paging and a terminal fence', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-03-items-'))
    const storagePath = path.join(root, 'product-tasks.json')
    await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    const service = new ProductTaskService({ storagePath, installationId: 'install', now })
    const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1000, client_operation_id: 'draft-items' })
    const accepted = await service.createAndSubmitTask(input(draft.draft.draft_id as string, 'submit-items'))
    const run = accepted.result!
    await service.claimTaskRunDispatch(run.run_id, 1)
    const parentId = 'activity_fedcba9876543210fedcba9876543210'
    const id = 'activity_0123456789abcdef0123456789abcdef'
    const started = { type: 'activity' as const, id, kind: 'workspace' as const, phase: 'started' as const, summary: '正在整理工作内容' }
    const completed = { ...started, parentId, progress: { completed: 2, total: 2 }, phase: 'completed' as const, summary: '已整理工作内容' }
    await service.recordTaskRunActivity(run.run_id, 1, started)
    const beforeDuplicate = await new ProductTaskAuthorityRepository(path.join(root, 'product-task-authority.v1.json')).read()
    await service.recordTaskRunActivity(run.run_id, 1, started)
    expect((await new ProductTaskAuthorityRepository(path.join(root, 'product-task-authority.v1.json')).read()).event_sequence).toBe(beforeDuplicate.event_sequence)
    await service.recordTaskRunActivity(run.run_id, 1, completed)
    await service.recordTaskRunTerminalProjection(run.run_id, 1, 'completed', '最终回答')
    await expect(service.recordTaskRunActivity(run.run_id, 1, { ...started, id: 'activity_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).rejects.toThrow('AUTHORITY_INVALID')

    const first = await service.listTaskEvents(run.task_id, 0, 2)
    const second = await service.listTaskEvents(run.task_id, first.cursor, 2)
    const third = await service.listTaskEvents(run.task_id, second.cursor, 2)
    expect(first.has_more).toBeTrue()
    expect(second.has_more).toBeTrue()
    expect(third.has_more).toBeUndefined()
    expect([...first.events, ...second.events, ...third.events].map(event => event.type)).toEqual([
      'user_text', 'activity', 'activity', 'assistant_text', 'run_terminal',
    ])
    expect([...first.events, ...second.events, ...third.events]).toContainEqual(expect.objectContaining({
      type: 'activity',
      item_id: id,
      parent_item_id: parentId,
      progress: { completed: 2, total: 2 },
    }))
    expect(await service.getTaskThread(run.task_id)).toMatchObject({
      entries: [
        { type: 'user_text', text: 'homepage text' },
        { type: 'activity', kind: 'workspace', phase: 'completed' },
        { type: 'assistant_text', text: '最终回答' },
      ],
    })
    expect(JSON.stringify([...first.events, ...second.events, ...third.events])).not.toContain('session')
  })

  test('keeps durable Core binding private and replays one session fail-closed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-03dr3-binding-')); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    const service = new ProductTaskService({ storagePath, installationId: 'install', now }); const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1000, client_operation_id: 'draft' }); const accepted = await service.createAndSubmitTask(input(draft.draft.draft_id as string)); const run = accepted.result!
    const file = await new ProductTaskAuthorityRepository(authorityPath).read(); const binding = (file.task_runs[run.run_id] as any).core_binding; const lineage = file.conversation_lineages[(file.task_runs[run.run_id] as any).lineage_id] as any
    expect(binding).toMatchObject({ resume_binding_id: lineage.resume_binding_id, dispatch_generation: run.dispatch_generation, work_dir: root }); expect(JSON.stringify(await service.listTaskEvents(run.task_id))).not.toContain(binding.session_id); expect(JSON.stringify(await service.getConversationLineage(lineage.lineage_id))).not.toContain(binding.resume_binding_id)
    const first = await service.resolveTaskRunCoreBinding(run.run_id, run.dispatch_generation); const restarted = new ProductTaskService({ storagePath, installationId: 'install', now }); const replay = await restarted.resolveTaskRunCoreBinding(run.run_id, run.dispatch_generation); expect(replay).toEqual(first); expect((await Promise.all([restarted.resolveTaskRunCoreBinding(run.run_id, 1), restarted.resolveTaskRunCoreBinding(run.run_id, 1)])).every(value => value.session_id === first.session_id)).toBeTrue()
    await expect(restarted.resolveTaskRunCoreBinding(run.run_id, 2)).rejects.toThrow('CORE_BINDING_UNAVAILABLE'); await new ProductTaskAuthorityRepository(authorityPath).transactSubmit(state => { const stored = state.task_runs[run.run_id] as any; stored.core_binding = { ...stored.core_binding, resume_binding_id: 'resume_forged' }; return undefined }); await expect(restarted.resolveTaskRunCoreBinding(run.run_id, 1)).rejects.toThrow('CORE_BINDING_UNAVAILABLE'); await fs.rm(root, { recursive: true, force: true }); await expect(restarted.resolveTaskRunCoreBinding(run.run_id, 1)).rejects.toThrow('CORE_BINDING_UNAVAILABLE')
  })

  test('anchors a workspace-bound submit to its authoritative canonical root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-03dr3-workspace-')); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
    const service = new ProductTaskService({ storagePath, installationId: 'install', now, workspaceFs: { inspect: async value => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'volume', file_id: 'file' }, availability: 'available' as const }) } }); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); const workspace = await service.registerWorkspace(root); expect((await service.bindTaskWorkspace({ task_id: 'task', workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' })).outcome).toBe('accepted')
    const accepted = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'submit', text: 'text', attachment_ids: [] }); const run = accepted.result!; const file = await new ProductTaskAuthorityRepository(authorityPath).read(); const stored = file.task_runs[run.run_id] as any; expect(stored).toMatchObject({ execution_capability: 'workspace_bound', core_binding: { work_dir: root, dispatch_generation: 1 } }); expect(stored.core_binding.resume_binding_id).toBe((file.conversation_lineages[stored.lineage_id] as any).resume_binding_id); await expect(service.resolveTaskRunCoreBinding(run.run_id, 1)).resolves.toMatchObject({ work_dir: await fs.realpath(root) })
  })

  test('rejections and beforeWrite failure preserve every map and draft', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-homepage-fail-')); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await fs.writeFile(storagePath, '{"version":4,"tasks":{}}'); let fail = false
    const service = new ProductTaskService({ storagePath, installationId: 'install', now, authorityRepositoryDeps: { beforeWrite: () => { if (fail) throw new Error('write failure') } } }); const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1000, client_operation_id: 'draft' }); const before = await fs.readFile(authorityPath)
    for (const value of [input('missing', 'missing'), { ...input(draft.draft.draft_id as string, 'stale'), expected_draft_revision: 1 }, { ...input(draft.draft.draft_id as string, 'invalid'), attachment_ids: ['a', 'a'] }]) expect((await service.createAndSubmitTask(value)).outcome).toBe('rejected'); expect(await fs.readFile(authorityPath)).toEqual(before)
    fail = true; expect((await service.createAndSubmitTask(input(draft.draft.draft_id as string))).outcome).toBe('rejected'); expect(await fs.readFile(authorityPath)).toEqual(before); await expect(new ProductTaskAuthorityRepository(authorityPath).transactSubmit(state => { state.tasks.bad = { invalid: true }; return undefined })).rejects.toThrow('AUTHORITY_INVALID'); expect(await fs.readFile(authorityPath)).toEqual(before)
  })
})

describe('BB-02C existing task submit matrix', () => {
  test('stop targets the running queue head instead of a later follow-up', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-07c-stop-run-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({
      version: 4,
      tasks: {
        task: {
          coreSessionId: 'core',
          title: 'task',
          lifecycle: 'active',
          kind: 'main',
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
        },
      },
    }))
    const stopped: Array<[string, number]> = []
    const service = new ProductTaskService({
      storagePath,
      installationId: 'install',
      now,
      dispatcher: {
        dispatch: async () => 'started',
        stop: async (runId, generation) => { stopped.push([runId, generation]) },
      },
    })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({
      task_id: 'task',
      expected_task_revision: 0,
      client_operation_id: 'lineage',
    })
    const first = await service.submitTaskRun('task', {
      expected_task_revision: 1,
      expected_lineage_revision: 0,
      client_operation_id: 'first',
      text: 'first',
      attachment_ids: [],
    })
    const second = await service.submitTaskRun('task', {
      expected_task_revision: 2,
      expected_lineage_revision: 1,
      client_operation_id: 'second',
      text: 'second',
      attachment_ids: [],
    })

    expect(await service.stopActiveTaskRun('task')).toBeTrue()
    expect(stopped).toEqual([[first.result!.run_id, first.result!.dispatch_generation]])
    expect(second.result).toMatchObject({ delivery: 'queued' })
  })

  test('injects only an explicitly steered durable input into the active Turn and replays consumption idempotently', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-steer-consume-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    const steered: Array<[string, number, string, string]> = []
    const service = new ProductTaskService({
      storagePath,
      installationId: 'install',
      now,
      dispatcher: {
        dispatch: async () => 'started',
        steer: async (targetRunId, generation, queueItemId, text) => {
          steered.push([targetRunId, generation, queueItemId, text])
          return true
        },
      },
    })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [] })
    const second = await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'second', text: 'second', attachment_ids: [] })
    const third = await service.submitTaskRun('task', { expected_task_revision: 3, expected_lineage_revision: 1, client_operation_id: 'third', text: 'third', attachment_ids: [] })
    const runId = (first.result as { run_id: string }).run_id
    const secondQueueId = (second.result as { queue_item_id: string }).queue_item_id
    const thirdQueueId = (third.result as { queue_item_id: string }).queue_item_id
    await service.claimTaskRunDispatch(runId, 1)

    await expect(service.recordQueuedInputConsumed(runId, 1, thirdQueueId)).rejects.toThrow('AUTHORITY_INVALID')
    expect(await service.steerTaskInputQueue('task', {
      queue_item_id: secondQueueId,
      expected_task_revision: 4,
      client_operation_id: 'steer-second',
    })).toMatchObject({ outcome: 'accepted', task_revision: 5, delivery: 'steer' })
    expect(steered).toEqual([[runId, 1, secondQueueId, 'second']])
    const consumed = await service.recordQueuedInputConsumed(runId, 1, secondQueueId)
    expect(consumed.events.map((event) => event.type)).toEqual(['queue_updated', 'user_text'])
    expect(consumed.events[1]).toMatchObject({ type: 'user_text', text: 'second', replayed: true })
    expect(await service.recordQueuedInputConsumed(runId, 1, secondQueueId)).toEqual(consumed)

    const state = await new ProductTaskAuthorityRepository(authorityPath).read()
    expect(Object.keys(state.task_runs)).toEqual([runId])
    expect(Object.values(state.thread_entries).map((entry) => (entry as { run_id: string }).run_id)).toEqual([runId, runId])
    expect((state.conversation_lineages[(state.task_runs[runId] as { lineage_id: string }).lineage_id] as { revision: number }).revision).toBe(2)
    expect((await service.listQueuedInputs('task')).items.map((item) => item.id)).toEqual([thirdQueueId])
  })

  test('edits, reorders, deletes, and releases unconsumed durable follow-ups', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-queue-manage-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    const service = new ProductTaskService({
      storagePath,
      installationId: 'install',
      now,
      dispatcher: { dispatch: async () => 'started', steer: async () => true },
    })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [] })
    const second = await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'second', text: 'second', attachment_ids: [] })
    const third = await service.submitTaskRun('task', { expected_task_revision: 3, expected_lineage_revision: 1, client_operation_id: 'third', text: 'third', attachment_ids: [] })
    const fourth = await service.submitTaskRun('task', { expected_task_revision: 4, expected_lineage_revision: 1, client_operation_id: 'fourth', text: 'fourth', attachment_ids: [] })
    const runId = (first.result as { run_id: string }).run_id
    const secondQueueId = (second.result as { queue_item_id: string }).queue_item_id
    const thirdQueueId = (third.result as { queue_item_id: string }).queue_item_id
    const fourthQueueId = (fourth.result as { queue_item_id: string }).queue_item_id

    expect(await service.mutateTaskInputQueue('task', { action: 'reorder', queue_item_ids: [fourthQueueId, secondQueueId, thirdQueueId], expected_task_revision: 5, client_operation_id: 'reorder' })).toMatchObject({ outcome: 'accepted', task_revision: 6 })
    expect(await service.mutateTaskInputQueue('task', { action: 'edit', queue_item_id: secondQueueId, text: 'second edited', expected_task_revision: 6, client_operation_id: 'edit' })).toMatchObject({ outcome: 'accepted', task_revision: 7 })
    expect(await service.mutateTaskInputQueue('task', { action: 'delete', queue_item_id: thirdQueueId, expected_task_revision: 7, client_operation_id: 'delete' })).toMatchObject({ outcome: 'accepted', task_revision: 8 })
    expect((await service.listQueuedInputs('task')).items.map(item => [item.id, item.text])).toEqual([[fourthQueueId, 'fourth'], [secondQueueId, 'second edited']])

    await service.claimTaskRunDispatch(runId, 1)
    expect(await service.steerTaskInputQueue('task', { queue_item_id: fourthQueueId, expected_task_revision: 8, client_operation_id: 'steer' })).toMatchObject({ outcome: 'accepted', task_revision: 9, delivery: 'steer' })
    expect((await service.listQueuedInputs('task')).items[0]).toMatchObject({ id: fourthQueueId, targetRunId: runId })
    const terminal = await service.recordTaskRunTerminalProjection(runId, 1, 'completed', '')
    expect(terminal.queue_events).toHaveLength(1)
    expect((await service.listQueuedInputs('task')).items).toEqual([
      expect.objectContaining({ id: fourthQueueId, text: 'fourth' }),
      expect.objectContaining({ id: secondQueueId, text: 'second edited' }),
    ])
    expect((await service.listQueuedInputs('task')).items[0]?.targetRunId).toBeUndefined()
  })

  test('keeps an attachment follow-up for the next Turn and requires an explicit resume after stop', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-queue-attachment-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    const dispatched: string[] = []
    const service = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async runId => { dispatched.push(runId); return 'started' } } })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const attachment = await service.registerAttachmentIdentity({ kind: 'product_task', id: 'task' }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 1 }, 1_000, 'attachment')
    await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [] })
    const queued = await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'attachment-follow-up', text: 'inspect image', attachment_ids: [attachment.attachment_id] })
    const runId = (first.result as { run_id: string }).run_id
    const queueId = (queued.result as { queue_item_id: string }).queue_item_id
    await service.claimTaskRunDispatch(runId, 1)
    await expect(service.recordQueuedInputConsumed(runId, 1, queueId)).rejects.toThrow('AUTHORITY_INVALID')
    await service.recordTaskRunTerminalProjection(runId, 1, 'stopped', '')
    await service.advanceTaskRunQueue(runId, 1)
    expect((await service.listQueuedInputs('task')).items.map((item) => item.id)).toEqual([queueId])

    const overtaking = await service.submitTaskRun('task', { expected_task_revision: 3, expected_lineage_revision: 1, client_operation_id: 'later', text: 'later', attachment_ids: [] })
    expect(overtaking.result).toMatchObject({ delivery: 'queued' })
    const resumed = await service.resumeTaskInputQueue('task', { expected_task_revision: 4, client_operation_id: 'resume' })
    expect(resumed).toMatchObject({ outcome: 'accepted', task_revision: 5 })
    const state = await new ProductTaskAuthorityRepository(authorityPath).read()
    expect(state.turn_input_queue[queueId]).toMatchObject({ state: 'promoted' })
    expect(Object.values(state.attachment_bindings)).toContainEqual(expect.objectContaining({ attachment_id: attachment.attachment_id }))
    expect(dispatched.length).toBeGreaterThanOrEqual(2)
  })

  test('keeps follow-up input in durable FIFO order and promotes one new Turn at a time', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-09a-task-queue-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    const service = new ProductTaskService({ storagePath, installationId: 'install', now })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [] })
    const second = await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'second', text: 'second', attachment_ids: [] })
    const third = await service.submitTaskRun('task', { expected_task_revision: 3, expected_lineage_revision: 1, client_operation_id: 'third', text: 'third', attachment_ids: [] })
    expect(await service.inspectTaskRunQueuePosition(first.result!.run_id, 1)).toBe('ready')
    expect(await service.claimTaskRunDispatch(first.result!.run_id, 1)).toMatchObject({ outcome: 'claimed' })
    expect(second.result).toMatchObject({ delivery: 'queued' })
    expect(third.result).toMatchObject({ delivery: 'queued' })
    await service.recordTaskRunTerminalProjection(first.result!.run_id, 1, 'completed', 'first answer')
    await service.advanceTaskRunQueue(first.result!.run_id, 1)
    let state = await new ProductTaskAuthorityRepository(authorityPath).read()
    const secondRunId = (state.turn_input_queue[(second.result as { queue_item_id: string }).queue_item_id] as { target_run_id: string }).target_run_id
    expect(await service.inspectTaskRunQueuePosition(secondRunId, 1)).toBe('ready')
    expect(await service.claimTaskRunDispatch(secondRunId, 1)).toMatchObject({ outcome: 'claimed' })
    await service.recordTaskRunTerminalProjection(secondRunId, 1, 'completed', 'second answer')
    await service.advanceTaskRunQueue(secondRunId, 1)
    state = await new ProductTaskAuthorityRepository(authorityPath).read()
    const thirdRunId = (state.turn_input_queue[(third.result as { queue_item_id: string }).queue_item_id] as { target_run_id: string }).target_run_id

    const dispatched: string[] = []
    const restarted = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async runId => { dispatched.push(runId); return 'queued' } } })
    await restarted.recoverDurableTaskRunQueue()
    await restarted.recoverDurableTaskRunQueue()
    expect(dispatched).toEqual([thirdRunId])
  })

  test('promotes a queued follow-up exactly once after a completed Turn restart gap', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-queue-completed-recovery-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    const service = new ProductTaskService({ storagePath, installationId: 'install', now })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [] })
    const followUp = await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'follow-up', text: 'follow-up', attachment_ids: [] })
    await service.recordTaskRunTerminalProjection(first.result!.run_id, 1, 'completed', 'done')

    const dispatched: string[] = []
    const restarted = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async runId => { dispatched.push(runId); return 'started' } } })
    await restarted.recoverDurableTaskRunQueue()
    await restarted.recoverDurableTaskRunQueue()

    const state = await new ProductTaskAuthorityRepository(authorityPath).read()
    const queueId = (followUp.result as { queue_item_id: string }).queue_item_id
    expect(state.turn_input_queue[queueId]).toMatchObject({ state: 'promoted' })
    expect(dispatched).toEqual([(state.turn_input_queue[queueId] as { target_run_id: string }).target_run_id])
  })

  test('keeps a queued follow-up paused across restart after a stopped Turn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-queue-stopped-recovery-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    const service = new ProductTaskService({ storagePath, installationId: 'install', now })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [] })
    const followUp = await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'follow-up', text: 'follow-up', attachment_ids: [] })
    await service.recordTaskRunTerminalProjection(first.result!.run_id, 1, 'stopped', '')

    const dispatched: string[] = []
    const restarted = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async runId => { dispatched.push(runId); return 'started' } } })
    await restarted.recoverDurableTaskRunQueue()

    const queueId = (followUp.result as { queue_item_id: string }).queue_item_id
    expect(dispatched).toEqual([])
    expect((await restarted.listQueuedInputs('task')).items).toContainEqual(expect.objectContaining({ id: queueId, state: 'queued' }))
  })

  test('BB-09A never replays an interrupted Core run or overtakes it after restart', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-09a-crash-fence-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    const service = new ProductTaskService({ storagePath, installationId: 'install', now })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [] })
    await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'second', text: 'second', attachment_ids: [] })
    for (let index = 3; index <= 8; index += 1) expect((await service.submitTaskRun('task', { expected_task_revision: index, expected_lineage_revision: 1, client_operation_id: `queued-${index}`, text: `queued-${index}`, attachment_ids: [] })).outcome).toBe('accepted')
    expect(await service.submitTaskRun('task', { expected_task_revision: 9, expected_lineage_revision: 1, client_operation_id: 'queue-full', text: 'queue-full', attachment_ids: [] })).toMatchObject({ outcome: 'rejected', error: 'TASK_QUEUE_FULL' })
    await service.claimTaskRunDispatch(first.result!.run_id, 1)
    const dispatched: string[] = []
    const restarted = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async runId => { dispatched.push(runId); return 'started' } } })
    await restarted.recoverDurableTaskRunQueue()
    expect(dispatched).toEqual([])
    const blocked = await new ProductTaskAuthorityRepository(authorityPath).read()
    expect(blocked.dispatch_records[first.result!.run_id]).toMatchObject({ state: 'recovery_required', error: 'SERVER_RESTARTED' })
    const originalSessionId = (blocked.task_runs[first.result!.run_id] as { core_binding: { session_id: string } }).core_binding.session_id

    const attempts: Array<[string, number]> = []
    let executions = 0
    let recovering!: ProductTaskService
    recovering = new ProductTaskService({ storagePath, installationId: 'install', now, dispatcher: { dispatch: async (runId, generation) => {
      attempts.push([runId, generation])
      const claim = await recovering.claimTaskRunDispatch(runId, generation)
      if (claim.outcome === 'claimed') executions += 1
      return claim.outcome === 'claimed' || claim.outcome === 'duplicate' ? 'started' : 'recovery_required'
    } } })
    const recoveryInput = { expected_revision: 9, client_operation_id: 'recover-first' }
    expect((await recovering.recoverTaskRun('task', recoveryInput)).receipt.outcome).toBe('accepted')
    let recovered = await new ProductTaskAuthorityRepository(authorityPath).read()
    for (let index = 0; recovered.dispatch_records[first.result!.run_id]?.state !== 'claimed' && index < 100; index += 1) {
      await Bun.sleep(1)
      recovered = await new ProductTaskAuthorityRepository(authorityPath).read()
    }
    expect(recovered.dispatch_records[first.result!.run_id]).toMatchObject({ state: 'claimed', dispatch_generation: 2 })
    expect((recovered.task_runs[first.result!.run_id] as { core_binding: { session_id: string; dispatch_generation: number } }).core_binding).toMatchObject({ dispatch_generation: 2 })
    expect((recovered.task_runs[first.result!.run_id] as { core_binding: { session_id: string } }).core_binding.session_id).not.toBe(originalSessionId)
    const bytes = await fs.readFile(authorityPath)
    expect((await recovering.recoverTaskRun('task', recoveryInput)).receipt.outcome).toBe('duplicate')
    while (attempts.length < 2) await Bun.sleep(1)
    expect(executions).toBe(1)
    expect(attempts).toEqual([[first.result!.run_id, 2], [first.result!.run_id, 2]])
    expect(await fs.readFile(authorityPath)).toEqual(bytes)
  })

  test('persists an accepted snapshot across later revisions and rejects attachment/domain conflicts atomically', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-existing-')); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' } } }))
    let fail = false; const now = () => new Date('2026-01-01T00:00:00.000Z'); const service = new ProductTaskService({ storagePath, installationId: 'install', now, authorityRepositoryDeps: { beforeWrite: () => { if (fail) throw new Error('write failure') } } }); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const attachment = await service.registerAttachmentIdentity({ kind: 'product_task', id: 'task' }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'image/png', storage_kind: 'external_reference', byte_size: 1 }, 1000, 'attachment'); await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
    const firstInput = { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'first', attachment_ids: [attachment.attachment_id] }; const first = await service.submitTaskRun('task', firstInput); expect(first.outcome).toBe('accepted'); const bytes = await fs.readFile(authorityPath)
    expect((await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'second', text: 'second', attachment_ids: [] })).outcome).toBe('accepted'); const duplicate = await service.submitTaskRun('task', firstInput); expect(duplicate).toEqual({ ...first, outcome: 'duplicate' }); const afterDuplicate = await fs.readFile(authorityPath); expect(afterDuplicate).not.toEqual(bytes)
    const stable = await fs.readFile(authorityPath); expect(await service.submitTaskRun('task', { ...firstInput, text: 'changed' })).toMatchObject({ outcome: 'rejected', error: 'OPERATION_INPUT_CONFLICT' }); expect(await service.submitTaskRun('task', { ...firstInput, client_operation_id: 'stale' })).toMatchObject({ outcome: 'conflict' }); fail = true; expect((await service.submitTaskRun('task', { expected_task_revision: 3, expected_lineage_revision: 1, client_operation_id: 'write-fail', text: 'fail', attachment_ids: [] })).outcome).toBe('rejected'); expect(await fs.readFile(authorityPath)).toEqual(stable)
  })

  test('submit attachment negative matrix is atomic', async () => {
    for (const scenario of ['wrong-product-task-owner', 'composer-draft-owner-mismatch', 'staged', 'inspecting', 'accepted-bound', 'expired', 'cross-install'] as const) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `bb-02c-submit-${scenario}-`)); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); let clock = new Date('2026-01-01T00:00:00.000Z'); const now = () => clock
      await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: clock.toISOString(), updatedAt: clock.toISOString() } } }))
      const service = new ProductTaskService({ storagePath, installationId: 'install', now }); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' }); const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1_000, client_operation_id: 'draft' }); const owner = { kind: 'composer_draft' as const, id: draft.draft.draft_id as string }; const attachment = await service.registerAttachmentIdentity(owner, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'text/plain', storage_kind: 'external_reference', byte_size: 1 }, 1_000, 'attachment')
      if (!['staged', 'inspecting'].includes(scenario)) await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
      const repository = new ProductTaskAuthorityRepository(authorityPath); if (scenario === 'wrong-product-task-owner' || scenario === 'composer-draft-owner-mismatch') await repository.mutateCapabilities(state => { const value = state.task_attachments[attachment.attachment_id] as Record<string, unknown>; state.task_attachments[attachment.attachment_id] = { ...value, owner_kind: scenario === 'wrong-product-task-owner' ? 'product_task' : 'composer_draft', owner_id: 'other' } }); if (scenario === 'inspecting') await service.transitionAttachment({ attachment_id: attachment.attachment_id, expected_revision: 0, target_state: 'inspecting', client_operation_id: 'inspect' }); if (scenario === 'accepted-bound') await repository.mutateCapabilities(state => { const value = state.task_attachments[attachment.attachment_id] as Record<string, unknown>; state.task_attachments[attachment.attachment_id] = { ...value, state: 'accepted_bound' } }); if (scenario === 'cross-install') await repository.mutateCapabilities(state => { const value = state.task_attachments[attachment.attachment_id] as Record<string, unknown>; state.task_attachments[attachment.attachment_id] = { ...value, installation_id: 'other' } }); if (scenario === 'expired') clock = new Date('2026-01-02T00:00:00.000Z')
      const before = await repository.read(); const result = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, expected_draft_revision: 0, draft_id: draft.draft.draft_id as string, client_operation_id: 'submit', text: 'text', attachment_ids: [attachment.attachment_id] }); expect(['rejected', 'conflict']).toContain(result.outcome); const after = await repository.read(); expect(JSON.stringify({ revision: after.revision, tasks: after.tasks, lineages: after.conversation_lineages, attachments: after.task_attachments, root: { entries: after.thread_entries, runs: after.task_runs, dispatch: after.dispatch_records, events: after.task_events, bindings: after.attachment_bindings, receipts: after.receipts } })).toBe(JSON.stringify({ revision: before.revision, tasks: before.tasks, lineages: before.conversation_lineages, attachments: before.task_attachments, root: { entries: before.thread_entries, runs: before.task_runs, dispatch: before.dispatch_records, events: before.task_events, bindings: before.attachment_bindings, receipts: before.receipts } }))
    }
  })
})


test('submit service rejects unpaired draft CAS fields without a durable write', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-submit-pair-')); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); const now = '2026-01-01T00:00:00.000Z'; await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: {} }))
  const repository = new ProductTaskAuthorityRepository(authorityPath); await repository.mutateCapabilities(state => { state.tasks.task = { task: { id: 'task', projectId: '', directoryId: '', workDir: '', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now, worktreeState: 'not_requested', actions: [], revision: 0 }, binding: { coreSessionId: 'core' } } }); const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => new Date(now) }); const before = await fs.readFile(authorityPath)
  for (const input of [{ draft_id: 'draft', expected_draft_revision: undefined }, { draft_id: undefined, expected_draft_revision: 0 }]) expect((await service.submitTaskRun('task', { expected_task_revision: 0, expected_lineage_revision: 0, client_operation_id: `pair-${input.draft_id ?? 'missing'}`, text: 'text', attachment_ids: [], ...input } as any)).outcome).toBe('rejected')
  expect(await fs.readFile(authorityPath)).toEqual(before)
})

describe('authority submit schema upgrade', () => {
  test('first C transaction upgrades legal revision one and restart reads all C maps', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-rev3-')); const authorityPath = path.join(root, 'authority.json'); const now = '2026-01-01T00:00:00.000Z'; const task = { id: 'task', projectId: '', directoryId: '', workDir: '', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now, worktreeState: 'not_requested', actions: ['pin', 'unpin', 'rename', 'continue', 'archive', 'restore'], revision: 1, current_lineage_id: 'lineage' }
    await fs.writeFile(authorityPath, JSON.stringify({ version: 1, revision: 0, event_sequence: 0, tasks: { task: { task, binding: { coreSessionId: 'core' } } }, side_tasks: {}, bindings: {}, receipts: {}, events: {}, outbox: {}, prepared: {}, provenance: { task: { version: 4, store_digest: 'a'.repeat(64), record_digest: 'b'.repeat(64) } } }))
    await new ProductTaskAuthorityRepository(authorityPath).transactSubmit(state => { state.conversation_lineages.lineage = { lineage_id: 'lineage', product_task_id: 'task', revision: 1, compact_generation: 0, resume_binding_id: 'resume', state: 'active', created_at: now, updated_at: now, head_entry_id: 'entry' }; state.thread_entries.entry = { entry_id: 'entry', task_id: 'task', run_id: 'run', text: 'text', created_at: now }; state.task_runs.run = { run_id: 'run', task_id: 'task', lineage_id: 'lineage', entry_id: 'entry', created_at: now, execution_capability: 'installation_default_denied', permission_mode: null, provider: null, model: null }; state.dispatch_records.run = { run_id: 'run', dispatch_generation: 1, state: 'pending' }; state.task_events['1'] = { event_sequence: 1, task_id: 'task', run_id: 'run', type: 'user_text', entry_id: 'entry', text: 'text', attachment_ids: [], created_at: now }; state.events.submit = { event_sequence: 1, client_operation_id: 'submit', kind: 'task_submit', revision: 1, canonical_input: '{}', entity_id: 'task', product_task_id: 'task' }; state.receipts.submit = { client_operation_id: 'submit', expected_revision: 1, outcome: 'accepted', revision: 1, result: { task_id: 'task', run_id: 'run', entry_id: 'entry', dispatch_generation: 1, authority_revision: 1, entity_revisions: { task: 1, lineage: 1 } } } })
    const restarted = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(restarted.authority_schema_revision).toBe(7); expect(restarted).toMatchObject({ task_runs: { run: { entry_id: 'entry' } }, dispatch_records: { run: { state: 'pending' } }, task_events: { '1': { run_id: 'run' } }, turn_input_queue: {}, context_snapshots: {} })
  })

  test('real existing submit upgrades rev2 to rev3 without losing B maps', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-rev2-submit-')); const storagePath = path.join(root, 'product-tasks.json'); const authorityPath = path.join(root, 'product-task-authority.v1.json'); const now = () => new Date('2026-01-01T00:00:00.000Z')
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now().toISOString(), updatedAt: now().toISOString() } } }))
    let fail = false; const service = new ProductTaskService({ storagePath, installationId: 'install', now, authorityRepositoryDeps: { beforeWrite: () => { if (fail) throw new Error('write failure') } } }); await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath }); await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
    const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 1_000, client_operation_id: 'draft' }); const attachment = await service.registerAttachmentIdentity({ kind: 'composer_draft', id: draft.draft.draft_id as string }, { source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'text/plain', storage_kind: 'external_reference', byte_size: 1 }, 1_000, 'attachment'); await service.setAttachmentReadyForTest(attachment.attachment_id, 0)
    const repository = new ProductTaskAuthorityRepository(authorityPath); await repository.mutateCapabilities(state => { state.workspaces.workspace = { workspace_id: 'workspace', installation_id: 'install', canonical_root: '/workspace', root_identity: { platform: 'test', volume_id: 'v', file_id: 'f' }, revision: 0, availability: 'available', created_at: now().toISOString(), updated_at: now().toISOString() }; state.task_scopes.task = { kind: 'installation-default' } })
    const before = await repository.read(); const b = JSON.stringify({ workspaces: before.workspaces, task_scopes: before.task_scopes, composer_drafts: before.composer_drafts, task_attachments: before.task_attachments, conversation_lineages: before.conversation_lineages })
    const accepted = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, expected_draft_revision: 0, draft_id: draft.draft.draft_id as string, client_operation_id: 'submit', text: 'text', attachment_ids: [attachment.attachment_id] }); expect(accepted.outcome).toBe('accepted')
    const after = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(after.authority_schema_revision).toBe(7); expect(JSON.stringify({ workspaces: after.workspaces, task_scopes: after.task_scopes })).toBe(JSON.stringify({ workspaces: before.workspaces, task_scopes: before.task_scopes })); expect(Object.keys(after.thread_entries)).toHaveLength(1); expect(Object.keys(after.task_runs)).toHaveLength(1); expect(Object.keys(after.dispatch_records)).toHaveLength(1); expect(Object.keys(after.task_events)).toHaveLength(1); expect(Object.keys(after.attachment_bindings)).toHaveLength(1); expect(after.turn_input_queue).toEqual({}); expect(after.context_snapshots).toEqual({}); expect(JSON.stringify(after.composer_drafts)).not.toBe(JSON.stringify(before.composer_drafts)); expect(JSON.stringify(after.task_attachments)).not.toBe(JSON.stringify(before.task_attachments)); expect(JSON.stringify(after.conversation_lineages)).not.toBe(JSON.stringify(before.conversation_lineages)); expect(b).toContain('workspace')
    const bytes = await fs.readFile(authorityPath); fail = true; expect((await service.submitTaskRun('task', { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'write-fail', text: 'fail', attachment_ids: [] })).outcome).toBe('rejected'); expect(await fs.readFile(authorityPath)).toEqual(bytes)
  })

  test('A/B-only mutations preserve rev2 bytes shape and do not add C maps', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02c-rev2-no-upgrade-')); const authorityPath = path.join(root, 'authority.json'); const body = JSON.stringify({ version: 1, authority_schema_revision: 2, revision: 0, event_sequence: 0, tasks: {}, side_tasks: {}, bindings: {}, receipts: {}, events: {}, outbox: {}, prepared: {}, provenance: {}, workspaces: {}, task_scopes: {}, composer_drafts: {}, task_attachments: {}, conversation_lineages: {} }); await fs.writeFile(authorityPath, body)
    const repository = new ProductTaskAuthorityRepository(authorityPath); await repository.mutateCapabilities(state => { state.task_scopes.task = { kind: 'installation-default' } }); const written = JSON.parse(await fs.readFile(authorityPath, 'utf8')); expect(written.authority_schema_revision).toBe(2); for (const key of ['thread_entries', 'task_runs', 'dispatch_records', 'task_events', 'attachment_bindings']) expect(written).not.toHaveProperty(key)
  })
})

describe('BB-02D recoverable task deletion', () => {
  test('blocks registered consumers, supports pre-purge cancel, and only retries after durable purge commit', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02d-delete-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    await fs.writeFile(storagePath, '{"version":4,"tasks":{}}')
    let blockers: Array<{ participant: string; code: 'ACTIVE_RUN' | 'QUEUE' | 'SCHEDULE' | 'RECRUITING' | 'FORK' | 'WORKTREE'; action: 'stop' | 'detach' | 'disable' | 'resolve' }> = []
    let unavailable = false
    let failPrepare = false
    let failPurge = false
    const service = new ProductTaskService({
      storagePath,
      installationId: 'install',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      lifecycleParticipants: [{
        id: 'fake_lifecycle',
        inspectBlockers: async () => { if (unavailable) throw new Error('offline'); return blockers },
        prepareCleanup: async () => { if (failPrepare) throw new Error('pre-purge failure') },
        purgeCleanup: async () => { if (failPurge) throw new Error('post-purge failure') },
      }],
    })
    const draft = await service.createNewTaskComposerDraft({ ttl_ms: 1_000, client_operation_id: 'draft' })
    const submitted = await service.createAndSubmitTask({ draft_id: draft.draft.draft_id as string, expected_draft_revision: 0, client_operation_id: 'submit', text: 'delete me', attachment_ids: [], permission_mode: 'ask_for_approval' })
    const taskId = submitted.result!.task_id
    const repository = new ProductTaskAuthorityRepository(authorityPath)
    await repository.transactSubmit((state) => {
      const stored = state.tasks[taskId] as { task: Record<string, unknown>; binding: unknown }
      state.tasks[taskId] = { ...stored, task: { ...stored.task, lifecycle: 'archived', archivedAt: '2026-01-01T00:00:00.000Z', actions: ['restore', 'continue'], revision: 2 } }
    })

    for (const blocker of [
      { participant: 'active', code: 'ACTIVE_RUN' as const, action: 'stop' as const },
      { participant: 'queue', code: 'QUEUE' as const, action: 'detach' as const },
      { participant: 'schedule', code: 'SCHEDULE' as const, action: 'disable' as const },
      { participant: 'recruiting', code: 'RECRUITING' as const, action: 'resolve' as const },
      { participant: 'fork', code: 'FORK' as const, action: 'detach' as const },
      { participant: 'worktree', code: 'WORKTREE' as const, action: 'resolve' as const },
    ]) {
      blockers = [blocker]
      expect(await service.mutateTaskDeletion(taskId, { action: 'begin', expected_revision: 2, client_operation_id: `delete-${blocker.code}` })).toMatchObject({ outcome: 'rejected', blockers: [blocker] })
    }
    blockers = []
    unavailable = true
    expect(await service.mutateTaskDeletion(taskId, { action: 'begin', expected_revision: 2, client_operation_id: 'delete-unavailable' })).toMatchObject({ outcome: 'rejected', blockers: [{ participant: 'fake_lifecycle', code: 'BLOCKER_UNAVAILABLE', action: 'resolve' }] })
    unavailable = false
    failPrepare = true
    expect(await service.mutateTaskDeletion(taskId, { action: 'begin', expected_revision: 2, client_operation_id: 'delete-pre-fail' })).toMatchObject({ outcome: 'accepted', task: { lifecycle: 'delete_failed_pre_purge', revision: 3, deletion: { failed_items: ['fake_lifecycle'] } } })
    failPrepare = false
    expect(await service.mutateTaskDeletion(taskId, { action: 'cancel', expected_revision: 3, client_operation_id: 'delete-cancel-failed-pre' })).toMatchObject({ outcome: 'accepted', task: { lifecycle: 'archived', revision: 4 } })
    blockers = []
    expect(await service.mutateTaskDeletion(taskId, { action: 'begin', expected_revision: 4, client_operation_id: 'delete-begin-2' })).toMatchObject({ outcome: 'accepted', task: { lifecycle: 'deleting', revision: 5 } })
    expect(await service.mutateTaskDeletion(taskId, { action: 'begin', expected_revision: 4, client_operation_id: 'delete-begin-2' })).toMatchObject({ outcome: 'duplicate', task: { lifecycle: 'deleting', revision: 5 } })
    expect(await service.mutateTaskDeletion(taskId, { action: 'commit_purge', expected_revision: 5, client_operation_id: 'delete-commit' })).toMatchObject({ outcome: 'accepted', task: { lifecycle: 'purge_committed', revision: 6 } })
    const committed = await repository.read()
    expect(Object.keys(committed.thread_entries)).toHaveLength(1)
    expect(await service.mutateTaskDeletion(taskId, { action: 'cancel', expected_revision: 6, client_operation_id: 'delete-too-late' })).toMatchObject({ outcome: 'rejected', task: { lifecycle: 'purge_committed' } })
    failPurge = true
    expect(await service.mutateTaskDeletion(taskId, { action: 'retry', expected_revision: 6, client_operation_id: 'delete-post-fail' })).toMatchObject({ outcome: 'accepted', task: { lifecycle: 'delete_failed_post_purge', revision: 7, deletion: { failed_items: ['fake_lifecycle'] } } })
    failPurge = false
    expect(await service.mutateTaskDeletion(taskId, { action: 'retry', expected_revision: 7, client_operation_id: 'delete-retry' })).toMatchObject({ outcome: 'accepted', task: { lifecycle: 'deleted', revision: 8, workDir: '', title: '', deletion: { phase: 'deleted', tombstone_expires_at: expect.any(String) } } })
    const deleted = await repository.read()
    expect(Object.keys(deleted.thread_entries)).toHaveLength(0)
    expect(Object.keys(deleted.task_runs)).toHaveLength(0)
    expect(Object.keys(deleted.dispatch_records)).toHaveLength(0)
    expect(Object.keys(deleted.task_events)).toHaveLength(0)
    expect(Object.keys(deleted.conversation_lineages)).toHaveLength(0)
    expect(await service.mutateTaskDeletion(taskId, { action: 'retry', expected_revision: 7, client_operation_id: 'delete-retry' })).toMatchObject({ outcome: 'duplicate', task: { lifecycle: 'deleted', revision: 8 } })
  })

  test('purges private bindings, attachments, harness sessions, AutoMem turns, and side-task consumers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-02d-private-artifacts-'))
    const storagePath = path.join(root, 'product-tasks.json')
    const authorityPath = path.join(root, 'product-task-authority.v1.json')
    const timestamp = '2026-01-01T00:00:00.000Z'
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'private-core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: timestamp, updatedAt: timestamp } } }))
    const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => new Date(timestamp) })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath })
    const repository = new ProductTaskAuthorityRepository(authorityPath)
    await repository.transactSubmit(state => {
      const stored = state.tasks.task as { task: Record<string, unknown>; binding: unknown }
      state.tasks.task = { ...stored, task: { ...stored.task, lifecycle: 'archived', archivedAt: timestamp, actions: ['restore', 'continue'], revision: 1 } }
      state.conversation_lineages.lineage = { lineage_id: 'lineage', product_task_id: 'task', revision: 0, compact_generation: 0, resume_binding_id: 'resume-private', state: 'active', created_at: timestamp, updated_at: timestamp }
      state.thread_entries.entry = { entry_id: 'entry', task_id: 'task', run_id: 'run-terminal', text: 'remember me', created_at: timestamp }
      state.composer_drafts.draft = { draft_id: 'draft', installation_id: 'install', target_task_id: 'task', revision: 0, last_activity: timestamp, state: 'consumed', created_at: timestamp, expires_at: '2027-01-01T00:00:00.000Z' }
      state.task_attachments.attachment_asset = { attachment_id: 'attachment_asset', installation_id: 'install', owner_kind: 'product_task', owner_id: 'task', source_fingerprint: 'a'.repeat(64), content_hash: 'b'.repeat(64), verified_media_type: 'text/plain', storage_kind: 'app_owned_copy', byte_size: 7, state: 'accepted_bound', refs: ['task'], created_at: timestamp, last_activity: timestamp, expires_at: '2027-01-01T00:00:00.000Z', revision: 1 }
      state.side_tasks.side = { id: 'side', parentTaskId: 'task', taskId: 'task-side', title: 'side', status: 'closed', createdAt: timestamp, updatedAt: timestamp, closedAt: timestamp }
      state.bindings.side = { id: 'side', kind: 'side', binding: { coreSessionId: 'side-private' } }
    })
    const attachmentDir = path.join(root, 'product-task-attachments', 'attachment_asset')
    await fs.mkdir(attachmentDir, { recursive: true }); await fs.writeFile(path.join(attachmentDir, 'source.txt'), 'private')
    const harnessBinding = { storage_dir: path.join(root, 'product-harness-sessions'), binding_id: 'resume-private', lineage_id: 'lineage' }
    const harness = new ProductHarnessSessionRepository()
    await harness.save(harnessBinding, { context_prefix: '', messages: [createProductUserMessage({ content: 'private turn' })], run_id: 'run-terminal', instruction_digest: 'c'.repeat(64), instruction_prompt: null })
    const autoMemory = new ProductAutoMemoryRepository()
    const memoryBinding = { storage_dir: path.join(root, 'product-auto-memory'), work_dir: root, enabled: true }
    await autoMemory.initialize(memoryBinding); await autoMemory.appendCompletedTurn(memoryBinding, { task_id: 'task', entry_id: 'entry', user: 'remember me', assistant: 'private result' })

    expect((await service.mutateTaskDeletion('task', { action: 'begin', expected_revision: 1, client_operation_id: 'delete-begin' })).outcome).toBe('accepted')
    expect((await service.mutateTaskDeletion('task', { action: 'commit_purge', expected_revision: 2, client_operation_id: 'delete-commit' })).outcome).toBe('accepted')
    expect((await service.mutateTaskDeletion('task', { action: 'retry', expected_revision: 3, client_operation_id: 'delete-purge' })).task.lifecycle).toBe('deleted')

    const deleted = await repository.read()
    expect(deleted.tasks.task).not.toHaveProperty('binding')
    expect(Object.keys(deleted.bindings)).toEqual([])
    expect(Object.keys(deleted.side_tasks)).toEqual([])
    expect(Object.keys(deleted.task_attachments)).toEqual([])
    expect(Object.keys(deleted.composer_drafts)).toEqual([])
    const registry = JSON.parse(await fs.readFile(storagePath, 'utf8')) as { tasks: Record<string, unknown> }
    expect(registry.tasks).not.toHaveProperty('task')
    expect(await harness.load(harnessBinding)).toBeUndefined()
    expect(await autoMemory.load(memoryBinding)).toBe('')
    await expect(fs.stat(attachmentDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
