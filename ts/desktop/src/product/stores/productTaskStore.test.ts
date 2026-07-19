import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { productTasksApi } from '../api/tasks'
import type { ProductTaskIndexResponse, ProductTaskRecord } from '../domain/types'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from './productTaskStore'

vi.mock('../api/tasks', () => ({
  productTasksApi: {
    list: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    archive: vi.fn(),
    restore: vi.fn(),
    continue: vi.fn(),
  },
}))

function makeTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-1',
    workDir: '/workspace/billiard',
    title: '修复开球规则',
    lifecycle: 'active',
    kind: 'main',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    worktreeState: 'planned',
    actions: ['rename', 'archive', 'continue'],
    ...overrides,
  }
}

function makeIndex(task = makeTask()): ProductTaskIndexResponse {
  return {
    schemaVersion: 1,
    projects: [{
      id: 'project-1',
      title: 'BilliardBuddy',
      workDir: '/workspace/billiard',
      taskCount: 1,
      archivedTaskCount: 0,
      updatedAt: '2026-07-18T00:00:00.000Z',
    }],
    tasks: [task],
    total: 1,
    capabilities: { createTask: true },
  }
}

function resetStore() {
  useProductTaskStore.setState({
    index: EMPTY_PRODUCT_TASK_INDEX,
    isLoading: false,
    error: null,
    mutations: {},
  })
}

describe('productTaskStore', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
  })

  afterEach(() => {
    resetStore()
  })

  it('refreshes only from the product task index endpoint', async () => {
    const index = makeIndex()
    vi.mocked(productTasksApi.list).mockResolvedValue(index)

    await useProductTaskStore.getState().refresh()

    expect(productTasksApi.list).toHaveBeenCalledOnce()
    expect(useProductTaskStore.getState()).toMatchObject({
      index,
      isLoading: false,
      error: null,
    })
  })

  it('reconciles lifecycle mutations with the server task returned by the endpoint', async () => {
    const original = makeTask()
    const archived = makeTask({
      lifecycle: 'archived',
      archivedAt: '2026-07-18T01:00:00.000Z',
      actions: ['restore'],
    })
    useProductTaskStore.setState({ index: makeIndex(original) })
    vi.mocked(productTasksApi.archive).mockResolvedValue({ task: archived })

    await useProductTaskStore.getState().archiveTask(original.id)

    expect(productTasksApi.archive).toHaveBeenCalledWith('task-1')
    expect(useProductTaskStore.getState().index.tasks).toEqual([archived])
    expect(useProductTaskStore.getState().mutations['task-1:archive']).toBe(false)
  })

  it('adds a returned continuation as a separate product task', async () => {
    const original = makeTask()
    const continuation = makeTask({
      id: 'task-2',
      title: '继续修复开球规则',
      kind: 'continuation',
      parentTaskId: original.id,
    })
    useProductTaskStore.setState({ index: makeIndex(original) })
    vi.mocked(productTasksApi.continue).mockResolvedValue({ task: continuation })

    await useProductTaskStore.getState().continueTask(original.id, {})

    expect(productTasksApi.continue).toHaveBeenCalledWith('task-1', {})
    expect(useProductTaskStore.getState().index.tasks).toEqual([continuation, original])
    expect(useProductTaskStore.getState().index.total).toBe(2)
  })
})
