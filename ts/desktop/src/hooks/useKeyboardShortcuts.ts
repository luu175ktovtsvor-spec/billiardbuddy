import { useEffect, useRef } from 'react'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import {
  getAppZoomKeyboardAction,
  nextAppZoomLevel,
} from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { openProductTaskComposer } from '../product/openTaskComposer'
import { useProductTaskRuntimeStore } from '../product/stores/productTaskRuntimeStore'

export function useKeyboardShortcuts() {
  const openModal = useUIStore((s) => s.openModal)
  const closeModal = useUIStore((s) => s.closeModal)
  const activeModal = useUIStore((s) => s.activeModal)
  const activeProductTaskId = useTabStore((state) => {
    const activeTab = state.tabs.find((tab) => tab.sessionId === state.activeTabId)
    return activeTab?.type === 'product-task' ? activeTab.taskId ?? null : null
  })
  const activeProductTaskRunState = useProductTaskRuntimeStore((state) => (
    activeProductTaskId ? state.tasks[activeProductTaskId]?.runState ?? 'idle' : 'idle'
  ))
  const stopTask = useProductTaskRuntimeStore((state) => state.stopTask)
  const uiZoom = useSettingsStore((s) => s.uiZoom)
  const setUiZoom = useSettingsStore((s) => s.setUiZoom)

  const activeModalRef = useRef(activeModal)
  activeModalRef.current = activeModal
  const activeProductTaskRef = useRef({
    taskId: activeProductTaskId,
    runState: activeProductTaskRunState,
  })
  activeProductTaskRef.current = {
    taskId: activeProductTaskId,
    runState: activeProductTaskRunState,
  }
  const appZoomLevelRef = useRef(uiZoom)
  appZoomLevelRef.current = uiZoom

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const zoomAction = getAppZoomKeyboardAction(e)
      if (zoomAction) {
        e.preventDefault()
        const nextZoom = nextAppZoomLevel(appZoomLevelRef.current, zoomAction)
        appZoomLevelRef.current = nextZoom
        setUiZoom(nextZoom)
        return
      }

      const meta = e.metaKey || e.ctrlKey

      // Cmd+N — New task
      if (meta && e.key === 'n') {
        e.preventDefault()
        openProductTaskComposer()
      }

      // Cmd+K — Open product task search.
      if (meta && e.key === 'k') {
        e.preventDefault()
        openModal('task-search')
      }

      // Escape — Close modal or clear state
      if (e.key === 'Escape') {
        if (activeModalRef.current) {
          closeModal()
        }
      }

      // Cmd+. — Stop the active public product task only.
      if (meta && e.key === '.') {
        const { taskId, runState } = activeProductTaskRef.current
        if (taskId && (runState === 'working' || runState === 'awaiting_approval')) {
          e.preventDefault()
          stopTask(taskId)
        }
      }
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [closeModal, openModal, setUiZoom, stopTask])
}
