import { useEffect, useMemo, useRef, useState } from 'react'
import { getMcpRequestErrorCode } from '../api/mcp'
import { Button } from '../components/shared/Button'
import { ConfirmDialog } from '../components/shared/ConfirmDialog'
import { DirectoryPicker } from '../components/shared/DirectoryPicker'
import { Input } from '../components/shared/Input'
import { useTranslation, type TranslationKey } from '../i18n'
import { useMcpStore } from '../stores/mcpStore'
import { useUIStore } from '../stores/uiStore'
import type { McpServerRecord, McpUpsertPayload, McpWritableScope } from '../types/mcp'
import { useCurrentProductTaskContext } from '../product/currentProductTaskContext'
import { useProductTaskStore } from '../product/stores/productTaskStore'

type View =
  | { type: 'list' }
  | { type: 'configure'; server?: McpServerRecord }
  | { type: 'details'; server: McpServerRecord }

type TransportKind = 'stdio' | 'http' | 'sse'

type StringRow = {
  id: string
  value: string
}

type KeyValueRow = {
  id: string
  key: string
  value: string
}

type McpDraft = {
  name: string
  scope: McpWritableScope
  projectPath: string
  transport: TransportKind
  command: string
  args: StringRow[]
  env: KeyValueRow[]
  url: string
  headers: KeyValueRow[]
  headersHelper: string
  oauthClientId: string
  oauthCallbackPort: string
}

const WRITABLE_SCOPES: McpWritableScope[] = ['local', 'project', 'user']

const STATUS_TONE: Record<McpServerRecord['status'], string> = {
  connected: 'bg-[var(--color-inspector-success-bg)] text-[var(--color-inspector-success)] border-[var(--color-border)]',
  checking: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
  'needs-auth': 'bg-[var(--color-surface-container-low)] text-[var(--color-warning)] border-[var(--color-border)]',
  failed: 'bg-[var(--color-inspector-danger-bg)] text-[var(--color-inspector-danger)] border-[var(--color-border)]',
  disabled: 'bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] border-[var(--color-border)]',
}

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createStringRow(value = ''): StringRow {
  return { id: createId(), value }
}

function createKeyValueRow(key = '', value = ''): KeyValueRow {
  return { id: createId(), key, value }
}

function asWritableScope(scope: string): McpWritableScope {
  return scope === 'project' || scope === 'user' ? scope : 'local'
}

function editableTransport(transport: string): TransportKind {
  return transport === 'http' || transport === 'sse' ? transport : 'stdio'
}

function scopeRequiresProject(scope: McpWritableScope) {
  return scope === 'local' || scope === 'project'
}

function isMcpServerNameValid(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && !/[^\p{L}\p{N}_-]/u.test(trimmed)
}

function createDraft(server?: McpServerRecord, defaultProjectPath = ''): McpDraft {
  return {
    name: server?.name ?? '',
    scope: server ? asWritableScope(server.scope) : 'local',
    projectPath: server?.projectPath ?? defaultProjectPath,
    transport: editableTransport(server?.transport ?? 'stdio'),
    command: '',
    args: [createStringRow()],
    env: [createKeyValueRow()],
    url: '',
    headers: [createKeyValueRow()],
    headersHelper: '',
    oauthClientId: '',
    oauthCallbackPort: '',
  }
}

function rowsToRecord(rows: KeyValueRow[]) {
  return Object.fromEntries(
    rows
      .map((row) => [row.key.trim(), row.value] as const)
      .filter(([key]) => key.length > 0),
  )
}

function rowsToList(rows: StringRow[]) {
  return rows.map((row) => row.value.trim()).filter(Boolean)
}

function buildPayload(draft: McpDraft): McpUpsertPayload {
  if (draft.transport === 'stdio') {
    return {
      scope: draft.scope,
      config: {
        type: 'stdio',
        command: draft.command.trim(),
        args: rowsToList(draft.args),
        env: rowsToRecord(draft.env),
      },
    }
  }

  const callbackPort = Number(draft.oauthCallbackPort.trim())
  const validCallbackPort = Number.isInteger(callbackPort) && callbackPort > 0 && callbackPort <= 65535
  const oauthClientId = draft.oauthClientId.trim()

  return {
    scope: draft.scope,
    config: {
      type: draft.transport,
      url: draft.url.trim(),
      headers: rowsToRecord(draft.headers),
      ...(draft.headersHelper.trim() ? { headersHelper: draft.headersHelper.trim() } : {}),
      ...(oauthClientId || validCallbackPort
        ? {
            oauth: {
              ...(oauthClientId ? { clientId: oauthClientId } : {}),
              ...(validCallbackPort ? { callbackPort } : {}),
            },
          }
        : {}),
    },
  }
}

function isDraftValid(draft: McpDraft) {
  if (!isMcpServerNameValid(draft.name)) return false
  if (scopeRequiresProject(draft.scope) && !draft.projectPath.trim()) return false
  return draft.transport === 'stdio' ? Boolean(draft.command.trim()) : Boolean(draft.url.trim())
}

function scopeTranslationKey(server: McpServerRecord): TranslationKey {
  if (server.name.startsWith('plugin:')) return 'settings.mcp.scope.plugin'
  switch (server.scope) {
    case 'user':
      return 'settings.mcp.scope.user'
    case 'project':
      return 'settings.mcp.scope.project'
    case 'local':
      return 'settings.mcp.scope.local'
    case 'managed':
      return 'settings.mcp.scope.managed'
    case 'enterprise':
      return 'settings.mcp.scope.enterprise'
    case 'claudeai':
      return 'settings.mcp.scope.claudeai'
    default:
      return 'settings.mcp.scope.dynamic'
  }
}

function statusTranslationKey(status: McpServerRecord['status']): TranslationKey {
  switch (status) {
    case 'connected':
      return 'status.connected'
    case 'checking':
      return 'status.connecting'
    case 'needs-auth':
      return 'settings.mcp.status.needsAuth'
    case 'disabled':
      return 'settings.mcp.status.disabled'
    case 'failed':
      return 'settings.mcp.status.unavailable'
  }
}

function getServerIdentityKey(server: Pick<McpServerRecord, 'name' | 'scope' | 'projectPath'>) {
  if (server.scope === 'local' || server.scope === 'project') {
    return `${server.scope}:${server.projectPath ?? ''}:${server.name}`
  }
  return `${server.scope}:${server.name}`
}

function StatusBadge({ server }: { server: McpServerRecord }) {
  const t = useTranslation()
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${STATUS_TONE[server.status]}`}>
      {t(statusTranslationKey(server.status))}
    </span>
  )
}

function ToggleSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={onChange}
      className={`relative inline-flex h-8 w-14 items-center rounded-full transition-colors ${
        checked ? 'bg-[var(--color-switch-checked-bg)]' : 'bg-[var(--color-border)]'
      } ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}`}
    >
      <span
        className={`inline-block h-6 w-6 transform rounded-full bg-[var(--color-switch-thumb)] shadow-sm transition-transform ${
          checked ? 'translate-x-7' : 'translate-x-1'
        }`}
      />
    </button>
  )
}

function StringRows({
  label,
  rows,
  placeholder,
  addLabel,
  onChange,
  onAdd,
  onRemove,
}: {
  label: string
  rows: StringRow[]
  placeholder: string
  addLabel: string
  onChange: (id: string, value: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
}) {
  return (
    <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">{label}</div>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_32px] gap-3">
            <Input value={row.value} onChange={(event) => onChange(row.id, event.target.value)} placeholder={placeholder} />
            <button
              type="button"
              onClick={() => onRemove(row.id)}
              aria-label={addLabel}
              className="flex h-10 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          {addLabel}
        </button>
      </div>
    </section>
  )
}

function KeyValueRows({
  label,
  rows,
  addLabel,
  onChange,
  onAdd,
  onRemove,
}: {
  label: string
  rows: KeyValueRow[]
  addLabel: string
  onChange: (id: string, field: 'key' | 'value', value: string) => void
  onAdd: () => void
  onRemove: (id: string) => void
}) {
  const t = useTranslation()
  return (
    <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="mb-4 text-sm font-semibold text-[var(--color-text-primary)]">{label}</div>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_32px] gap-3">
            <Input value={row.key} onChange={(event) => onChange(row.id, 'key', event.target.value)} placeholder={t('settings.mcp.form.keyPlaceholder')} />
            <Input type="password" value={row.value} onChange={(event) => onChange(row.id, 'value', event.target.value)} placeholder={t('settings.mcp.form.valuePlaceholder')} />
            <button
              type="button"
              onClick={() => onRemove(row.id)}
              aria-label={addLabel}
              className="flex h-10 w-8 items-center justify-center rounded-[var(--radius-md)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
            >
              <span className="material-symbols-outlined text-[18px]">delete</span>
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={onAdd}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-[var(--radius-lg)] bg-[var(--color-surface-hover)] text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
        >
          <span className="material-symbols-outlined text-[18px]">add</span>
          {addLabel}
        </button>
      </div>
    </section>
  )
}

function ServerRow({
  server,
  isBusy,
  onManage,
  onToggle,
}: {
  server: McpServerRecord
  isBusy: boolean
  onManage: () => void
  onToggle: () => void
}) {
  const t = useTranslation()
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 border-t border-[var(--color-border)] px-6 py-5 first:border-t-0">
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="truncate text-[1.05rem] font-semibold text-[var(--color-text-primary)]">{server.name}</div>
          <StatusBadge server={server} />
        </div>
        <div className="mt-2 text-xs text-[var(--color-text-tertiary)]">{t(scopeTranslationKey(server))}</div>
      </div>
      <button
        type="button"
        onClick={onManage}
        aria-label={`${t('settings.mcp.manage')} ${server.name}`}
        className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)]"
      >
        <span className="material-symbols-outlined text-[20px]">settings</span>
      </button>
      <ToggleSwitch checked={server.enabled} disabled={isBusy || !server.canToggle} onChange={onToggle} />
    </div>
  )
}

export function McpSettings() {
  const {
    servers,
    isLoading,
    error,
    fetchServers,
    createServer,
    updateServer,
    deleteServer,
    toggleServer,
    reconnectServer,
    refreshServerStatus,
    selectServer,
  } = useMcpStore()
  const addToast = useUIStore((state) => state.addToast)
  const { taskId: currentTaskId, workDir: currentWorkDir } = useCurrentProductTaskContext()
  const productProjects = useProductTaskStore((state) => state.index.projects)
  const t = useTranslation()
  const [view, setView] = useState<View>({ type: 'list' })
  const [draft, setDraft] = useState<McpDraft>(() => createDraft(undefined, currentWorkDir))
  const [isInitialLoading, setIsInitialLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [busyServerKey, setBusyServerKey] = useState<string | null>(null)
  const [pendingDeleteServer, setPendingDeleteServer] = useState<McpServerRecord | null>(null)
  const projectPathsForFetchRef = useRef<string[] | undefined>(undefined)
  const refreshInFlightRef = useRef(new Set<string>())

  const resolveOperationCwd = (server?: McpServerRecord) => server?.projectPath ?? currentWorkDir

  useEffect(() => {
    let cancelled = false
    setIsInitialLoading(useMcpStore.getState().servers.length === 0)

    const paths = [currentWorkDir, ...productProjects.map((project) => project.workDir)]
      .filter((path): path is string => Boolean(path))
    projectPathsForFetchRef.current = Array.from(new Set(paths))

    void fetchServers(
      projectPathsForFetchRef.current.length > 0 ? projectPathsForFetchRef.current : undefined,
      currentWorkDir,
    )
      .finally(() => {
        if (!cancelled) setIsInitialLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [currentWorkDir, fetchServers, productProjects])

  useEffect(() => {
    const pending = servers.filter((server) => (
      server.enabled && server.status === 'checking' && !refreshInFlightRef.current.has(getServerIdentityKey(server))
    ))
    if (pending.length === 0) return

    let cancelled = false
    void Promise.all(pending.slice(0, 2).map(async (server) => {
      const key = getServerIdentityKey(server)
      refreshInFlightRef.current.add(key)
      try {
        const updated = await refreshServerStatus(server, resolveOperationCwd(server))
        if (cancelled) return
        setView((current) => (
          current.type !== 'list' && getServerIdentityKey(current.server ?? server) === key
            ? { ...current, server: updated } as View
            : current
        ))
      } catch {
        // Passive checks should not surface technical connection details.
      } finally {
        refreshInFlightRef.current.delete(key)
      }
    }))

    return () => {
      cancelled = true
    }
  }, [currentWorkDir, refreshServerStatus, servers])

  const stats = useMemo(() => ({
    total: servers.length,
    connected: servers.filter((server) => server.status === 'connected').length,
    attention: servers.filter((server) => server.status === 'failed' || server.status === 'needs-auth').length,
  }), [servers])

  const returnToList = () => {
    setView({ type: 'list' })
    selectServer(null)
  }

  const beginCreate = () => {
    setDraft(createDraft(undefined, currentWorkDir))
    setView({ type: 'configure' })
  }

  const beginManage = (server: McpServerRecord) => {
    selectServer(server)
    if (!server.canEdit) {
      setView({ type: 'details', server })
      return
    }
    setDraft(createDraft(server, currentWorkDir))
    setView({ type: 'configure', server })
  }

  const handleToggle = async (server: McpServerRecord) => {
    setBusyServerKey(getServerIdentityKey(server))
    try {
      const { server: updated, taskSync } = await toggleServer(server, resolveOperationCwd(server), currentTaskId)
      addToast({
        type: taskSync?.applied === false ? 'warning' : 'success',
        message: taskSync?.applied === false
          ? t(
              taskSync.reason === 'not_running'
                ? 'settings.mcp.toast.taskSyncNextRun'
                : 'settings.mcp.toast.taskSyncFailed',
              { name: server.name },
            )
          : updated.enabled
            ? t('settings.mcp.toast.enabled', { name: server.name })
            : t('settings.mcp.toast.disabled', { name: server.name }),
      })
    } catch (error) {
      addToast({
        type: 'error',
        message: getMcpRequestErrorCode(error) === 'PRODUCT_TASK_UNAVAILABLE'
          ? t('settings.mcp.toast.taskUnavailable')
          : t('settings.mcp.toast.toggleFailed'),
      })
    } finally {
      setBusyServerKey(null)
    }
  }

  const handleReconnect = async (server: McpServerRecord) => {
    const key = getServerIdentityKey(server)
    const checking = { ...server, status: 'checking' as const }
    setBusyServerKey(key)
    setView((current) => (
      current.type !== 'list' && getServerIdentityKey(current.server ?? server) === key
        ? { ...current, server: checking } as View
        : current
    ))
    try {
      const updated = await reconnectServer(server, resolveOperationCwd(server))
      setView((current) => (
        current.type !== 'list' && getServerIdentityKey(current.server ?? server) === key
          ? { ...current, server: updated } as View
          : current
      ))
      addToast({
        type: updated.status === 'connected' ? 'success' : 'warning',
        message: updated.status === 'connected'
          ? t('settings.mcp.toast.reconnected', { name: server.name })
          : t('settings.mcp.toast.reconnectFailed'),
      })
    } catch {
      setView((current) => (
        current.type !== 'list' && getServerIdentityKey(current.server ?? server) === key
          ? { ...current, server } as View
          : current
      ))
      addToast({ type: 'error', message: t('settings.mcp.toast.reconnectFailed') })
    } finally {
      setBusyServerKey(null)
    }
  }

  const confirmDelete = async () => {
    const server = pendingDeleteServer
    if (!server) return
    setIsDeleting(true)
    try {
      await deleteServer(server, resolveOperationCwd(server))
      addToast({ type: 'success', message: t('settings.mcp.toast.deleted', { name: server.name }) })
      setPendingDeleteServer(null)
      returnToList()
    } catch {
      addToast({ type: 'error', message: t('settings.mcp.toast.deleteFailed') })
    } finally {
      setIsDeleting(false)
    }
  }

  const handleSave = async () => {
    if (!isDraftValid(draft)) return
    setIsSaving(true)
    try {
      const payload = buildPayload(draft)
      const targetCwd = scopeRequiresProject(draft.scope) ? draft.projectPath.trim() : undefined
      const saved = view.type === 'configure' && view.server
        ? await updateServer(view.server, payload, targetCwd)
        : await createServer(draft.name.trim(), payload, targetCwd)
      addToast({
        type: 'success',
        message: view.type === 'configure' && view.server
          ? t('settings.mcp.toast.saved', { name: saved.name })
          : t('settings.mcp.toast.created', { name: saved.name }),
      })
      returnToList()
    } catch {
      addToast({ type: 'error', message: t('settings.mcp.toast.saveFailed') })
    } finally {
      setIsSaving(false)
    }
  }

  const setDraftField = <K extends keyof McpDraft>(key: K, value: McpDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const updateStringRows = (id: string, value: string) => {
    setDraft((current) => ({
      ...current,
      args: current.args.map((row) => row.id === id ? { ...row, value } : row),
    }))
  }

  const updateKeyValueRows = (kind: 'env' | 'headers', id: string, field: 'key' | 'value', value: string) => {
    setDraft((current) => ({
      ...current,
      [kind]: current[kind].map((row) => row.id === id ? { ...row, [field]: value } : row),
    }))
  }

  const addStringRow = () => setDraft((current) => ({ ...current, args: [...current.args, createStringRow()] }))
  const addKeyValueRow = (kind: 'env' | 'headers') => setDraft((current) => ({
    ...current,
    [kind]: [...current[kind], createKeyValueRow()],
  }))
  const removeStringRow = (id: string) => setDraft((current) => {
    const args = current.args.filter((row) => row.id !== id)
    return { ...current, args: args.length ? args : [createStringRow()] }
  })
  const removeKeyValueRow = (kind: 'env' | 'headers', id: string) => setDraft((current) => {
    const rows = current[kind].filter((row) => row.id !== id)
    return { ...current, [kind]: rows.length ? rows : [createKeyValueRow()] }
  })

  const deleteModal = (
    <ConfirmDialog
      open={pendingDeleteServer !== null}
      onClose={() => {
        if (!isDeleting) setPendingDeleteServer(null)
      }}
      title={t('settings.mcp.form.deleteTitle')}
      body={pendingDeleteServer ? t('settings.mcp.form.deleteConfirmBody', { name: pendingDeleteServer.name }) : ''}
      confirmLabel={t('settings.mcp.form.confirmDelete')}
      cancelLabel={t('settings.mcp.form.cancel')}
      confirmVariant="danger"
      loading={isDeleting}
      onConfirm={confirmDelete}
    />
  )

  if (view.type === 'details') {
    const server = view.server
    return (
      <>
        <div className="max-w-4xl min-w-0">
          <button type="button" onClick={returnToList} className="mb-5 inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('settings.mcp.form.back')}
          </button>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[2.2rem] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">{server.name}</h2>
              <p className="mt-3 max-w-2xl text-base leading-7 text-[var(--color-text-secondary)]">{t('settings.mcp.detailsHint')}</p>
              <div className="mt-4"><StatusBadge server={server} /></div>
            </div>
            {server.canReconnect ? (
              <Button variant="secondary" onClick={() => void handleReconnect(server)} loading={busyServerKey === getServerIdentityKey(server)}>
                <span className="material-symbols-outlined text-[16px]">sync</span>
                {t('settings.mcp.form.reconnect')}
              </Button>
            ) : null}
          </div>
        </div>
        {deleteModal}
      </>
    )
  }

  if (view.type === 'configure') {
    const editing = Boolean(view.server)
    const targetServer = view.server
    const needsProject = scopeRequiresProject(draft.scope)
    const busy = isSaving || isDeleting
    return (
      <>
        <div className="max-w-4xl min-w-0">
          <button type="button" onClick={returnToList} className="mb-5 inline-flex items-center gap-2 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]">
            <span className="material-symbols-outlined text-[18px]">arrow_back</span>
            {t('settings.mcp.form.back')}
          </button>
          <div className="mb-8 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-[2.2rem] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">
                {editing && targetServer ? t('settings.mcp.form.editTitle', { name: targetServer.name }) : t('settings.mcp.form.createTitle')}
              </h2>
              <p className="mt-3 max-w-3xl text-base leading-7 text-[var(--color-text-secondary)]">
                {editing ? t('settings.mcp.form.editHint') : t('settings.mcp.form.createHint')}
              </p>
              {editing ? (
                <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--color-text-tertiary)]">{t('settings.mcp.privateConfigHint')}</p>
              ) : null}
            </div>
            {targetServer?.canReconnect ? (
              <Button variant="secondary" onClick={() => void handleReconnect(targetServer)} loading={busyServerKey === getServerIdentityKey(targetServer)}>
                <span className="material-symbols-outlined text-[16px]">sync</span>
                {t('settings.mcp.form.reconnect')}
              </Button>
            ) : null}
          </div>

          <div className="space-y-4">
            <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <Input
                label={t('settings.mcp.form.name')}
                value={draft.name}
                onChange={(event) => setDraftField('name', event.target.value)}
                placeholder={t('settings.mcp.form.namePlaceholder')}
                disabled={editing}
                required
              />
            </section>

            <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              <div className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">{t('settings.mcp.form.scope')}</div>
              <div className="grid gap-2 md:grid-cols-3">
                {WRITABLE_SCOPES.map((scope) => (
                  <button
                    key={scope}
                    type="button"
                    onClick={() => setDraftField('scope', scope)}
                    className={`rounded-[var(--radius-md)] border px-3 py-3 text-left text-sm font-semibold ${
                      draft.scope === scope
                        ? 'border-[var(--color-border-focus)] bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                        : 'border-[var(--color-border)] text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    {t(`settings.mcp.scope.${scope}` as TranslationKey)}
                  </button>
                ))}
              </div>
              {needsProject ? (
                <div className="mt-5 flex items-center justify-between gap-4 rounded-[var(--radius-lg)] bg-[var(--color-surface-container-low)] p-4">
                  <div className="text-sm text-[var(--color-text-secondary)]">{t('settings.mcp.targetProject.title')}</div>
                  <DirectoryPicker value={draft.projectPath} onChange={(path) => setDraftField('projectPath', path)} />
                </div>
              ) : null}
            </section>

            <section className="overflow-hidden rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)]">
              <div className="grid grid-cols-3">
                {(['stdio', 'http', 'sse'] as TransportKind[]).map((transport) => (
                  <button
                    key={transport}
                    type="button"
                    onClick={() => setDraftField('transport', transport)}
                    className={`h-14 text-sm font-semibold ${
                      draft.transport === transport
                        ? 'bg-[var(--color-surface-selected)] text-[var(--color-text-primary)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]'
                    }`}
                  >
                    {transport === 'stdio' ? 'STDIO' : transport.toUpperCase()}
                  </button>
                ))}
              </div>
            </section>

            {draft.transport === 'stdio' ? (
              <>
                <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                  <Input label={t('settings.mcp.form.command')} value={draft.command} onChange={(event) => setDraftField('command', event.target.value)} placeholder={t('settings.mcp.form.commandPlaceholder')} required />
                </section>
                <StringRows label={t('settings.mcp.form.arguments')} rows={draft.args} placeholder={t('settings.mcp.form.argumentPlaceholder')} addLabel={t('settings.mcp.form.addArgument')} onChange={updateStringRows} onAdd={addStringRow} onRemove={removeStringRow} />
                <KeyValueRows label={t('settings.mcp.form.environmentVariables')} rows={draft.env} addLabel={t('settings.mcp.form.addEnv')} onChange={(id, field, value) => updateKeyValueRows('env', id, field, value)} onAdd={() => addKeyValueRow('env')} onRemove={(id) => removeKeyValueRow('env', id)} />
              </>
            ) : (
              <>
                <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                  <Input label={draft.transport === 'http' ? t('settings.mcp.form.url') : t('settings.mcp.form.sseUrl')} value={draft.url} onChange={(event) => setDraftField('url', event.target.value)} placeholder={t('settings.mcp.form.urlPlaceholder')} required />
                </section>
                <KeyValueRows label={t('settings.mcp.form.headers')} rows={draft.headers} addLabel={t('settings.mcp.form.addHeader')} onChange={(id, field, value) => updateKeyValueRows('headers', id, field, value)} onAdd={() => addKeyValueRow('headers')} onRemove={(id) => removeKeyValueRow('headers', id)} />
                <section className="rounded-[var(--radius-xl)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <Input label={t('settings.mcp.form.oauthClientId')} value={draft.oauthClientId} onChange={(event) => setDraftField('oauthClientId', event.target.value)} placeholder={t('settings.mcp.form.oauthClientIdPlaceholder')} />
                    <Input label={t('settings.mcp.form.oauthCallbackPort')} value={draft.oauthCallbackPort} onChange={(event) => setDraftField('oauthCallbackPort', event.target.value)} placeholder={t('settings.mcp.form.oauthCallbackPortPlaceholder')} />
                  </div>
                  <div className="mt-4">
                    <Input label={t('settings.mcp.form.headersHelper')} value={draft.headersHelper} onChange={(event) => setDraftField('headersHelper', event.target.value)} placeholder={t('settings.mcp.form.headersHelperPlaceholder')} />
                  </div>
                </section>
              </>
            )}

            <div className="flex items-center justify-between gap-3 pt-2">
              {targetServer?.canRemove ? (
                <Button variant="ghost" className="text-[var(--color-error)] hover:bg-[var(--color-error)]/8 hover:text-[var(--color-error)]" onClick={() => setPendingDeleteServer(targetServer)} loading={isDeleting}>
                  <span className="material-symbols-outlined text-[16px]">delete</span>
                  {t('settings.mcp.form.uninstall')}
                </Button>
              ) : <span />}
              <Button onClick={() => void handleSave()} disabled={!isDraftValid(draft) || busy} loading={isSaving}>{t('settings.mcp.form.save')}</Button>
            </div>
          </div>
        </div>
        {deleteModal}
      </>
    )
  }

  const showLoading = (isInitialLoading || isLoading) && servers.length === 0
  return (
    <div className="max-w-5xl min-w-0">
      <div className="mb-8 flex items-start justify-between gap-6">
        <div>
          <h2 className="text-[2.2rem] font-semibold tracking-[-0.03em] text-[var(--color-text-primary)]">{t('settings.mcp.title')}</h2>
          <p className="mt-3 max-w-3xl text-base leading-7 text-[var(--color-text-secondary)]">{t('settings.mcp.description')}</p>
        </div>
        <Button variant="secondary" size="lg" onClick={beginCreate}>
          <span className="material-symbols-outlined text-[18px]">add</span>
          {t('settings.mcp.addServer')}
        </Button>
      </div>

      {showLoading ? (
        <div role="status" className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] text-center">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-[var(--color-brand)] border-t-transparent" />
          <div className="text-sm font-medium text-[var(--color-text-secondary)]">{t('common.loading')}</div>
        </div>
      ) : (
        <>
          <div className="mb-8 grid gap-4 md:grid-cols-3">
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4"><div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.mcp.stats.total')}</div><div className="mt-2 text-3xl font-semibold text-[var(--color-text-primary)]">{stats.total}</div></div>
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4"><div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.mcp.stats.connected')}</div><div className="mt-2 text-3xl font-semibold text-[var(--color-text-primary)]">{stats.connected}</div></div>
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] px-5 py-4"><div className="text-xs text-[var(--color-text-tertiary)]">{t('settings.mcp.stats.attention')}</div><div className="mt-2 text-3xl font-semibold text-[var(--color-text-primary)]">{stats.attention}</div></div>
          </div>

          {error ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] py-14 text-center">
              <p className="text-sm text-[var(--color-text-secondary)]">{t('settings.mcp.loadFailed')}</p>
              <button type="button" onClick={() => void fetchServers(projectPathsForFetchRef.current, currentWorkDir)} className="mt-3 text-sm text-[var(--color-text-accent)] hover:underline">{t('common.retry')}</button>
            </div>
          ) : servers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface-container-low)] py-16 text-center">
              <span className="material-symbols-outlined mb-3 block text-[40px] text-[var(--color-text-tertiary)]">dns</span>
              <p className="text-sm text-[var(--color-text-secondary)]">{t('settings.mcp.empty')}</p>
              <p className="mt-1 text-xs text-[var(--color-text-tertiary)]">{t('settings.mcp.emptyHint')}</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-[28px] border border-[var(--color-border)] bg-[var(--color-surface)]">
              {servers.map((server) => (
                <ServerRow key={getServerIdentityKey(server)} server={server} isBusy={busyServerKey === getServerIdentityKey(server)} onManage={() => beginManage(server)} onToggle={() => void handleToggle(server)} />
              ))}
            </div>
          )}
        </>
      )}
      {deleteModal}
    </div>
  )
}
