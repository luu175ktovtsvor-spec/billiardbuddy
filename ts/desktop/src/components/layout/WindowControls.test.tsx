import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const hostMinimize = vi.fn().mockResolvedValue(undefined)
const hostToggleMaximize = vi.fn().mockResolvedValue(undefined)
const hostClose = vi.fn().mockResolvedValue(undefined)
const hostIsMaximized = vi.fn().mockResolvedValue(false)
const hostOnResized = vi.fn().mockResolvedValue(() => {})

describe('WindowControls', () => {
  const originalPlatform = navigator.platform

  beforeEach(async () => {
    hostMinimize.mockClear()
    hostToggleMaximize.mockClear()
    hostClose.mockClear()
    hostIsMaximized.mockReset()
    hostIsMaximized.mockResolvedValue(false)
    hostOnResized.mockReset()
    hostOnResized.mockResolvedValue(() => {})
    window.desktopHost = {
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        appMode: false,
        dialogs: false,
        notifications: false,
        previewWebview: false,
        shell: false,
        terminal: false,
        updates: false,
        windowControls: true,
        zoom: false,
      },
      window: {
        minimize: hostMinimize,
        toggleMaximize: hostToggleMaximize,
        close: hostClose,
        startDragging: vi.fn(),
        requestAttention: vi.fn(),
        focus: vi.fn(),
        isMaximized: hostIsMaximized,
        onResized: hostOnResized,
        onNativeMenuNavigate: vi.fn().mockResolvedValue(() => {}),
      },
    } as any
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: 'Win32',
    })
    vi.resetModules()
  })

  afterEach(() => {
    Reflect.deleteProperty(window, 'desktopHost')
    Object.defineProperty(navigator, 'platform', {
      configurable: true,
      value: originalPlatform,
    })
  })

  it('invokes desktop host window APIs for custom controls on Windows', async () => {
    hostIsMaximized
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const { WindowControls } = await import('./WindowControls')

    render(<WindowControls />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Minimize window' })).toBeInTheDocument()
    })
    await waitFor(() => expect(hostOnResized).toHaveBeenCalledTimes(1))

    const handleResize = hostOnResized.mock.calls[0]?.[0]
    expect(handleResize).toBeDefined()
    await act(async () => {
      handleResize?.()
      await Promise.resolve()
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Restore window' })).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Minimize window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Restore window' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close window' }))

    await waitFor(() => {
      expect(hostMinimize).toHaveBeenCalledTimes(1)
      expect(hostToggleMaximize).toHaveBeenCalledTimes(1)
      expect(hostClose).toHaveBeenCalledTimes(1)
    })
  })
})
