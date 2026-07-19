import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { terminalApi } from '../../api/terminal'
import { getDesktopHost } from '../../lib/desktopHost'
import { useSettingsStore } from '../../stores/settingsStore'
import { Button } from '../../components/shared/Button'
import { Dropdown } from '../../components/shared/Dropdown'
import { Input } from '../../components/shared/Input'
import type { DesktopTerminalStartupShell } from '../../types/settings'

/**
 * Product settings for the native task terminal. It intentionally configures
 * future Windows sessions only; opening a live shell belongs to a task dock.
 */
export function ProductTerminalPreferences() {
  const t = useTranslation()
  const desktopTerminal = useSettingsStore((state) => state.desktopTerminal)
  const setDesktopTerminal = useSettingsStore((state) => state.setDesktopTerminal)
  const [startupShell, setStartupShell] = useState<DesktopTerminalStartupShell>(desktopTerminal.startupShell)
  const [customShellPath, setCustomShellPath] = useState(desktopTerminal.customShellPath)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const isWindows = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || navigator.userAgent)

  useEffect(() => {
    setStartupShell(desktopTerminal.startupShell)
    setCustomShellPath(desktopTerminal.customShellPath)
  }, [desktopTerminal])

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 2_500)
    return () => window.clearTimeout(timer)
  }, [saved])

  const shellItems = useMemo(() => [
    { value: 'system' as const, label: t('settings.terminal.shell.system'), description: t('settings.terminal.shell.systemDesc') },
    { value: 'pwsh' as const, label: t('settings.terminal.shell.pwsh'), description: t('settings.terminal.shell.pwshDesc') },
    { value: 'powershell' as const, label: t('settings.terminal.shell.powershell'), description: t('settings.terminal.shell.powershellDesc') },
    { value: 'cmd' as const, label: t('settings.terminal.shell.cmd'), description: t('settings.terminal.shell.cmdDesc') },
    { value: 'custom' as const, label: t('settings.terminal.shell.custom'), description: t('settings.terminal.shell.customDesc') },
  ], [t])

  const savePreferences = async () => {
    setError(null)
    setSaved(false)
    const trimmedPath = customShellPath.trim()
    if (startupShell === 'custom') {
      if (!trimmedPath) {
        setError(t('settings.terminal.customPathRequired'))
        return
      }
      if (!/^[A-Za-z]:[\\/]/.test(trimmedPath)) {
        setError(t('settings.terminal.customPathAbsolute'))
        return
      }
    }

    setSaving(true)
    try {
      await setDesktopTerminal({ startupShell, customShellPath: trimmedPath })
      setSaved(true)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (!isWindows) {
    return (
      <section className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4" data-testid="product-terminal-preferences">
        <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.terminal.preferencesTitle')}</h2>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t('settings.terminal.preferencesBody')}</p>
      </section>
    )
  }

  return (
    <section className="flex flex-col gap-4" data-testid="product-terminal-preferences">
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
        <div className="flex flex-col gap-3">
          <div>
            <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.terminal.preferencesTitle')}</h2>
            <p className="mt-1 text-sm text-[var(--color-text-secondary)]">{t('settings.terminal.preferencesBody')}</p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[var(--color-text-primary)]">{t('settings.terminal.startupShell')}</span>
            <Dropdown<DesktopTerminalStartupShell>
              items={shellItems}
              value={startupShell}
              onChange={(value) => {
                setStartupShell(value)
                setError(null)
                setSaved(false)
              }}
              width="100%"
              trigger={
                <button
                  type="button"
                  className="flex h-10 w-full items-center justify-between rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)]"
                >
                  <span>{shellItems.find((item) => item.value === startupShell)?.label ?? startupShell}</span>
                  <span className="material-symbols-outlined text-[18px] text-[var(--color-text-tertiary)]">expand_more</span>
                </button>
              }
            />
          </div>

          {startupShell === 'custom' ? (
            <Input
              label={t('settings.terminal.customPath')}
              placeholder={t('settings.terminal.customPathPlaceholder')}
              value={customShellPath}
              onChange={(event) => {
                setCustomShellPath(event.target.value)
                setError(null)
                setSaved(false)
              }}
              error={error ?? undefined}
            />
          ) : null}

          {error && startupShell !== 'custom' ? <p className="text-xs text-[var(--color-error)]">{error}</p> : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" size="sm" loading={saving} onClick={() => void savePreferences()}>
              {t('settings.terminal.saveShell')}
            </Button>
            {saved ? <span className="text-xs text-[var(--color-text-secondary)]">{t('settings.terminal.saveShellSuccess')}</span> : null}
          </div>
        </div>
      </div>
      <BashPathPreferences isTerminalAvailable={terminalApi.isAvailable()} />
    </section>
  )
}

function BashPathPreferences({ isTerminalAvailable }: { isTerminalAvailable: boolean }) {
  const t = useTranslation()
  const [bashPath, setBashPath] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [invalid, setInvalid] = useState(false)

  useEffect(() => {
    if (!isTerminalAvailable) return
    void terminalApi.getBashPath().then(setBashPath).catch(() => {})
  }, [isTerminalAvailable])

  const save = async () => {
    const nextPath = bashPath?.trim() || null
    setSaving(true)
    setInvalid(false)
    setSaved(false)
    try {
      await terminalApi.setBashPath(nextPath)
      setBashPath(nextPath)
      setSaved(true)
    } catch {
      setInvalid(true)
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    setSaving(true)
    setInvalid(false)
    setSaved(false)
    try {
      await terminalApi.setBashPath(null)
      setBashPath(null)
      setSaved(true)
    } catch {} finally {
      setSaving(false)
    }
  }

  const browse = async () => {
    if (!isTerminalAvailable) return
    const host = getDesktopHost()
    if (!host.capabilities.dialogs) return
    try {
      const selected = await host.dialogs.open({
        title: t('settings.terminal.bashPathLabel'),
        multiple: false,
        filters: [{ name: 'Bash Executable', extensions: ['exe', '', 'bat', 'cmd', 'ps1'] }],
      })
      if (typeof selected === 'string') {
        setBashPath(selected)
        setInvalid(false)
      }
    } catch {
      // The native dialog being dismissed leaves the current draft unchanged.
    }
  }

  if (!isTerminalAvailable) return null

  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-4 py-3">
      <label className="mb-1.5 block text-sm font-medium text-[var(--color-text-primary)]">{t('settings.terminal.bashPathLabel')}</label>
      <p className="mb-2 text-xs text-[var(--color-text-tertiary)]">{t('settings.terminal.bashPathDescription')}</p>
      <div className="flex gap-2">
        <input
          type="text"
          value={bashPath || ''}
          onChange={(event) => { setBashPath(event.target.value); setInvalid(false); setSaved(false) }}
          placeholder={t('settings.terminal.bashPathLabel')}
          className="flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1.5 text-sm font-mono text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)] focus:border-[var(--color-border-focus)]"
        />
        <button type="button" onClick={() => void browse()} className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)]">
          <span className="material-symbols-outlined text-[16px]">folder_open</span>
        </button>
        <button type="button" onClick={() => void save()} disabled={saving} className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-text-primary)] px-3 text-xs font-medium text-[var(--color-surface)] transition-colors hover:opacity-90 disabled:opacity-50">
          {saved ? t('settings.terminal.bashPathSaved') : t('settings.terminal.bashPathSave')}
        </button>
        <button type="button" onClick={() => void reset()} disabled={saving || bashPath === null} className="inline-flex h-8 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 text-xs font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] disabled:opacity-50">
          {t('settings.terminal.bashPathReset')}
        </button>
      </div>
      {invalid ? <p className="mt-1.5 text-xs text-[var(--color-error)]">{t('settings.terminal.bashPathInvalid')}</p> : null}
    </div>
  )
}
