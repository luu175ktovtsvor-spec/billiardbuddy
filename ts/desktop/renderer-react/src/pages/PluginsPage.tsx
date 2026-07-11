// 插件页(照 Codex/ChatGPT「Plugins / Connectors」:主区卡片网格,给管家接能力/外部服务)。
// 分两块:①内置能力(管家开箱就有的本机能力,恒亮、信息卡)②连接器(可挂载领域包 + 添加 MCP)。
// 台球领域包的开关接**真实** settingsStore.enabledPacks;MCP 添加后端就绪前占位 toast。
import { useState, type ReactNode } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import { Modal } from '../components/shared/Modal'
import { IconTile, PageHeader, PrimaryButton, SecondaryButton } from '../components/shared/PageKit'
import {
  IconPlus, IconGlobe2, IconFolder, IconSparkles, IconTerminal, IconTarget, IconCheckCircle, IconPuzzle, IconWrench, IconTrash,
} from '../components/shared/icons'
import { t } from '../i18n'

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

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col rounded-xl p-4" style={{ border: '1px solid var(--color-border)' }}>
      {children}
    </div>
  )
}

interface Connector {
  id: string
  name: string
  target: string
}

/** 添加 MCP 服务器表单弹窗。 */
function AddMcpForm({ onCancel, onSave }: { onCancel: () => void; onSave: (c: Connector) => void }) {
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
          <PrimaryButton onClick={() => { if (canSave) onSave({ id: `mcp${Date.now()}`, name: name.trim(), target: target.trim() }) }}>
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
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [adding, setAdding] = useState(false)
  const addConnector = (c: Connector) => { setConnectors((cs) => [...cs, c]); setAdding(false) }
  const removeConnector = (id: string) => setConnectors((cs) => cs.filter((c) => c.id !== id))

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

        {/* ② 连接器 / 领域包 */}
        <h2 className="mb-2.5 text-[12px] font-semibold uppercase tracking-wide" style={{ color: 'var(--color-text-tertiary)' }}>
          {t('plugins.connectorSection')}
        </h2>
        <div className="grid grid-cols-2 gap-3">
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

          {/* 已添加的连接器 */}
          {connectors.map((c) => (
            <Card key={c.id}>
              <div className="flex items-center gap-3">
                <IconTile><IconWrench size={18} /></IconTile>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{c.name}</div>
                </div>
                <button
                  type="button"
                  aria-label={t('plugins.remove')}
                  onClick={() => removeConnector(c.id)}
                  className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-container)]"
                  style={{ color: 'var(--color-text-tertiary)' }}
                >
                  <IconTrash size={15} />
                </button>
              </div>
              <p className="mt-2.5 truncate text-[12px]" style={{ color: 'var(--color-text-tertiary)', fontFamily: 'var(--font-mono)' }}>{c.target}</p>
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
      </div>

      {adding && <AddMcpForm onCancel={() => setAdding(false)} onSave={addConnector} />}
    </div>
  )
}
