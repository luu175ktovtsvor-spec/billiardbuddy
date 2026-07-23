import '@testing-library/jest-dom'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ open: vi.fn(), navigate: vi.fn(), setBounds: vi.fn(), setVisible: vi.fn(), close: vi.fn(), message: vi.fn() }))
vi.mock('../../lib/previewBridge', () => ({ previewBridge: bridge }))

import { ProductTaskBrowserPreviewDock } from './ProductTaskBrowserPreviewDock'

afterEach(() => { cleanup(); Object.values(bridge).forEach((mock) => mock.mockReset()) })

describe('ProductTaskBrowserPreviewDock', () => {
  it('does not mount a BrowserSurface or call native preview APIs while disabled', () => {
    const view = render(<ProductTaskBrowserPreviewDock taskId="task_public_0123456789" browserOpen previewOpen activeMode="browser" workspaceAvailable onActivate={vi.fn()} onClose={vi.fn()} onCapture={vi.fn()} />)
    expect(view.container).toBeEmptyDOMElement()
    expect(bridge.open).not.toHaveBeenCalled()
    expect(bridge.navigate).not.toHaveBeenCalled()
  })
})
