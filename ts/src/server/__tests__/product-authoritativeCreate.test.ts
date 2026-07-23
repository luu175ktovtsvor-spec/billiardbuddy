import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskService } from '../product/taskService.js'
import { CoreOperationTerminalError } from '../product/coreOperationBridge.js'
import { ProductTaskAuthorityRepository } from '../product/authorityRepository.js'
import { SessionAdmissionBarrier } from '../product/sessionAdmissionBarrier.js'
import { ActiveCoreRunRegistry } from '../product/activeCoreRunRegistry.js'

test('authoritative create prepares before bridge, never writes legacy, and replays after finalize crash', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-create-')); const legacy = path.join(root, 'product-tasks.json'); await fs.writeFile(legacy, '{"version":4,"tasks":{}}'); const before = await fs.readFile(legacy); const authority = path.join(root, 'product-task-authority.v1.json'); let calls = 0; let observedPrepared = false; const bridge = { ensureCreate: async () => { calls++; observedPrepared = Boolean((await fs.readFile(authority, 'utf8')).includes('"prepared"')); return { coreSessionId: 'private-core' } } }; const service = new ProductTaskService({ storagePath: legacy }); const input = { workDir: root, title: 'hello', expected_revision: 0, client_operation_id: 'op-create' }; await expect(service.createTaskAuthoritatively(input, { authorityPath: authority, bridge, afterEnsure: () => { throw new Error('crash-after-bridge') } })).rejects.toThrow('crash-after-bridge'); const result = await new ProductTaskService({ storagePath: legacy }).createTaskAuthoritatively(input, { authorityPath: authority, bridge }); expect(observedPrepared).toBeTrue(); expect(calls).toBe(2); expect(result.receipt.outcome).toBe('accepted'); expect(JSON.stringify(result.task)).not.toContain('private-core'); expect(await fs.readFile(legacy)).toEqual(before) })
test('authoritative create rejects input reuse conflict', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-create-conflict-')); const authority = path.join(root, 'product-task-authority.v1.json'); const bridge = { ensureCreate: async () => ({ coreSessionId: 'private' }) }; const s = new ProductTaskService(); await s.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'same' }, { authorityPath: authority, bridge }); const second = await s.createTaskAuthoritatively({ workDir: `${root}/other`, expected_revision: 0, client_operation_id: 'same' }, { authorityPath: authority, bridge }); expect(second.receipt.outcome).toBe('conflict') })
test('legacy task projection is one-time, byte-preserving, and starts at revision one', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-projection-')); const legacy = path.join(root, 'product-tasks.json'); const body = '{"version":4,"tasks":{"task-legacy":{"coreSessionId":"private-core","title":"legacy","lifecycle":"active","kind":"main","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}},"sideTasks":{"side-1":{"parentTaskId":"task-parent"}}}'; await fs.writeFile(legacy, body); const authority = path.join(root, 'authority.json'); const service = new ProductTaskService({ storagePath: legacy }); const first = await service.ensureAuthorityProjectionForLegacyTask('task-legacy', { authorityPath: authority }); const again = await service.ensureAuthorityProjectionForLegacyTask('task-legacy', { authorityPath: authority }); expect(first.revision).toBe(1); expect(again.revision).toBe(1); expect(await fs.readFile(legacy, 'utf8')).toBe(body); await fs.writeFile(legacy, body.replace('"title":"legacy"','"title":"changed"')); await expect(service.ensureAuthorityProjectionForLegacyTask('task-legacy', { authorityPath: authority })).rejects.toThrow('LEGACY_SOURCE_CHANGED') })
test('legacy projection serializes concurrent initialization and supports CAS branch lifecycle', async () => { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'authority-projection-cas-')); const legacy = path.join(root, 'product-tasks.json'); const body = '{"version":4,"tasks":{"task-parent":{"coreSessionId":"private-core","title":"legacy","lifecycle":"active","kind":"main","createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}},"sideTasks":{"side-1":{"parentTaskId":"task-parent"}}}'; await fs.writeFile(legacy, body); const authority = path.join(root, 'authority.json'); const service = new ProductTaskService({ storagePath: legacy }); const [left, right] = await Promise.all([service.ensureAuthorityProjectionForLegacyTask('task-parent', { authorityPath: authority }), service.ensureAuthorityProjectionForLegacyTask('task-parent', { authorityPath: authority })]); expect([left.revision, right.revision]).toEqual([1, 1]); const pin = await service.mutateTaskAuthoritatively({ taskId: 'task-parent', patch: { pinned: true }, expected_revision: 0, client_operation_id: 'pin' }, { authorityPath: authority }); expect(pin.receipt.outcome).toBe('accepted'); const stale = await service.mutateTaskAuthoritatively({ taskId: 'task-parent', patch: { pinned: false }, expected_revision: 0, client_operation_id: 'stale' }, { authorityPath: authority }); expect(stale.receipt.outcome).toBe('conflict'); const bridge = { ensureBranch: async () => ({ coreSessionId: 'private-child' }) }; const continued = await service.continueTaskAuthoritatively({ taskId: 'task-parent', expected_revision: 1, client_operation_id: 'continue', canonical_input: '{}' }, { authorityPath: authority, bridge }); expect(continued.outcome).toBe('accepted'); const side = await service.createSideTaskAuthoritatively({ taskId: 'task-parent', sideTaskId: 'task-side', expected_revision: 2, client_operation_id: 'side', canonical_input: '{}' }, { authorityPath: authority, bridge }); expect(side.outcome).toBe('accepted'); const closed = await service.closeSideTaskAuthoritatively({ taskId: 'task-parent', sideTaskId: 'task-side', expected_revision: 2, client_operation_id: 'close', canonical_input: '{}' }, { authorityPath: authority }); expect(closed.outcome).toBe('accepted'); expect(await fs.readFile(legacy, 'utf8')).toBe(body) })


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
  for (const [action, head] of [['advance', 'head'], ['park', undefined], ['recovery', undefined], ['compact', undefined]] as const) { const result = await service.mutateConversationLineage({ lineage_id: id, expected_revision: revision, client_operation_id: `${action}-${revision}`, action, ...(head ? { head_entry_id: head } : {}) }); expect(result).toMatchObject({ outcome: 'accepted', lineage_revision: revision + 1 }); revision += 1 }
  const before = await new ProductTaskAuthorityRepository(authorityPath).read(); expect((await service.mutateConversationLineage({ lineage_id: id, expected_revision: 0, client_operation_id: 'stale', action: 'compact' })).outcome).toBe('conflict'); const after = await new ProductTaskAuthorityRepository(authorityPath).read(); expect(JSON.stringify({ revision: after.revision, lineages: after.conversation_lineages })).toBe(JSON.stringify({ revision: before.revision, lineages: before.conversation_lineages }))
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
  const result = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'terminal-create' }, { authorityPath: authority, bridge: { ensureCreate: async () => { throw new CoreOperationTerminalError('CORE_OPERATION_INPUT_INVALID', 'bad') } } })
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
  const barrier = new SessionAdmissionBarrier(); const registry = new ActiveCoreRunRegistry(); let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }); const order: string[] = []
  const mutation = barrier.withWorkspaceMutation('core', async () => { order.push('bind-inspect-clear'); await held; order.push('bind-commit') })
  await Bun.sleep(5)
  const run = barrier.withRunStart('core', async () => { registry.markActive('core'); order.push('run-active') })
  await Bun.sleep(5); expect(order).toEqual(['bind-inspect-clear']); expect(registry.hasActive('core')).toBeFalse()
  release(); await Promise.all([mutation, run]); expect(order).toEqual(['bind-inspect-clear', 'bind-commit', 'run-active']); registry.markInactive('core')
})

test('real bind waits for active run admission then rejects without workspace mutation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bind-active-admission-')); const storagePath = path.join(root, 'tasks.json'); await fs.writeFile(storagePath, '{"version":4,"tasks":{}}'); const barrier = new SessionAdmissionBarrier(); const registry = new ActiveCoreRunRegistry(); const authority = path.join(root, 'product-task-authority.v1.json'); let inspectCalls = 0
  const receipts = (active: boolean) => active ? [{ participant: 'active_core_run', status: 'BLOCKED', code: 'ACTIVE_RUN' }, { participant: 'queue', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'pty', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'preview', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'workspace_write', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }] as const : [{ participant: 'active_core_run', status: 'CLEAR' }, { participant: 'queue', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'pty', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'preview', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'workspace_write', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }] as const
  const service = new ProductTaskService({ storagePath, admissionBarrier: barrier, workspaceFs: { inspect: async (value) => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'v', file_id: value }, availability: 'available' as const }) }, workspaceBindBlockers: { inspect: async () => { inspectCalls++; return { receipts: receipts(registry.hasActive('core')) } } } })
  const task = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'create' }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: 'core' }) } }); const workspace = await service.registerWorkspace('/workspace'); const before = await new ProductTaskAuthorityRepository(authority).read()
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve }); const run = barrier.withRunStart('core', async () => { registry.markActive('core'); await held }); await Bun.sleep(5)
  let settled = false; const bind = service.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' }).then(value => { settled = true; return value }); await Bun.sleep(5); expect(settled).toBeFalse(); expect(inspectCalls).toBe(0)
  release(); await run; const result = await bind; expect(result).toMatchObject({ outcome: 'rejected', error: 'ACTIVE_RUN' }); const after = await new ProductTaskAuthorityRepository(authority).read(); expect((after.tasks[task.task.id] as { task: { revision: number } }).task.revision).toBe((before.tasks[task.task.id] as { task: { revision: number } }).task.revision); expect(after.workspaces[workspace.workspace_id].revision).toBe(before.workspaces[workspace.workspace_id].revision); expect(after.task_scopes[task.task.id]).toBeUndefined(); registry.markInactive('core')
})

test('real bind commit keeps a same-session run start queued until clear inspection commits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bind-clear-admission-')); const storagePath = path.join(root, 'tasks.json'); await fs.writeFile(storagePath, '{"version":4,"tasks":{}}'); const barrier = new SessionAdmissionBarrier(); const registry = new ActiveCoreRunRegistry(); const authority = path.join(root, 'product-task-authority.v1.json'); let inspected!: () => void; const inspectStarted = new Promise<void>(resolve => { inspected = resolve }); let releaseInspect!: () => void; const inspectHeld = new Promise<void>(resolve => { releaseInspect = resolve })
  const disabled = [{ participant: 'queue', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'pty', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'preview', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }, { participant: 'workspace_write', status: 'OUT_OF_SCOPE_DISABLED', owner_module: 'BB-02C' }] as const
  const service = new ProductTaskService({ storagePath, admissionBarrier: barrier, workspaceFs: { inspect: async value => ({ canonical_root: value, identity: { platform: 'test', volume_id: 'v', file_id: value }, availability: 'available' as const }) }, workspaceBindBlockers: { inspect: async () => { inspected(); await inspectHeld; return { receipts: [{ participant: 'active_core_run', status: 'CLEAR' }, ...disabled] } } } })
  const task = await service.createTaskAuthoritatively({ workDir: root, expected_revision: 0, client_operation_id: 'create' }, { authorityPath: authority, bridge: { ensureCreate: async () => ({ coreSessionId: 'core' }) } }); const workspace = await service.registerWorkspace('/workspace')
  const bind = service.bindTaskWorkspace({ task_id: task.task.id, workspace_id: workspace.workspace_id, expected_task_revision: 0, expected_workspace_revision: 0, client_operation_id: 'bind' }); await inspectStarted
  let runEntered = false; const run = barrier.withRunStart('core', async () => { runEntered = true; registry.markActive('core') }); await Bun.sleep(5); expect(runEntered).toBeFalse(); expect(registry.hasActive('core')).toBeFalse()
  releaseInspect(); const result = await bind; expect(result.outcome).toBe('accepted'); expect(result.participant_receipts).toHaveLength(5); await run; expect(runEntered).toBeTrue(); const after = await new ProductTaskAuthorityRepository(authority).read(); expect((after.tasks[task.task.id] as { task: { revision: number } }).task.revision).toBe(1); expect(after.workspaces[workspace.workspace_id].revision).toBe(1); expect(after.task_scopes[task.task.id]).toMatchObject({ kind: 'workspace', workspace_id: workspace.workspace_id }); registry.markInactive('core')
})
