import { beforeEach, describe, expect, it } from 'vitest'
import {
  productTaskBrowserPreviewKey,
  useProductTaskWorkspaceStore,
} from './productTaskWorkspaceStore'

const TASK_ID = 'task_public_0123456789'

beforeEach(() => {
  useProductTaskWorkspaceStore.setState(
    useProductTaskWorkspaceStore.getInitialState(),
    true,
  )
})

describe('useProductTaskWorkspaceStore', () => {
  it('opens Browser and source Preview as independent result surfaces', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'browser')
    store.openPanel(TASK_ID, 'preview', true)

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      browserOpen: true,
      previewOpen: true,
      activePanel: 'browser-preview',
      activeBrowserPreviewMode: 'preview',
    })
  })

  it('keeps Review open while the independent task terminal opens', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'review', true)
    store.openPanel(TASK_ID, 'terminal', true)

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      reviewOpen: true,
      terminalOpen: true,
      activePanel: 'review',
    })
  })

  it('allows Browser without a workspace but rejects workspace-less source Preview', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'browser', true)
    store.openPanel('task_public_without_workspace', 'preview', false)

    expect(useProductTaskWorkspaceStore.getState().byTaskId).toMatchObject({
      [TASK_ID]: {
        browserOpen: true,
        activePanel: 'browser-preview',
        activeBrowserPreviewMode: 'browser',
      },
    })
    expect(useProductTaskWorkspaceStore.getState().byTaskId).not.toHaveProperty('task_public_without_workspace')
  })

  it('derives browser store keys only from the public task id and selected mode', () => {
    expect(productTaskBrowserPreviewKey(TASK_ID, 'browser')).toBe(
      'product-task:task_public_0123456789:browser',
    )
    expect(productTaskBrowserPreviewKey(TASK_ID, 'preview')).toBe(
      'product-task:task_public_0123456789:preview',
    )
  })

  it('forgets all renderer workspace state after durable task deletion', () => {
    useProductTaskWorkspaceStore.getState().openPanel(TASK_ID, 'review', true)
    useProductTaskWorkspaceStore.getState().forgetTask(TASK_ID)
    expect(useProductTaskWorkspaceStore.getState().byTaskId).not.toHaveProperty(TASK_ID)
  })
})
