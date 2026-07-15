// 已安排页(照 Codex/ChatGPT「Scheduled tasks」:主区一张列表,每行=一个定时任务)。
// 真接后端 /api/v1/scheduled-tasks(拉列表/建/改/删/立即跑)。
import { useEffect, useState } from 'react'
import { ContextMenu } from '../components/shared/Menu'
import { Modal } from '../components/shared/Modal'
import { PageHeader, PrimaryButton, SecondaryButton } from '../components/shared/PageKit'
import { toast } from '../stores/toastStore'
import { IconClock, IconPlus, IconMoreHorizontal, IconEdit, IconTrash, IconZap } from '../components/shared/icons'
import { t } from '../i18n'
import { scheduledApi, toView, tasksFrom, type Freq, type ScheduledFormValues, type TaskView } from '../api/scheduled'
import { workflowsApi, type WorkflowDefinition, type WorkflowRun } from '../api/workflows'

const FREQ_LABEL: Record<Freq, string> = { day: '每天', week: '每周一', month: '每月 1 日' }
export const scheduleText = (f: Freq, time: string) => `${FREQ_LABEL[f]} ${time}`

export function formatNext(next: number | string | null | undefined, freq: Freq, time: string): string {
  if (typeof next === 'number' && next > 0) {
    try {
      const d = new Date(next)
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    } catch { /* 落回文案 */ }
  }
  return freq === 'day' ? `明天 ${time}` : freq === 'week' ? `周一 ${time}` : `下月 1 日 ${time}`
}

/** 频率三选一(照 Codex 分段控件)。 */
function FreqPicker({ value, onChange }: { value: Freq; onChange: (f: Freq) => void }) {
  const opts: { v: Freq; label: string }[] = [
    { v: 'day', label: t('scheduled.freqDay') },
    { v: 'week', label: t('scheduled.freqWeek') },
    { v: 'month', label: t('scheduled.freqMonth') },
  ]
  return (
    <div className="inline-flex w-full rounded-lg p-0.5" style={{ background: 'var(--color-surface-container)' }}>
      {opts.map((o) => {
        const on = o.v === value
        return (
          <button key={o.v} type="button" onClick={() => onChange(o.v)}
            className="flex-1 rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
            style={{ background: on ? 'var(--color-surface)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: on ? 'var(--shadow-control)' : undefined, fontWeight: on ? 600 : 400 }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

type FormValues = ScheduledFormValues

/** 任务类型二选一(样式同 FreqPicker 的分段控件)。 */
function TypePicker({ isWorkflow, onChange }: { isWorkflow: boolean; onChange: (workflow: boolean) => void }) {
  const opts = [
    { v: false, label: t('scheduled.formTypeInstruction') },
    { v: true, label: t('scheduled.formTypeWorkflow') },
  ]
  return (
    <div className="inline-flex w-full rounded-lg p-0.5" style={{ background: 'var(--color-surface-container)' }}>
      {opts.map((o) => {
        const on = o.v === isWorkflow
        return (
          <button key={String(o.v)} type="button" onClick={() => onChange(o.v)}
            className="flex-1 rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
            style={{ background: on ? 'var(--color-surface)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: on ? 'var(--shadow-control)' : undefined, fontWeight: on ? 600 : 400 }}>
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export const RUN_STATUS_LABEL: Record<WorkflowRun['status'], string> = {
  running: t('scheduled.runStatusRunning'),
  completed: t('scheduled.runStatusCompleted'),
  failed: t('scheduled.runStatusFailed'),
  cancelled: t('scheduled.runStatusCancelled'),
}

export function formatRunTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 工作流运行记录(轻列表:名称、时间、状态、步骤进度、失败原因)。 */
export function WorkflowRunList({ runs }: { runs: WorkflowRun[] }) {
  return (
    <div role="list" aria-label={t('scheduled.runsTitle')} className="flex flex-col gap-0.5">
      {runs.map(run => {
        const done = run.steps.filter(step => step.status === 'completed').length
        const statusColor = run.status === 'failed'
          ? 'var(--color-error)'
          : run.status === 'completed' ? 'var(--color-success)' : 'var(--color-text-tertiary)'
        return (
          <div key={run.id} role="listitem" data-testid="workflow-run-row"
            className="flex min-h-[44px] items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-[var(--color-surface-hover)]">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{run.workflowName}</div>
              <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
                <span className="shrink-0">{formatRunTime(run.startedAt)}</span>
                <span aria-hidden>·</span>
                <span className="shrink-0">{done}/{run.steps.length} 步</span>
                {run.error && <><span aria-hidden>·</span><span className="truncate">{run.error}</span></>}
              </div>
            </div>
            <span className="shrink-0 text-[11.5px]" style={{ color: statusColor }}>{RUN_STATUS_LABEL[run.status]}</span>
          </div>
        )
      })}
    </div>
  )
}

export function ScheduledTaskList({ tasks, onToggle, onOpenMenu }: {
  tasks: TaskView[]
  onToggle: (task: TaskView) => void
  onOpenMenu: (task: TaskView, point: { x: number; y: number }) => void
}) {
  return (
    <div role="list" aria-label="已安排任务" className="flex flex-col gap-0.5">
      {tasks.map(task => (
        <div
          key={task.id}
          role="listitem"
          className="group flex min-h-[56px] items-center gap-2 rounded-md px-2 py-2 transition-colors hover:bg-[var(--color-surface-hover)]"
          data-testid="scheduled-task-row"
        >
          <div className="flex w-5 shrink-0 items-center justify-center">
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: task.enabled ? 'var(--color-success)' : 'var(--color-text-tertiary)' }}
              aria-label={task.enabled ? '运行中' : '已暂停'}
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-normal" style={{ color: 'var(--color-text-primary)' }}>{task.title}</div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
              {task.workflowId && (
                <>
                  <span className="shrink-0 rounded px-1 py-px text-[10.5px]" data-testid="workflow-badge"
                    style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }}>
                    {t('scheduled.workflowBadge')}
                  </span>
                  <span aria-hidden>·</span>
                </>
              )}
              <span className="shrink-0">{scheduleText(task.freq, task.time)}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{t('scheduled.nextRun')} {formatNext(task.nextRunAt, task.freq, task.time)}</span>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={task.enabled}
            aria-label={task.enabled ? t('scheduled.pausedToggle') : t('scheduled.enableToggle')}
            onClick={() => onToggle(task)}
            className="relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors"
            style={{ background: task.enabled ? 'var(--color-brand)' : 'var(--color-surface-container-high)' }}
          >
            <span
              className="absolute top-[2px] h-[18px] w-[18px] rounded-full transition-all"
              style={{ left: task.enabled ? '18px' : '2px', background: task.enabled ? 'var(--color-on-primary)' : 'var(--cx-gray-0)', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }}
            />
          </button>
          <button
            type="button"
            aria-label={t('scheduled.edit')}
            title={t('scheduled.edit')}
            onClick={event => onOpenMenu(task, { x: event.clientX, y: event.clientY })}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md opacity-70 transition-colors hover:bg-[var(--color-surface-container)] group-hover:opacity-100 focus:opacity-100"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            <IconMoreHorizontal size={17} />
          </button>
        </div>
      ))}
    </div>
  )
}

/** 新建/编辑表单弹窗。onSave 只回表单值,建/改由页面走后端。 */
function TaskForm({ initial, busy, onCancel, onSave }: { initial: TaskView | null; busy: boolean; onCancel: () => void; onSave: (v: FormValues) => void }) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [freq, setFreq] = useState<Freq>(initial?.freq ?? 'day')
  const [time, setTime] = useState(initial?.time ?? '09:00')
  const [isWorkflow, setIsWorkflow] = useState(!!initial?.workflowId)
  const [workflowId, setWorkflowId] = useState(initial?.workflowId ?? '')
  const [workflows, setWorkflows] = useState<WorkflowDefinition[] | null>(null)

  // 工作流清单按需拉取一次(打开表单即拉,选项立即可用;失败落 [] 显示空态)。
  useEffect(() => {
    let alive = true
    workflowsApi.list()
      .then(list => { if (alive) setWorkflows(list) })
      .catch(() => { if (alive) setWorkflows([]) })
    return () => { alive = false }
  }, [])

  const selected = workflows?.find(w => w.id === workflowId) ?? null
  const canSave = !busy && (isWorkflow ? !!workflowId : title.trim().length > 0)
  const save = () => {
    if (!canSave) return
    if (isWorkflow) onSave({ title: selected?.name ?? workflowId, freq, time, enabled: initial?.enabled ?? true, workflowId })
    else onSave({ title: title.trim(), freq, time, enabled: initial?.enabled ?? true })
  }

  return (
    <Modal open onClose={onCancel} title={initial ? t('scheduled.formEdit') : t('scheduled.formNew')} maxWidth={480} testId="task-form"
      footer={<>
        <SecondaryButton onClick={onCancel}>{t('scheduled.cancel')}</SecondaryButton>
        <PrimaryButton onClick={save}>
          {busy ? '保存中…' : t('scheduled.save')}
        </PrimaryButton>
      </>}>
      <div className="px-5 py-4">
        <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formType')}</label>
        <TypePicker isWorkflow={isWorkflow} onChange={setIsWorkflow} />
        {isWorkflow ? (
          <div className="mt-4">
            <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formWorkflow')}</label>
            {workflows === null ? (
              <p className="text-[12.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{t('scheduled.formWorkflowLoading')}</p>
            ) : workflows.length === 0 ? (
              <p className="text-[12.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{t('scheduled.formWorkflowEmpty')}</p>
            ) : (
              <>
                <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)} data-testid="workflow-select"
                  className="w-full rounded-lg px-3 py-2 text-[13px] outline-none"
                  style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}>
                  <option value="">{t('scheduled.formWorkflow')}</option>
                  {workflows.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
                {selected?.description && (
                  <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{selected.description}</p>
                )}
              </>
            )}
          </div>
        ) : (
          <div className="mt-4">
            <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formContent')}</label>
            <textarea autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('scheduled.formContentPlaceholder')} rows={3}
              className="w-full resize-none rounded-lg px-3 py-2 text-[13px] outline-none"
              style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }} />
          </div>
        )}
        <div className="mt-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formFreq')}</label>
            <FreqPicker value={freq} onChange={setFreq} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formTime')}</label>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className="rounded-lg px-3 py-1.5 text-[13px] outline-none"
              style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }} />
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function ScheduledPage() {
  const [tasks, setTasks] = useState<TaskView[]>([])
  const [runs, setRuns] = useState<WorkflowRun[]>([])
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<TaskView | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  const reload = async () => {
    try {
      setTasks(tasksFrom(await scheduledApi.list()).map(toView))
      setLoadFailed(false)
    } catch {
      setLoadFailed(true)
    } finally {
      setLoaded(true)
    }
    // 运行记录是补充信息:拉不到不影响任务列表。
    try { setRuns((await workflowsApi.listRuns()).slice(0, 10)) } catch { /* 保持上次 */ }
  }
  useEffect(() => { void reload() }, [])

  const save = async (v: FormValues) => {
    setBusy(true)
    try {
      if (editing && editing !== 'new') await scheduledApi.updateForm(editing.id, v)
      else await scheduledApi.create(v)
      setEditing(null)
      await reload()
      toast(editing === 'new' ? '定时任务已建,到点自动跑' : '已更新')
    } catch (e) { toast(e instanceof Error ? e.message : '保存失败') } finally { setBusy(false) }
  }
  const toggle = async (task: TaskView) => {
    setTasks((ts) => ts.map((x) => (x.id === task.id ? { ...x, enabled: !x.enabled } : x))) // 乐观
    try { await scheduledApi.update(task.id, { enabled: !task.enabled }) } catch { void reload() }
  }
  const remove = async (id: string) => {
    setTasks((ts) => ts.filter((x) => x.id !== id))
    try { await scheduledApi.remove(id) } catch { void reload() }
  }
  const runNow = async (id: string) => {
    try { await scheduledApi.runNow(id); toast('已立即开跑一轮(看对话/通知)') } catch { toast('立即运行失败') }
  }
  const menuTask = menu ? tasks.find((x) => x.id === menu.id) ?? null : null

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="scheduled-page">
      <div className="mx-auto w-full max-w-[820px] px-8 py-8">
        <PageHeader title={t('scheduled.title')} subtitle={t('scheduled.subtitle')}
          action={<PrimaryButton onClick={() => setEditing('new')}><IconPlus size={15} /> {t('scheduled.newTask')}</PrimaryButton>} />

        {!loaded ? (
          <div className="px-2 py-10 text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>正在读取已安排任务...</div>
        ) : tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
            <IconClock size={20} style={{ color: 'var(--color-text-tertiary)' }} />
            <h2 className="mt-3 text-[15px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{t('scheduled.emptyTitle')}</h2>
            <p className="mt-1 max-w-[380px] text-[13px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{t('scheduled.emptyHint')}</p>
            <div className="mt-4"><PrimaryButton onClick={() => setEditing('new')}><IconPlus size={15} /> {t('scheduled.newTask')}</PrimaryButton></div>
          </div>
        ) : (
          <ScheduledTaskList
            tasks={tasks}
            onToggle={task => void toggle(task)}
            onOpenMenu={(task, point) => setMenu({ id: task.id, ...point })}
          />
        )}
        {loaded && loadFailed && <p className="mt-4 px-2 text-[12px]" style={{ color: 'var(--color-error)' }}>暂时无法读取全部任务。</p>}

        {runs.length > 0 && (
          <div className="mt-8" data-testid="workflow-runs-section">
            <h2 className="mb-2 px-2 text-[13px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.runsTitle')}</h2>
            <WorkflowRunList runs={runs} />
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={[
            { label: t('scheduled.run'), icon: <IconZap size={15} />, onClick: () => void runNow(menu.id) },
            { label: t('scheduled.edit'), icon: <IconEdit size={15} />, onClick: () => { if (menuTask) setEditing(menuTask) } },
            { label: t('scheduled.remove'), icon: <IconTrash size={15} />, danger: true, separatorBefore: true, onClick: () => void remove(menu.id) },
          ]} />
      )}

      {editing && <TaskForm initial={editing === 'new' ? null : editing} busy={busy} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  )
}
