import { beforeEach, describe, expect, it } from 'vitest'
import {
  productTaskBrowserPreviewKey,
  useProductTaskBrowserPreviewStore,
} from './productTaskBrowserPreviewStore'

const TASK_ID = 'task_public_0123456789'

beforeEach(() => {
  useProductTaskBrowserPreviewStore.setState(
    useProductTaskBrowserPreviewStore.getInitialState(),
    true,
  )
})

describe('useProductTaskBrowserPreviewStore', () => {
  it('keeps Browser and Preview open states independent for one public task id', () => {
    const store = useProductTaskBrowserPreviewStore.getState()
    store.openPanel(TASK_ID, 'browser')
    store.openPanel(TASK_ID, 'preview')

    expect(useProductTaskBrowserPreviewStore.getState().byTaskId[TASK_ID]).toEqual({
      browserOpen: true,
      previewOpen: true,
      activeMode: 'preview',
    })

    useProductTaskBrowserPreviewStore.getState().closePanel(TASK_ID, 'preview')
    expect(useProductTaskBrowserPreviewStore.getState().byTaskId[TASK_ID]).toEqual({
      browserOpen: true,
      previewOpen: false,
      activeMode: 'browser',
    })
  })

  it('does not activate a closed panel or change the other panel state', () => {
    const store = useProductTaskBrowserPreviewStore.getState()
    store.openPanel(TASK_ID, 'browser')
    store.activatePanel(TASK_ID, 'preview')

    expect(useProductTaskBrowserPreviewStore.getState().byTaskId[TASK_ID]).toEqual({
      browserOpen: true,
      previewOpen: false,
      activeMode: 'browser',
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
