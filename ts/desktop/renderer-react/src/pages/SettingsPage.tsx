// 设置页只展示有真实实现支撑的常规、外观、快捷键、插件和归档入口。
import { useState, type ReactNode } from 'react'
import { useUiStore, type ThemeMode } from '../stores/uiStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { openExistingConversation } from '../lib/conversations'
import { toast } from '../stores/toastStore'
import {
  IconSettings, IconSun, IconPuzzle, IconArchive, IconChevronRight, IconFolder,
} from '../components/shared/icons'
import { t } from '../i18n'

type SettingsNav = 'general' | 'appearance' | 'shortcuts' | 'archived'

// 设置开关使用主题主操作色，禁用态降低透明度。
function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange?: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!on)}
      className="relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ background: on ? 'var(--color-primary)' : 'color-mix(in srgb, var(--color-text-primary) 18%, transparent)' }}
    >
      <span
        className="absolute top-[2px] h-[18px] w-[18px] rounded-full transition-all"
        style={{ left: on ? 18 : 2, background: on ? 'var(--color-on-primary)' : 'var(--cx-gray-0)', boxShadow: '0 1px 2px rgba(0,0,0,.25)' }}
      />
    </button>
  )
}

/** 设置行:标题 + 描述(可选)+ 右侧控件;行间由 GroupCard 画分割线。 */
function Row({ title, desc, right }: { title: string; desc?: ReactNode; right: ReactNode }) {
  return (
    <div className="flex items-center gap-6 px-5 py-3.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px]" style={{ color: 'var(--color-text-primary)' }}>{title}</div>
        {desc && <div className="mt-0.5 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{desc}</div>}
      </div>
      <div className="shrink-0">{right}</div>
    </div>
  )
}

/** 分组:组标题小灰字 + 白卡(行间分割线),照 Codex 常规页版式。 */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mb-7">
      <h3 className="mb-2 px-1 text-[13px] font-medium" style={{ color: 'var(--color-text-secondary)' }}>{title}</h3>
      <div className="divide-y divide-[color:var(--color-border)] overflow-hidden rounded-lg" style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)' }}>
        {children}
      </div>
    </section>
  )
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex rounded-lg p-0.5" style={{ background: 'var(--color-surface-container)' }}>
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className="rounded-md px-3 py-1 text-[12.5px] transition-colors"
            style={{ background: on ? 'var(--color-surface)' : 'transparent', color: on ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', boxShadow: on ? 'var(--shadow-control)' : undefined, fontWeight: on ? 600 : 400 }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// —— 常规页 ——
function GeneralPane() {
  const perm = useSettingsStore((s) => s.defaultPermissionMode)
  const hidden = useSettingsStore((s) => s.hiddenPermissionModes)
  const toggleHidden = useSettingsStore((s) => s.togglePermissionModeHidden)
  const preventSleep = useSettingsStore((s) => s.preventSleepWhileRunning)
  const setPreventSleep = useSettingsStore((s) => s.setPreventSleepWhileRunning)
  const packs = useSettingsStore((s) => s.enabledPacks)
  const setPacks = useSettingsStore((s) => s.setEnabledPacks)
  const billiards = packs.includes('billiards')
  void perm

  return (
    <>
      <Group title="权限">
        <Row
          title="默认权限"
          desc="读取工作目录可以直接进行；修改文件、运行命令或执行有副作用的操作时按需确认。"
          right={<Switch on disabled label="默认权限始终显示" />}
        />
        <Row
          title={t('permission.acceptEdits')}
          desc="选择工作文件夹后,新会话默认使用此档:工作区内文件修改直接执行,其他工具按当前权限规则处理。关闭后此档从输入框的权限菜单中隐藏。"
          right={<Switch on={!hidden.includes('acceptEdits')} onChange={() => toggleHidden('acceptEdits')} label="在权限菜单中显示接受修改" />}
        />
        <Row
          title={t('permission.bypass')}
          desc="以完全访问运行时,管家无需你的批准即可编辑电脑上的文件并运行可联网的命令。这会显著增加数据丢失或意外行为的风险。关闭后此档从权限菜单中隐藏。"
          right={<Switch on={!hidden.includes('bypassPermissions')} onChange={() => toggleHidden('bypassPermissions')} label="在权限菜单中显示完全访问" />}
        />
      </Group>

      <Group title="常规">
        <Row
          title="运行时防止系统休眠"
          desc="在管家运行任务时,让电脑保持唤醒状态。"
          right={<Switch on={preventSleep} onChange={setPreventSleep} label="运行时防止系统休眠" />}
        />
        <Row
          title="语言"
          desc="应用界面语言。"
          right={<span className="text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>简体中文</span>}
        />
      </Group>

      <Group title="领域知识">
        <Row
          title="台球运营知识库"
          desc="在当前对话挂载台球房经营知识(只影响当前对话,新对话默认不挂)。也可在输入框敲 /台球 开、/台球关闭 关。"
          right={<Switch on={billiards} onChange={(v) => { setPacks(v ? ['billiards'] : []); toast(v ? '台球运营知识库已挂载(当前对话)' : '台球运营知识库已关闭(当前对话)') }} label="台球运营知识库" />}
        />
      </Group>
    </>
  )
}

// —— 外观页 ——
function AppearancePane() {
  const theme = useUiStore((s) => s.theme)
  const setTheme = useUiStore((s) => s.setTheme)
  return (
    <Group title="主题">
      <Row
        title="主题"
        desc="使用浅色、深色,或匹配系统设置。"
        right={
          <Segmented<ThemeMode>
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
              { value: 'system', label: '跟随系统' },
            ]}
          />
        }
      />
    </Group>
  )
}

// —— 键盘快捷键页(只读)——
const SHORTCUTS: Array<{ keys: string; desc: string }> = [
  { keys: '⌘K', desc: '打开命令面板(搜对话/快捷操作)' },
  { keys: '⌘B', desc: '开合左侧栏' },
  { keys: '⌘\\', desc: '开合右侧工作区面板' },
  { keys: 'Enter', desc: '发送消息(运行中 = 排队)' },
  { keys: 'Shift+Enter', desc: '输入框内换行' },
  { keys: 'Esc', desc: '收起斜杠命令浮层 / 关闭弹层' },
  { keys: '↑ ↓', desc: '斜杠命令浮层内上下选择' },
]
function ShortcutsPane() {
  return (
    <Group title="键盘快捷键">
      {SHORTCUTS.map((s) => (
        <Row
          key={s.keys}
          title={s.desc}
          right={<kbd className="rounded-md px-2 py-0.5 text-[12px]" style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}>{s.keys}</kbd>}
        />
      ))}
    </Group>
  )
}

// —— 已归档任务页 ——
function ArchivedPane() {
  const sessions = useSessionStore((s) => s.sessions)
  const toggleArchive = useSessionStore((s) => s.toggleArchive)
  const removeSession = useSessionStore((s) => s.removeSession)
  const setNav = useUiStore((s) => s.setNav)
  const archived = sessions.filter((s) => s.archived)
  if (archived.length === 0) {
    return (
      <div className="px-1 py-8 text-[13px]" style={{ color: 'var(--color-text-tertiary)' }}>
        还没有已归档的任务。在任务标题旁的「···」菜单里可以归档。
      </div>
    )
  }
  return (
    <Group title="已归档任务">
      {archived.map((s) => (
        <Row
          key={s.id}
          title={s.title || t('sidebar.newChat')}
          right={
            <span className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => { toggleArchive(s.id); toast('已恢复到侧栏') }}
                className="rounded-md px-2.5 py-1 text-[12.5px] transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
              >
                恢复
              </button>
              <button
                type="button"
                onClick={() => { toggleArchive(s.id); setNav('chat'); openExistingConversation(s.id, s.title) }}
                className="rounded-md px-2.5 py-1 text-[12.5px] transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)' }}
              >
                打开
              </button>
              <button
                type="button"
                onClick={() => { if (window.confirm('删除这个任务?聊天记录将一并删除。')) removeSession(s.id) }}
                className="rounded-md px-2.5 py-1 text-[12.5px] transition-colors hover:bg-[var(--color-surface-hover)]"
                style={{ color: 'var(--color-error)', border: '1px solid var(--color-border)' }}
              >
                删除
              </button>
            </span>
          }
        />
      ))}
    </Group>
  )
}

// —— 导航项 ——
function NavRow({ icon, label, active, onClick, trailing }: { icon: ReactNode; label: string; active?: boolean; onClick: () => void; trailing?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className="flex h-[30px] w-full items-center gap-2 rounded-[10px] px-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-primary)', background: active ? 'var(--color-surface-selected)' : undefined }}
    >
      <span className="flex h-4.5 w-4.5 shrink-0 items-center justify-center" style={{ color: 'var(--color-text-secondary)' }}>{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px]">{label}</span>
      {trailing}
    </button>
  )
}

const PANE_TITLE: Record<SettingsNav, string> = {
  general: '常规',
  appearance: '外观',
  shortcuts: '键盘快捷键',
  archived: '已归档任务',
}

export function SettingsPage() {
  const setNav = useUiStore((s) => s.setNav)
  const [pane, setPane] = useState<SettingsNav>('general')

  return (
    <div className="flex h-full" data-testid="settings-page">
      {/* 左:设置导航(照 Codex:返回应用 + 分组) */}
      <aside className="flex w-[240px] shrink-0 flex-col gap-0.5 overflow-y-auto px-3 pb-4 pt-12" style={{ background: 'var(--color-app-sidebar)', borderRight: '1px solid var(--color-border)' }}>
        <button
          type="button"
          onClick={() => setNav('chat')}
          className="mb-3 flex h-[30px] items-center gap-1.5 rounded-[10px] px-2 text-left text-[13px] transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ color: 'var(--color-text-secondary)' }}
          data-testid="settings-back"
        >
          ← 返回应用
        </button>
        <div className="px-2 pb-1 text-[12px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>个人</div>
        <NavRow icon={<IconSettings size={15} />} label="常规" active={pane === 'general'} onClick={() => setPane('general')} />
        <NavRow icon={<IconSun size={15} />} label="外观" active={pane === 'appearance'} onClick={() => setPane('appearance')} />
        <NavRow icon={<IconFolder size={15} />} label="键盘快捷键" active={pane === 'shortcuts'} onClick={() => setPane('shortcuts')} />
        <div className="px-2 pb-1 pt-4 text-[12px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>集成</div>
        <NavRow icon={<IconPuzzle size={15} />} label="插件" onClick={() => setNav('plugins')} trailing={<IconChevronRight size={13} style={{ color: 'var(--color-text-tertiary)' }} />} />
        <div className="px-2 pb-1 pt-4 text-[12px] font-medium" style={{ color: 'var(--color-text-tertiary)' }}>已归档</div>
        <NavRow icon={<IconArchive size={15} />} label="已归档任务" active={pane === 'archived'} onClick={() => setPane('archived')} />
      </aside>

      {/* 右:内容区(标题 + 分组卡,居中限宽,照 Codex) */}
      <main className="min-w-0 flex-1 overflow-y-auto" style={{ background: 'var(--color-app-main)' }}>
        <div className="mx-auto w-full max-w-[760px] px-8 pb-16 pt-12">
          <h1 className="mb-7 text-[20px] font-semibold" style={{ color: 'var(--color-text-primary)' }}>{PANE_TITLE[pane]}</h1>
          {pane === 'general' && <GeneralPane />}
          {pane === 'appearance' && <AppearancePane />}
          {pane === 'shortcuts' && <ShortcutsPane />}
          {pane === 'archived' && <ArchivedPane />}
        </div>
      </main>
    </div>
  )
}
