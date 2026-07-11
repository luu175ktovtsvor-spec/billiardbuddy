// 内容路由(对齐 cc ContentRouter:无第三方路由)。先按左栏主视图 nav 分发
// (对话 / 已安排 / 插件),对话视图内再按 activeTab.type 分发。
import { useTabStore } from '../../stores/tabStore'
import { useUiStore } from '../../stores/uiStore'
import { ActiveSession } from '../../pages/ActiveSession'
import { EmptySession } from '../../pages/EmptySession'
import { ScheduledPage } from '../../pages/ScheduledPage'
import { PluginsPage } from '../../pages/PluginsPage'

export function ContentRouter() {
  const nav = useUiStore((s) => s.nav)
  const activeTab = useTabStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)

  // 主视图:已安排 / 插件(照 Codex 左栏切主区)。
  if (nav === 'scheduled') return <ScheduledPage />
  if (nav === 'plugins') return <PluginsPage />

  // 对话视图。
  if (!activeTab) return <EmptySession />
  switch (activeTab.type) {
    case 'session':
      return <ActiveSession />
    case 'settings':
      // 设置走弹窗(SettingsModal),此分支保留兜底。
      return <EmptySession />
    default:
      return <EmptySession />
  }
}
