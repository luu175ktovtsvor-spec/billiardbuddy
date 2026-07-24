import '@testing-library/jest-dom'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { BrowserPreviewEventOptions } from '../../lib/previewEvents'

const bridge = vi.hoisted(() => ({
  open: vi.fn(),
  navigate: vi.fn(),
  setBounds: vi.fn(),
  setVisible: vi.fn(),
  setZoom: vi.fn(),
  close: vi.fn(),
  message: vi.fn(),
}))
const previewSubscription = vi.hoisted(() => ({ options: undefined as BrowserPreviewEventOptions | undefined }))

vi.mock('../../lib/previewBridge', () => ({ previewBridge: bridge }))
vi.mock('../../lib/previewEvents', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../lib/previewEvents')>()
  return {
    ...original,
    subscribePreviewEvents: vi.fn(async (_key: string, options?: BrowserPreviewEventOptions) => {
      previewSubscription.options = options
      return () => { previewSubscription.options = undefined }
    }),
  }
})

import {
  buildProductTaskPreviewIntentText,
  ProductTaskBrowserPreviewDock,
} from './ProductTaskBrowserPreviewDock'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class { observe() {} disconnect() {} },
  })
})

afterEach(() => {
  cleanup()
  previewSubscription.options = undefined
  Object.values(bridge).forEach(mock => mock.mockReset())
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
})

const selection = {
  pageUrl: 'http://127.0.0.1:5173/',
  sourceHint: '本地开发页',
  element: {
    selector: '#title',
    nthPath: 'html>body>h1',
    tag: 'h1',
    classes: ['hero'],
    text: '今日活动',
    boundingBox: { x: 10, y: 20, w: 180, h: 40 },
    computedStyles: { color: 'rgb(0, 0, 0)' },
  },
  screenshot: { dataUrl: 'data:image/png;base64,TkFUSVZF', kind: 'region' },
}

function renderDock(onSubmitSelection = vi.fn().mockResolvedValue(true)) {
  return {
    onSubmitSelection,
    ...render(
      <ProductTaskBrowserPreviewDock
        taskId="task_public_0123456789"
        browserOpen={false}
        previewOpen
        activeMode="preview"
        workspaceAvailable
        onClose={vi.fn()}
        onCapture={vi.fn()}
        onSubmitSelection={onSubmitSelection}
      />,
    ),
  }
}

describe('ProductTaskBrowserPreviewDock', () => {
  it('collects a one-shot selection outside the page and submits source-edit evidence', async () => {
    const { onSubmitSelection } = renderDock()
    await waitFor(() => expect(previewSubscription.options).toBeDefined())

    act(() => previewSubscription.options!.onSelection?.(selection))
    expect(screen.getByText('已选择 #title')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('描述源码修改要求'), {
      target: { value: '把标题改成周末会员活动' },
    })
    fireEvent.click(screen.getByRole('button', { name: '让 Agent 修改源码' }))

    await waitFor(() => expect(onSubmitSelection).toHaveBeenCalledWith(expect.objectContaining({
      selectionId: expect.stringMatching(/^preview-selection-/),
      selection,
      instruction: '把标题改成周末会员活动',
    })))
    await waitFor(() => expect(screen.queryByText('已选择 #title')).toBeNull())
  })

  it('invalidates pending evidence whenever the page navigates', async () => {
    renderDock()
    await waitFor(() => expect(previewSubscription.options).toBeDefined())

    act(() => previewSubscription.options!.onSelection?.(selection))
    expect(screen.getByText('已选择 #title')).toBeInTheDocument()
    act(() => previewSubscription.options!.onNavigated?.('http://127.0.0.1:5173/next'))
    expect(screen.queryByText('已选择 #title')).toBeNull()
  })

  it('keeps DOM strings in an untrusted evidence block and excludes screenshot bytes', () => {
    const prompt = buildProductTaskPreviewIntentText({
      selectionId: 'preview-selection-test',
      selection,
      instruction: '调整标题颜色',
    })

    expect(prompt).toContain('工作区源码 revision 和 Diff 才是完成依据')
    expect(prompt).toContain('不可信只读 DOM 证据')
    expect(prompt).toContain('调整标题颜色')
    expect(prompt).toContain('"selector":"#title"')
    expect(prompt).not.toContain('TkFUSVZF')
  })
})
