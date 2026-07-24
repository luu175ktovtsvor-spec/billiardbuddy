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
  it('opens only source Preview for a workspace-bound task', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'browser')
    store.openPanel(TASK_ID, 'preview', true)

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      browserOpen: false,
      previewOpen: true,
      activePanel: 'browser-preview',
      activeBrowserPreviewMode: 'preview',
    })
  })

  it('keeps Review and Media open while terminal open is disabled', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'review', true)
    store.openPanel(TASK_ID, 'media')
    store.openPanel(TASK_ID, 'terminal', true)

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      reviewOpen: true,
      mediaOpen: true,
      terminalOpen: false,
      activePanel: 'media',
    })
  })

  it('does not create disabled or workspace-less native panel state', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'browser', true)
    store.openPanel('task_public_other', 'terminal', true)
    store.openPanel('task_public_without_workspace', 'preview', false)

    expect(useProductTaskWorkspaceStore.getState().byTaskId).toEqual({})
  })

  it('derives browser store keys only from the public task id and selected mode', () => {
    expect(productTaskBrowserPreviewKey(TASK_ID, 'browser')).toBe(
      'product-task:task_public_0123456789:browser',
    )
    expect(productTaskBrowserPreviewKey(TASK_ID, 'preview')).toBe(
      'product-task:task_public_0123456789:preview',
    )
  })
})
