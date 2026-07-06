import type { Tool } from './Tool'
import { formatTodoChecklist, normalizeTodos } from '../types/todo'

/** 任务清单工具:写/更新 ctx.todos。read_only=false 但不审批(本机可逆的进度记录,Delta A 直接做)。 */
export const todoWriteTool: Tool<{ todos: unknown }> = {
  name: 'todo_write',
  description:
    '写或更新任务清单来跟踪多步任务的进度。入参 { todos },每项 { task, status },status ∈ pending|in_progress|done;也接受纯字符串数组(全按 pending)。做多步任务时随时更新它,让老板看得见进度。',
  inputSchema: {
    type: 'object',
    properties: { todos: { type: 'array', description: '任务项数组' } },
    required: ['todos'],
  },
  isReadOnly: false,
  async execute(input, ctx) {
    const todos = normalizeTodos(input?.todos)
    ctx.todos = todos
    return formatTodoChecklist(todos)
  },
}
