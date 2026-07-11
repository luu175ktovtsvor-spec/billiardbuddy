// 设置弹窗(照 Codex 设置壳:遮罩 + 居中卡 + 分节)。接真实 store:
//   外观 → uiStore.setTheme · 默认权限 → settingsStore.setPermissionMode · 台球包 → settingsStore.setEnabledPacks。
import { useEffect, type ReactNode } from 'react'
import type { PermissionMode } from '../../types/chat'
import { useUiStore, type ThemeMode } from '../../stores/uiStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { IconX } from '../shared/icons'
import { t } from '../../i18n'

function Segmented<T extends string>({ value, options, onChange, full }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; full?: boolean }) {
  return (
    <div className={`inline-flex rounded-lg p-0.5 ${full ? 'w-full' : ''}`} style={{ background: 'var(--color-surface-container)' }}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1 text-[12.5px] transition-colors ${full ? 'flex-1' : ''}`}
            style={{ background: on ? 'var(--color-surface)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: on ? 'var(--shadow-input)' : undefined, fontWeight: on ? 600 : 400 }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <div className="py-4" style={{ borderBottom: '1px solid var(--color-border)' }}>
      <div className="mb-2">
        <div className="text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{title}</div>
        {desc && <div className="mt-0.5 text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{desc}</div>}
      </div>
      {children}
    </div>
  )
}

const PERM_MODES: { value: PermissionMode; label: string }[] = [
  { value: 'default', label: t('permission.default') },
  { value: 'acceptEdits', label: t('permission.acceptEdits') },
  { value: 'plan', label: t('permission.plan') },
  { value: 'bypassPermissions', label: t('permission.bypass') },
]

export function SettingsModal() {
  const open = useUiStore((s) => s.settingsOpen)
  const setOpen = useUiStore((s) => s.setSettingsOpen)
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  const perm = useSettingsStore((s) => s.defaultPermissionMode)
  const setPerm = useSettingsStore((s) => s.setPermissionMode)
  const packs = useSettingsStore((s) => s.enabledPacks)
  const setPacks = useSettingsStore((s) => s.setEnabledPacks)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null
  const billiards = packs.includes('billiards')
  const permValue = PERM_MODES.some((m) => m.value === perm) ? perm : 'default'

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center p-6"
      style={{ background: 'color-mix(in srgb, #000 38%, transparent)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      onClick={() => setOpen(false)}
      data-testid="settings-modal"
    >
      <div
        className="flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-3.5" style={{ borderBottom: '1px solid var(--color-border)' }}>
          <span className="text-[15px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>{t('sidebar.settings')}</span>
          <button type="button" onClick={() => setOpen(false)} aria-label="关闭" className="rounded-md p-1 transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-tertiary)' }}>
            <IconX size={16} />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-auto px-5">
          <Section title="外观" desc="界面明暗主题">
            <Segmented<ThemeMode>
              value={theme}
              onChange={setTheme}
              options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }, { value: 'system', label: '跟随系统' }]}
            />
          </Section>

          <Section title="默认权限" desc="新对话默认的权限档;对外触达 / 不可逆 / 花钱的动作仍会单独拦你确认。">
            <Segmented<PermissionMode> full value={permValue} onChange={setPerm} options={PERM_MODES} />
          </Section>

          <Section title="台球运营专家" desc="只作用于当前对话窗口:挂载后这个窗口按台球运营知识回答,别的窗口不受影响;也可在输入框敲 /台球 开、/台球关闭 关。">
            <button
              type="button"
              onClick={() => setPacks(billiards ? [] : ['billiards'])}
              className="rounded-full px-3.5 py-1 text-[12.5px] transition-colors"
              style={billiards ? { background: 'var(--color-primary)', color: 'var(--color-on-primary)' } : { border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
            >
              {billiards ? '本窗口已挂载' : '本窗口未挂载'}
            </button>
          </Section>

          <div className="flex items-center justify-between py-4">
            <span className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{t('app.name')} {t('app.version')}</span>
            <span className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>本机 · 免登录</span>
          </div>
        </div>
      </div>
    </div>
  )
}
