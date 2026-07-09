export type TodoStatus = 'pending' | 'in_progress' | 'done'
export interface TodoItem {
  task: string
  status: TodoStatus
  activeForm?: string
}

const TODO_MARK: Record<TodoStatus, string> = { pending: '☐', in_progress: '◐', done: '☑' }

/**
 * 入参别名归一:模型常按 Claude Code / cc-haha 惯用枚举上报
 * ('pending'|'in_progress'|'completed'),而本内核用 'done'。这里把 cc 风格及
 * 常见别名映射到内核枚举 —— 关键:'completed' 必须变 'done'(已完成),不能被静默退回 pending。
 * 非法值返回 undefined,由调用方退回 'pending'。
 */
const STATUS_ALIAS: Record<string, TodoStatus> = {
  pending: 'pending',
  in_progress: 'in_progress',
  'in-progress': 'in_progress',
  inprogress: 'in_progress',
  done: 'done',
  completed: 'done',
  complete: 'done',
  finished: 'done',
}

function normalizeStatus(raw: unknown): TodoStatus | undefined {
  if (typeof raw !== 'string') return undefined
  return STATUS_ALIAS[raw.trim().toLowerCase()]
}

/** 渲染成大白话清单(照 Python format_todo_checklist)。 */
export function formatTodoChecklist(todos: TodoItem[]): string {
  const done = todos.filter(t => t.status === 'done').length
  const lines = todos.map(t => `${TODO_MARK[t.status]} ${displayTodoTask(t)}`).join('\n')
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
      const status = normalizeStatus(o.status) ?? 'pending'
      const activeForm = typeof o.activeForm === 'string'
        ? o.activeForm.trim()
        : typeof o.active_form === 'string'
          ? o.active_form.trim()
          : ''
      out.push({ task: task.trim(), status, ...(activeForm ? { activeForm } : {}) })
    }
  }
  return enforceSingleInProgress(out)
}

/** 解析 markdown 勾选清单(task_progress 内联参数用);未勾选的第一项会作为 in_progress。永不抛。 */
export function parseProgressMarkdown(md: string): TodoItem[] {
  if (typeof md !== 'string') return []
  const out: TodoItem[] = []
  for (const line of md.split('\n')) {
    const m = line.match(/^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/)
    if (m) out.push({ task: m[2]!, status: m[1]!.toLowerCase() === 'x' ? 'done' : 'pending' })
  }
  return enforceSingleInProgress(out)
}

function enforceSingleInProgress(todos: TodoItem[]): TodoItem[] {
  let seenInProgress = false
  const normalized = todos.map(item => {
    if (item.status !== 'in_progress') return item
    if (!seenInProgress) {
      seenInProgress = true
      return item
    }
    return { ...item, status: 'pending' as const }
  })
  if (!seenInProgress) {
    const next = normalized.findIndex(item => item.status === 'pending')
    if (next >= 0) normalized[next] = { ...normalized[next]!, status: 'in_progress' }
  }
  return normalized
}

function displayTodoTask(item: TodoItem): string {
  if (item.status === 'in_progress' && item.activeForm) return item.activeForm
  return item.task
}
