import { useState } from 'react'
import {
  getPluginRequestErrorCode,
  pluginActionTranslationKey,
  pluginErrorTranslationKey,
} from '../../api/plugins'
import { usePluginStore } from '../../stores/pluginStore'
import { useTranslation } from '../../i18n'
import type { TranslationKey } from '../../i18n'
import { useUIStore } from '../../stores/uiStore'
import { useCurrentProductTaskContext } from '../../product/currentProductTaskContext'
import { Button } from '../shared/Button'
import { ConfirmDialog } from '../shared/ConfirmDialog'
import type {
  PluginAction,
  PluginCapabilityKey,
  PluginDescriptionKind,
  PluginStatus,
} from '../../types/plugin'

const CAPABILITIES: Array<{ key: PluginCapabilityKey; icon: string }> = [
  { key: 'skills', icon: 'auto_awesome' },
  { key: 'agents', icon: 'smart_toy' },
  { key: 'mcpServers', icon: 'hub' },
  { key: 'hooks', icon: 'bolt' },
  { key: 'commands', icon: 'terminal' },
  { key: 'lspServers', icon: 'code' },
]

const PRODUCT_DESCRIPTION_KEYS: Record<PluginDescriptionKind, TranslationKey> = {
  workspace_extension: 'settings.plugins.productDescription.workspaceExtension',
}

export function PluginDetail() {
  const {
    selectedPlugin,
    isDetailLoading,
    isApplying,
    clearSelection,
    enablePlugin,
    disablePlugin,
    updatePlugin,
    uninstallPlugin,
    reloadPlugins,
  } = usePluginStore()
  const { taskId: currentTaskId, workDir: currentWorkDir } = useCurrentProductTaskContext()
  const addToast = useUIStore((s) => s.addToast)
  const t = useTranslation()
  const [actionKey, setActionKey] = useState<string | null>(null)
  const [showUninstallDialog, setShowUninstallDialog] = useState(false)

  if (isDetailLoading) {
    return (
      <div className="flex justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-[var(--color-brand)] border-t-transparent rounded-full" />
      </div>
    )
  }

  if (!selectedPlugin) return null

  const runAction = async (key: string, fn: () => Promise<PluginAction>) => {
    setActionKey(key)
    try {
      const action = await fn()
      addToast({ type: 'success', message: t(pluginActionTranslationKey(action)) })
    } catch (error) {
      addToast({
        type: 'error',
        message: t(pluginErrorTranslationKey(getPluginRequestErrorCode(error))),
      })
    } finally {
      setActionKey(null)
    }
  }

  const handleReload = async () => {
    setActionKey('reload')
    try {
      const summary = await reloadPlugins(currentWorkDir, currentTaskId)
      addToast({
        type: summary.errors > 0 ? 'warning' : 'success',
        message: t('settings.plugins.reloadToast', {
          enabled: String(summary.enabled),
          skills: String(summary.skills),
          errors: String(summary.errors),
        }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: t(pluginErrorTranslationKey(getPluginRequestErrorCode(error))),
      })
    } finally {
      setActionKey(null)
    }
  }

  return (
    <div className="flex flex-col gap-4 min-w-0">
      <div>
        <button
          onClick={clearSelection}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
        >
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          {t('settings.plugins.back')}
        </button>
      </div>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] overflow-hidden">
        <div className="grid gap-4 px-5 py-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.9fr)] lg:items-start">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)] mb-2">
              {t('settings.plugins.entryEyebrow')}
            </div>
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <h3 className="text-[22px] font-semibold leading-tight text-[var(--color-text-primary)] break-all">
                {selectedPlugin.name}
              </h3>
              <StatusPill status={selectedPlugin.status} />
            </div>
            <p className="max-w-4xl text-sm leading-6 text-[var(--color-text-secondary)]">
              {t(PRODUCT_DESCRIPTION_KEYS[selectedPlugin.descriptionKind])}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2">
            {CAPABILITIES.slice(0, 4).map(({ key, icon }) => (
              <DetailStat
                key={key}
                label={t(`settings.plugins.capabilityLabel.${key}`)}
                value={String(selectedPlugin.componentCounts[key])}
                icon={icon}
              />
            ))}
          </div>
        </div>
      </section>

      {selectedPlugin.status === 'attention' && (
        <section className="rounded-2xl border border-[var(--color-error)]/20 bg-[var(--color-error)]/6 px-5 py-4">
          <div className="flex items-start gap-3">
            <span className="material-symbols-outlined text-[18px] text-[var(--color-error)]">error</span>
            <div>
              <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
                {t('settings.plugins.status.attention')}
              </h4>
              <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
                {t('settings.plugins.attentionHint')}
              </p>
            </div>
          </div>
        </section>
      )}

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {selectedPlugin.canManage && (
            selectedPlugin.enabled ? (
              <Button
                variant="secondary"
                size="sm"
                loading={isApplying && actionKey === 'disable'}
                onClick={() => void runAction('disable', () => disablePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, currentTaskId))}
              >
                {t('settings.plugins.disable')}
              </Button>
            ) : (
              <Button
                size="sm"
                loading={isApplying && actionKey === 'enable'}
                onClick={() => void runAction('enable', () => enablePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, currentTaskId))}
              >
                {t('settings.plugins.enable')}
              </Button>
            )
          )}

          {selectedPlugin.canManage && (
            <Button
              variant="secondary"
              size="sm"
              loading={isApplying && actionKey === 'update'}
              onClick={() => void runAction('update', () => updatePlugin(selectedPlugin.id, selectedPlugin.scope, currentWorkDir, currentTaskId))}
            >
              {t('settings.plugins.update')}
            </Button>
          )}

          <Button
            variant="secondary"
            size="sm"
            loading={isApplying && actionKey === 'reload'}
            onClick={() => void handleReload()}
          >
            {t('settings.plugins.apply')}
          </Button>

          {selectedPlugin.canManage && (
            <Button
              variant="danger"
              size="sm"
              loading={isApplying && actionKey === 'uninstall'}
              onClick={() => setShowUninstallDialog(true)}
            >
              {t('settings.plugins.uninstall')}
            </Button>
          )}
        </div>

        {!selectedPlugin.canManage && (
          <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
            {t('settings.plugins.controlsUnavailable')}
          </p>
        )}

        <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
          {t('settings.plugins.applyHint')}
        </p>
      </section>

      <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
          <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">
            {t('settings.plugins.capabilitiesTitle')}
          </h4>
          <p className="text-xs text-[var(--color-text-tertiary)] mt-1">
            {t('settings.plugins.capabilitiesHint')}
          </p>
        </div>
        <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
          {CAPABILITIES.map(({ key, icon }) => (
            <DetailStat
              key={key}
              label={t(`settings.plugins.capabilityLabel.${key}`)}
              value={String(selectedPlugin.componentCounts[key])}
              icon={icon}
            />
          ))}
        </div>
      </section>

      <ConfirmDialog
        open={showUninstallDialog}
        onClose={() => {
          if (isApplying && actionKey === 'uninstall') return
          setShowUninstallDialog(false)
        }}
        onConfirm={async () => {
          setShowUninstallDialog(false)
          await runAction('uninstall', () => uninstallPlugin(selectedPlugin.id, selectedPlugin.scope, false, currentWorkDir, currentTaskId))
        }}
        title={t('settings.plugins.uninstall')}
        body={t('settings.plugins.confirmUninstall', { name: selectedPlugin.name })}
        confirmLabel={t('settings.plugins.uninstall')}
        cancelLabel={t('common.cancel')}
        confirmVariant="danger"
        loading={isApplying && actionKey === 'uninstall'}
      />
    </div>
  )
}

function DetailStat({
  label,
  value,
  icon,
}: {
  label: string
  value: string
  icon: string
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)]">
        <span className="material-symbols-outlined text-[16px]">{icon}</span>
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-[var(--color-text-primary)]">{value}</div>
    </div>
  )
}

function StatusPill({ status }: { status: PluginStatus }) {
  const t = useTranslation()
  const className = status === 'attention'
    ? 'bg-[var(--color-error)]/12 text-[var(--color-error)]'
    : status === 'enabled'
      ? 'bg-[var(--color-success-container)] text-[var(--color-success)]'
      : 'bg-[var(--color-surface-container-high)] text-[var(--color-text-tertiary)]'

  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${className}`}>
      {t(`settings.plugins.status.${status}`)}
    </span>
  )
}
