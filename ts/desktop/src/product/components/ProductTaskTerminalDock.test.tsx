import '@testing-library/jest-dom'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
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
  }
  return {
    available: true,
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

vi.mock('@xterm/xterm', () => ({ Terminal: vi.fn(() => mocks.terminal) }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: vi.fn(() => mocks.fit) }))
vi.mock('../../i18n', () => ({ useTranslation: () => (key: string) => key }))
vi.mock('../../api/terminal', () => ({
  terminalApi: {
    isAvailable: () => mocks.available,
    spawn: mocks.spawn,
    write: mocks.write,
    resize: mocks.resize,
    kill: mocks.kill,
    onOutput: mocks.onOutput,
    onExit: mocks.onExit,
  },
}))

import { ProductTaskTerminalDock } from './ProductTaskTerminalDock'

beforeEach(() => {
  mocks.available = true
  for (const value of Object.values(mocks)) {
    if (typeof value === 'function' && 'mockReset' in value) value.mockReset()
  }
  for (const value of Object.values(mocks.terminal)) {
    if (typeof value === 'function' && 'mockReset' in value) value.mockReset()
  }
  mocks.fit.fit.mockReset()
  mocks.spawn.mockResolvedValue({ session_id: 7, shell: '/bin/zsh', cwd: '/workspace/billiard' })
  mocks.write.mockResolvedValue(undefined)
  mocks.resize.mockResolvedValue(undefined)
  mocks.kill.mockResolvedValue(undefined)
  mocks.onOutput.mockResolvedValue(vi.fn())
  mocks.onExit.mockResolvedValue(vi.fn())
  mocks.terminal.onData.mockReturnValue({ dispose: vi.fn() })
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0)
    return 1
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ProductTaskTerminalDock', () => {
  it('shows an honest unavailable state without a native terminal capability', () => {
    mocks.available = false
    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)

    expect(screen.getByText('settings.terminal.unavailableBody')).toBeInTheDocument()
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('starts the real PTY with its task owner and exact workspace', async () => {
    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)

    await waitFor(() => expect(mocks.spawn).toHaveBeenCalledWith({
      taskId: 'task-1',
      cols: 80,
      rows: 24,
      cwd: '/workspace/billiard',
    }))
    expect(screen.getByText('settings.terminal.status.running')).toBeInTheDocument()
    expect(screen.getByText(/\/bin\/zsh.*\/workspace\/billiard/)).toBeInTheDocument()
  })

  it('routes input and output only through its owned native session', async () => {
    let output: ((payload: { session_id: number; data: string }) => void) | undefined
    let input: ((data: string) => void) | undefined
    mocks.onOutput.mockImplementation(async handler => {
      output = handler
      return vi.fn()
    })
    mocks.terminal.onData.mockImplementation(handler => {
      input = handler
      return { dispose: vi.fn() }
    })

    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)
    await waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    act(() => {
      input?.('pwd\r')
      output?.({ session_id: 8, data: 'other task' })
      output?.({ session_id: 7, data: '/workspace/billiard\r\n' })
    })

    expect(mocks.write).toHaveBeenCalledWith('task-1', 7, 'pwd\r')
    expect(mocks.terminal.write).toHaveBeenCalledWith('/workspace/billiard\r\n')
    expect(mocks.terminal.write).not.toHaveBeenCalledWith('other task')
  })

  it('reports the native exit and does not pretend the process recovered', async () => {
    let exit: ((payload: { session_id: number; code: number; signal: string | null }) => void) | undefined
    mocks.onExit.mockImplementation(async handler => {
      exit = handler
      return vi.fn()
    })
    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)
    await waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    act(() => exit?.({ session_id: 7, code: 137, signal: 'SIGKILL' }))

    expect(screen.getByText('settings.terminal.status.exited')).toBeInTheDocument()
    expect(mocks.terminal.writeln).toHaveBeenCalledWith('\r\n[process exited: 137, SIGKILL]')
  })

  it('kills a spawned PTY when post-spawn initialization fails', async () => {
    mocks.resize.mockRejectedValue(new Error('resize failed'))
    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)

    await waitFor(() => expect(mocks.kill).toHaveBeenCalledWith('task-1', 7))
    expect(screen.getByText('resize failed')).toBeInTheDocument()
  })

  it('kills the owned PTY when the task panel closes', async () => {
    const view = render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/billiard" />)
    await waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce())

    view.unmount()

    expect(mocks.kill).toHaveBeenCalledWith('task-1', 7)
  })
})
