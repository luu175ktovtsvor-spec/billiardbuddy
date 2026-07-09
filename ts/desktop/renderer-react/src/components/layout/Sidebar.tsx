// 左栏(对标真机 WorkBuddy 布局:红绿灯位+工具图标 → 品牌行 → 主导航 → 任务分区 → 空间分区 → 底部头像)。
// 底色 gray-3(真机 sidebar-bg),略暗于主区;宽 232px。交互:新建任务/任务项接 chatStore 会话开合。
import { useState, type ReactNode } from 'react'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useUiStore } from '../../stores/uiStore'
import { openNewConversation, openExistingConversation } from '../../lib/conversations'
import { DRAG, NODRAG } from '../../lib/dragRegion'
import { Smiley } from '../shared/Smiley'
import {
  IconPanelLeft, IconSearch, IconFilter, IconPlusCircle, IconUser, IconBranch,
  IconSparkles, IconZap, IconGrid, IconChevronDown, IconChevronRight, IconBell, IconSun, IconMoon,
} from '../shared/icons'
import { t } from '../../i18n'

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts
  if (!ts || Number.isNaN(diff)) return ''
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m}分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}天前`
  try {
    return new Date(ts).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  } catch {
    return ''
  }
}

function ToolBtn({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-tertiary)', ...NODRAG }}
    >
      {children}
    </button>
  )
}

function NavItem({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-10 w-full items-center gap-2.5 rounded-lg px-2.5 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-primary)' }}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center" style={{ color: 'var(--color-text-secondary)' }}>{icon}</span>
      <span className="flex-1 truncate text-sm">{label}</span>
      {hint && <span className="truncate text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{hint}</span>}
    </button>
  )
}

function SectionHeader({ label, count, open, onToggle }: { label: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-1 px-2.5 py-1.5 text-xs font-medium transition-colors hover:text-[var(--color-text-secondary)]"
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      <span className="transition-transform" style={{ transform: open ? 'none' : 'rotate(-90deg)' }}>
        <IconChevronDown size={13} />
      </span>
      <span>{label}</span>
      <span style={{ color: 'var(--color-text-tertiary)' }}>({count})</span>
    </button>
  )
}

export function Sidebar() {
  const sessions = useSessionStore((s) => s.sessions)
  const refresh = useSessionStore((s) => s.refresh)
  const activeId = useChatStore((s) => s.conversationId)
  const toggleTheme = useUiStore((s) => s.toggleTheme)
  const effective = useUiStore((s) => s.effectiveTheme)
  const [tasksOpen, setTasksOpen] = useState(true)
  const [spacesOpen, setSpacesOpen] = useState(true)

  const taskCount = Math.max(sessions.length, 1)

  return (
    <aside
      className="flex h-full shrink-0 flex-col"
      style={{ width: 232, background: 'var(--color-app-sidebar)', borderRight: '1px solid var(--color-border)' }}
      data-testid="sidebar"
    >
      {/* 顶:红绿灯位(左) + 工具图标(右) */}
      <div
        className="flex h-[46px] items-center justify-end gap-0.5 px-2 pl-[78px]"
        style={DRAG}
      >
        <ToolBtn label={t('sidebar.collapse')}><IconPanelLeft size={17} /></ToolBtn>
        <ToolBtn label={t('sidebar.search')}><IconSearch size={17} /></ToolBtn>
        <ToolBtn label={t('sidebar.filter')}><IconFilter size={17} /></ToolBtn>
      </div>

      {/* 品牌行:绿笑脸 + 球房管家 + 版本 */}
      <div className="flex items-center gap-2 px-3 pb-2 pt-1">
        <Smiley size={22} />
        <span className="text-sm font-semibold" style={{ color: 'var(--color-text-primary)' }}>{t('app.name')}</span>
        <span className="text-[11px]" style={{ color: 'var(--color-text-tertiary)' }}>{t('app.version')}</span>
      </div>

      {/* 主导航 */}
      <nav className="px-2 pb-1">
        <NavItem icon={<IconPlusCircle size={18} />} label={t('sidebar.newTask')} onClick={() => openNewConversation()} />
        <NavItem icon={<IconUser size={18} />} label={t('sidebar.assistant')} />
        <NavItem icon={<IconBranch size={18} />} label={t('sidebar.projects')} />
        <NavItem icon={<IconSparkles size={18} />} label={t('sidebar.experts')} />
        <NavItem icon={<IconZap size={18} />} label={t('sidebar.automation')} />
        <NavItem icon={<IconGrid size={18} />} label={t('sidebar.more')} hint={t('sidebar.moreHint')} />
      </nav>

      {/* 分区:任务 + 空间 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1">
        <SectionHeader label={t('sidebar.sectionTasks')} count={taskCount} open={tasksOpen} onToggle={() => setTasksOpen((v) => !v)} />
        {tasksOpen && (
          <div className="mb-2">
            {sessions.length === 0 ? (
              <button
                type="button"
                onClick={() => openNewConversation()}
                className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left"
                style={{ background: 'var(--color-surface-selected)' }}
              >
                <span className="truncate text-sm" style={{ color: 'var(--color-text-primary)' }}>{t('sidebar.newChat')}</span>
                <span className="shrink-0 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>刚刚</span>
              </button>
            ) : (
              sessions.map((s) => {
                const active = s.id === activeId
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      openExistingConversation(s.id, s.title)
                      void refresh()
                    }}
                    className="mb-0.5 flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
                    style={{ background: active ? 'var(--color-surface-selected)' : 'transparent' }}
                  >
                    <span className="truncate text-sm" style={{ color: 'var(--color-text-primary)' }}>{s.title || t('sidebar.newChat')}</span>
                    <span className="shrink-0 text-xs" style={{ color: 'var(--color-text-tertiary)' }}>{fmtRelative(s.updatedAt)}</span>
                  </button>
                )
              })
            )}
          </div>
        )}

        <SectionHeader label={t('sidebar.sectionSpaces')} count={1} open={spacesOpen} onToggle={() => setSpacesOpen((v) => !v)} />
        {spacesOpen && (
          <button
            type="button"
            className="flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
            style={{ color: 'var(--color-text-primary)' }}
          >
            <span className="truncate text-sm">{t('sidebar.spaceGuide')}</span>
            <IconChevronRight size={14} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
          </button>
        )}
      </div>

      {/* 底部:绿笑脸头像 + 用户名 + 铃铛 + 主题小图标 */}
      <div className="flex items-center gap-2 px-3 py-2.5" style={{ borderTop: '1px solid var(--color-border)' }}>
        <Smiley size={26} />
        <span className="flex-1 truncate text-sm" style={{ color: 'var(--color-text-primary)' }}>本机用户</span>
        <ToolBtn label={t('sidebar.notifications')}><IconBell size={17} /></ToolBtn>
        <ToolBtn label="切换主题" onClick={toggleTheme}>
          {effective === 'dark' ? <IconSun size={17} /> : <IconMoon size={17} />}
        </ToolBtn>
      </div>
    </aside>
  )
}
