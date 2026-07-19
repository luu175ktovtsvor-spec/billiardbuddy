import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import {
  productTaskBrowserPreviewKey,
  type ProductTaskBrowserPreviewMode,
} from '../stores/productTaskBrowserPreviewStore'

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} unobserve() {} disconnect() {} },
  })
})

const { bridge } = vi.hoisted(() => ({
  bridge: {
    open: vi.fn(),
    navigate: vi.fn(),
    setBounds: vi.fn(),
    setVisible: vi.fn(),
    setZoom: vi.fn(),
    close: vi.fn(),
    message: vi.fn(),
  },
}))

vi.mock('../../lib/previewBridge', () => ({ previewBridge: bridge }))

import { ProductTaskBrowserPreviewDock } from './ProductTaskBrowserPreviewDock'

const TASK_ID = 'task_public_0123456789'

function setPreviewHostAvailable(available: boolean) {
  window.desktopHost = {
    ...browserHost,
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      ...browserHost.capabilities,
      previewWebview: available,
    },
  }
}

type DockProps = {
  browserOpen: boolean
  previewOpen: boolean
  activeMode: ProductTaskBrowserPreviewMode | null
  onActivate?: (mode: ProductTaskBrowserPreviewMode) => void
  onClose?: (mode: ProductTaskBrowserPreviewMode) => void
}

function renderDock({
  browserOpen,
  previewOpen,
  activeMode,
  onActivate = vi.fn(),
  onClose = vi.fn(),
}: DockProps) {
  return render(
    <ProductTaskBrowserPreviewDock
      taskId={TASK_ID}
      browserOpen={browserOpen}
      previewOpen={previewOpen}
      activeMode={activeMode}
      onActivate={onActivate}
      onClose={onClose}
    />,
  )
}

beforeEach(() => {
  setPreviewHostAvailable(true)
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  Object.values(bridge).forEach((mock) => mock.mockReset())
})

afterEach(() => {
  cleanup()
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  window.desktopHost = undefined
})

describe('ProductTaskBrowserPreviewDock', () => {
  it('uses public task-derived keys and keeps Browser and Preview independently open', async () => {
    const onActivate = vi.fn()
    const onClose = vi.fn()
    const view = renderDock({
      browserOpen: true,
      previewOpen: true,
      activeMode: 'browser',
      onActivate,
      onClose,
    })

    const browserKey = productTaskBrowserPreviewKey(TASK_ID, 'browser')
    const previewKey = productTaskBrowserPreviewKey(TASK_ID, 'preview')
    await waitFor(() => {
      expect(useBrowserPanelStore.getState().bySession[browserKey]).toMatchObject({ isOpen: true })
    })
    expect(Object.keys(useBrowserPanelStore.getState().bySession)).toEqual([browserKey])
    expect(Object.keys(useBrowserPanelStore.getState().bySession).join('|')).not.toContain('core-session-secret')

    fireEvent.click(screen.getByRole('tab', { name: '预览' }))
    expect(onActivate).toHaveBeenCalledWith('preview')

    view.rerender(
      <ProductTaskBrowserPreviewDock
        taskId={TASK_ID}
        browserOpen={true}
        previewOpen={true}
        activeMode="preview"
        onActivate={onActivate}
        onClose={onClose}
      />,
    )
    await waitFor(() => {
      expect(useBrowserPanelStore.getState().bySession[previewKey]).toMatchObject({ isOpen: true })
    })
    expect(useBrowserPanelStore.getState().bySession[browserKey]).toMatchObject({ isOpen: true })

    fireEvent.click(screen.getByLabelText('关闭预览'))
    expect(onClose).toHaveBeenCalledWith('preview')
    expect(onClose).not.toHaveBeenCalledWith('browser')
    expect(useBrowserPanelStore.getState().bySession[previewKey]).toMatchObject({ isOpen: false })
  })

  it('accepts only explicit HTTP(S) navigation and never routes a product key through preview-fs', async () => {
    renderDock({ browserOpen: false, previewOpen: true, activeMode: 'preview' })
    const previewKey = productTaskBrowserPreviewKey(TASK_ID, 'preview')

    await waitFor(() => {
      expect(useBrowserPanelStore.getState().bySession[previewKey]).toMatchObject({ isOpen: true, url: '' })
    })

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'file:///private/secret-preview.html' } })
    fireEvent.submit(input.closest('form')!)

    expect(screen.getByRole('alert')).toHaveTextContent('预览仅支持手动输入 HTTP(S) 地址')
    expect(bridge.open).not.toHaveBeenCalled()
    expect(useBrowserPanelStore.getState().bySession[previewKey]!.url).toBe('')
    expect(screen.queryByLabelText('截图')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('选择元素')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'http://localhost:3000' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith('http://localhost:3000', expect.any(Object))
    })
    expect(useBrowserPanelStore.getState().bySession[previewKey]!.url).toBe('http://localhost:3000')
    expect(useBrowserPanelStore.getState().bySession[previewKey]!.url).not.toContain('/preview-fs/')
  })

  it('shows an explicit unavailable state instead of falling back to a legacy session browser', () => {
    setPreviewHostAvailable(false)
    renderDock({ browserOpen: true, previewOpen: false, activeMode: 'browser' })

    expect(screen.getByRole('status')).toHaveTextContent('当前环境不支持内置 Browser/Preview')
    expect(screen.queryByTestId('preview-host')).not.toBeInTheDocument()
    expect(useBrowserPanelStore.getState().bySession).toEqual({})
  })
})
