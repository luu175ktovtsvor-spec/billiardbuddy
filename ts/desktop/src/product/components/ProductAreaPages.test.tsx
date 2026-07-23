import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from '../stores/productTaskStore'
import {
  IMAGE_WORKBENCH_TAB_ID,
  NEW_PRODUCT_TASK_TAB_ID,
  VIDEO_STUDIO_TAB_ID,
  useTabStore,
} from '../../stores/tabStore'

const hostCapabilities = vi.hoisted(() => ({ mediaActions: true }))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({ capabilities: hostCapabilities }),
}))

import { ProductCreationPage, ProductOperationsPage } from './ProductAreaPages'

describe('ProductAreaPages', () => {
  beforeEach(() => {
    hostCapabilities.mediaActions = true
    useTabStore.setState({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
    useProductTaskStore.setState({
      index: { ...EMPTY_PRODUCT_TASK_INDEX, capabilities: { createTask: true } },
    })
  })

  afterEach(() => {
    cleanup()
    window.localStorage.clear()
  })

  it('opens image and video tools inside the creation area when native media is available', () => {
    render(<ProductCreationPage />)

    const openButtons = screen.getAllByRole('button', { name: /打开/ })
    fireEvent.click(openButtons[0]!)
    expect(useTabStore.getState().activeTabId).toBe(IMAGE_WORKBENCH_TAB_ID)

    fireEvent.click(openButtons[1]!)
    expect(useTabStore.getState().activeTabId).toBe(VIDEO_STUDIO_TAB_ID)
  })

  it('shows an actionable capability-aware empty state for operations', () => {
    const { rerender } = render(<ProductOperationsPage />)

    fireEvent.click(screen.getByRole('button', { name: '新建经营任务' }))
    expect(useTabStore.getState().activeTabId).toBe(NEW_PRODUCT_TASK_TAB_ID)

    act(() => {
      useProductTaskStore.setState({
        index: { ...EMPTY_PRODUCT_TASK_INDEX, capabilities: { createTask: false } },
      })
    })
    rerender(<ProductOperationsPage />)
    expect(screen.getByText('经营任务暂不可用')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新建经营任务' })).not.toBeInTheDocument()
  })

  it('disables native creation tools when the host cannot execute media actions', () => {
    hostCapabilities.mediaActions = false
    render(<ProductCreationPage />)

    expect(screen.getAllByRole('button', { name: /打开/ })).toEqual([
      expect.objectContaining({ disabled: true }),
      expect.objectContaining({ disabled: true }),
    ])
    expect(screen.getAllByText('需要桌面版')).toHaveLength(2)
  })
})
