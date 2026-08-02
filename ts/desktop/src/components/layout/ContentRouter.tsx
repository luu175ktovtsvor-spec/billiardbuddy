import { useEffect, type ReactNode } from 'react'
import { useTabStore } from '../../stores/tabStore'
import { Settings } from '../../pages/Settings'
import { ImageWorkbench } from '../media/ImageWorkbench'
import { VideoStudio } from '../media/VideoStudio'
import { ProductShell } from '../../product/components/ProductShell'
import { ProductTaskPage } from '../../product/components/ProductTaskPage'
import { ProductScheduledTasksPage } from '../../product/components/ProductScheduledTasksPage'
import { previewBridge } from '../../lib/previewBridge'
import { NativeAgentPage } from '../../agent/components/NativeAgentPage'

export function ContentRouter() {
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTab = tabs.find((t) => t.sessionId === activeTabId)
  const activeTabType = activeTab?.type

  useEffect(() => {
    if (activeTabType === 'product-task') return
    void previewBridge.close()
  }, [activeTabType])

  let page: ReactNode = null
  if (!activeTabId || !activeTabType) {
    page = <NativeAgentPage />
  } else if (activeTabType === 'native-agent') {
    page = (
      <NativeAgentPage
        key={activeTab.sessionId}
        threadId={activeTab.nativeAgentThreadId}
        workDir={activeTab.nativeAgentWorkDir}
        onThreadReady={(threadId, workDir, title) => {
          useTabStore.getState().bindNativeAgentThread(activeTab.sessionId, threadId, workDir, title)
        }}
      />
    )
  } else if (activeTabType === 'settings') {
    page = <Settings />
  } else if (activeTabType === 'scheduled') {
    page = <ProductScheduledTasksPage />
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
      ? <ProductTaskPage key={activeTab.taskId} taskId={activeTab.taskId} />
      : <ProductShell />
  } else {
    // A persisted or plugin-provided unknown tab must not select a task
    // runtime by treating its tab id as public task identity.
    page = <NativeAgentPage />
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {page && (
        <div className="absolute inset-0 z-10 flex min-h-0 flex-col overflow-hidden">
          {page}
        </div>
      )}
    </div>
  )
}
