// 对齐 cc-haha-ref desktop/src/components/chat/SessionTaskBar.tsx:1-159 —— sticky 常驻、折叠头
// 进度条+完成数、展开逐项(状态图标 + 编号 + 标题,进行中项带呼吸点)。数据源换成我们 chatStore.todos
// (从后端 todo_update 的大白话清单文本解析而来,见 stores/chatStore.ts parseTodoChecklist);
// cc 的 pending/in_progress/completed 三态对齐我们 TodoItem 的 pending/in_progress/done。
import { useChatStore } from '../../stores/chatStore'
import { IconChecklist, IconChevronDown, IconX } from '../shared/icons'
import { t } from '../../i18n'

export function SessionTaskBar() {
  const todos = useChatStore((s) => s.todos)
  const expanded = useChatStore((s) => s.todoBarExpanded)
  const toggle = useChatStore((s) => s.toggleTodoBar)
  const dismiss = useChatStore((s) => s.dismissTodos)

  if (todos.length === 0) return null

  const done = todos.filter((td) => td.status === 'done').length
  const total = todos.length
  const allDone = done === total
  const progressPercent = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <div className="sticky top-0 z-10 mb-2" data-block="todo-bar">
      <div
        className="overflow-hidden rounded-lg"
        style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-lowest)', boxShadow: 'var(--shadow-popover)' }}
      >
        <div className="flex items-center gap-2 px-2 py-1.5" style={{ background: 'var(--color-surface-container)' }}>
          <button type="button" onClick={toggle} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)]">
            <IconChecklist size={13} style={{ color: 'var(--color-text-secondary)' }} />
            <span className="shrink-0 text-[11px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>{t('tasks.title')}</span>
            <span className="h-1.5 max-w-[160px] flex-1 overflow-hidden rounded-full" style={{ background: 'var(--color-border)' }}>
              <span
                className="block h-full rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%`, background: allDone ? 'var(--color-success)' : 'var(--color-brand)' }}
              />
            </span>
            <span className="shrink-0 text-[10px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>{done}/{total}</span>
            <IconChevronDown size={13} style={{ color: 'var(--color-text-tertiary)', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .2s ease' }} />
          </button>
          {allDone && (
            <button
              type="button"
              aria-label={t('tasks.dismissCompleted')}
              onClick={dismiss}
              className="shrink-0 rounded-md p-1 transition-colors hover:bg-[var(--color-surface-hover)]"
              style={{ color: 'var(--color-text-tertiary)' }}
            >
              <IconX size={13} />
            </button>
          )}
        </div>

        {expanded && (
          <div className="flex max-h-[220px] flex-col gap-0.5 overflow-y-auto px-3 pb-2 pt-1">
            {todos.map((todo, i) => (
              <div key={`${i}-${todo.task}`} className="flex items-start gap-2 rounded-md px-1 py-1">
                <StatusDot status={todo.status} />
                <div className="min-w-0 flex-1">
                  <span
                    className="text-[12px]"
                    style={{
                      color: todo.status === 'done' ? 'var(--color-text-tertiary)' : 'var(--color-text-primary)',
                      textDecoration: todo.status === 'done' ? 'line-through' : undefined,
                    }}
                  >
                    {todo.task}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function StatusDot({ status }: { status: 'pending' | 'in_progress' | 'done' }) {
  if (status === 'done') {
    return <span className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: 'var(--color-success)' }} />
  }
  if (status === 'in_progress') {
    return <span className="qf-pulse-dot mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: 'var(--color-warning)' }} />
  }
  return <span className="mt-[3px] h-2.5 w-2.5 shrink-0 rounded-full" style={{ border: '1.5px solid var(--color-text-tertiary)' }} />
}
