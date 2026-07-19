import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { APP_ZOOM_STORAGE_KEY } from '../lib/appZoom'
import { useSettingsStore } from '../stores/settingsStore'
import { NEW_PRODUCT_TASK_TAB_ID, useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'

function ShortcutHost() {
  useKeyboardShortcuts()
  return null
}

function setNavigatorPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', {
    configurable: true,
    value: platform,
  })
}

describe('useKeyboardShortcuts app zoom', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-zoom-mode')
    document.documentElement.removeAttribute('data-app-zoom-percent')
    document.documentElement.style.removeProperty('--app-zoom')
    document.body.style.removeProperty('zoom')
    useSettingsStore.setState({ uiZoom: 1 })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useUIStore.setState({ activeModal: null })
    setNavigatorPlatform('Win32')
  })

  afterEach(() => {
    cleanup()
  })

  it('handles Ctrl zoom shortcuts on Windows and Linux style platforms', async () => {
    render(<ShortcutHost />)

    fireEvent.keyDown(document, {
      code: 'Equal',
      ctrlKey: true,
      key: '=',
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.1')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(1.1)
    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('110')

    fireEvent.keyDown(document, {
      code: 'Minus',
      ctrlKey: true,
      key: '-',
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(1)

    fireEvent.keyDown(document, {
      code: 'NumpadAdd',
      ctrlKey: true,
      key: '+',
    })
    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1.1')
    })

    fireEvent.keyDown(document, {
      code: 'Digit0',
      ctrlKey: true,
      key: '0',
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('1')
    })
  })

  it('uses Cmd zoom shortcuts on macOS', async () => {
    setNavigatorPlatform('MacIntel')
    render(<ShortcutHost />)

    fireEvent.keyDown(document, {
      code: 'Minus',
      key: '-',
      metaKey: true,
    })

    await waitFor(() => {
      expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('0.9')
    })

    fireEvent.keyDown(document, {
      code: 'Equal',
      ctrlKey: true,
      key: '=',
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(window.localStorage.getItem(APP_ZOOM_STORAGE_KEY)).toBe('0.9')
  })

  it('opens the dedicated product-owned new-task page with Ctrl or Cmd N', () => {
    render(<ShortcutHost />)

    fireEvent.keyDown(document, {
      key: 'n',
      ctrlKey: true,
    })

    expect(useTabStore.getState().activeTabId).toBe(NEW_PRODUCT_TASK_TAB_ID)
    expect(useTabStore.getState().tabs).toEqual([
      expect.objectContaining({
        sessionId: NEW_PRODUCT_TASK_TAB_ID,
        type: 'new-product-task',
      }),
    ])
  })

  it('opens the dedicated task-search modal with Cmd or Ctrl K', () => {
    render(<ShortcutHost />)

    fireEvent.keyDown(document, {
      key: 'k',
      ctrlKey: true,
    })

    expect(useUIStore.getState().activeModal).toBe('task-search')
  })
})
