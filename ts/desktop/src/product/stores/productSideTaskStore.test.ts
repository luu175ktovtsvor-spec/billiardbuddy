import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productSideTasksApi } from '../api/sideTasks'
import type { ProductSideTask, ProductSideTaskActionResponse } from '../domain/types'
import { useProductSideTaskStore } from './productSideTaskStore'

vi.mock('../api/sideTasks', () => ({ productSideTasksApi: { list: vi.fn(), create: vi.fn(), close: vi.fn() } }))
const parent = 'task-1'
function side(overrides: Partial<ProductSideTask> = {}): ProductSideTask { return { id: 'side-1', parentTaskId: parent, taskId: 'side-1', title: '分支', status: 'open', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...overrides } }
function result(revision = 1, sideTask?: ProductSideTask): ProductSideTaskActionResponse { return { receipt: { client_operation_id: 'op', expected_revision: revision - 1, outcome: 'accepted', revision }, authority: { revision, event_sequence: revision, tasks: [], side_tasks: sideTask ? [sideTask] : [] }, sideTask } }
function reset() { useProductSideTaskStore.setState({ sideTasksByParentTaskId: {}, loadingByParentTaskId: {}, errorsByParentTaskId: {}, mutations: {}, panelByParentTaskId: {}, confirmedAuthorityRevisionByParentTaskId: {}, pending: {} }) }

describe('productSideTaskStore authority mutations', () => {
 beforeEach(() => { reset(); vi.clearAllMocks() }); afterEach(reset)
 it('keeps an unknown create pending and retries the same envelope/id', async () => {
   vi.mocked(productSideTasksApi.create).mockRejectedValueOnce(new Error('timeout')).mockImplementationOnce(async (_parent, input) => result(1, side({ id: input.sideTaskId, taskId: input.sideTaskId })))
   await expect(useProductSideTaskStore.getState().createSideTask(parent, { sourceEntryId: 'entry-1' })).rejects.toThrow('timeout')
   const pending = Object.values(useProductSideTaskStore.getState().pending)[0]
   expect(pending).toEqual(expect.objectContaining({ expected_revision: 0, client_operation_id: expect.any(String), sideTaskId: expect.any(String) }))
   await useProductSideTaskStore.getState().createSideTask(parent, { sourceEntryId: 'entry-1' })
   expect(vi.mocked(productSideTasksApi.create).mock.calls[0]?.[1]).toBe(vi.mocked(productSideTasksApi.create).mock.calls[1]?.[1])
   expect(useProductSideTaskStore.getState().pending).toEqual({})
 })
 it('clears close pending after receipt and preserves panel state while merging projection', async () => {
   const open = side(); const closed = side({ status: 'closed', closedAt: '2026-01-02T00:00:00.000Z' })
   useProductSideTaskStore.setState({ sideTasksByParentTaskId: { [parent]: [open] }, panelByParentTaskId: { [parent]: { isOpen: true, selectedSideTaskId: open.id } } })
   vi.mocked(productSideTasksApi.close).mockResolvedValue(result(3, closed))
   await useProductSideTaskStore.getState().closeSideTask(parent, open.id)
   expect(useProductSideTaskStore.getState().sideTasksByParentTaskId[parent]?.[0]).toMatchObject({ status: 'closed' })
   expect(useProductSideTaskStore.getState().panelByParentTaskId[parent]).toEqual({ isOpen: true, selectedSideTaskId: open.id })
   expect(useProductSideTaskStore.getState().confirmedAuthorityRevisionByParentTaskId[parent]).toBe(3)
 })
 it('ignores stale authority responses', async () => {
   const open = side(); useProductSideTaskStore.setState({ sideTasksByParentTaskId: { [parent]: [open] }, confirmedAuthorityRevisionByParentTaskId: { [parent]: 5 } })
   vi.mocked(productSideTasksApi.close).mockResolvedValue(result(4, side({ status: 'closed' })))
   await useProductSideTaskStore.getState().closeSideTask(parent, open.id)
   expect(useProductSideTaskStore.getState().sideTasksByParentTaskId[parent]?.[0]?.status).toBe('open')
 })
})
