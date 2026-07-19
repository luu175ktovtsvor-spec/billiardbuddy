import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productSideTasksApi } from '../api/sideTasks'
import type { ProductSideTask } from '../domain/types'
import {
  productSideTaskMutationKey,
  useProductSideTaskStore,
} from './productSideTaskStore'

vi.mock('../api/sideTasks', () => ({
  productSideTasksApi: {
    list: vi.fn(),
    create: vi.fn(),
    close: vi.fn(),
  },
}))

const parentTaskId = 'task-1'

function makeSideTask(overrides: Partial<ProductSideTask> = {}): ProductSideTask {
  return {
    id: 'side-1',
    parentTaskId,
    taskId: 'task-side-1',
    title: '单独核对优惠规则',
    status: 'open',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  }
}

function resetStore() {
  useProductSideTaskStore.setState({
    sideTasksByParentTaskId: {},
    loadingByParentTaskId: {},
    errorsByParentTaskId: {},
    mutations: {},
    panelByParentTaskId: {},
  })
}

describe('productSideTaskStore', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetStore()
  })

  it('keeps side tasks in a parent-scoped temporary collection', async () => {
    const sideTask = makeSideTask()
    vi.mocked(productSideTasksApi.create).mockResolvedValue({ sideTask })

    await useProductSideTaskStore.getState().createSideTask(parentTaskId, {
      sourceEntryId: 'thread_0123456789abcdef0123',
    })

    expect(productSideTasksApi.create).toHaveBeenCalledWith(parentTaskId, {
      sourceEntryId: 'thread_0123456789abcdef0123',
    })
    expect(useProductSideTaskStore.getState().sideTasksByParentTaskId[parentTaskId]).toEqual([sideTask])
    expect(useProductSideTaskStore.getState().mutations[
      productSideTaskMutationKey(parentTaskId, 'new', 'create')
    ]).toBe(false)
  })

  it('reconciles a closed side task without removing its retained transcript record', async () => {
    const openSideTask = makeSideTask()
    const closedSideTask = makeSideTask({
      status: 'closed',
      closedAt: '2026-07-18T01:00:00.000Z',
      updatedAt: '2026-07-18T01:00:00.000Z',
    })
    useProductSideTaskStore.setState({
      sideTasksByParentTaskId: { [parentTaskId]: [openSideTask] },
    })
    vi.mocked(productSideTasksApi.close).mockResolvedValue({ sideTask: closedSideTask })

    await useProductSideTaskStore.getState().closeSideTask(parentTaskId, openSideTask.id)

    expect(productSideTasksApi.close).toHaveBeenCalledWith(parentTaskId, openSideTask.id)
    expect(useProductSideTaskStore.getState().sideTasksByParentTaskId[parentTaskId]).toEqual([closedSideTask])
  })

  it('opens a panel with the requested side task and never adds it to the normal task store', () => {
    const sideTask = makeSideTask()
    useProductSideTaskStore.setState({
      sideTasksByParentTaskId: { [parentTaskId]: [sideTask] },
    })

    useProductSideTaskStore.getState().openSideTaskPanel(parentTaskId, sideTask.id)

    expect(useProductSideTaskStore.getState().panelByParentTaskId[parentTaskId]).toEqual({
      isOpen: true,
      selectedSideTaskId: sideTask.id,
    })
  })
})
