// 插件页(照 Codex/ChatGPT「Plugins / Connectors」:主区卡片网格,给管家接能力/外部服务)。
// 分三块:①内置能力(管家开箱就有的本机能力,恒亮、信息卡)②可挂载领域包(台球运营专家,真实开关)
// ③MCP 连接器:一键启用预设(Playwright/高德)+ 已装列表 + 添加/删除 —— 全接**真实**后端 /api/v1/agent/mcp*。
import { useEffect, useState, type ReactNode } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { Modal } from '../components/shared/Modal'
import { IconTile, PageHeader, PrimaryButton, SecondaryButton } from '../components/shared/PageKit'
import {
  IconPlus, IconGlobe2, IconFolder, IconSparkles, IconTerminal, IconTarget, IconCheckCircle, IconPuzzle, IconWrench, IconTrash,
} from '../components/shared/icons'
import { t } from '../i18n'
import { toast } from '../stores/toastStore'
import { api } from '../api/client'
import { mcpApi, addInputFromPreset, type McpPreset, type McpServerStatus, type AddMcpInput } from '../api/mcp'

/** 技能条目(接后端 /api/v1/agent/skills)。 */
interface SkillInfo {
  name: string
  description: string
  source?: string
  argument_hint?: string
  user_invocable?: boolean
}

interface Builtin {
  id: string
  name: string
  desc: string
  icon: ReactNode
}

const BUILTINS: Builtin[] = [
  { id: 'web', name: '网页搜索', desc: '联网搜资料、查文档、看最新信息。', icon: <IconGlobe2 size={18} /> },
  { id: 'files', name: '本地文件', desc: '读写、整理你电脑上的文件,改前自动备份。', icon: <IconFolder size={18} /> },
  { id: 'image', name: '生成图片', desc: '出海报、改图、生成配图。', icon: <IconSparkles size={18} /> },
  { id: 'shell', name: '运行命令', desc: '在本机跑命令、装工具、批处理。', icon: <IconTerminal size={18} /> },
]

/** 状态药丸:恒亮「已启用」用绿勾。 */
function OnPill() {
  return (
    <span className="inline-flex items-center gap-1 text-[12px]" style={{ color: 'var(--color-success)' }}>
      <IconCheckCircle size={14} /> {t('plugins.on')}
    </span>
  )
}

/** MCP 服务状态药丸:已连接(绿)/已配置/已停用/连接失败(红)。 */
function StatusPill({ s }: { s: McpServerStatus }) {
  const map = {
    connected: { text: `已连接 · ${s.tools} 个工具`, color: 'var(--color-success)' },
    configured: { text: '已配置', color: 'var(--color-text-tertiary)' },
    disabled: { text: '已停用', color: 'var(--color-text-tertiary)' },
    error: { text: '连接失败', color: 'var(--color-danger, #e5484d)' },
  } as const
  const it = map[s.status] ?? map.configured
  return <span className="text-[12px]" style={{ color: it.color }}>{it.text}</span>
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl p-4" style={{ border: '1px solid var(--color-border)' }}>
      {children}
    </div>
  )
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

export function PluginsPage() {
  const enabledPacks = useSettingsStore((s) => s.enabledPacks)
  const setEnabledPacks = useSettingsStore((s) => s.setEnabledPacks)
  const billiardsOn = enabledPacks.includes('billiards')
  const toggleBilliards = () =>
    setEnabledPacks(billiardsOn ? enabledPacks.filter((p) => p !== 'billiards') : [...enabledPacks, 'billiards'])

  const [servers, setServers] = useState<McpServerStatus[]>([])
  const [presets, setPresets] = useState<McpPreset[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)

  const reload = async () => {
    try {
      const [list, pre] = await Promise.all([mcpApi.list(), mcpApi.presets()])
      setServers(list.servers ?? [])
      setPresets(pre.presets ?? [])
    } catch {
      // 后端未就绪/离线:列表留空,不崩(页面仍展示内置能力+领域包)。
    }
    try {
      const s = await api.get<{ skills: SkillInfo[] }>('/api/v1/agent/skills')
      setSkills(s.skills ?? [])
    } catch { /* 技能列表拿不到不影响页面其余部分 */ }
  }
  useEffect(() => { void reload() }, [])

  const installedNames = new Set(servers.map((s) => s.name))

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
    setBusy(true)
    try {
      const r = await mcpApi.remove(name)
      toast(r.message || (r.ok ? '已删除' : '删除失败'))
      if (r.ok) await reload()
    } catch { toast('删除失败') } finally { setBusy(false) }
  }

  return (
    <div className="h-full overflow-y-auto" style={{ background: 'var(--color-app-main)' }} data-testid="plugins-page">
      <div className="mx-auto w-full max-w-[820px] px-8 py-8">
        <PageHeader
          title={t('plugins.title')}
          subtitle={t('plugins.subtitle')}
          action={
            <SecondaryButton onClick={() => setAdding(true)}>
              <IconPlus size={15} /> {t('plugins.add')}
            </SecondaryButton>
          }
        />

        {/* ① 内置能力 */}
        <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('plugins.builtinSection')}
        </h2>
        <div className="mb-8 grid grid-cols-2 gap-3">
          {BUILTINS.map((b) => (
            <Card key={b.id}>
              <div className="flex items-center gap-3">
                <IconTile>{b.icon}</IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{b.name}</div>
                </div>
                <OnPill />
              </div>
              <p className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{b.desc}</p>
            </Card>
          ))}
        </div>

        {/* ② 领域包 */}
        <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('plugins.connectorSection')}
        </h2>
        <div className="mb-8 grid grid-cols-2 gap-3">
          {/* 台球运营专家:真实领域包开关 */}
          <Card>
            <div className="flex items-center gap-3">
              <IconTile muted={!billiardsOn}><IconTarget size={18} /></IconTile>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>台球运营专家</div>
              </div>
              <button
                type="button"
                onClick={toggleBilliards}
                className="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors"
                style={
                  billiardsOn
                    ? { background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)' }
                    : { background: 'var(--color-brand)', color: '#fff' }
                }
              >
                {billiardsOn ? t('plugins.domainOn') : t('plugins.domainOff')}
              </button>
            </div>
            <p className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>
              挂上后,管家懂球房运营——获客、留客、助教、活动那一套一线打法随问随答。
            </p>
          </Card>
        </div>

        {/* ③ MCP 连接器:一键启用预设 + 已装列表 + 添加 */}
        <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          MCP 服务
        </h2>
        <div className="grid grid-cols-2 gap-3">
          {/* 预设:一键启用(未装的才显示) */}
          {presets.filter((p) => !installedNames.has(p.id)).map((p) => (
            <Card key={`preset-${p.id}`}>
              <div className="flex items-center gap-3">
                <IconTile muted><IconPuzzle size={18} /></IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{p.name}</div>
                </div>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void enablePreset(p)}
                  className="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:opacity-50"
                  style={{ background: 'var(--color-brand)', color: '#fff' }}
                >
                  {p.needsKey ? '需 key' : '启用'}
                </button>
              </div>
              <p className="mt-2.5 text-[12.5px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{p.desc}</p>
              {(p.needsAsset || p.note) && (
                <p className="mt-1.5 text-[11.5px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)', opacity: 0.8 }}>
                  {p.needsAsset ? '首次启用需后台准备组件。' : ''}{p.note ?? ''}
                </p>
              )}
            </Card>
          ))}

          {/* 已装 MCP 服务(真实后端) */}
          {servers.map((s) => (
            <Card key={`srv-${s.name}`}>
              <div className="flex items-center gap-3">
                <IconTile muted={s.disabled}><IconWrench size={18} /></IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{s.name}</div>
                </div>
                <button
                  type="button"
                  aria-label={t('plugins.remove')}
                  disabled={busy}
                  onClick={() => void removeServer(s.name)}
                  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-container)] disabled:opacity-50"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
              <div className="mt-2.5"><StatusPill s={s} /></div>
            </Card>
          ))}

          {/* 添加 MCP 服务器:虚线卡(点开表单弹窗) */}
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex flex-col items-center justify-center gap-2 rounded-xl px-4 py-6 text-center transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ border: '1px dashed var(--color-border)' }}
          >
            <IconTile muted><IconPuzzle size={18} /></IconTile>
            <div className="text-[13px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{t('plugins.add')}</div>
            <div className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>接入你自己的 MCP 服务器</div>
          </button>
        </div>

        {/* ④ 技能(管家会的招式,对话里斜杠 / 唤起) */}
        {skills.length > 0 && (
          <>
            <h2 className="mb-2.5 mt-8 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
              技能 · {skills.length} 个
            </h2>
            <div className="grid grid-cols-2 gap-3">
              {skills.map((s) => (
                <Card key={s.name}>
                  <div className="flex items-center gap-2">
                    <IconTile muted><IconSparkles size={16} /></IconTile>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium" style={{ color: 'var(--color-text-primary)', fontFamily: 'var(--font-mono)' }}>/{s.name}</div>
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{s.description}</p>
                </Card>
              ))}
            </div>
          </>
        )}
      </div>

      {adding && <AddMcpForm onCancel={() => setAdding(false)} onSave={addConnector} />}
    </div>
  )
}
