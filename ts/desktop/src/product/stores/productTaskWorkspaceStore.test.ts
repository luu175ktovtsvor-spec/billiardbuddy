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
  it('keeps Browser and Preview open states independent for one public task id', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'browser')
    store.openPanel(TASK_ID, 'preview')

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      browserOpen: true,
      previewOpen: true,
      activePanel: 'browser-preview',
      activeBrowserPreviewMode: 'preview',
    })

    useProductTaskWorkspaceStore.getState().closePanel(TASK_ID, 'preview')
    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      browserOpen: true,
      previewOpen: false,
      activePanel: 'browser-preview',
      activeBrowserPreviewMode: 'browser',
    })
  })

  it('coordinates the right dock while keeping the terminal as an independent axis', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'review')
    store.openPanel(TASK_ID, 'media')
    store.openPanel(TASK_ID, 'terminal')

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      reviewOpen: true,
      mediaOpen: true,
      terminalOpen: true,
      activePanel: 'media',
    })

    useProductTaskWorkspaceStore.getState().closePanel(TASK_ID, 'media')
    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      reviewOpen: true,
      mediaOpen: false,
      terminalOpen: true,
      activePanel: 'review',
    })

    useProductTaskWorkspaceStore.getState().openPanel(TASK_ID, 'browser')
    useProductTaskWorkspaceStore.getState().closePanel(TASK_ID, 'browser')
    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      reviewOpen: true,
      browserOpen: false,
      terminalOpen: true,
      activePanel: 'review',
      activeBrowserPreviewMode: null,
    })
  })

  it('does not activate a closed panel and isolates workspace chrome by public task id', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.activatePanel(TASK_ID, 'preview')
    expect(useProductTaskWorkspaceStore.getState().byTaskId).toEqual({})

    store.openPanel(TASK_ID, 'browser')
    store.openPanel('task_public_other', 'terminal')
    store.activatePanel(TASK_ID, 'preview')

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toMatchObject({
      browserOpen: true,
      previewOpen: false,
      terminalOpen: false,
      activeBrowserPreviewMode: 'browser',
    })
    expect(useProductTaskWorkspaceStore.getState().byTaskId.task_public_other).toMatchObject({
      browserOpen: false,
      terminalOpen: true,
      activePanel: null,
    })
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
