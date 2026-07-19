import { useEffect, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { ActiveSession } from '../../pages/ActiveSession'
import { ScheduledTasks } from '../../pages/ScheduledTasks'
import { Settings } from '../../pages/Settings'
import { TerminalSettings } from '../../pages/TerminalSettings'
import { WorkbenchTab } from '../workbench/WorkbenchTab'
import { ImageWorkbench } from '../media/ImageWorkbench'
import { VideoStudio } from '../media/VideoStudio'
import { ProductShell } from '../../product/components/ProductShell'
import { previewBridge } from '../../lib/previewBridge'

export function ContentRouter() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTab = tabs.find((t) => t.sessionId === activeTabId)
  const activeTabType = activeTab?.type
  const terminalTabs = tabs.filter((tab) => tab.type === 'terminal')

  useEffect(() => {
    if (activeTabType === 'session' || activeTabType === 'workbench') return
    void previewBridge.close()
  }, [activeTabType])

  let page: ReactNode = null
  if (!activeTabId || !activeTabType) {
    page = <ProductShell page="new-task" />
  } else if (activeTabType === 'settings') {
    page = <Settings />
  } else if (activeTabType === 'scheduled') {
    page = <ScheduledTasks />
  } else if (activeTabType === 'workbench') {
    const workbenchTab = tabs.find((t) => t.sessionId === activeTabId)
    page = workbenchTab?.workbenchSessionId
      ? <WorkbenchTab tabId={activeTabId} sessionId={workbenchTab.workbenchSessionId} />
      : <ProductShell />
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
  } else if (activeTabType !== 'terminal') {
    // 会话页由 ActiveSession 承载。审阅、Diff、文件预览、浏览器和终端
    // 按需挂载，不常驻挤压任务线程。
    page = <ActiveSession />
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
