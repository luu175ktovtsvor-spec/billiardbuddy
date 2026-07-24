import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productTasksApi } from '../api/tasks'
import type { AuthoritySnapshot, ProductTaskActionResponse, ProductTaskIndexResponse, ProductTaskRecord } from '../domain/types'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from './productTaskStore'

vi.mock('../api/tasks', () => ({
  productTasksApi: { list: vi.fn(), create: vi.fn(), update: vi.fn(), pin: vi.fn(), unpin: vi.fn(), archive: vi.fn(), restore: vi.fn(), recover: vi.fn(), delete: vi.fn(), continue: vi.fn() },
}))

function makeTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return { id: 'task-1', projectId: 'project-1', directoryId: 'directory-1', workDir: '/workspace/billiard', title: '修复开球规则', lifecycle: 'active', kind: 'main', createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z', worktreeState: 'planned', actions: ['rename', 'archive', 'continue'], links: { page: '/tasks/task-1' }, ...overrides }
}
function makeIndex(task = makeTask()): ProductTaskIndexResponse {
  return { schemaVersion: 2, projects: [{ id: 'project-1', title: 'BilliardBuddy', rootDir: '/workspace/billiard', createdAt: task.createdAt, taskCount: 1, archivedTaskCount: 0, updatedAt: task.updatedAt }], directories: [{ id: 'directory-1', projectId: 'project-1', path: '/workspace/billiard', label: 'BilliardBuddy', createdAt: task.createdAt, updatedAt: task.updatedAt }], tasks: [task], total: 1, capabilities: { createTask: true } }
}
function authority(task: ProductTaskRecord, revision = 1): AuthoritySnapshot {
  return { revision, event_sequence: revision, tasks: [{ ...task, actions: undefined, links: undefined } as never], side_tasks: [] }
}
function response(task: ProductTaskRecord, revision = 1, outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected' = 'accepted'): ProductTaskActionResponse {
  return { receipt: { client_operation_id: 'op', expected_revision: revision - 1, outcome, revision }, authority: authority(task, revision), task }
}
function resetStore() {
  useProductTaskStore.setState({ index: EMPTY_PRODUCT_TASK_INDEX, isLoading: false, error: null, mutations: {}, confirmedAuthorityRevision: 0, pending: {} })
}

describe('productTaskStore authority mutations', () => {
  beforeEach(() => { resetStore(); vi.clearAllMocks() })
  afterEach(resetStore)

  it('uses list only for task index loading', async () => {
    const index = makeIndex()
    vi.mocked(productTasksApi.list).mockResolvedValue(index)
    await useProductTaskStore.getState().refresh()
    expect(useProductTaskStore.getState().index).toEqual(index)
  })

  it('retains an immutable envelope after timeout and retries the same operation id', async () => {
    const original = makeTask()
    const archived = makeTask({ lifecycle: 'archived', archivedAt: '2026-07-18T01:00:00.000Z', actions: ['restore'] })
    useProductTaskStore.setState({ index: makeIndex(original) })
    vi.mocked(productTasksApi.archive).mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce(response(archived))
    await expect(useProductTaskStore.getState().archiveTask(original.id)).rejects.toThrow('network timeout')
    const pending = useProductTaskStore.getState().pending['task-1:archive']
    expect(pending).toEqual(expect.objectContaining({ expected_revision: 0, client_operation_id: expect.any(String) }))
    await useProductTaskStore.getState().archiveTask(original.id)
    expect(productTasksApi.archive).toHaveBeenCalledTimes(2)
    expect(vi.mocked(productTasksApi.archive).mock.calls[0]?.[1]).toBe(vi.mocked(productTasksApi.archive).mock.calls[1]?.[1])
    expect(useProductTaskStore.getState().pending['task-1:archive']).toBeUndefined()
  })

  it('clears pending only after a durable terminal receipt', async () => {
    const task = makeTask({ lifecycle: 'archived', archivedAt: '2026-07-18T01:00:00.000Z' })
    useProductTaskStore.setState({ index: makeIndex() })
    vi.mocked(productTasksApi.archive).mockResolvedValue(response(task))
    await useProductTaskStore.getState().archiveTask(task.id)
    expect(useProductTaskStore.getState().pending).toEqual({})
    expect(useProductTaskStore.getState().confirmedAuthorityRevision).toBe(1)
  })

  it('merges conflict authority without losing renderer projection fields', async () => {
    const original = makeTask({ actions: ['rename', 'archive'], links: { page: '/tasks/task-1', review: '/review' } })
    const server = makeTask({ title: '其他窗口标题', pinnedAt: '2026-07-18T01:00:00.000Z' })
    useProductTaskStore.setState({ index: makeIndex(original), confirmedAuthorityRevision: 1 })
    vi.mocked(productTasksApi.update).mockResolvedValue(response(server, 2, 'conflict'))
    await useProductTaskStore.getState().renameTask(original.id, '我的标题')
    expect(useProductTaskStore.getState().index.tasks[0]).toEqual(expect.objectContaining({ title: '其他窗口标题', actions: original.actions, links: original.links }))
    expect(useProductTaskStore.getState().confirmedAuthorityRevision).toBe(2)
  })

  it('ignores stale authority and keeps the higher confirmed revision', async () => {
    const current = makeTask({ title: '新标题' })
    const stale = makeTask({ title: '旧标题' })
    useProductTaskStore.setState({ index: makeIndex(current), confirmedAuthorityRevision: 4 })
    vi.mocked(productTasksApi.pin).mockResolvedValue(response(stale, 3))
    await useProductTaskStore.getState().pinTask(current.id)
    expect(useProductTaskStore.getState().index.tasks[0]!.title).toBe('新标题')
    expect(useProductTaskStore.getState().confirmedAuthorityRevision).toBe(4)
  })

  it('uses local request sequence only to prevent a late list overwrite', async () => {
    const original = makeTask()
    const archived = makeTask({ lifecycle: 'archived', archivedAt: '2026-07-18T01:00:00.000Z' })
    let resolveIndex!: (value: ProductTaskIndexResponse) => void
    vi.mocked(productTasksApi.list).mockReturnValueOnce(new Promise((resolve) => { resolveIndex = resolve }))
    vi.mocked(productTasksApi.archive).mockResolvedValue(response(archived, 7))
    useProductTaskStore.setState({ index: makeIndex(original) })
    const refresh = useProductTaskStore.getState().refresh()
    await useProductTaskStore.getState().archiveTask(original.id)
    resolveIndex(makeIndex(original))
    await refresh
    expect(useProductTaskStore.getState().index.tasks[0]!.lifecycle).toBe('archived')
    expect(useProductTaskStore.getState().confirmedAuthorityRevision).toBe(7)
  })

  it('uses the task revision for a two-confirmation deletion and refreshes away a tombstone', async () => {
    const archived = makeTask({ lifecycle: 'archived', revision: 4, actions: ['restore', 'continue'] })
    const deleted = makeTask({ lifecycle: 'deleted', revision: 5, projectId: '', directoryId: '', workDir: '', title: '', actions: [] })
    useProductTaskStore.setState({ index: makeIndex(archived) })
    vi.mocked(productTasksApi.delete).mockResolvedValue({ task: deleted, receipt: { outcome: 'accepted' }, blockers: [] })
    vi.mocked(productTasksApi.list).mockResolvedValue({ ...makeIndex(archived), tasks: [], total: 0 })
    await expect(useProductTaskStore.getState().mutateTaskDeletion(archived.id, 'retry')).resolves.toEqual(deleted)
    expect(productTasksApi.delete).toHaveBeenCalledWith(archived.id, expect.objectContaining({ phase: 'retry', expected_revision: 4, client_operation_id: expect.any(String) }))
    expect(useProductTaskStore.getState().index.tasks).toEqual([])
  })

  it('forks from the task entity revision instead of the unrelated authority root revision', async () => {
    const current = makeTask({ revision: 4 })
    const forked = makeTask({ revision: 5, workDir: '/workspace/fork', worktreeState: 'materialized' })
    useProductTaskStore.setState({ index: makeIndex(current), confirmedAuthorityRevision: 12 })
    vi.mocked(productTasksApi.continue).mockResolvedValue(response(forked, 14))
    vi.mocked(productTasksApi.list).mockResolvedValue(makeIndex(forked))
    await useProductTaskStore.getState().continueTask(current.id, { sourceEntryId: 'thread_0123456789abcdef0123', target: 'new_worktree' })
    expect(productTasksApi.continue).toHaveBeenCalledWith(current.id, expect.objectContaining({ expected_revision: 4, target: 'new_worktree' }))
  })

  it('retries one failed-run recovery with the same durable operation envelope', async () => {
    const failed = makeTask({ revision: 4 })
    const recovered = makeTask({ revision: 5 })
    useProductTaskStore.setState({ index: makeIndex(failed), confirmedAuthorityRevision: 12 })
    vi.mocked(productTasksApi.recover).mockRejectedValueOnce(new Error('network timeout')).mockResolvedValueOnce(response(recovered, 13))
    vi.mocked(productTasksApi.list).mockResolvedValue(makeIndex(recovered))
    await expect(useProductTaskStore.getState().recoverTaskRun(failed.id)).rejects.toThrow('network timeout')
    const pending = useProductTaskStore.getState().pending['task-1:recover']
    expect(pending).toEqual(expect.objectContaining({ expected_revision: 4, client_operation_id: expect.any(String) }))
    await useProductTaskStore.getState().recoverTaskRun(failed.id)
    expect(productTasksApi.recover).toHaveBeenCalledTimes(2)
    expect(vi.mocked(productTasksApi.recover).mock.calls[0]?.[1]).toBe(vi.mocked(productTasksApi.recover).mock.calls[1]?.[1])
  })
})
