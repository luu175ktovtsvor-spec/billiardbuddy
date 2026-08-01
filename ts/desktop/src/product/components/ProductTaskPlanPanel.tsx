import type { ProductTaskPlan } from '../domain/types'

const STATUS_LABEL: Record<ProductTaskPlan['steps'][number]['status'], string> = {
  pending: '待处理',
  in_progress: '进行中',
  completed: '已完成',
}

const STATUS_ICON: Record<ProductTaskPlan['steps'][number]['status'], string> = {
  pending: 'radio_button_unchecked',
  in_progress: 'progress_activity',
  completed: 'check_circle',
}

/** The plan is a durable worker projection, not a renderer-local checklist. */
export function ProductTaskPlanPanel({ plan }: { plan: ProductTaskPlan }) {
  const completed = plan.steps.filter(step => step.status === 'completed').length
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" aria-label="任务计划">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)]">
          <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-[var(--color-primary)]">checklist</span>
          任务计划
        </span>
        <span className="text-xs tabular-nums text-[var(--color-text-tertiary)]">{completed}/{plan.steps.length}</span>
      </header>
      <ol className="px-4 py-2" aria-label="当前计划步骤">
        {plan.steps.map((step, index) => (
          <li key={`${plan.id}:${index}`} className="flex items-start gap-2 py-2 text-sm">
            <span aria-hidden="true" className={`material-symbols-outlined mt-0.5 text-[18px] ${step.status === 'completed' ? 'text-emerald-500' : step.status === 'in_progress' ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-tertiary)]'}`}>{STATUS_ICON[step.status]}</span>
            <span className={`min-w-0 flex-1 break-words ${step.status === 'completed' ? 'text-[var(--color-text-secondary)] line-through' : 'text-[var(--color-text-primary)]'}`}>{step.content}</span>
            <span className="shrink-0 text-xs text-[var(--color-text-tertiary)]">{STATUS_LABEL[step.status]}</span>
          </li>
        ))}
      </ol>
    </section>
  )
}
