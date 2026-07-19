import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '../../stores/settingsStore'
import { browserHost } from '../../lib/desktopHost/browserHost'

const terminalMocks = vi.hoisted(() => ({
  available: false,
  getBashPath: vi.fn(),
  setBashPath: vi.fn(),
}))

vi.mock('../../api/terminal', () => ({
  terminalApi: {
    isAvailable: () => terminalMocks.available,
    getBashPath: terminalMocks.getBashPath,
    setBashPath: terminalMocks.setBashPath,
  },
}))

import { ProductTerminalPreferences } from './ProductTerminalPreferences'

describe('ProductTerminalPreferences', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useSettingsStore.setState({
      locale: 'en',
      desktopTerminal: { startupShell: 'system', customShellPath: '' },
      setDesktopTerminal: vi.fn().mockResolvedValue(undefined),
    })
    terminalMocks.available = false
    terminalMocks.getBashPath.mockReset()
    terminalMocks.setBashPath.mockReset()
    terminalMocks.getBashPath.mockResolvedValue(null)
    terminalMocks.setBashPath.mockResolvedValue(undefined)
    Reflect.deleteProperty(window, 'desktopHost')
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  })

  afterEach(cleanup)

  it('keeps desktop settings free of an unbound live terminal on macOS', () => {
    render(<ProductTerminalPreferences />)

    expect(screen.getByTestId('product-terminal-preferences')).toHaveTextContent('Startup shell')
    expect(screen.queryByTestId('product-task-terminal-frame')).not.toBeInTheDocument()
  })

  it('validates and persists the Windows startup shell preference for future task terminals', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    const setDesktopTerminal = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      desktopTerminal: { startupShell: 'custom', customShellPath: 'C:\\Tools\\pwsh.exe' },
      setDesktopTerminal,
    })

    render(<ProductTerminalPreferences />)
    fireEvent.click(screen.getByRole('button', { name: 'Save shell' }))

    await waitFor(() => {
      expect(setDesktopTerminal).toHaveBeenCalledWith({
        startupShell: 'custom',
        customShellPath: 'C:\\Tools\\pwsh.exe',
      })
    })
    expect(screen.getByText('Saved. Restart or open a new terminal to apply it.')).toBeInTheDocument()
  })

  it('rejects an empty custom Windows shell path before it reaches the settings API', () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    const setDesktopTerminal = vi.fn().mockResolvedValue(undefined)
    useSettingsStore.setState({
      desktopTerminal: { startupShell: 'custom', customShellPath: '' },
      setDesktopTerminal,
    })

    render(<ProductTerminalPreferences />)
    fireEvent.click(screen.getByRole('button', { name: 'Save shell' }))

    expect(screen.getByText('Enter a shell path before saving.')).toBeInTheDocument()
    expect(setDesktopTerminal).not.toHaveBeenCalled()
  })

  it('keeps the Windows Bash path in the capability-protected desktop API', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    terminalMocks.getBashPath.mockResolvedValue('C:\\Program Files\\Git\\bin\\bash.exe')
    const setBashPath = terminalMocks.setBashPath

    render(<ProductTerminalPreferences />)

    const input = await screen.findByDisplayValue('C:\\Program Files\\Git\\bin\\bash.exe')
    fireEvent.change(input, { target: { value: ' C:\\Tools\\Git\\bin\\bash.exe ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(setBashPath).toHaveBeenCalledWith('C:\\Tools\\Git\\bin\\bash.exe'))
  })

  it('uses the injected desktop dialog to choose a Windows Bash executable', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
    terminalMocks.available = true
    const open = vi.fn().mockResolvedValue('C:\\Program Files\\Git\\bin\\bash.exe')
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: { ...browserHost.capabilities, dialogs: true },
      dialogs: { ...browserHost.dialogs, open },
    }

    render(<ProductTerminalPreferences />)
    await screen.findByPlaceholderText('Bash Path')
    fireEvent.click(screen.getByText('folder_open').closest('button')!)

    expect(await screen.findByDisplayValue('C:\\Program Files\\Git\\bin\\bash.exe')).toBeInTheDocument()
    expect(open).toHaveBeenCalledWith({
      title: 'Bash Path',
      multiple: false,
      filters: [{ name: 'Bash Executable', extensions: ['exe', '', 'bat', 'cmd', 'ps1'] }],
    })
  })
})
