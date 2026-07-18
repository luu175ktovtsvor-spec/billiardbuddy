import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserPanelStore } from '../../stores/browserPanelStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore } from '../../stores/tabStore'
import { useTerminalPanelStore } from '../../stores/terminalPanelStore'
import { useUIStore } from '../../stores/uiStore'
import { useWorkspacePanelStore } from '../../stores/workspacePanelStore'

vi.mock('./WindowControls', () => ({
  WindowControls: () => null,
  showWindowControls: false,
}))

import { TopBar } from './TopBar'

const SESSION_ID = 'topbar-session'

beforeEach(() => {
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useTerminalPanelStore.setState(useTerminalPanelStore.getInitialState(), true)
  useTabStore.setState({
    tabs: [{ sessionId: SESSION_ID, title: 'Panel task', type: 'session', status: 'idle' }],
    activeTabId: SESSION_ID,
  })
  useSessionStore.setState({
    sessions: [{
      id: SESSION_ID,
      title: 'Panel task',
      createdAt: '2026-07-18T00:00:00.000Z',
      modifiedAt: '2026-07-18T00:00:00.000Z',
      messageCount: 0,
      projectPath: '/workspace/panel-task',
      workDir: '/workspace/panel-task',
      workDirExists: true,
    }],
    activeSessionId: SESSION_ID,
    isLoading: false,
    error: null,
  })
  useSettingsStore.setState({ locale: 'en' })
  useUIStore.setState({ sidebarOpen: true, activeModal: null })
})

afterEach(() => {
  cleanup()
  useBrowserPanelStore.setState(useBrowserPanelStore.getInitialState(), true)
  useWorkspacePanelStore.setState(useWorkspacePanelStore.getInitialState(), true)
  useTerminalPanelStore.setState(useTerminalPanelStore.getInitialState(), true)
  useTabStore.setState({ tabs: [], activeTabId: null })
  useSessionStore.setState({ sessions: [], activeSessionId: null, isLoading: false, error: null })
})

describe('TopBar panel controls', () => {
  it('opens the dedicated task-search modal from search and recent-task controls', () => {
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Search tasks' }))
    expect(useUIStore.getState().activeModal).toBe('task-search')

    useUIStore.getState().closeModal()
    fireEvent.click(screen.getByRole('button', { name: 'Recent tasks' }))
    expect(useUIStore.getState().activeModal).toBe('task-search')
  })

  it('opens, selects, and closes browser and file panels independently', () => {
    render(<TopBar />)

    fireEvent.click(screen.getByRole('button', { name: 'Show Browser' }))

    expect(useBrowserPanelStore.getState().bySession[SESSION_ID]?.isOpen).toBe(true)
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(false)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('browser')

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))

    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')
    expect(useBrowserPanelStore.getState().bySession[SESSION_ID]?.isOpen).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Hide Workspace' }))
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(false)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('browser')

    fireEvent.click(screen.getByRole('button', { name: 'Show Workspace' }))
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')

    fireEvent.click(screen.getByRole('button', { name: 'Show Browser' }))
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('browser')

    fireEvent.click(screen.getByRole('button', { name: 'Hide Browser' }))

    expect(useBrowserPanelStore.getState().bySession[SESSION_ID]?.isOpen).toBe(false)
    expect(useWorkspacePanelStore.getState().isPanelOpen(SESSION_ID)).toBe(true)
    expect(useWorkspacePanelStore.getState().getMode(SESSION_ID)).toBe('workspace')
  })
})
