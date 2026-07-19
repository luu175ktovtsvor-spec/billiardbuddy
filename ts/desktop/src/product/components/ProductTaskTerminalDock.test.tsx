import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { destroyTerminalRuntime, getTerminalRuntime } from '../../lib/terminalRuntime'
import { browserHost } from '../../lib/desktopHost/browserHost'
import { useSettingsStore } from '../../stores/settingsStore'

const terminalMocks = vi.hoisted(() => {
  const terminal = {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    open: vi.fn(),
    dispose: vi.fn(),
    onData: vi.fn(),
    write: vi.fn(),
    writeln: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    getSelection: vi.fn(),
    hasSelection: vi.fn(),
    paste: vi.fn(),
  }
  return {
    available: false,
    terminal,
    fit: { fit: vi.fn() },
    spawn: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onOutput: vi.fn(),
    onExit: vi.fn(),
  }
})

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => terminalMocks.terminal) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => terminalMocks.fit) }))
vi.mock('../../api/terminal', () => ({
  terminalApi: {
    isAvailable: () => terminalMocks.available,
    spawn: terminalMocks.spawn,
    write: terminalMocks.write,
    resize: terminalMocks.resize,
    kill: terminalMocks.kill,
    onOutput: terminalMocks.onOutput,
    onExit: terminalMocks.onExit,
  },
}))

import { ProductTaskTerminalDock } from './ProductTaskTerminalDock'

describe('ProductTaskTerminalDock', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    terminalMocks.available = false
    terminalMocks.spawn.mockReset()
    terminalMocks.write.mockReset()
    terminalMocks.resize.mockReset()
    terminalMocks.kill.mockReset()
    terminalMocks.onOutput.mockReset()
    terminalMocks.onExit.mockReset()
    terminalMocks.terminal.loadAddon.mockClear()
    terminalMocks.terminal.open.mockClear()
    terminalMocks.terminal.dispose.mockClear()
    terminalMocks.terminal.write.mockClear()
    terminalMocks.terminal.clear.mockClear()
    terminalMocks.terminal.focus.mockClear()
    terminalMocks.terminal.getSelection.mockReturnValue('')
    terminalMocks.terminal.hasSelection.mockReturnValue(false)
    terminalMocks.terminal.paste.mockClear()
    terminalMocks.fit.fit.mockClear()
    terminalMocks.onOutput.mockResolvedValue(vi.fn())
    terminalMocks.onExit.mockResolvedValue(vi.fn())
    terminalMocks.spawn.mockResolvedValue({ session_id: 7, shell: '/bin/zsh', cwd: '/workspace/billiard' })
    terminalMocks.write.mockResolvedValue(undefined)
    terminalMocks.resize.mockResolvedValue(undefined)
    terminalMocks.kill.mockResolvedValue(undefined)
    Reflect.deleteProperty(window, 'desktopHost')
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = vi.fn()
    })
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  })

  afterEach(() => {
    cleanup()
    destroyTerminalRuntime('product-task-terminal-task-1')
  })

  it('shows an honest unavailable state outside the desktop host', () => {
    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)

    expect(screen.getByTestId('product-task-terminal-toolbar')).toHaveTextContent('Terminal')
    expect(screen.getByText('Desktop runtime required')).toBeInTheDocument()
    expect(terminalMocks.spawn).not.toHaveBeenCalled()
  })

  it('removes an unavailable task runtime when its panel unmounts', () => {
    const { unmount } = render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)

    expect(getTerminalRuntime('product-task-terminal-task-1', 'idle').status).toBe('unavailable')

    unmount()

    expect(getTerminalRuntime('product-task-terminal-task-1', 'idle').status).toBe('idle')
  })

  it('starts exactly in the owning product task work directory', async () => {
    terminalMocks.available = true

    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)

    await waitFor(() => {
      expect(terminalMocks.spawn).toHaveBeenCalledWith({
        cols: 80,
        rows: 24,
        cwd: '/workspace/billiard',
      })
    })
    expect(screen.getByText('/bin/zsh')).toBeInTheDocument()
    expect(screen.getByText('/workspace/billiard')).toBeInTheDocument()
    expect(terminalMocks.terminal.open).toHaveBeenCalled()
  })

  it('abandons initialization when the output subscription resolves after unmount', async () => {
    terminalMocks.available = true
    const outputUnlisten = vi.fn()
    let resolveOutput: ((unlisten: () => void) => void) | undefined
    terminalMocks.onOutput.mockImplementation(
      () => new Promise<() => void>((resolve) => {
        resolveOutput = resolve
      }),
    )

    const { unmount } = render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)
    await waitFor(() => expect(terminalMocks.onOutput).toHaveBeenCalledOnce())

    unmount()
    await act(async () => {
      resolveOutput?.(outputUnlisten)
      await Promise.resolve()
    })

    expect(outputUnlisten).toHaveBeenCalledOnce()
    expect(terminalMocks.onExit).not.toHaveBeenCalled()
    expect(terminalMocks.spawn).not.toHaveBeenCalled()
    expect(terminalMocks.terminal.dispose).toHaveBeenCalled()
  })

  it('kills a terminal spawned after its task panel has unmounted', async () => {
    terminalMocks.available = true
    let resolveSpawn: ((result: { session_id: number; shell: string; cwd: string }) => void) | undefined
    terminalMocks.spawn.mockImplementation(
      () => new Promise((resolve) => {
        resolveSpawn = resolve
      }),
    )

    const { unmount } = render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalledOnce())

    unmount()
    await act(async () => {
      resolveSpawn?.({ session_id: 7, shell: '/bin/zsh', cwd: '/workspace/billiard' })
      await Promise.resolve()
    })

    await waitFor(() => expect(terminalMocks.kill).toHaveBeenCalledWith(7))
  })

  it('keeps the task terminal controls visible when native startup fails', async () => {
    terminalMocks.available = true
    terminalMocks.spawn.mockRejectedValue(new Error('terminal startup failed'))

    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)

    expect(await screen.findByText('terminal startup failed')).toBeInTheDocument()
    expect(screen.getByText('Error')).toBeInTheDocument()
    expect(screen.getByTestId('product-task-terminal-toolbar')).toBeInTheDocument()
  })

  it('writes only output from its own native terminal session', async () => {
    terminalMocks.available = true
    let outputHandler: ((payload: { session_id: number; data: string }) => void) | undefined
    terminalMocks.onOutput.mockImplementation(async (handler) => {
      outputHandler = handler
      return vi.fn()
    })

    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())

    act(() => {
      outputHandler?.({ session_id: 7, data: 'hello\r\n' })
      outputHandler?.({ session_id: 8, data: 'ignored\r\n' })
    })

    expect(terminalMocks.terminal.write).toHaveBeenCalledWith('hello\r\n')
    expect(terminalMocks.terminal.write).not.toHaveBeenCalledWith('ignored\r\n')
  })

  it('uses Windows copy shortcuts without intercepting an unselected Ctrl+C', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    const writeText = vi.fn().mockResolvedValue(undefined)
    window.desktopHost = {
      ...browserHost,
      capabilities: { ...browserHost.capabilities, clipboard: true },
      clipboard: { readText: vi.fn(), writeText },
    }

    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)
    await waitFor(() => expect(terminalMocks.spawn).toHaveBeenCalled())

    const frame = screen.getByTestId('product-task-terminal-frame')
    fireEvent.keyDown(frame, { key: 'c', ctrlKey: true })
    expect(writeText).not.toHaveBeenCalled()

    terminalMocks.terminal.hasSelection.mockReturnValue(true)
    terminalMocks.terminal.getSelection.mockReturnValue('task output')
    fireEvent.keyDown(frame, { key: 'c', ctrlKey: true })
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('task output'))
  })

  it('closes only the product task panel through its supplied action', () => {
    const onClose = vi.fn()
    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal panel' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
