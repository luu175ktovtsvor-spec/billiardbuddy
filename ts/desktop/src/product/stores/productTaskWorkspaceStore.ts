import { create } from 'zustand'

export type ProductTaskBrowserPreviewMode = 'browser' | 'preview'

export type ProductTaskWorkspaceRightDockPanel = 'review' | 'media' | 'browser-preview'

export type ProductTaskWorkspacePanel = 'review' | 'media' | ProductTaskBrowserPreviewMode | 'terminal'

/**
 * Product-owned workspace chrome, keyed only by the public product task id.
 * Core sessions, paths, and raw tool payloads deliberately stay outside this
 * store so a task surface can be restored without exposing runtime internals.
 */
export type ProductTaskWorkspaceState = {
  reviewOpen: boolean
  mediaOpen: boolean
  browserOpen: boolean
  previewOpen: boolean
  terminalOpen: boolean
  activePanel: ProductTaskWorkspaceRightDockPanel | null
  activeBrowserPreviewMode: ProductTaskBrowserPreviewMode | null
}

type ProductTaskWorkspaceStore = {
  byTaskId: Record<string, ProductTaskWorkspaceState | undefined>
  openPanel: (taskId: string, panel: ProductTaskWorkspacePanel, workspaceAvailable?: boolean) => void
  closePanel: (taskId: string, panel: ProductTaskWorkspacePanel) => void
  activatePanel: (taskId: string, panel: ProductTaskWorkspacePanel) => void
}

const RIGHT_DOCK_PANEL_ORDER: readonly ProductTaskWorkspaceRightDockPanel[] = [
  'review',
  'media',
  'browser-preview',
]

const DEFAULT_WORKSPACE_STATE: ProductTaskWorkspaceState = {
  reviewOpen: false,
  mediaOpen: false,
  browserOpen: false,
  previewOpen: false,
  terminalOpen: false,
  activePanel: null,
  activeBrowserPreviewMode: null,
}

function currentState(
  byTaskId: Record<string, ProductTaskWorkspaceState | undefined>,
  taskId: string,
): ProductTaskWorkspaceState {
  return byTaskId[taskId] ?? DEFAULT_WORKSPACE_STATE
}

function isBrowserPreviewOpen(state: ProductTaskWorkspaceState): boolean {
  return state.browserOpen || state.previewOpen
}

function isRightDockPanelOpen(
  state: ProductTaskWorkspaceState,
  panel: ProductTaskWorkspaceRightDockPanel,
): boolean {
  switch (panel) {
    case 'review':
      return state.reviewOpen
    case 'media':
      return state.mediaOpen
    case 'browser-preview':
      return isBrowserPreviewOpen(state)
  }
}

function nextOpenRightDockPanel(
  closedPanel: ProductTaskWorkspaceRightDockPanel,
  state: ProductTaskWorkspaceState,
): ProductTaskWorkspaceRightDockPanel | null {
  const index = RIGHT_DOCK_PANEL_ORDER.indexOf(closedPanel)
  for (let offset = 1; offset < RIGHT_DOCK_PANEL_ORDER.length; offset += 1) {
    const candidate = RIGHT_DOCK_PANEL_ORDER[
      (index + offset) % RIGHT_DOCK_PANEL_ORDER.length
    ]!
    if (isRightDockPanelOpen(state, candidate)) return candidate
  }
  return null
}

function activeBrowserPreviewMode(
  requestedMode: ProductTaskBrowserPreviewMode | null,
  state: ProductTaskWorkspaceState,
): ProductTaskBrowserPreviewMode | null {
  if (requestedMode === 'browser' && state.browserOpen) return 'browser'
  if (requestedMode === 'preview' && state.previewOpen) return 'preview'
  if (state.browserOpen) return 'browser'
  if (state.previewOpen) return 'preview'
  return null
}

function replaceTaskState(
  state: ProductTaskWorkspaceStore,
  taskId: string,
  next: ProductTaskWorkspaceState,
): Pick<ProductTaskWorkspaceStore, 'byTaskId'> {
  return {
    byTaskId: {
      ...state.byTaskId,
      [taskId]: next,
    },
  }
}

/**
 * Browser store keys also stay in the product boundary. They intentionally
 * derive only from the public task id and the selected product panel.
 */
export function productTaskBrowserPreviewKey(
  taskId: string,
  mode: ProductTaskBrowserPreviewMode,
): string {
  return `product-task:${taskId}:${mode}`
}

export const useProductTaskWorkspaceStore = create<ProductTaskWorkspaceStore>((set) => ({
  byTaskId: {},

  openPanel: (taskId, panel, workspaceAvailable = true) => set((state) => {
    // Review and source preview need a real workspace; renderer state cannot
    // manufacture that capability for an unbound task.
    if (!workspaceAvailable && (panel === 'review' || panel === 'preview')) return state
    const current = currentState(state.byTaskId, taskId)
    let next: ProductTaskWorkspaceState

    switch (panel) {
      case 'browser':
      case 'terminal':
        return state
      case 'preview':
        next = {
          ...current,
          previewOpen: true,
          activePanel: 'browser-preview',
          activeBrowserPreviewMode: 'preview',
        }
        break
      case 'review':
        next = { ...current, reviewOpen: true, activePanel: 'review' }
        break
      case 'media':
        next = { ...current, mediaOpen: true, activePanel: 'media' }
        break
    }

    return replaceTaskState(state, taskId, next)
  }),

  closePanel: (taskId, panel) => set((state) => {
    const current = currentState(state.byTaskId, taskId)
    let next: ProductTaskWorkspaceState

    switch (panel) {
      case 'review': {
        next = { ...current, reviewOpen: false }
        next.activePanel = current.activePanel === 'review'
          ? nextOpenRightDockPanel('review', next)
          : current.activePanel
        break
      }
      case 'media': {
        next = { ...current, mediaOpen: false }
        next.activePanel = current.activePanel === 'media'
          ? nextOpenRightDockPanel('media', next)
          : current.activePanel
        break
      }
      case 'browser':
      case 'preview': {
        next = {
          ...current,
          [panel === 'browser' ? 'browserOpen' : 'previewOpen']: false,
        }
        next.activeBrowserPreviewMode = activeBrowserPreviewMode(
          current.activeBrowserPreviewMode,
          next,
        )
        if (!isBrowserPreviewOpen(next) && current.activePanel === 'browser-preview') {
          next.activePanel = nextOpenRightDockPanel('browser-preview', next)
        }
        break
      }
      case 'terminal':
        next = { ...current, terminalOpen: false }
        break
    }

    return replaceTaskState(state, taskId, next)
  }),

  activatePanel: (taskId, panel) => set((state) => {
    const current = currentState(state.byTaskId, taskId)
    let next = current

    switch (panel) {
      case 'review':
        if (current.reviewOpen) next = { ...current, activePanel: 'review' }
        break
      case 'media':
        if (current.mediaOpen) next = { ...current, activePanel: 'media' }
        break
      case 'browser':
        if (current.browserOpen) {
          next = {
            ...current,
            activePanel: 'browser-preview',
            activeBrowserPreviewMode: 'browser',
          }
        }
        break
      case 'preview':
        if (current.previewOpen) {
          next = {
            ...current,
            activePanel: 'browser-preview',
            activeBrowserPreviewMode: 'preview',
          }
        }
        break
      case 'terminal':
        break
    }

    return next === current ? state : replaceTaskState(state, taskId, next)
  }),
}))
