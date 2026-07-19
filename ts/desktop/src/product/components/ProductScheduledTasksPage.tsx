import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bell,
  CheckCircle2,
  Clock3,
  History,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react'
import { ActionDialog } from '../../components/shared/ActionDialog'
import { Button } from '../../components/shared/Button'
import { Modal } from '../../components/shared/Modal'
import { useTranslation } from '../../i18n'
import { describeCron, isValidCron } from '../../lib/cronDescribe'
import { productScheduledTasksApi } from '../api/scheduledTasks'
import { productApiUserFacingError } from '../api/client'
import type {
  CreateProductScheduledTaskInput,
  ProductScheduledTask,
  ProductScheduledTaskRun,
  UpdateProductScheduledTaskInput,
} from '../domain/types'

type EditorTarget = ProductScheduledTask | 'create' | null
type ConfirmTarget =
  | { kind: 'run'; task: ProductScheduledTask }
  | { kind: 'delete'; task: ProductScheduledTask }
  | null

const QUICK_SCHEDULES = [
  { label: '每天 09:00', value: '0 9 * * *' },
  { label: '工作日 09:00', value: '0 9 * * 1-5' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每 15 分钟', value: '*/15 * * * *' },
]

const INPUT_CLASS = 'w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none transition-colors placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-brand)]'

function formatDateTime(value: string | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null
  return new Date(value).toLocaleString()
}

function runLabel(status: ProductScheduledTaskRun['status']): string {
  switch (status) {
    case 'running': return '正在运行'
    case 'completed': return '已完成'
    case 'timeout': return '已超时'
    default: return '未完成'
  }
}

function runTone(status: ProductScheduledTaskRun['status']): string {
  switch (status) {
    case 'running': return 'text-[var(--color-warning)]'
    case 'completed': return 'text-[var(--color-success)]'
    default: return 'text-[var(--color-error)]'
  }
}

function replaceTask(tasks: ProductScheduledTask[], nextTask: ProductScheduledTask): ProductScheduledTask[] {
  return tasks.map((task) => task.id === nextTask.id ? nextTask : task)
}

/**
 * Product-owned scheduled-task surface. The page only consumes the bounded
 * product contract; the CronScheduler remains the execution authority.
 */
export function ProductScheduledTasksPage() {
  const t = useTranslation()
  const [tasks, setTasks] = useState<ProductScheduledTask[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editorTarget, setEditorTarget] = useState<EditorTarget>(null)
  const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const [runsTaskId, setRunsTaskId] = useState<string | null>(null)
  const [runs, setRuns] = useState<ProductScheduledTaskRun[]>([])
  const [runsLoading, setRunsLoading] = useState(false)
  const taskListVersionRef = useRef(0)
  const taskListRequestVersionRef = useRef(0)
  const taskListLoadedRef = useRef(false)
  const runsRequestVersionRef = useRef(0)
  const runsScopeRef = useRef({ taskId: runsTaskId, version: 0 })

  if (runsScopeRef.current.taskId !== runsTaskId) {
    runsScopeRef.current = {
      taskId: runsTaskId,
      version: runsScopeRef.current.version + 1,
    }
  }

  const refreshTasks = useCallback(async () => {
    const requestVersion = taskListRequestVersionRef.current + 1
    taskListRequestVersionRef.current = requestVersion
    const taskListVersion = taskListVersionRef.current
    const showLoading = !taskListLoadedRef.current
    if (showLoading) setIsLoading(true)

    try {
      const response = await productScheduledTasksApi.list()
      if (
        taskListRequestVersionRef.current !== requestVersion ||
        taskListVersionRef.current !== taskListVersion
      ) return
      setTasks(response.tasks)
      taskListLoadedRef.current = true
      setError(null)
    } catch (cause) {
      if (
        taskListRequestVersionRef.current !== requestVersion ||
        taskListVersionRef.current !== taskListVersion
      ) return
      setError(productApiUserFacingError(cause, '暂时无法读取定时任务，请稍后重试。'))
    } finally {
      if (
        showLoading &&
        taskListRequestVersionRef.current === requestVersion &&
        taskListVersionRef.current === taskListVersion
      ) {
        setIsLoading(false)
      }
    }
  }, [])

  const refreshRuns = useCallback(async (taskId: string) => {
    const scope = runsScopeRef.current
    if (scope.taskId !== taskId) return
    const requestVersion = runsRequestVersionRef.current + 1
    runsRequestVersionRef.current = requestVersion
    setRunsLoading(true)
    try {
      const response = await productScheduledTasksApi.getTaskRuns(taskId)
      if (
        runsScopeRef.current.taskId !== taskId ||
        runsScopeRef.current.version !== scope.version ||
        runsRequestVersionRef.current !== requestVersion
      ) return
      setRuns(response.runs.filter((run) => run.taskId === taskId))
      setError(null)
    } catch (cause) {
      if (
        runsScopeRef.current.taskId !== taskId ||
        runsScopeRef.current.version !== scope.version ||
        runsRequestVersionRef.current !== requestVersion
      ) return
      setError(productApiUserFacingError(cause, '暂时无法读取运行记录，请稍后重试。'))
    } finally {
      if (
        runsScopeRef.current.taskId === taskId &&
        runsScopeRef.current.version === scope.version &&
        runsRequestVersionRef.current === requestVersion
      ) {
        setRunsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void refreshTasks()
  }, [refreshTasks])

  useEffect(() => {
    if (!runsTaskId) {
      setRuns([])
      setRunsLoading(false)
      return
    }
    setRuns([])
    void refreshRuns(runsTaskId)
  }, [refreshRuns, runsTaskId])

  const currentRuns = useMemo(
    () => runs.filter((run) => run.taskId === runsTaskId),
    [runs, runsTaskId],
  )
  const hasRunningRun = currentRuns.some((run) => run.status === 'running')
  useEffect(() => {
    if (!runsTaskId || !hasRunningRun) return
    const interval = window.setInterval(() => {
      void refreshRuns(runsTaskId)
      void refreshTasks()
    }, 2_000)
    return () => window.clearInterval(interval)
  }, [hasRunningRun, refreshRuns, refreshTasks, runsTaskId])

  const activeRunsTask = useMemo(
    () => tasks.find((task) => task.id === runsTaskId) ?? null,
    [runsTaskId, tasks],
  )

  const invalidateTaskList = () => {
    taskListVersionRef.current += 1
    taskListLoadedRef.current = true
    setIsLoading(false)
  }

  const updateTask = async (taskId: string, input: UpdateProductScheduledTaskInput) => {
    invalidateTaskList()
    setPendingAction(`update:${taskId}`)
    setError(null)
    try {
      const { task } = await productScheduledTasksApi.update(taskId, input)
      setTasks((current) => replaceTask(current, task))
      return task
    } catch (cause) {
      const message = productApiUserFacingError(cause, '定时任务暂未更新，请稍后重试。')
      setError(message)
      throw cause
    } finally {
      setPendingAction(null)
    }
  }

  const saveEditor = async (input: CreateProductScheduledTaskInput | UpdateProductScheduledTaskInput) => {
    setError(null)
    if (editorTarget === 'create') {
      invalidateTaskList()
      setPendingAction('create')
      try {
        const { task } = await productScheduledTasksApi.create(input as CreateProductScheduledTaskInput)
        setTasks((current) => [task, ...current])
        setEditorTarget(null)
      } catch (cause) {
        setError(productApiUserFacingError(cause, '定时任务暂未创建，请稍后重试。'))
        throw cause
      } finally {
        setPendingAction(null)
      }
      return
    }

    if (editorTarget) {
      await updateTask(editorTarget.id, input as UpdateProductScheduledTaskInput)
      setEditorTarget(null)
    }
  }

  const toggleTask = async (task: ProductScheduledTask) => {
    await updateTask(task.id, { enabled: !task.enabled })
  }

  const runTask = async (task: ProductScheduledTask) => {
    setPendingAction(`run:${task.id}`)
    setError(null)
    try {
      await productScheduledTasksApi.run(task.id)
      setRunsTaskId(task.id)
      window.setTimeout(() => {
        void refreshRuns(task.id)
        void refreshTasks()
      }, 350)
    } catch (cause) {
      setError(productApiUserFacingError(cause, '定时任务暂时无法启动，请稍后重试。'))
    } finally {
      setPendingAction(null)
      setConfirmTarget(null)
    }
  }

  const deleteTask = async (task: ProductScheduledTask) => {
    invalidateTaskList()
    setPendingAction(`delete:${task.id}`)
    setError(null)
    try {
      await productScheduledTasksApi.delete(task.id)
      setTasks((current) => current.filter((entry) => entry.id !== task.id))
      if (runsTaskId === task.id) setRunsTaskId(null)
    } catch (cause) {
      setError(productApiUserFacingError(cause, '定时任务暂时无法删除，请稍后重试。'))
    } finally {
      setPendingAction(null)
      setConfirmTarget(null)
    }
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--color-app-main)]" data-testid="product-scheduled-tasks">
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-4 border-b border-[var(--color-border)] px-6 py-5">
        <div>
          <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">定时任务</h1>
          <p className="mt-1 text-sm text-[var(--color-text-secondary)]">按计划执行重复工作，并在任务完成后收到桌面提醒。</p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => setEditorTarget('create')}>新建定时任务</Button>
      </header>

      <div className="shrink-0 border-b border-[var(--color-border)] px-6 py-3">
        <div className="flex items-start gap-2 rounded-lg bg-[var(--color-surface-container)] px-3 py-2.5 text-xs text-[var(--color-text-secondary)]">
          <Clock3 size={16} className="mt-0.5 shrink-0 text-[var(--color-brand)]" />
          <p>定时任务只会在桌面应用运行时执行。无人值守时，任何需要确认的操作都会被拒绝。</p>
        </div>
      </div>

      {error ? (
        <div className="mx-6 mt-4 flex items-center gap-2 rounded-lg border border-[var(--color-error)]/30 px-3 py-2 text-sm text-[var(--color-error)]" role="alert">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" aria-label="关闭提示" onClick={() => setError(null)} className="rounded p-1 hover:bg-[var(--color-surface-hover)]"><X size={14} /></button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        {isLoading ? (
          <div className="flex justify-center py-20 text-[var(--color-text-tertiary)]"><Loader2 className="animate-spin" size={22} /></div>
        ) : tasks.length === 0 ? (
          <section className="mx-auto flex max-w-lg flex-col items-center rounded-xl border border-dashed border-[var(--color-border)] px-6 py-14 text-center">
            <Clock3 size={30} className="text-[var(--color-text-tertiary)]" />
            <h2 className="mt-4 text-base font-medium text-[var(--color-text-primary)]">还没有定时任务</h2>
            <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">把每日复盘、营业提醒或固定检查交给计划执行，结果仍会留在这里。</p>
            <Button className="mt-5" icon={<Plus size={16} />} onClick={() => setEditorTarget('create')}>新建定时任务</Button>
          </section>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-3">
            {tasks.map((task) => {
              const runOpen = task.id === runsTaskId
              const isPending = pendingAction !== null && pendingAction.endsWith(task.id)
              const lastRun = formatDateTime(task.lastRunAt)
              return (
                <article key={task.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid={`product-scheduled-task-${task.id}`}>
                  <div className="flex flex-wrap items-start gap-4 px-4 py-4">
                    <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${task.enabled ? 'bg-[var(--color-success)]' : 'bg-[var(--color-text-tertiary)]'}`} aria-label={task.enabled ? '已启用' : '已暂停'} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <h2 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">{task.title}</h2>
                        <span className="rounded-full bg-[var(--color-surface-container)] px-2 py-0.5 text-xs text-[var(--color-text-secondary)]" title={task.schedule}>{describeCron(task.schedule, t)}</span>
                        {!task.enabled ? <span className="text-xs text-[var(--color-text-tertiary)]">已暂停</span> : null}
                      </div>
                      {task.description ? <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{task.description}</p> : null}
                      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-text-tertiary)]">
                        {lastRun ? <span>上次运行：{lastRun}</span> : <span>尚未运行</span>}
                        {task.workDir ? <span className="truncate" title={task.workDir}>工作目录：{task.workDir}</span> : null}
                        {task.notification?.enabled ? <span className="inline-flex items-center gap-1"><Bell size={12} />完成后提醒</span> : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" variant="secondary" icon={<History size={14} />} onClick={() => setRunsTaskId(runOpen ? null : task.id)}>运行记录</Button>
                      <Button size="sm" variant="secondary" icon={<Play size={14} />} disabled={!task.enabled || isPending} onClick={() => setConfirmTarget({ kind: 'run', task })}>立即运行</Button>
                      <Button size="sm" variant="secondary" icon={task.enabled ? <Pause size={14} /> : <Play size={14} />} disabled={isPending} onClick={() => { void toggleTask(task).catch(() => undefined) }}>{task.enabled ? '暂停' : '启用'}</Button>
                      <Button size="sm" variant="ghost" icon={<Pencil size={14} />} disabled={isPending} onClick={() => setEditorTarget(task)}>编辑</Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} disabled={isPending} onClick={() => setConfirmTarget({ kind: 'delete', task })}>删除</Button>
                    </div>
                  </div>
                  {runOpen && activeRunsTask ? (
                    <ScheduledTaskRunsPanel
                      task={activeRunsTask}
                      runs={currentRuns}
                      loading={runsLoading}
                      onClose={() => setRunsTaskId(null)}
                      onRefresh={() => void refreshRuns(activeRunsTask.id)}
                    />
                  ) : null}
                </article>
              )
            })}
          </div>
        )}
      </div>

      {editorTarget ? (
        <ScheduledTaskEditor
          key={editorTarget === 'create' ? 'create' : editorTarget.id}
          task={editorTarget === 'create' ? undefined : editorTarget}
          saving={pendingAction === 'create' || (editorTarget !== 'create' && pendingAction === `update:${editorTarget.id}`)}
          onClose={() => setEditorTarget(null)}
          onSubmit={saveEditor}
        />
      ) : null}

      <ActionDialog
        open={confirmTarget?.kind === 'run'}
        onClose={() => setConfirmTarget(null)}
        title="立即运行定时任务"
        body="任务会按保存的工作目录和无人值守权限运行。需要确认的操作不会自动放行。"
        actions={[
          { label: '取消', onClick: () => setConfirmTarget(null) },
          {
            label: '立即运行',
            variant: 'primary',
            loading: confirmTarget?.kind === 'run' && pendingAction === `run:${confirmTarget.task.id}`,
            onClick: () => confirmTarget?.kind === 'run' ? runTask(confirmTarget.task) : undefined,
          },
        ]}
      />
      <ActionDialog
        open={confirmTarget?.kind === 'delete'}
        onClose={() => setConfirmTarget(null)}
        title="删除定时任务"
        body="删除后将不再按计划运行，已有运行记录也不会在此任务下继续显示。"
        actions={[
          { label: '取消', onClick: () => setConfirmTarget(null) },
          {
            label: '删除',
            variant: 'danger',
            loading: confirmTarget?.kind === 'delete' && pendingAction === `delete:${confirmTarget.task.id}`,
            onClick: () => confirmTarget?.kind === 'delete' ? deleteTask(confirmTarget.task) : undefined,
          },
        ]}
      />
    </main>
  )
}

function ScheduledTaskRunsPanel({
  task,
  runs,
  loading,
  onClose,
  onRefresh,
}: {
  task: ProductScheduledTask
  runs: ProductScheduledTaskRun[]
  loading: boolean
  onClose: () => void
  onRefresh: () => void
}) {
  return (
    <section className="border-t border-[var(--color-border)] bg-[var(--color-surface-container)]/40 px-4 py-3" aria-label={`${task.title} 的运行记录`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm font-medium text-[var(--color-text-primary)]"><History size={15} />运行记录</div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={onRefresh} aria-label="刷新运行记录" className="rounded-md px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]">刷新</button>
          <button type="button" onClick={onClose} aria-label="关闭运行记录" className="rounded-md p-1 text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]"><X size={14} /></button>
        </div>
      </div>
      {loading ? (
        <div className="flex justify-center py-5 text-[var(--color-text-tertiary)]"><Loader2 size={18} className="animate-spin" /></div>
      ) : runs.length === 0 ? (
        <p className="py-3 text-sm text-[var(--color-text-tertiary)]">还没有运行记录。</p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <div key={run.id} className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                <span className={`inline-flex items-center gap-1 font-medium ${runTone(run.status)}`}>
                  {run.status === 'completed' ? <CheckCircle2 size={13} /> : run.status === 'running' ? <Loader2 size={13} className="animate-spin" /> : <Clock3 size={13} />}
                  {runLabel(run.status)}
                </span>
                <span className="text-[var(--color-text-tertiary)]">{formatDateTime(run.startedAt) ?? '时间未知'}</span>
                {typeof run.durationMs === 'number' ? <span className="text-[var(--color-text-tertiary)]">用时 {Math.max(1, Math.round(run.durationMs / 1_000))} 秒</span> : null}
              </div>
              {run.result ? <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-[var(--color-text-secondary)]">{run.result}</p> : null}
              {run.status === 'failed' || run.status === 'timeout' ? <p className="mt-2 text-sm text-[var(--color-error)]">本次运行未完成，请稍后重试。</p> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function ScheduledTaskEditor({
  task,
  saving,
  onClose,
  onSubmit,
}: {
  task?: ProductScheduledTask
  saving: boolean
  onClose: () => void
  onSubmit: (input: CreateProductScheduledTaskInput | UpdateProductScheduledTaskInput) => Promise<void>
}) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [instruction, setInstruction] = useState(task?.instruction ?? '')
  const [schedule, setSchedule] = useState(task?.schedule ?? '0 9 * * *')
  const [workDir, setWorkDir] = useState(task?.workDir ?? '')
  const [notifyOnComplete, setNotifyOnComplete] = useState(task?.notification?.enabled ?? false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  const canSubmit = title.trim().length > 0 && instruction.trim().length > 0 && isValidCron(schedule)

  const submit = async () => {
    if (!canSubmit) return
    setSubmitError(null)
    const input = {
      title: title.trim(),
      description: description.trim() || null,
      schedule: schedule.trim(),
      instruction: instruction.trim(),
      workDir: workDir.trim() || null,
      notification: notifyOnComplete
        ? { enabled: true, channels: ['desktop'] as Array<'desktop'> }
        : { enabled: false, channels: [] as Array<'desktop'> },
    }
    try {
      await onSubmit(task ? input : {
        ...input,
        description: input.description ?? undefined,
        workDir: input.workDir ?? undefined,
        recurring: true,
        enabled: true,
      })
    } catch {
      setSubmitError('暂时无法保存定时任务，请稍后重试。')
    }
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      title={task ? '编辑定时任务' : '新建定时任务'}
      width={640}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={() => void submit()} disabled={!canSubmit} loading={saving}>{task ? '保存' : '创建任务'}</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <div className="rounded-lg bg-[var(--color-surface-container)] px-3 py-2.5 text-xs leading-5 text-[var(--color-text-secondary)]">
          定时任务不会跳过确认。适合固定复盘、提醒和检查，不适合需要持续人工判断的操作。
        </div>
        {submitError ? <p role="alert" className="rounded-lg border border-[var(--color-error)]/30 px-3 py-2 text-sm text-[var(--color-error)]">{submitError}</p> : null}
        <Field label="任务名称" required>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：每日营业复盘" className={INPUT_CLASS} autoFocus />
        </Field>
        <Field label="简要说明">
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="这项计划要完成什么" className={INPUT_CLASS} />
        </Field>
        <Field label="执行内容" required>
          <textarea value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="说明需要执行的工作和完成标准。" rows={5} className={`${INPUT_CLASS} resize-y`} />
        </Field>
        <Field label="执行计划" required>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {QUICK_SCHEDULES.map((entry) => (
                <button key={entry.value} type="button" onClick={() => setSchedule(entry.value)} className={`rounded-md border px-2 py-1 text-xs transition-colors ${schedule === entry.value ? 'border-[var(--color-brand)] bg-[var(--color-surface-selected)] text-[var(--color-brand)]' : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'}`}>{entry.label}</button>
              ))}
            </div>
            <input value={schedule} onChange={(event) => setSchedule(event.target.value)} aria-label="执行计划表达式" placeholder="例如：0 9 * * *" className={`${INPUT_CLASS} font-[var(--font-mono)]`} />
            <p className={`text-xs ${isValidCron(schedule) ? 'text-[var(--color-text-tertiary)]' : 'text-[var(--color-error)]'}`}>
              {isValidCron(schedule) ? '计划：使用标准五段时间表达式。' : '请输入有效的五段时间表达式。'}
            </p>
          </div>
        </Field>
        <Field label="工作目录（可选）">
          <input value={workDir} onChange={(event) => setWorkDir(event.target.value)} placeholder="留空时使用默认工作目录" className={INPUT_CLASS} />
        </Field>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-[var(--color-border)] p-3">
          <input type="checkbox" checked={notifyOnComplete} onChange={(event) => setNotifyOnComplete(event.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" />
          <span><span className="flex items-center gap-1 text-sm font-medium text-[var(--color-text-primary)]"><Bell size={14} />完成后发送桌面提醒</span><span className="mt-1 block text-xs text-[var(--color-text-tertiary)]">提醒只会显示本次执行的状态和简短结果。</span></span>
        </label>
      </div>
    </Modal>
  )
}

function Field({ label, required, children }: { label: string; required?: boolean; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">{label}{required ? <span className="ml-1 text-[var(--color-error)]">*</span> : null}</span>
      {children}
    </label>
  )
}
