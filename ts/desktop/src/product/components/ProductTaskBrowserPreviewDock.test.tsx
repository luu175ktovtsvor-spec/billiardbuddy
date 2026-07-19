import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import {
  productTaskBrowserPreviewKey,
  type ProductTaskBrowserPreviewMode,
} from '../stores/productTaskWorkspaceStore'

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
let previewHandler: ((payload: unknown) => void) | null = null

function setPreviewHostAvailable(available: boolean) {
  window.desktopHost = {
    ...browserHost,
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      ...browserHost.capabilities,
      previewWebview: available,
    },
    preview: {
      ...browserHost.preview,
      onEvent: async (handler) => {
        previewHandler = handler
        return () => {
          if (previewHandler === handler) previewHandler = null
        }
      },
    },
  }
}

type DockProps = {
  browserOpen: boolean
  previewOpen: boolean
  activeMode: ProductTaskBrowserPreviewMode | null
  onActivate?: (mode: ProductTaskBrowserPreviewMode) => void
  onClose?: (mode: ProductTaskBrowserPreviewMode) => void
  onCapture?: (capture: { mode: ProductTaskBrowserPreviewMode; dataUrl: string }) => void
}

function renderDock({
  browserOpen,
  previewOpen,
  activeMode,
  onActivate = vi.fn(),
  onClose = vi.fn(),
  onCapture = vi.fn(),
}: DockProps) {
  return render(
    <ProductTaskBrowserPreviewDock
      taskId={TASK_ID}
      browserOpen={browserOpen}
      previewOpen={previewOpen}
      activeMode={activeMode}
      onActivate={onActivate}
      onClose={onClose}
      onCapture={onCapture}
    />,
  )
}

beforeEach(() => {
  setPreviewHostAvailable(true)
  previewHandler = null
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  Object.values(bridge).forEach((mock) => mock.mockReset())
})

afterEach(() => {
  cleanup()
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  window.desktopHost = undefined
  previewHandler = null
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
        onCapture={vi.fn()}
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

  it('accepts only explicit HTTP(S) navigation with a task-scoped browser key', async () => {
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
    expect(screen.getByLabelText('截取当前页面')).toBeInTheDocument()
    expect(screen.getByLabelText('选择页面元素')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'http://localhost:3000' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => {
      expect(bridge.open).toHaveBeenCalledWith('http://localhost:3000', expect.any(Object))
    })
    expect(useBrowserPanelStore.getState().bySession[previewKey]!.url).toBe('http://localhost:3000')
  })

  it('shows an explicit unavailable state instead of falling back to a legacy session browser', () => {
    setPreviewHostAvailable(false)
    renderDock({ browserOpen: true, previewOpen: false, activeMode: 'browser' })

    expect(screen.getByRole('status')).toHaveTextContent('当前环境不支持内置 Browser/Preview')
    expect(screen.queryByTestId('preview-host')).not.toBeInTheDocument()
    expect(useBrowserPanelStore.getState().bySession).toEqual({})
  })

  it('adds only a native capture whose one-shot id matches the current product panel', async () => {
    const onCapture = vi.fn()
    renderDock({ browserOpen: true, previewOpen: false, activeMode: 'browser', onCapture })

    await waitFor(() => expect(previewHandler).not.toBeNull())
    previewHandler!({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,VE9PX0VBUkxZ',
      kind: 'viewport',
      captureId: 'capture_id_that_was_not_armed',
    })
    expect(onCapture).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('截取当前页面'))
    const captureMessage = bridge.message.mock.calls.at(-1)?.[0]
    expect(captureMessage).toMatchObject({ v: 1, type: 'capture', kind: 'viewport' })
    const captureId = (captureMessage as { captureId?: string }).captureId
    expect(captureId).toMatch(/^[0-9a-zA-Z_-]{16,64}$/)

    previewHandler!({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,Rk9SR0VE',
      kind: 'viewport',
      captureId: 'capture_id_that_was_not_armed',
    })
    expect(onCapture).not.toHaveBeenCalled()

    previewHandler!({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,TkFUSVZF',
      kind: 'viewport',
      captureId,
    })
    expect(onCapture).toHaveBeenCalledWith({
      mode: 'browser',
      dataUrl: 'data:image/png;base64,TkFUSVZF',
    })
  })

  it('drops a late native capture after the active product surface changes', async () => {
    const onCapture = vi.fn()
    const view = renderDock({ browserOpen: true, previewOpen: true, activeMode: 'browser', onCapture })

    await waitFor(() => expect(previewHandler).not.toBeNull())
    fireEvent.click(screen.getByLabelText('截取当前页面'))
    const captureId = (bridge.message.mock.calls.at(-1)?.[0] as { captureId?: string }).captureId
    const oldHandler = previewHandler!

    view.rerender(
      <ProductTaskBrowserPreviewDock
        taskId={TASK_ID}
        browserOpen={true}
        previewOpen={true}
        activeMode="preview"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onCapture={onCapture}
      />,
    )
    await waitFor(() => expect(previewHandler).not.toBe(oldHandler))

    oldHandler({
      v: 1,
      type: 'screenshot',
      dataUrl: 'data:image/png;base64,TEFURQ==',
      kind: 'viewport',
      captureId,
    })
    expect(onCapture).not.toHaveBeenCalled()
  })

  it('keeps only the native screenshot from an armed element selection', async () => {
    const onCapture = vi.fn()
    renderDock({ browserOpen: false, previewOpen: true, activeMode: 'preview', onCapture })

    await waitFor(() => expect(previewHandler).not.toBeNull())
    fireEvent.click(screen.getByLabelText('选择页面元素'))
    expect(bridge.message).toHaveBeenLastCalledWith({ v: 1, type: 'enter-picker' })

    act(() => {
      previewHandler!({
        v: 1,
        type: 'selection',
        payload: {
          pageUrl: 'https://private.example/path',
          sourceHint: 'Core session hidden-id',
          element: { selector: '#private', tag: 'button', classes: ['secret'] },
          change: { description: '不要泄露' },
          screenshot: { dataUrl: 'data:image/png;base64,TkFUSVZF', kind: 'region' },
        },
      })
    })

    expect(onCapture).toHaveBeenCalledWith({
      mode: 'preview',
      dataUrl: 'data:image/png;base64,TkFUSVZF',
    })
    expect(onCapture.mock.calls[0]?.[0]).toEqual({
      mode: 'preview',
      dataUrl: 'data:image/png;base64,TkFUSVZF',
    })
  })
})
