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
  it('rejects Browser and Preview opens while native transport is disabled', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'browser')
    store.openPanel(TASK_ID, 'preview')

    expect(useProductTaskWorkspaceStore.getState().byTaskId[TASK_ID]).toBeUndefined()
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

  it('does not create disabled native panel state for any task id', () => {
    const store = useProductTaskWorkspaceStore.getState()
    store.openPanel(TASK_ID, 'browser', true)
    store.openPanel('task_public_other', 'terminal', true)
    store.activatePanel(TASK_ID, 'preview')

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
