import { useMemo, useState } from 'react'
import type {
  ProductTaskActivityKind,
  ProductTaskActivityPhase,
  ProductTaskActivityProgress,
} from '../domain/types'

export type ProductTaskRunActivityView = {
  id: string
  parentId?: string
  kind: ProductTaskActivityKind
  phase: ProductTaskActivityPhase
  summary?: string
  progress?: ProductTaskActivityProgress
}

const ACTIVE_ACTIVITY_LABEL: Record<ProductTaskActivityKind, string> = {
  workspace: '正在处理文件',
  command: '正在执行命令',
  research: '正在检索资料',
  browser: '正在处理浏览器内容',
  media: '正在处理媒体内容',
  subtask: '正在协调子任务',
  tool: '正在处理任务步骤',
}

const COMPLETED_ACTIVITY_LABEL: Record<ProductTaskActivityKind, string> = {
  workspace: '文件处理完成',
  command: '命令执行完成',
  research: '资料检索完成',
  browser: '浏览器步骤完成',
  media: '媒体处理完成',
  subtask: '子任务已完成',
  tool: '任务步骤完成',
}

const FAILED_ACTIVITY_LABEL: Record<ProductTaskActivityKind, string> = {
  workspace: '文件处理未完成',
  command: '命令未完成',
  research: '资料检索未完成',
  browser: '浏览器步骤未完成',
  media: '媒体处理未完成',
  subtask: '子任务未完成',
  tool: '任务步骤未完成',
}

// The socket parser permits only this finite, product-authored vocabulary. The
// component repeats the check so manually constructed state can never render
// a Core message as an activity label.
const PRODUCT_ACTIVITY_SUMMARIES = new Set([
  '正在整理任务计划',
  '已整理任务计划',
  '任务计划整理未完成',
  '正在整理工作内容',
  '已整理工作内容',
  '工作内容整理未完成',
  '正在处理任务操作',
  '已完成任务操作',
  '任务操作未完成',
  '正在查询资料',
  '已完成资料查询',
  '资料查询未完成',
  '正在查看网页',
  '已完成网页查看',
  '网页查看未完成',
  '正在处理素材',
  '已完成素材处理',
  '素材处理未完成',
  '正在协同处理事项',
  '已完成协同事项',
  '协同事项未完成',
  '正在处理任务',
  '已完成任务处理',
  '任务处理未完成',
])

export function productTaskActivityLabel(
  kind: ProductTaskActivityKind,
  phase: ProductTaskActivityPhase,
): string {
  if (phase === 'completed') return COMPLETED_ACTIVITY_LABEL[kind]
  if (phase === 'failed') return FAILED_ACTIVITY_LABEL[kind]
  return ACTIVE_ACTIVITY_LABEL[kind]
}

export function productTaskActivityDisplayLabel(
  kind: ProductTaskActivityKind,
  phase: ProductTaskActivityPhase,
  summary?: string,
): string {
  return summary && PRODUCT_ACTIVITY_SUMMARIES.has(summary)
    ? summary
    : productTaskActivityLabel(kind, phase)
}

function productTaskActivitySummary(activity: ProductTaskRunActivityView): string {
  return productTaskActivityDisplayLabel(activity.kind, activity.phase, activity.summary)
}

export type ProductTaskRunActivityRow = ProductTaskRunActivityView & {
  depth: number
}

/**
 * Keep the server's update order, but render children beneath their parent
 * whenever both opaque IDs are available. Cycles and orphaned parent IDs are
 * intentionally rendered at the root instead of making the panel disappear.
 */
export function productTaskRunActivityRows(
  activities: readonly ProductTaskRunActivityView[],
): ProductTaskRunActivityRow[] {
  const byId = new Map(activities.map((activity) => [activity.id, activity]))
  const children = new Map<string, ProductTaskRunActivityView[]>()
  const roots: ProductTaskRunActivityView[] = []

  for (const activity of activities) {
    if (activity.parentId && activity.parentId !== activity.id && byId.has(activity.parentId)) {
      const siblings = children.get(activity.parentId) ?? []
      siblings.push(activity)
      children.set(activity.parentId, siblings)
    } else {
      roots.push(activity)
    }
  }

  const rows: ProductTaskRunActivityRow[] = []
  const visited = new Set<string>()
  const append = (activity: ProductTaskRunActivityView, depth: number, ancestors: ReadonlySet<string>) => {
    if (visited.has(activity.id) || ancestors.has(activity.id)) return
    visited.add(activity.id)
    rows.push({ ...activity, depth })
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(activity.id)
    for (const child of children.get(activity.id) ?? []) {
      append(child, Math.min(depth + 1, 6), nextAncestors)
    }
  }

  for (const activity of roots) append(activity, 0, new Set())
  for (const activity of activities) append(activity, 0, new Set())
  return rows
}

function phaseDotClass(phase: ProductTaskActivityPhase): string {
  if (phase === 'failed') return 'bg-[var(--color-error)]'
  if (phase === 'completed') return 'bg-emerald-500'
  return 'bg-[var(--color-primary)]'
}

export function ProductTaskRunPanel({
  activities,
}: {
  activities: readonly ProductTaskRunActivityView[]
}) {
  const [isOpen, setIsOpen] = useState(false)
  const rows = useMemo(() => productTaskRunActivityRows(activities), [activities])
  if (rows.length === 0) return null

  const activeCount = rows.filter((activity) => (
    activity.phase === 'started' || activity.phase === 'running'
  )).length

  return (
    <section
      className="mx-auto mb-5 w-full max-w-4xl overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
      data-testid="product-task-run-panel"
    >
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((current) => !current)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left hover:bg-[var(--color-surface-hover)]"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-[var(--color-text-secondary)]">account_tree</span>
          <span className="text-sm font-medium text-[var(--color-text-primary)]">运行活动</span>
          <span className="truncate text-xs text-[var(--color-text-tertiary)]">
            {activeCount > 0 ? `${activeCount} 项进行中` : `${rows.length} 个步骤`}
          </span>
        </span>
        <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">
          {isOpen ? 'expand_less' : 'expand_more'}
        </span>
      </button>

      {isOpen ? (
        <ol className="border-t border-[var(--color-border)] px-3.5 py-2.5" aria-label="任务运行活动">
          {rows.map((activity) => (
            <li
              key={activity.id}
              className="flex min-w-0 items-center gap-2 py-1.5 text-sm"
              style={{ paddingInlineStart: `${activity.depth * 16}px` }}
            >
              <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${phaseDotClass(activity.phase)}`} />
              <span className="min-w-0 flex-1 truncate text-[var(--color-text-secondary)]">
                {productTaskActivitySummary(activity)}
              </span>
              {activity.progress ? (
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-text-tertiary)]">
                  {activity.progress.completed}/{activity.progress.total}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  )
}
