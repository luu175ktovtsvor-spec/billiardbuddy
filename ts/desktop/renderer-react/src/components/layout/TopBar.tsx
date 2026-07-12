// 主区顶栏(对齐 Codex 线程头「📁 任务名 ···」):左=文件夹图标+对话标题+「···」线程菜单、右=图标排[搜索/分享/历史/右侧面板开关]。
// 「···」菜单 = Codex threadHeader 动作里前端数据现成的那部分:复制整段对话/复制会话 ID/复制工作目录/归档;
// fork/新窗口/副任务要后端与 IPC 配合,等接轨指令再加。右侧面板按钮 → filePreviewStore.togglePanel。
import { useState, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { useUiStore } from '../../stores/uiStore'
import { useChatStore } from '../../stores/chatStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { openNewConversation } from '../../lib/conversations'
import { DRAG, NODRAG } from '../../lib/dragRegion'
import { IconSearch, IconShareUp, IconClock, IconPanelRight, IconPanelLeft, IconFolder, IconMoreHorizontal, IconCopy, IconArchive } from '../shared/icons'
import { ShareModal, composeConversationText } from '../chat/ShareModal'
import { ContextMenu } from '../shared/Menu'
import { toast } from '../../stores/toastStore'
import { t } from '../../i18n'

function IconBtn({ label, active, onClick, children }: { label: string; active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: active ? 'var(--color-text-primary)' : 'var(--color-text-secondary)', background: active ? 'var(--color-surface-selected)' : undefined, ...NODRAG }}
    >
      {children}
    </button>
  )
}

function copyText(text: string, doneMsg: string) {
  try {
    void navigator.clipboard?.writeText(text)
    toast(doneMsg)
  } catch {
    toast('复制失败,再试一次')
  }
}

export function TopBar() {
  const activeTab = useTabStore((s) => s.tabs.find((tb) => tb.id === s.activeTabId) ?? null)
  const panelOpen = useFilePreviewStore((s) => s.panelOpen)
  const togglePanel = useFilePreviewStore((s) => s.togglePanel)
  const collapsed = useUiStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useUiStore((s) => s.toggleSidebar)
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen)
  const nav = useUiStore((s) => s.nav)
  const conversationId = useChatStore((s) => s.conversationId)
  const workspaceRoot = useSettingsStore((s) => s.workspaceRoot)
  const [shareOpen, setShareOpen] = useState(false)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  // 标题随主视图:已安排/插件 显示区名,对话显示会话标题。
  const title = nav === 'scheduled' ? t('scheduled.title') : nav === 'plugins' ? t('plugins.title') : activeTab?.title || t('sidebar.newChat')
  const isChat = nav === 'chat'

  return (
    <>
      <header className={`flex h-14 shrink-0 items-center justify-between pr-6 ${collapsed ? 'pl-[80px]' : 'pl-6'}`} style={DRAG} data-testid="topbar">
        <div className="group/title flex min-w-0 items-center gap-1.5" style={NODRAG}>
          {collapsed && <IconBtn label="展开侧栏" onClick={toggleSidebar}><IconPanelLeft size={18} /></IconBtn>}
          {isChat && <IconFolder size={15} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />}
          <span className="truncate text-sm font-medium" style={{ color: 'var(--color-text-primary)' }}>{title}</span>
          {/* 「···」线程菜单(对齐 Codex threadHeader.moreActions,hover 标题区淡入) */}
          {isChat && (
            <button
              type="button"
              title="更多操作"
              aria-label="更多操作"
              onClick={(e) => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setMenuAt({ x: r.left, y: r.bottom + 4 }) }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity hover:bg-[var(--color-surface-hover)] group-hover/title:opacity-100"
              style={{ color: 'var(--color-text-tertiary)' }}
              data-testid="thread-more"
            >
              <IconMoreHorizontal size={15} />
            </button>
          )}
        </div>
        {/* 对话专属操作(搜索/分享/历史/面板)只在对话视图显示;已安排/插件页不挂。
            终端按钮已随假终端下架(asar 核实 Codex 终端=真交互 xterm+pty,不是 AI 命令回放板;等真终端落地再回来)。 */}
        {isChat && (
          <div className="flex items-center gap-0.5" style={NODRAG}>
            <IconBtn label={t('topbar.search')} onClick={() => setPaletteOpen(true)}><IconSearch size={18} /></IconBtn>
            <IconBtn label={t('topbar.share')} onClick={() => setShareOpen(true)}><IconShareUp size={18} /></IconBtn>
            <IconBtn label={t('topbar.history')} onClick={() => setPaletteOpen(true)}><IconClock size={18} /></IconBtn>
            <IconBtn label={t('topbar.panel')} active={panelOpen} onClick={togglePanel}><IconPanelRight size={18} /></IconBtn>
          </div>
        )}
      </header>
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} title={activeTab?.title} />
      {menuAt && (
        <ContextMenu
          x={menuAt.x}
          y={menuAt.y}
          onClose={() => setMenuAt(null)}
          items={[
            {
              label: '复制整段对话',
              icon: <IconCopy size={15} />,
              onClick: () => copyText(composeConversationText(activeTab?.title), '整段对话已复制'),
            },
            {
              label: '复制会话 ID',
              icon: <IconCopy size={15} />,
              onClick: () => { if (conversationId) copyText(conversationId, '会话 ID 已复制') },
            },
            ...(workspaceRoot
              ? [{
                  label: '复制工作目录',
                  icon: <IconFolder size={15} />,
                  onClick: () => copyText(workspaceRoot, '工作目录路径已复制'),
                }]
              : []),
            {
              label: '归档此任务',
              icon: <IconArchive size={15} />,
              separatorBefore: true,
              onClick: () => {
                if (!conversationId) return
                useSessionStore.getState().toggleArchive(conversationId)
                toast('已归档,可在侧栏「已归档」里找回')
                openNewConversation()
              },
            },
          ]}
        />
      )}
    </>
  )
}
