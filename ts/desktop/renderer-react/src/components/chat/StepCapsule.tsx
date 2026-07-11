// 居中步骤胶囊(照 Codex 02 号截图:「第 1 / 5 步」+ 转圈,悬在内容流与输入框之间)。
// 数据源 = chatStore.todos(计划清单):运行中且有清单时显示「第 <done+1> / <总> 步」;
// 没清单或不在跑就不渲染,不占位。纯展示组件,不碰任何状态机。
import { useChatStore } from '../../stores/chatStore'
import { IconSpinner } from '../shared/icons'

export function StepCapsule() {
  const todos = useChatStore((s) => s.todos)
  const status = useChatStore((s) => s.status)
  if (status !== 'running' || todos.length === 0) return null
  const done = todos.filter((t) => t.status === 'done').length
  const current = Math.min(done + 1, todos.length)
  const active = todos.find((td) => td.status === 'in_progress') ?? todos[current - 1]
  return (
    <div className="pointer-events-none sticky bottom-2 z-10 my-2 flex justify-center">
      <div
        className="pointer-events-auto flex items-center gap-2 rounded-full px-3.5 py-1.5"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
        title={active?.task ?? ''}
      >
        <IconSpinner size={13} style={{ color: 'var(--color-text-tertiary)' }} />
        <span className="text-[12.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>
          第 {current} / {todos.length} 步
        </span>
      </div>
    </div>
  )
}
