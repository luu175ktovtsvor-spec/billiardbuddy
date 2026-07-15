// Codex todo-list 是对话流中的紧凑摘要，不是 sticky 状态卡。默认折叠，展开后显示编号清单。
import { useChatStore } from '../../stores/chatStore'
import { IconCheckCircle, IconChevronDown } from '../shared/icons'

export function todoSummary(todos: Array<{ status: 'pending' | 'in_progress' | 'done' }>): string {
  const done = todos.filter((todo) => todo.status === 'done').length
  return done === 0
    ? `已创建包含 ${todos.length} 个任务的待办事项清单`
    : `已完成 ${done} 个任务，共 ${todos.length} 个`
}

export function SessionTaskBar() {
  const todos = useChatStore((s) => s.todos)
  const expanded = useChatStore((s) => s.todoBarExpanded)
  const toggle = useChatStore((s) => s.toggleTodoBar)
  const dismiss = useChatStore((s) => s.dismissTodos)

  if (todos.length === 0) return null

  const done = todos.filter((td) => td.status === 'done').length
  const total = todos.length
  const summary = todoSummary(todos)

  return (
    <div className="min-w-0 py-0 text-[13px]" data-block="todo-bar">
      <button type="button" onClick={toggle} className="group flex min-w-0 w-full cursor-pointer items-center justify-between text-left">
        <span className="min-w-0 truncate" style={{ color: 'var(--color-text-tertiary)' }}>{summary}</span>
        <IconChevronDown
          size={13}
          className={`shrink-0 transition-[opacity,transform] duration-150 ${expanded ? 'rotate-180 opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
          style={{ color: 'var(--color-text-tertiary)' }}
        />
      </button>

      {expanded && (
        <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
          {todos.map((todo, i) => (
            <div key={`${i}-${todo.task}`} className="flex items-center gap-2">
              <StatusDot status={todo.status} />
              <span className="shrink-0 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{i + 1}.</span>
              <span
                className="text-[13px]"
                style={{
                  color: 'var(--color-text-tertiary)',
                  textDecoration: todo.status === 'done' ? 'line-through' : undefined,
                }}
              >
                {todo.task}
              </span>
            </div>
          ))}
          {done === total && (
            <button type="button" onClick={dismiss} className="mt-1 rounded-md px-1 py-0.5 text-[12px] hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-tertiary)' }}>
              清除已完成清单
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function StatusDot({ status }: { status: 'pending' | 'in_progress' | 'done' }) {
  if (status === 'done') {
    return <IconCheckCircle size={12} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
  }
  return <span className={`h-3 w-3 shrink-0 rounded-full border ${status === 'in_progress' ? 'qf-pulse-dot' : ''}`} style={{ borderColor: 'var(--color-text-tertiary)' }} />
}
