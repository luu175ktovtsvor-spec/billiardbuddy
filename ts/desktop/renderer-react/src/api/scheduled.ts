// 定时任务 api(接后端 /api/v1/scheduled-tasks)。已安排页用它:拉列表、建、改、删、立即跑。
// 后端 schedule_kind = daily/weekly/monthly/…;schedule_spec = {hour,minute}。前端只暴露 day/week/month + 时间。
import { api } from './client'
import { useSettingsStore } from '../stores/settingsStore'

export type Freq = 'day' | 'week' | 'month'

/** 后端定时任务(节选前端要的字段)。 */
export interface ScheduledTask {
  id: string
  name?: string
  instruction?: string
  workflow_id?: string | null
  schedule_kind?: string
  schedule_spec?: { hour?: number; minute?: number }
  enabled?: boolean
  next_run_at?: number | string | null
  last_run_status?: string | null
}

/** 前端表单/行用的视图模型。workflowId 非空 = 到点执行整条经营工作流(而非单条指令)。 */
export interface TaskView {
  id: string
  title: string
  freq: Freq
  time: string
  enabled: boolean
  nextRunAt?: number | string | null
  workflowId?: string
}

const KIND_TO_FREQ: Record<string, Freq> = { daily: 'day', weekly: 'week', weekdays: 'week', monthly: 'month' }
const FREQ_TO_KIND: Record<Freq, string> = { day: 'daily', week: 'weekly', month: 'monthly' }

export function toView(t: ScheduledTask): TaskView {
  const spec = t.schedule_spec ?? {}
  const time = `${String(spec.hour ?? 9).padStart(2, '0')}:${String(spec.minute ?? 0).padStart(2, '0')}`
  return {
    id: t.id,
    title: t.instruction || t.name || '定时任务',
    freq: KIND_TO_FREQ[t.schedule_kind ?? 'daily'] ?? 'day',
    time,
    enabled: t.enabled !== false,
    nextRunAt: t.next_run_at ?? null,
    workflowId: typeof t.workflow_id === 'string' && t.workflow_id ? t.workflow_id : undefined,
  }
}

export interface ScheduledFormValues {
  title: string
  freq: Freq
  time: string
  enabled: boolean
  /** 选了工作流 = 到点执行整条工作流;instruction 置空。切回指令型时显式清空后端字段。 */
  workflowId?: string
}

/** 表单 → 后端建/改入参。带上当前工作目录,让定时任务在店主选的文件夹里跑。 */
export function toBackend(v: ScheduledFormValues): Record<string, unknown> {
  const [h, m] = v.time.split(':').map((x) => Number(x))
  return {
    name: v.title.trim().slice(0, 40),
    instruction: v.workflowId ? '' : v.title.trim(),
    workflow_id: v.workflowId ?? null,
    schedule_kind: FREQ_TO_KIND[v.freq],
    schedule_spec: { hour: Number.isFinite(h) ? h : 9, minute: Number.isFinite(m) ? m : 0 },
    enabled: v.enabled,
    working_dir: useSettingsStore.getState().workspaceRoot ?? undefined,
  }
}

export const scheduledApi = {
  list: () => api.get<{ tasks?: ScheduledTask[] } | ScheduledTask[]>('/api/v1/scheduled-tasks'),
  create: (v: ScheduledFormValues) =>
    api.post<ScheduledTask>('/api/v1/scheduled-tasks', toBackend(v)),
  update: (id: string, patch: Record<string, unknown>) =>
    api.patch<ScheduledTask>(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}`, patch),
  updateForm: (id: string, v: ScheduledFormValues) =>
    api.patch<ScheduledTask>(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}`, toBackend(v)),
  remove: (id: string) => api.delete<{ status: string }>(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}`),
  runNow: (id: string) => api.post<unknown>(`/api/v1/scheduled-tasks/${encodeURIComponent(id)}/run`, {}),
}

/** 列表响应两种形状(数组 or {tasks}）都兼容。 */
export function tasksFrom(res: { tasks?: ScheduledTask[] } | ScheduledTask[]): ScheduledTask[] {
  return Array.isArray(res) ? res : res.tasks ?? []
}
