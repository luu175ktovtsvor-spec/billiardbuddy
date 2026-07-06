export type TodoStatus = 'pending' | 'in_progress' | 'done'
export interface TodoItem {
  task: string
  status: TodoStatus
}

const TODO_MARK: Record<TodoStatus, string> = { pending: '☐', in_progress: '◐', done: '☑' }
const VALID_STATUS: readonly TodoStatus[] = ['pending', 'in_progress', 'done']

/** 渲染成大白话清单(照 Python format_todo_checklist)。 */
export function formatTodoChecklist(todos: TodoItem[]): string {
  const done = todos.filter(t => t.status === 'done').length
  const lines = todos.map(t => `${TODO_MARK[t.status]} ${t.task}`).join('\n')
  return `任务清单(共 ${todos.length} 步,已完成 ${done} 步):\n${lines}`
}

/** 归一模型给的 todos:接受 ["a","b"](全 pending)或 [{task|content, status}]。非法项跳过,永不抛。 */
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return []
  const out: TodoItem[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      if (item.trim()) out.push({ task: item.trim(), status: 'pending' })
      continue
    }
    if (item && typeof item === 'object') {
      const o = item as Record<string, unknown>
      const task = typeof o.task === 'string' ? o.task : typeof o.content === 'string' ? o.content : ''
      if (!task.trim()) continue
      const status = VALID_STATUS.includes(o.status as TodoStatus) ? (o.status as TodoStatus) : 'pending'
      out.push({ task: task.trim(), status })
    }
  }
  return out
}

/** 解析 markdown 勾选清单(task_progress 内联参数用);markdown 只能表达勾没勾 → done/pending。永不抛。 */
export function parseProgressMarkdown(md: string): TodoItem[] {
  if (typeof md !== 'string') return []
  const out: TodoItem[] = []
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/)
    if (m) out.push({ task: m[2]!, status: m[1]!.toLowerCase() === 'x' ? 'done' : 'pending' })
  }
  return out
}
