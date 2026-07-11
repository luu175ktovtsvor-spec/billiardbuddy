// 已安排页(照 Codex/ChatGPT「Scheduled tasks」:主区一张列表,每行=一个定时任务)。
// 前端全搭:列表 + 空态 + 启用/暂停开关 + 行「⋯」菜单 + **新建/编辑表单弹窗**,预览模式塞示例。
// 数据本地态(useState)——后端定时任务系统就绪后换成 /api/v1/scheduled-tasks 拉取 + 持久化;
// 「立即运行」需后端真跑,暂占位。
import { useState } from 'react'
import { isPreviewMode } from '../lib/previewSeed'
import { ContextMenu } from '../components/shared/Menu'
import { Modal } from '../components/shared/Modal'
import { IconTile, PageHeader, PrimaryButton, SecondaryButton } from '../components/shared/PageKit'
import { toast } from '../stores/toastStore'
import { IconClock, IconPlus, IconMoreHorizontal, IconEdit, IconTrash, IconZap } from '../components/shared/icons'
import { t } from '../i18n'

type Freq = 'day' | 'week' | 'month'
interface Task {
  id: string
  title: string
  freq: Freq
  time: string
  enabled: boolean
}

const SEED: Task[] = [
  { id: 's1', title: '每天早上汇总昨天的营业数据', freq: 'day', time: '09:00', enabled: true },
  { id: 's2', title: '每周一出一版本周活动文案', freq: 'week', time: '10:00', enabled: true },
  { id: 's3', title: '每月 1 号盘一次会员到期名单', freq: 'month', time: '08:00', enabled: false },
]

const FREQ_LABEL: Record<Freq, string> = { day: '每天', week: '每周一', month: '每月 1 日' }
const scheduleText = (f: Freq, time: string) => `${FREQ_LABEL[f]} ${time}`
const nextRunText = (f: Freq, time: string) => (f === 'day' ? `明天 ${time}` : f === 'week' ? `周一 ${time}` : `下月 1 日 ${time}`)

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
          <button
            key={o.v}
            type="button"
            onClick={() => onChange(o.v)}
            className="flex-1 rounded-md px-3 py-1.5 text-[12.5px] transition-colors"
            style={{ background: on ? 'var(--color-surface)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: on ? 'var(--shadow-input)' : undefined, fontWeight: on ? 600 : 400 }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 新建/编辑表单弹窗。 */
function TaskForm({ initial, onCancel, onSave }: { initial: Task | null; onCancel: () => void; onSave: (t: Task) => void }) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [freq, setFreq] = useState<Freq>(initial?.freq ?? 'day')
  const [time, setTime] = useState(initial?.time ?? '09:00')
  const canSave = title.trim().length > 0

  const save = () => {
    if (!canSave) return
    onSave({ id: initial?.id ?? `t${Date.now()}`, title: title.trim(), freq, time, enabled: initial?.enabled ?? true })
  }

  return (
    <Modal
      open
      onClose={onCancel}
      title={initial ? t('scheduled.formEdit') : t('scheduled.formNew')}
      maxWidth={480}
      testId="task-form"
      footer={
        <>
          <SecondaryButton onClick={onCancel}>{t('scheduled.cancel')}</SecondaryButton>
          <PrimaryButton onClick={save}>{t('scheduled.save')}</PrimaryButton>
        </>
      }
    >
      <div className="px-5 py-4">
        <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formContent')}</label>
        <textarea
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('scheduled.formContentPlaceholder')}
          rows={3}
          className="w-full resize-none rounded-lg px-3 py-2 text-[13px] outline-none"
          style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
        />

        <div className="mt-4 flex items-end gap-3">
          <div className="min-w-0 flex-1">
            <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formFreq')}</label>
            <FreqPicker value={freq} onChange={setFreq} />
          </div>
          <div>
            <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('scheduled.formTime')}</label>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-lg px-3 py-1.5 text-[13px] outline-none"
              style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
            />
          </div>
        </div>
      </div>
    </Modal>
  )
}

export function ScheduledPage() {
  const [tasks, setTasks] = useState<Task[]>(() => (isPreviewMode() ? SEED : []))
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [editing, setEditing] = useState<Task | 'new' | null>(null)

  const toggle = (id: string) => setTasks((ts) => ts.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)))
  const remove = (id: string) => setTasks((ts) => ts.filter((x) => x.id !== id))
  const save = (task: Task) => {
    setTasks((ts) => (ts.some((x) => x.id === task.id) ? ts.map((x) => (x.id === task.id ? task : x)) : [...ts, task]))
    setEditing(null)
  }
  const menuTask = menu ? tasks.find((x) => x.id === menu.id) ?? null : null

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="scheduled-page">
      <div className="mx-auto w-full max-w-[820px] px-8 py-8">
        <PageHeader
          title={t('scheduled.title')}
          subtitle={t('scheduled.subtitle')}
          action={
            <PrimaryButton onClick={() => setEditing('new')}>
              <IconPlus size={15} /> {t('scheduled.newTask')}
            </PrimaryButton>
          }
        />

        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-2xl px-6 py-16 text-center" style={{ border: '1px dashed var(--color-border)' }}>
            <IconTile muted><IconClock size={18} /></IconTile>
            <h2 className="mt-3 text-[15px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{t('scheduled.emptyTitle')}</h2>
            <p className="mt-1 max-w-[380px] text-[13px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{t('scheduled.emptyHint')}</p>
            <div className="mt-4">
              <PrimaryButton onClick={() => setEditing('new')}>
                <IconPlus size={15} /> {t('scheduled.newTask')}
              </PrimaryButton>
            </div>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl" style={{ border: '1px solid var(--color-border)' }}>
            {tasks.map((task, i) => (
              <div
                key={task.id}
                className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-[var(--color-surface-hover)]"
                style={i > 0 ? { borderTop: '1px solid var(--color-border)' } : undefined}
              >
                <IconTile muted={!task.enabled}><IconClock size={17} /></IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{task.title}</div>
                  <div className="mt-0.5 flex items-center gap-2 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>
                    <span>{scheduleText(task.freq, task.time)}</span>
                    <span aria-hidden>·</span>
                    <span>{t('scheduled.nextRun')} {nextRunText(task.freq, task.time)}</span>
                  </div>
                </div>

                {/* 启用/暂停开关(照 Codex 行内 toggle) */}
                <button
                  type="button"
                  role="switch"
                  aria-checked={task.enabled}
                  aria-label={task.enabled ? t('scheduled.pausedToggle') : t('scheduled.enableToggle')}
                  onClick={() => toggle(task.id)}
                  className="relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors"
                  style={{ background: task.enabled ? 'var(--color-brand)' : 'var(--color-surface-container-high)' }}
                >
                  <span
                    className="absolute top-[2px] h-[18px] w-[18px] rounded-full bg-white transition-all"
                    style={{ left: task.enabled ? '18px' : '2px', boxShadow: '0 1px 2px rgba(0,0,0,.2)' }}
                  />
                </button>

                <button
                  type="button"
                  aria-label={t('scheduled.edit')}
                  onClick={(e) => setMenu({ id: task.id, x: e.clientX, y: e.clientY })}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-container)]"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  <IconMoreHorizontal size={17} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            { label: t('scheduled.run'), icon: <IconZap size={15} />, onClick: () => toast(t('scheduled.comingSoon')) },
            { label: t('scheduled.edit'), icon: <IconEdit size={15} />, onClick: () => { if (menuTask) setEditing(menuTask) } },
            { label: t('scheduled.remove'), icon: <IconTrash size={15} />, danger: true, separatorBefore: true, onClick: () => remove(menu.id) },
          ]}
        />
      )}

      {editing && <TaskForm initial={editing === 'new' ? null : editing} onCancel={() => setEditing(null)} onSave={save} />}
    </div>
  )
}
