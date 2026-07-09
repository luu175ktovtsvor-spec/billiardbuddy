// 内容路由(对齐 cc ContentRouter:按 activeTab.type 分发 page,无第三方路由)。
// 地基只挂 session 一种;Block D/F 会加 settings/scheduled/trace/workbench 等分支。
import { useTabStore } from '../../stores/tabStore'
import { ActiveSession } from '../../pages/ActiveSession'
import { EmptySession } from '../../pages/EmptySession'

export function ContentRouter() {
  const activeTab = useTabStore((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null)

  if (!activeTab) return <EmptySession />

  switch (activeTab.type) {
    case 'session':
      return <ActiveSession />
    case 'settings':
      // Block F 接管:设置面板(白标最重)。
      return <EmptySession />
    default:
      return <EmptySession />
  }
}
