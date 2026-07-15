// 扩展管理页只展示可管理的领域包、插件、MCP 和技能状态。
import { useEffect, useState, type ReactNode } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { Modal } from '../components/shared/Modal'
import { IconTile, PageHeader, PrimaryButton, SecondaryButton } from '../components/shared/PageKit'
import {
  IconPlus, IconSparkles, IconTarget, IconPuzzle, IconWrench, IconTrash,
} from '../components/shared/icons'
import { t } from '../i18n'
import { toast } from '../stores/toastStore'
import { mcpApi, addInputFromPreset, type McpPreset, type McpServerStatus, type AddMcpInput } from '../api/mcp'
import { extensionApi, pluginApi, type ExtensionSkill, type PluginListItem } from '../api/extensions'

export type ExtensionTab = 'plugins' | 'skills' | 'mcp'

const EXTENSION_TABS: Array<{ id: ExtensionTab; label: string }> = [
  { id: 'plugins', label: '插件' },
  { id: 'skills', label: '技能' },
  { id: 'mcp', label: 'MCP' },
]

export function ExtensionTabs({ active, counts, onChange }: {
  active: ExtensionTab
  counts: Record<ExtensionTab, number>
  onChange: (tab: ExtensionTab) => void
}) {
  return (
    <div
      role="tablist"
      aria-label="管理扩展"
      className="inline-flex items-center gap-0.5 rounded-lg p-0.5"
      style={{ background: 'var(--color-surface-container)' }}
    >
      {EXTENSION_TABS.map(tab => {
        const selected = tab.id === active
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(tab.id)}
            className="rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors"
            style={{
              background: selected ? 'var(--color-surface-container-high)' : 'transparent',
              color: selected ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
              boxShadow: selected ? '0 1px 2px rgba(0,0,0,.08)' : 'none',
            }}
          >
            {tab.label}
            <span className="ml-1 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{counts[tab.id]}</span>
          </button>
        )
      })}
    </div>
  )
}

/** MCP 服务状态药丸:已连接(绿)/已配置/已停用/连接失败(红)。 */
function StatusPill({ s }: { s: McpServerStatus }) {
  const map = {
    connected: { text: `已连接 · ${s.tools} 个工具`, color: 'var(--color-success)' },
    configured: { text: '已配置', color: 'var(--color-text-tertiary)' },
    disabled: { text: '已停用', color: 'var(--color-text-tertiary)' },
    error: { text: '连接失败', color: 'var(--color-error)' },
  } as const
  const it = map[s.status] ?? map.configured
  return <span className="text-[12px]" style={{ color: it.color }}>{it.text}</span>
}

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="mb-1 mt-6 px-1 text-[12px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>{children}</h2>
  )
}

function ExtensionRow({ icon, title, description, detail, muted, actions, testId }: {
  icon: ReactNode
  title: ReactNode
  description?: ReactNode
  detail?: ReactNode
  muted?: boolean
  actions?: ReactNode
  testId?: string
}) {
  return (
    <div
      className="flex min-h-[62px] items-center gap-3 px-1 py-3"
      style={{ borderBottom: '1px solid var(--color-border)' }}
      data-testid={testId}
    >
      <IconTile muted={muted} size={34}>{icon}</IconTile>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{title}</div>
        {description && <div className="mt-0.5 line-clamp-2 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{description}</div>}
        {detail && <div className="mt-1 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{detail}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="px-1 py-8 text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>
      {children}
    </div>
  )
}

function Toggle({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ background: checked ? 'var(--color-primary)' : 'color-mix(in srgb, var(--color-text-primary) 18%, transparent)' }}
    >
      <span
        className="absolute top-[2px] h-[18px] w-[18px] rounded-full transition-all"
        style={{ left: checked ? 18 : 2, background: checked ? 'var(--color-on-primary)' : 'var(--cx-gray-0)', boxShadow: '0 1px 2px rgba(0,0,0,.25)' }}
      />
    </button>
  )
}

export function pluginContributionText(plugin: PluginListItem): string {
  const entries = [
    ['技能', plugin.components.skills],
    ['命令', plugin.components.commands],
    ['自动化', plugin.components.hooks],
    ['MCP', plugin.components.mcp],
    ['输出风格', plugin.components['output-styles']],
  ].filter((entry): entry is [string, number] => Number(entry[1]) > 0)
  return entries.length > 0 ? entries.map(([label, count]) => `${label} ${count}`).join(' · ') : '未发现可加载内容'
}

const SKILL_SCOPE_LABEL: Record<ExtensionSkill['layer'], string> = {
  bundled: '系统',
  user: '个人',
  workspace: '项目',
  plugin: '插件',
}

export function skillPresentation(skill: ExtensionSkill) {
  return {
    title: skill.display_name || skill.name,
    description: skill.short_description || skill.when_to_use || skill.description,
    invocation: skill.user_invocable ? `/${skill.name}` : skill.name,
    detail: `${SKILL_SCOPE_LABEL[skill.layer]}${skill.user_invocable ? '' : ' · Agent 自动编排'}`,
  }
}

export function visibleExtensionSkills(skills: ExtensionSkill[]): ExtensionSkill[] {
  return skills.filter(skill => skill.user_invocable)
}

/** 把表单里的「命令或 URL」拆成后端 add 入参:http/sse 开头当远程 url,否则当本机命令+参数。 */
function parseTarget(name: string, target: string): AddMcpInput {
  const raw = target.trim()
  if (/^(https?|sse):\/\//i.test(raw) || /^https?:/i.test(raw)) {
    return { name, url: raw, transport: /\/sse|sse:/i.test(raw) ? 'sse' : undefined }
  }
  const parts = raw.split(/\s+/).filter(Boolean)
  return { name, command: parts[0], args: parts.slice(1) }
}

/** 添加 MCP 服务器表单弹窗。 */
function AddMcpForm({ onCancel, onSave }: { onCancel: () => void; onSave: (input: AddMcpInput) => void }) {
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const canSave = name.trim().length > 0 && target.trim().length > 0

  const field = 'w-full rounded-lg px-3 py-2 text-[13px] outline-none'
  const fieldStyle = { background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' } as const

  return (
    <Modal
      open
      onClose={onCancel}
      title={t('plugins.mcpTitle')}
      maxWidth={480}
      testId="add-mcp"
      footer={
        <>
          <SecondaryButton onClick={onCancel}>{t('plugins.cancel')}</SecondaryButton>
          <PrimaryButton onClick={() => { if (canSave) onSave(parseTarget(name.trim(), target.trim())) }}>
            {t('plugins.save')}
          </PrimaryButton>
        </>
      }
    >
      <div className="px-5 py-4">
        <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('plugins.mcpName')}</label>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('plugins.mcpNamePlaceholder')} className={field} style={fieldStyle} />
        <label className="mb-1.5 mt-4 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{t('plugins.mcpTarget')}</label>
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={t('plugins.mcpTargetPlaceholder')}
          className={field}
          style={{ ...fieldStyle, fontFamily: 'var(--font-mono)' }}
        />
      </div>
    </Modal>
  )
}

function InstallPluginForm({ onCancel, onInstall }: { onCancel: () => void; onInstall: (repo: string) => void }) {
  const [repo, setRepo] = useState('')
  const canInstall = repo.trim().length > 0
  return (
    <Modal
      open
      onClose={onCancel}
      title="从 GitHub 安装插件"
      maxWidth={480}
      testId="install-plugin"
      footer={
        <>
          <SecondaryButton onClick={onCancel}>取消</SecondaryButton>
          <PrimaryButton onClick={() => { if (canInstall) onInstall(repo.trim()) }}>安装</PrimaryButton>
        </>
      }
    >
      <div className="px-5 py-4">
        <label className="mb-1.5 block text-[12.5px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>GitHub 仓库</label>
        <input
          autoFocus
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          placeholder="owner/repository"
          className="w-full rounded-lg px-3 py-2 text-[13px] outline-none"
          style={{ background: 'var(--color-surface-container-low)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)', fontFamily: 'var(--font-mono)' }}
        />
        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>
          插件会下载到本机并保持停用。检查来源和贡献内容后，再单独确认启用。
        </p>
      </div>
    </Modal>
  )
}

export function extensionHeaderActionLabel(tab: ExtensionTab): string | null {
  if (tab === 'plugins') return '安装插件'
  if (tab === 'mcp') return '添加 MCP'
  return null
}

export function PluginsPage() {
  const enabledPacks = useSettingsStore((s) => s.enabledPacks)
  const setEnabledPacks = useSettingsStore((s) => s.setEnabledPacks)
  const billiardsOn = enabledPacks.includes('billiards')
  const toggleBilliards = () =>
    setEnabledPacks(billiardsOn ? enabledPacks.filter((p) => p !== 'billiards') : [...enabledPacks, 'billiards'])
  const workspaceRoot = useSettingsStore((s) => s.workspaceRoot)

  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [presets, setPresets] = useState<McpPreset[]>([])
  const [skills, setSkills] = useState<ExtensionSkill[]>([])
  const [plugins, setPlugins] = useState<PluginListItem[]>([])
  const [activeTab, setActiveTab] = useState<ExtensionTab>('plugins')
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [adding, setAdding] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [pluginBusy, setPluginBusy] = useState<string | null>(null)
  const [pendingPlugin, setPendingPlugin] = useState<PluginListItem | null>(null)
  const [pendingServerRemoval, setPendingServerRemoval] = useState<McpServerStatus | null>(null)

  const reload = async () => {
    const results = await Promise.allSettled([
      mcpApi.list(workspaceRoot ?? undefined),
      mcpApi.presets(),
      extensionApi.skills({ workspaceRoot }),
      pluginApi.list(),
    ])
    if (results[0].status === 'fulfilled') setServers(results[0].value.servers)
    if (results[1].status === 'fulfilled') setPresets(results[1].value.presets)
    if (results[2].status === 'fulfilled') setSkills(results[2].value)
    if (results[3].status === 'fulfilled') setPlugins(results[3].value)
    setLoadFailed(results.some(result => result.status === 'rejected'))
    setLoaded(true)
  }
  useEffect(() => { void reload() }, [workspaceRoot])

  const installedNames = new Set(servers.map((s) => s.name))
  const availablePresets = presets.filter(preset => !installedNames.has(preset.id))
  const visibleSkills = visibleExtensionSkills(skills)
  const tabCounts: Record<ExtensionTab, number> = {
    plugins: plugins.length + 1,
    skills: visibleSkills.length,
    mcp: servers.length + availablePresets.length,
  }

  const enablePreset = async (preset: McpPreset) => {
    if (preset.needsKey) { toast(`「${preset.name}」需要先填 API key,添加时把地址里的占位替换成真实 key。`); return }
    setBusy(true)
    try {
      const r = await mcpApi.add(addInputFromPreset(preset))
      toast(r.message || (r.ok ? '已启用' : '启用失败'))
      if (r.ok) await reload()
    } catch { toast('启用失败,后端未就绪?') } finally { setBusy(false) }
  }

  const addConnector = async (input: AddMcpInput) => {
    setAdding(false); setBusy(true)
    try {
      const r = await mcpApi.add(input)
      toast(r.message || (r.ok ? '已添加' : '添加失败'))
      if (r.ok) await reload()
    } catch { toast('添加失败,后端未就绪?') } finally { setBusy(false) }
  }

  const removeServer = async (name: string) => {
    setPendingServerRemoval(null)
    setBusy(true)
    try {
      const r = await mcpApi.remove(name)
      toast(r.message || (r.ok ? '已删除' : '删除失败'))
      if (r.ok) await reload()
    } catch { toast('删除失败') } finally { setBusy(false) }
  }

  const installPlugin = async (repo: string) => {
    setInstalling(false)
    setBusy(true)
    try {
      const result = await pluginApi.install(repo)
      toast(result.message || (result.ok ? '插件已安装' : '插件安装失败'))
      if (result.ok) await reload()
    } catch {
      toast('插件安装失败')
    } finally {
      setBusy(false)
    }
  }

  const toggleServer = async (server: McpServerStatus, enabled: boolean) => {
    setBusy(true)
    try {
      const result = await mcpApi.toggle(server.name, !enabled)
      toast(result.message || (result.ok ? (enabled ? '已启用' : '已停用') : '操作失败'))
      if (result.ok) await reload()
    } catch { toast('操作失败') } finally { setBusy(false) }
  }

  const updatePlugin = async (plugin: PluginListItem, enabled: boolean) => {
    setPendingPlugin(null)
    setPluginBusy(plugin.name)
    try {
      const result = await pluginApi.toggle(plugin.name, enabled)
      toast(result.message || (result.ok ? (enabled ? '已启用' : '已停用') : '操作失败'))
      if (result.ok) await reload()
    } catch { toast('插件状态更新失败') } finally { setPluginBusy(null) }
  }

  const requestPluginToggle = (plugin: PluginListItem, enabled: boolean) => {
    if (enabled) setPendingPlugin(plugin)
    else void updatePlugin(plugin, false)
  }

  const headerActionLabel = extensionHeaderActionLabel(activeTab)

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="plugins-page">
      <div className="mx-auto w-full max-w-[820px] px-8 py-8">
        <PageHeader
          title={t('plugins.title')}
          subtitle={t('plugins.subtitle')}
          action={activeTab === 'plugins' ? (
            <SecondaryButton onClick={() => setInstalling(true)}>
              <IconPlus size={15} /> {headerActionLabel}
            </SecondaryButton>
          ) : activeTab === 'mcp' ? (
            <SecondaryButton onClick={() => setAdding(true)}>
              <IconPlus size={15} /> {headerActionLabel}
            </SecondaryButton>
          ) : undefined}
        />

        <ExtensionTabs active={activeTab} counts={tabCounts} onChange={setActiveTab} />

        {!loaded && <EmptyState>正在读取扩展...</EmptyState>}

        {loaded && activeTab === 'plugins' && (
          <div role="tabpanel" data-extension-panel="plugins">
            <SectionLabel>知识插件</SectionLabel>
            <ExtensionRow
              icon={<IconTarget size={17} />}
              title="台球运营知识库"
              description="为当前会话提供台球经营知识、门店资料检索和领域工具。"
              muted={!billiardsOn}
              actions={<Toggle checked={billiardsOn} label={`${billiardsOn ? '停用' : '启用'}台球运营知识库`} onChange={toggleBilliards} />}
              testId="domain-pack-billiards"
            />

            <SectionLabel>已安装插件{plugins.length > 0 ? ` · ${plugins.length}` : ''}</SectionLabel>
            {plugins.length > 0 ? plugins.map(plugin => (
              <ExtensionRow
                key={plugin.name}
                icon={<IconPuzzle size={17} />}
                title={plugin.name}
                description={plugin.description || '这个插件没有提供说明。'}
                detail={pluginContributionText(plugin)}
                muted={!plugin.enabled}
                actions={
                  <Toggle
                    checked={plugin.enabled}
                    disabled={pluginBusy === plugin.name}
                    label={`${plugin.enabled ? '停用' : '启用'}插件 ${plugin.name}`}
                    onChange={enabled => requestPluginToggle(plugin, enabled)}
                  />
                }
                testId="installed-plugin"
              />
            )) : <EmptyState>还没有安装插件。</EmptyState>}
          </div>
        )}

        {loaded && activeTab === 'skills' && (
          <div role="tabpanel" data-extension-panel="skills">
            <SectionLabel>当前可用技能{visibleSkills.length > 0 ? ` · ${visibleSkills.length}` : ''}</SectionLabel>
            {visibleSkills.length > 0 ? visibleSkills.map(skill => {
              const presentation = skillPresentation(skill)
              return (
                <ExtensionRow
                  key={`${skill.layer}:${skill.name}`}
                  icon={<IconSparkles size={16} />}
                  title={presentation.title}
                  description={presentation.description}
                  detail={<><span style={{ fontFamily: 'var(--font-mono)' }}>{presentation.invocation}</span>{` · ${presentation.detail}`}</>}
                  testId="extension-skill"
                />
              )
            }) : <EmptyState>当前项目没有可用技能。</EmptyState>}
          </div>
        )}

        {loaded && activeTab === 'mcp' && (
          <div role="tabpanel" data-extension-panel="mcp">
            <SectionLabel>已配置{servers.length > 0 ? ` · ${servers.length}` : ''}</SectionLabel>
            {servers.length > 0 ? servers.map(server => (
              <ExtensionRow
                key={`srv-${server.name}`}
                icon={<IconWrench size={17} />}
                title={server.name}
                detail={<StatusPill s={server} />}
                muted={server.disabled}
                actions={
                  <>
                    <Toggle
                      checked={!server.disabled}
                      disabled={busy}
                      label={`${server.disabled ? '启用' : '停用'} MCP 服务 ${server.name}`}
                      onChange={enabled => void toggleServer(server, enabled)}
                    />
                    <button
                      type="button"
                      aria-label={`${t('plugins.remove')} ${server.name}`}
                      title={t('plugins.remove')}
                      disabled={busy}
                      onClick={() => setPendingServerRemoval(server)}
                      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                      style={{ color: 'var(--color-text-tertiary)' }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </>
                }
                testId="mcp-server"
              />
            )) : <EmptyState>还没有配置 MCP 服务。</EmptyState>}

            {availablePresets.length > 0 && <SectionLabel>可添加</SectionLabel>}
            {availablePresets.map(preset => (
              <ExtensionRow
                key={`preset-${preset.id}`}
                icon={<IconPuzzle size={17} />}
                title={preset.name}
                description={preset.desc}
                detail={[preset.needsAsset ? '首次使用时准备组件' : '', preset.note ?? ''].filter(Boolean).join(' · ') || undefined}
                muted
                actions={
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void enablePreset(preset)}
                    className="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
                    style={{ background: 'var(--color-brand)', color: 'var(--color-on-primary)' }}
                  >
                    {preset.needsKey ? '需 key' : '启用'}
                  </button>
                }
                testId="mcp-preset"
              />
            ))}
          </div>
        )}

        {loadFailed && (
          <p className="mt-5 text-[12px]" style={{ color: 'var(--color-error)' }}>部分扩展状态暂时无法读取。</p>
        )}

      </div>

      {adding && <AddMcpForm onCancel={() => setAdding(false)} onSave={addConnector} />}
      {installing && <InstallPluginForm onCancel={() => setInstalling(false)} onInstall={repo => void installPlugin(repo)} />}
      {pendingPlugin && (
        <Modal
          open
          onClose={() => setPendingPlugin(null)}
          title={`启用“${pendingPlugin.name}”？`}
          maxWidth={480}
          testId="enable-plugin"
          footer={
            <>
              <SecondaryButton onClick={() => setPendingPlugin(null)}>取消</SecondaryButton>
              <PrimaryButton onClick={() => void updatePlugin(pendingPlugin, true)}>确认启用</PrimaryButton>
            </>
          }
        >
          <p className="px-5 py-4 text-[13px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            启用后，这个插件提供的技能、命令、自动化规则和外部服务会进入后续对话。只启用你信任的来源。
          </p>
        </Modal>
      )}
      {pendingServerRemoval && (
        <Modal
          open
          onClose={() => setPendingServerRemoval(null)}
          title={`删除 MCP“${pendingServerRemoval.name}”？`}
          maxWidth={480}
          testId="remove-mcp"
          footer={
            <>
              <SecondaryButton onClick={() => setPendingServerRemoval(null)}>取消</SecondaryButton>
              <button
                type="button"
                onClick={() => void removeServer(pendingServerRemoval.name)}
                className="rounded-lg px-3 py-2 text-[13px] font-medium transition-opacity hover:opacity-90"
                style={{ background: 'var(--color-error)', color: 'white' }}
              >
                删除配置
              </button>
            </>
          }
        >
          <p className="px-5 py-4 text-[13px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
            将从本机移除这个 MCP 的连接配置。外部服务和其中的数据不会被删除。
          </p>
        </Modal>
      )}
    </div>
  )
}
