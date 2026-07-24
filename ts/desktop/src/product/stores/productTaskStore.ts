import { create } from 'zustand'
import { ProductApiError, productApiUserFacingError } from '../api/client'
import { productAtomicTaskSubmitApi, productTasksApi } from '../api/tasks'
import { PRODUCT_DOMAIN_VERSION } from '../domain/types'
import { orderProductProjects, orderProductTasks } from '../taskOrdering'
import type {
  AuthoritySnapshot,
  ContinueProductTaskInput,
  CreateProductTaskInput,
  MutationEnvelope,
  ProductTaskActionResponse,
  ProductTaskDeletionPhase,
  ProductTaskIndexResponse,
  ProductTaskPermissionMode,
  ProductTaskRecord,
  UpdateProductTaskInput,
} from '../domain/types'

export const EMPTY_PRODUCT_TASK_INDEX: ProductTaskIndexResponse = {
  schemaVersion: PRODUCT_DOMAIN_VERSION,
  projects: [],
  directories: [],
  tasks: [],
  total: 0,
  capabilities: { createTask: false },
}

export function productTaskMutationKey(taskId: string, action: string): string {
  return `${taskId}:${action}`
}

type PendingMutation = MutationEnvelope<Record<string, unknown>>

type ProductTaskStore = {
  index: ProductTaskIndexResponse
  isLoading: boolean
  error: string | null
  mutations: Record<string, boolean | undefined>
  /** Last authority revision confirmed by a durable receipt, never a local request counter. */
  confirmedAuthorityRevision: number
  /** Durable-operation envelopes retained after unknown transport outcomes. */
  pending: Record<string, PendingMutation | undefined>

  refresh: () => Promise<void>
  clearError: () => void
  applyRuntimeTaskTitle: (taskId: string, title: string) => void
  createTask: (input: CreateProductTaskInput) => Promise<ProductTaskRecord>
  submitNewTask: (input: { text: string; attachment_ids: string[]; permission_mode: ProductTaskPermissionMode }) => Promise<ProductTaskRecord>
  renameTask: (taskId: string, title: string) => Promise<ProductTaskRecord>
  pinTask: (taskId: string) => Promise<ProductTaskRecord>
  unpinTask: (taskId: string) => Promise<ProductTaskRecord>
  archiveTask: (taskId: string) => Promise<ProductTaskRecord>
  restoreTask: (taskId: string) => Promise<ProductTaskRecord>
  recoverTaskRun: (taskId: string) => Promise<ProductTaskRecord>
  mutateTaskDeletion: (taskId: string, phase: ProductTaskDeletionPhase) => Promise<ProductTaskRecord>
  continueTask: (taskId: string, input: ContinueProductTaskInput) => Promise<ProductTaskRecord>
}

function errorMessage(error: unknown, fallback: string): string {
  return productApiUserFacingError(error, fallback)
}

function timestamp(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function reconcileProjectSummaries(index: ProductTaskIndexResponse, tasks: readonly ProductTaskRecord[]): ProductTaskIndexResponse['projects'] {
  return index.projects.map((project) => {
    const projectTasks = tasks.filter((task) => task.projectId === project.id)
    let updatedAt = project.updatedAt
    let updatedTimestamp = timestamp(updatedAt)
    let taskCount = 0
    let archivedTaskCount = 0
    for (const task of projectTasks) {
      if (task.lifecycle === 'archived') archivedTaskCount += 1
      else taskCount += 1
      const taskTimestamp = timestamp(task.updatedAt)
      if (taskTimestamp > updatedTimestamp) {
        updatedAt = task.updatedAt
        updatedTimestamp = taskTimestamp
      }
    }
    return { ...project, taskCount, archivedTaskCount, updatedAt }
  })
}

function upsertTask(index: ProductTaskIndexResponse, task: ProductTaskRecord): ProductTaskIndexResponse {
  const exists = index.tasks.some((current) => current.id === task.id)
  const tasks = orderProductTasks(exists
    ? index.tasks.map((current) => current.id === task.id ? task : current)
    : [task, ...index.tasks])
  const projects = reconcileProjectSummaries(index, tasks)
  return { ...index, projects: orderProductProjects(projects, tasks), tasks, total: tasks.length }
}

/** Authority is not a full index projection. Keep renderer-owned actions, links and catalog bindings. */
export function mergeAuthority(index: ProductTaskIndexResponse, authority: AuthoritySnapshot): ProductTaskIndexResponse {
  const byId = new Map(authority.tasks.map((task) => [task.id, task]))
  const tasks = index.tasks.map((current) => {
    const incoming = byId.get(current.id)
    if (!incoming) return current
    const required = ['id', 'projectId', 'directoryId', 'workDir', 'title', 'lifecycle', 'kind', 'createdAt', 'updatedAt', 'worktreeState'] as const
    if (required.some((key) => incoming[key] === undefined || incoming[key] === null)) throw new Error('Incomplete authority task projection')
    // Authority owns every ProductTask domain field. Renderer-only view fields
    // remain intentionally outside the persisted authority schema.
    return { ...current, id: incoming.id, projectId: incoming.projectId, directoryId: incoming.directoryId, workDir: incoming.workDir, title: incoming.title, lifecycle: incoming.lifecycle, kind: incoming.kind, pinnedAt: incoming.pinnedAt, archivedAt: incoming.archivedAt, parentTaskId: incoming.parentTaskId, createdAt: incoming.createdAt, updatedAt: incoming.updatedAt, worktreeState: incoming.worktreeState }
  })
  return { ...index, tasks: orderProductTasks(tasks), projects: orderProductProjects(reconcileProjectSummaries(index, tasks), tasks) }
}

function makeOperationId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `operation-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function createEnvelope<T extends object>(input: T, expected_revision: number): MutationEnvelope<T> {
  return Object.freeze({ ...input, expected_revision, client_operation_id: makeOperationId() })
}

let latestRefreshRequest = 0
let taskIndexRequestSequence = 0

export const useProductTaskStore = create<ProductTaskStore>((set, get) => {
  const runMutation = async (
    intentKey: string,
    input: Record<string, unknown>,
    action: (envelope: PendingMutation) => Promise<ProductTaskActionResponse>,
    expectedRevision = get().confirmedAuthorityRevision,
  ): Promise<ProductTaskRecord> => {
    const existing = get().pending[intentKey]
    const envelope = existing ?? createEnvelope(input, expectedRevision)
    set((state) => ({
      error: null,
      pending: { ...state.pending, [intentKey]: envelope },
      mutations: { ...state.mutations, [intentKey]: true },
    }))

    try {
      const response = await action(envelope)
      if (!response.receipt) throw new Error('Missing durable operation receipt')
      let task: ProductTaskRecord | undefined
      set((state) => {
        if (response.authority.revision < state.confirmedAuthorityRevision) {
          task = state.index.tasks.find((current) => current.id === (response.task?.id ?? input.taskId))
          const pending = { ...state.pending }
          delete pending[intentKey]
          return {
            mutations: { ...state.mutations, [intentKey]: false },
            pending,
          }
        }
        let index = mergeAuthority(state.index, response.authority)
        const returned = response.task
        if (returned && !index.tasks.some((current) => current.id === returned.id)) {
          task = { ...returned, actions: returned.actions ?? [] }
          index = upsertTask(index, task)
        }
        task ??= index.tasks.find((current) => current.id === (response.task?.id ?? ''))
          ?? index.tasks.find((current) => current.id === input.taskId)
        const pending = { ...state.pending }
        delete pending[intentKey]
        taskIndexRequestSequence += 1
        return {
          index,
          isLoading: false,
          confirmedAuthorityRevision: response.authority.revision,
          pending,
          mutations: { ...state.mutations, [intentKey]: false },
        }
      })
      if (!task) throw new Error('Authority receipt did not identify a task projection')
      return task
    } catch (error) {
      const knownTerminal = error instanceof ProductApiError
      set((state) => {
        const pending = { ...state.pending }
        if (knownTerminal) delete pending[intentKey]
        return {
          error: errorMessage(error, '暂时无法完成任务操作，请稍后重试。'),
          pending,
          mutations: { ...state.mutations, [intentKey]: false },
        }
      })
      throw error
    }
  }

  return {
    index: EMPTY_PRODUCT_TASK_INDEX,
    // The empty projection is not a capability snapshot until the first list
    // request settles.
    isLoading: true,
    error: null,
    mutations: {},
    confirmedAuthorityRevision: 0,
    pending: {},

    refresh: async () => {
      const requestId = ++latestRefreshRequest
      const sequenceAtRequestStart = taskIndexRequestSequence
      set({ isLoading: true, error: null })
      try {
        const index = await productTasksApi.list()
        if (requestId === latestRefreshRequest && sequenceAtRequestStart === taskIndexRequestSequence) {
          set({ index, isLoading: false })
        }
      } catch (error) {
        if (requestId === latestRefreshRequest && sequenceAtRequestStart === taskIndexRequestSequence) {
          set({ error: errorMessage(error, '暂时无法读取任务，请稍后重试。'), isLoading: false })
        }
      }
    },

    clearError: () => set({ error: null }),

    applyRuntimeTaskTitle: (taskId, title) => {
      const normalizedTaskId = taskId.trim()
      const normalizedTitle = title.trim()
      if (!normalizedTaskId || !normalizedTitle) return
      set((state) => {
        const current = state.index.tasks.find((task) => task.id === normalizedTaskId)
        if (!current || current.title === normalizedTitle) return state
        taskIndexRequestSequence += 1
        return {
          index: { ...state.index, tasks: state.index.tasks.map((task) => task.id === normalizedTaskId ? { ...task, title: normalizedTitle } : task) },
          isLoading: false,
        }
      })
    },

    createTask: async (input) => {
      const task = await runMutation('create', input, (envelope) => productTasksApi.create(envelope as MutationEnvelope<CreateProductTaskInput>))
      await get().refresh()
      return task
    },
    submitNewTask: async (input) => {
      const intentKey = 'create'
      const text = input.text.trim()
      if (!text) throw new Error('Task text is required')
      const operationId = makeOperationId()
      set((state) => ({ error: null, mutations: { ...state.mutations, [intentKey]: true } }))
      try {
        const draft = await productAtomicTaskSubmitApi.createDraft(`${operationId}-draft`)
        const submitted = await productAtomicTaskSubmitApi.submit({
          draft_id: draft.draft.draft_id,
          expected_draft_revision: draft.draft.revision,
          client_operation_id: operationId,
          text,
          attachment_ids: input.attachment_ids,
          permission_mode: input.permission_mode,
        })
        const taskId = submitted.receipt.result?.task_id
        if (!taskId || !['accepted', 'duplicate'].includes(submitted.receipt.outcome)) throw new Error('Atomic task submit was not accepted')
        const index = await productTasksApi.list()
        const task = index.tasks.find((current) => current.id === taskId)
        if (!task) throw new Error('Accepted task projection is unavailable')
        taskIndexRequestSequence += 1
        set((state) => ({
          index,
          isLoading: false,
          confirmedAuthorityRevision: Math.max(state.confirmedAuthorityRevision, submitted.receipt.authority_revision),
          mutations: { ...state.mutations, [intentKey]: false },
        }))
        return task
      } catch (error) {
        set((state) => ({
          error: errorMessage(error, '暂时无法提交任务，请稍后重试。'),
          mutations: { ...state.mutations, [intentKey]: false },
        }))
        throw error
      }
    },
    renameTask: (taskId, title) => runMutation(productTaskMutationKey(taskId, 'rename'), { taskId, title }, (envelope) =>
      productTasksApi.update(taskId, envelope as MutationEnvelope<UpdateProductTaskInput>)),
    pinTask: (taskId) => runMutation(productTaskMutationKey(taskId, 'pin'), { taskId }, (envelope) => productTasksApi.pin(taskId, envelope)),
    unpinTask: (taskId) => runMutation(productTaskMutationKey(taskId, 'unpin'), { taskId }, (envelope) => productTasksApi.unpin(taskId, envelope)),
    archiveTask: (taskId) => runMutation(productTaskMutationKey(taskId, 'archive'), { taskId }, (envelope) => productTasksApi.archive(taskId, envelope)),
    restoreTask: (taskId) => runMutation(productTaskMutationKey(taskId, 'restore'), { taskId }, (envelope) => productTasksApi.restore(taskId, envelope)),
    recoverTaskRun: async (taskId) => {
      const taskRevision = get().index.tasks.find(task => task.id === taskId)?.revision
      if (taskRevision === undefined) throw new Error('Task revision is unavailable')
      const task = await runMutation(productTaskMutationKey(taskId, 'recover'), { taskId }, (envelope) => productTasksApi.recover(taskId, envelope), taskRevision)
      await get().refresh()
      return task
    },
    mutateTaskDeletion: async (taskId, phase) => {
      const current = get().index.tasks.find((task) => task.id === taskId)
      if (!current) throw new Error('任务不存在或已删除')
      const intentKey = productTaskMutationKey(taskId, `delete-${phase}`)
      const existing = get().pending[intentKey]
      const envelope = existing ?? createEnvelope({ phase }, current.revision ?? 0)
      set((state) => ({ error: null, pending: { ...state.pending, [intentKey]: envelope }, mutations: { ...state.mutations, [intentKey]: true } }))
      try {
        const response = await productTasksApi.delete(taskId, envelope as { phase: ProductTaskDeletionPhase; expected_revision: number; client_operation_id: string })
        if (response.receipt.outcome === 'conflict' || response.receipt.outcome === 'rejected') throw new Error('任务删除当前不可继续')
        const index = await productTasksApi.list()
        taskIndexRequestSequence += 1
        set((state) => {
          const pending = { ...state.pending }
          delete pending[intentKey]
          return { index, isLoading: false, pending, mutations: { ...state.mutations, [intentKey]: false } }
        })
        return response.task
      } catch (error) {
        const knownTerminal = error instanceof ProductApiError
        set((state) => {
          const pending = { ...state.pending }
          if (knownTerminal) delete pending[intentKey]
          return { error: errorMessage(error, '暂时无法完成任务删除，请稍后重试。'), pending, mutations: { ...state.mutations, [intentKey]: false } }
        })
        throw error
      }
    },
    continueTask: async (taskId, input) => {
      const taskRevision = get().index.tasks.find(task => task.id === taskId)?.revision
      if (taskRevision === undefined) throw new Error('Task revision is unavailable')
      const task = await runMutation(productTaskMutationKey(taskId, 'continue'), { taskId, ...input }, (envelope) =>
        productTasksApi.continue(taskId, envelope as MutationEnvelope<ContinueProductTaskInput>), taskRevision)
      await get().refresh()
      return task
    },
  }
})
