import { create } from 'zustand'

export type ProductTaskBrowserPreviewMode = 'browser' | 'preview'

export type ProductTaskBrowserPreviewState = {
  browserOpen: boolean
  previewOpen: boolean
  activeMode: ProductTaskBrowserPreviewMode | null
}

type ProductTaskBrowserPreviewStore = {
  byTaskId: Record<string, ProductTaskBrowserPreviewState | undefined>
  openPanel: (taskId: string, mode: ProductTaskBrowserPreviewMode) => void
  closePanel: (taskId: string, mode: ProductTaskBrowserPreviewMode) => void
  activatePanel: (taskId: string, mode: ProductTaskBrowserPreviewMode) => void
}

const DEFAULT_PANEL_STATE: ProductTaskBrowserPreviewState = {
  browserOpen: false,
  previewOpen: false,
  activeMode: null,
}

function currentState(
  byTaskId: Record<string, ProductTaskBrowserPreviewState | undefined>,
  taskId: string,
): ProductTaskBrowserPreviewState {
  return byTaskId[taskId] ?? DEFAULT_PANEL_STATE
}

function otherMode(mode: ProductTaskBrowserPreviewMode): ProductTaskBrowserPreviewMode {
  return mode === 'browser' ? 'preview' : 'browser'
}

/**
 * Browser-panel state is keyed only by the public product task id. The suffix
 * keeps the manual Browser and Preview histories independent while the desktop
 * host renders only the active one at a time.
 */
export function productTaskBrowserPreviewKey(
  taskId: string,
  mode: ProductTaskBrowserPreviewMode,
): string {
  return `product-task:${taskId}:${mode}`
}

export const useProductTaskBrowserPreviewStore = create<ProductTaskBrowserPreviewStore>((set) => ({
  byTaskId: {},

  openPanel: (taskId, mode) => set((state) => {
    const current = currentState(state.byTaskId, taskId)
    return {
      byTaskId: {
        ...state.byTaskId,
        [taskId]: {
          ...current,
          [mode === 'browser' ? 'browserOpen' : 'previewOpen']: true,
          activeMode: mode,
        },
      },
    }
  }),

  closePanel: (taskId, mode) => set((state) => {
    const current = currentState(state.byTaskId, taskId)
    const other = otherMode(mode)
    const otherIsOpen = other === 'browser' ? current.browserOpen : current.previewOpen
    return {
      byTaskId: {
        ...state.byTaskId,
        [taskId]: {
          ...current,
          [mode === 'browser' ? 'browserOpen' : 'previewOpen']: false,
          activeMode: current.activeMode === mode
            ? (otherIsOpen ? other : null)
            : current.activeMode,
        },
      },
    }
  }),

  activatePanel: (taskId, mode) => set((state) => {
    const current = currentState(state.byTaskId, taskId)
    const isOpen = mode === 'browser' ? current.browserOpen : current.previewOpen
    if (!isOpen) return state
    return {
      byTaskId: {
        ...state.byTaskId,
        [taskId]: {
          ...current,
          activeMode: mode,
        },
      },
    }
  }),
}))
