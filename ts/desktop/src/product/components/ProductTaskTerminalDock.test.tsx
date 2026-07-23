import '@testing-library/jest-dom'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const terminal = vi.hoisted(() => ({ spawn: vi.fn(), resize: vi.fn(), write: vi.fn(), kill: vi.fn(), isAvailable: vi.fn(() => true) }))
vi.mock('../../api/terminal', () => ({ terminalApi: terminal }))

import { ProductTaskTerminalDock } from './ProductTaskTerminalDock'

beforeEach(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
})

afterEach(() => { cleanup(); Object.values(terminal).forEach((mock) => typeof mock === 'function' && mock.mockReset()) })

describe('ProductTaskTerminalDock', () => {
  it('does not spawn or control a native terminal while disabled', () => {
    render(<ProductTaskTerminalDock taskId="task-1" workDir="/workspace/project" workspaceAvailable />)
    expect(terminal.spawn).not.toHaveBeenCalled()
    expect(terminal.resize).not.toHaveBeenCalled()
    expect(terminal.write).not.toHaveBeenCalled()
    expect(terminal.kill).not.toHaveBeenCalled()
  })
})
