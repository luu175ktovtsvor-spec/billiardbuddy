import { useEffect, type ReactNode } from 'react'
import { PRODUCT_TASKS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { ScheduledTasks } from '../../pages/ScheduledTasks'
import { Settings } from '../../pages/Settings'
import { TerminalSettings } from '../../pages/TerminalSettings'
import { ImageWorkbench } from '../media/ImageWorkbench'
import { VideoStudio } from '../media/VideoStudio'
import { ProductShell } from '../../product/components/ProductShell'
import { ProductTaskPage } from '../../product/components/ProductTaskPage'
import { previewBridge } from '../../lib/previewBridge'

const PRODUCT_TASKS_TAB_TITLE = '任务中心'

function isLegacyTabType(type: string | undefined): boolean {
  return type === 'session' || type === 'workbench'
}

export function ContentRouter() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTab = tabs.find((t) => t.sessionId === activeTabId)
  const activeTabType = activeTab?.type
  const terminalTabs = tabs.filter((tab) => tab.type === 'terminal')

  useEffect(() => {
    if (activeTabType === 'product-task') return
    void previewBridge.close()
  }, [activeTabType])

  useEffect(() => {
    const legacyTabIds = tabs
      .filter((tab) => isLegacyTabType(tab.type))
      .map((tab) => tab.sessionId)
    if (legacyTabIds.length === 0) return

    const activeWasLegacy = activeTabId !== null && legacyTabIds.includes(activeTabId)
    const store = useTabStore.getState()
    for (const tabId of legacyTabIds) {
      store.closeTab(tabId)
    }
    if (activeWasLegacy) {
      store.openTab(PRODUCT_TASKS_TAB_ID, PRODUCT_TASKS_TAB_TITLE, 'product-tasks')
    }
  }, [activeTabId, tabs])

  let page: ReactNode = null
  if (!activeTabId || !activeTabType) {
    page = <ProductShell page="new-task" />
  } else if (activeTabType === 'settings') {
    page = <Settings />
  } else if (activeTabType === 'scheduled') {
    page = <ScheduledTasks />
  } else if (activeTabType === 'image-workbench') {
    page = <ImageWorkbench />
  } else if (activeTabType === 'video-studio') {
    page = <VideoStudio />
  } else if (activeTabType === 'product-tasks') {
    page = <ProductShell />
  } else if (activeTabType === 'new-product-task') {
    page = (
      <ProductShell
        key={activeTab?.newTaskRequestId ?? 'new-product-task'}
        page="new-task"
        initialWorkDir={activeTab?.newTaskWorkDir}
      />
    )
  } else if (activeTabType === 'product-task') {
    page = activeTab?.taskId
      ? <ProductTaskPage taskId={activeTab.taskId} />
      : <ProductShell />
  } else if (isLegacyTabType(activeTabType)) {
    // Render a product surface while the effect above removes every stale
    // legacy tab. A raw Core id must never select a renderer surface.
    page = <ProductShell page="new-task" />
  } else if (activeTabType !== 'terminal') {
    // A persisted or plugin-provided unknown tab must not fall back to the
    // legacy Core-session surface, which would treat its tab id as a session
    // id. Return users to the product shell instead.
    page = <ProductShell page="new-task" />
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {page && (
        <div className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden">
          {page}
        </div>
      )}
      {terminalTabs.map((tab) => {
        const active = tab.sessionId === activeTabId
        const visible = activeTabType === 'terminal' && active
        return (
          <div
            key={tab.sessionId}
            aria-hidden={!visible}
            data-testid={`terminal-tab-panel-${tab.sessionId}`}
            className={`absolute inset-0 flex min-h-0 flex-col overflow-hidden ${
              visible ? 'z-20 opacity-100' : 'pointer-events-none z-0 opacity-0'
            }`}
          >
            <TerminalSettings
              active={active}
              cwd={tab.terminalCwd}
              runtimeId={tab.terminalRuntimeId ?? tab.sessionId}
              workspace
              testId={`terminal-host-${tab.sessionId}`}
              onNewTerminal={() => useTabStore.getState().openTerminalTab(tab.terminalCwd)}
            />
          </div>
        )
      })}
    </div>
  )
}
