import { formatTodoChecklist, type TodoItem } from '../types/todo'
import type { Tool, ToolContext } from '../tools/Tool'
import { TaskListService } from './taskListService'
import type { StructuredTask, StructuredTaskStatus, TaskListScope } from './taskListService'

interface TaskCreateInput {
  subject?: string
  description?: string
  activeForm?: string
  active_form?: string
  metadata?: Record<string, unknown>
}

interface TaskUpdateInput {
  taskId?: string
  task_id?: string
  subject?: string
  description?: string
  activeForm?: string
  active_form?: string
  status?: StructuredTaskStatus | 'deleted'
  owner?: string
  addBlocks?: string[]
  add_blocks?: string[]
  addBlockedBy?: string[]
  add_blocked_by?: string[]
  metadata?: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function scopeFrom(ctx: ToolContext): TaskListScope {
  return { conversationId: ctx.conversationId, workspaceRoot: ctx.workspace.root }
}

function taskIdFrom(input: unknown): string {
  if (!isRecord(input)) throw new Error('需要 taskId')
  const id = input.taskId ?? input.task_id
  if (typeof id !== 'string' || !id.trim()) throw new Error('需要 string 参数 taskId')
  return id.trim()
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
}

function metadataFrom(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function toTodos(tasks: StructuredTask[]): TodoItem[] {
  return tasks.map(task => ({
    task: task.subject,
    status: task.status === 'completed' ? 'done' : task.status,
    ...(task.activeForm ? { activeForm: task.activeForm } : {}),
  }))
}

function syncContextTodos(ctx: ToolContext, tasks: StructuredTask[]): string {
  ctx.todos = toTodos(tasks)
  return formatTodoChecklist(ctx.todos)
}

function formatTaskLine(task: StructuredTask): string {
  const owner = task.owner ? ` (${task.owner})` : ''
  const blocked = task.blockedBy.length ? ` [blocked by ${task.blockedBy.map(id => `#${id}`).join(', ')}]` : ''
  return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`
}

function formatTaskDetail(task: StructuredTask): string {
  const lines = [
    `Task #${task.id}: ${task.subject}`,
    `Status: ${task.status}`,
    `Description: ${task.description || '(empty)'}`,
  ]
  if (task.activeForm) lines.push(`Active: ${task.activeForm}`)
  if (task.owner) lines.push(`Owner: ${task.owner}`)
  if (task.blockedBy.length) lines.push(`Blocked by: ${task.blockedBy.map(id => `#${id}`).join(', ')}`)
  if (task.blocks.length) lines.push(`Blocks: ${task.blocks.map(id => `#${id}`).join(', ')}`)
  if (task.metadata && Object.keys(task.metadata).length) lines.push(`Metadata: ${JSON.stringify(task.metadata)}`)
  return lines.join('\n')
}

function statusFrom(value: unknown): StructuredTaskStatus | 'deleted' | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
    ? value
    : undefined
}

function ccHahaAlias<T>(tool: Tool<T>, name: string): Tool<T> {
  return {
    ...tool,
    name,
    description: `${tool.description} CC-Haha-compatible alias for ${tool.name}.`,
  }
}

export function createStructuredTaskTools(taskLists: TaskListService): Tool[] {
  const createTask: Tool<TaskCreateInput> = {
    name: 'task_create',
    description: 'Create a structured task in the current conversation task list. Input: { subject, description, activeForm?, metadata? }.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['subject', 'description'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const subject = typeof input?.subject === 'string' ? input.subject : ''
      const description = typeof input?.description === 'string' ? input.description : ''
      const task = await taskLists.create(scopeFrom(ctx), {
        subject,
        description,
        activeForm: typeof input?.activeForm === 'string' ? input.activeForm : typeof input?.active_form === 'string' ? input.active_form : undefined,
        metadata: metadataFrom(input?.metadata),
      })
      const todos = syncContextTodos(ctx, await taskLists.list(scopeFrom(ctx)))
      return `Task #${task.id} created successfully: ${task.subject}\n\n${todos}`
    },
  }

  const listTasks: Tool = {
    name: 'task_list',
    description: 'List structured tasks in the current conversation task list. Input: {}.',
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: true,
    async execute(_input, ctx) {
      const tasks = await taskLists.list(scopeFrom(ctx))
      syncContextTodos(ctx, tasks)
      if (tasks.length === 0) return 'No tasks found'
      return tasks.map(formatTaskLine).join('\n')
    },
  }

  const getTask: Tool = {
    name: 'task_get',
    description: 'Retrieve one structured task by id. Input: { taskId }.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        task_id: { type: 'string' },
      },
    },
    isReadOnly: true,
    async execute(input, ctx) {
      const task = await taskLists.get(scopeFrom(ctx), taskIdFrom(input))
      return task ? formatTaskDetail(task) : 'Task not found'
    },
  }

  const updateTask: Tool<TaskUpdateInput> = {
    name: 'task_update',
    description: 'Update a structured task. Input: { taskId, subject?, description?, activeForm?, status?, addBlocks?, addBlockedBy?, owner?, metadata? }. status can be pending|in_progress|completed|deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        task_id: { type: 'string' },
        subject: { type: 'string' },
        description: { type: 'string' },
        activeForm: { type: 'string' },
        status: { type: 'string' },
        owner: { type: 'string' },
        addBlocks: { type: 'array', items: { type: 'string' } },
        addBlockedBy: { type: 'array', items: { type: 'string' } },
        metadata: { type: 'object' },
      },
      required: ['taskId'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const id = taskIdFrom(input)
      const result = await taskLists.update(scopeFrom(ctx), id, {
        subject: typeof input?.subject === 'string' ? input.subject : undefined,
        description: typeof input?.description === 'string' ? input.description : undefined,
        activeForm: typeof input?.activeForm === 'string' ? input.activeForm : typeof input?.active_form === 'string' ? input.active_form : undefined,
        status: statusFrom(input?.status),
        owner: typeof input?.owner === 'string' ? input.owner : undefined,
        addBlocks: stringArray(input?.addBlocks) ?? stringArray(input?.add_blocks),
        addBlockedBy: stringArray(input?.addBlockedBy) ?? stringArray(input?.add_blocked_by),
        metadata: metadataFrom(input?.metadata),
      })
      if (!result.task) return `Task #${id} not found`
      const tasks = await taskLists.list(scopeFrom(ctx))
      const todos = syncContextTodos(ctx, tasks)
      if (result.deleted) return `Deleted task #${id}\n\n${todos}`
      const fields = result.updatedFields.length ? result.updatedFields.join(', ') : 'no fields'
      return `Updated task #${id}: ${fields}\n\n${formatTaskDetail(result.task)}\n\n${todos}`
    },
  }

  return [
    createTask,
    listTasks,
    getTask,
    updateTask,
    ccHahaAlias(createTask, 'TaskCreate'),
    ccHahaAlias(listTasks, 'TaskList'),
    ccHahaAlias(getTask, 'TaskGet'),
    ccHahaAlias(updateTask, 'TaskUpdate'),
  ]
}
