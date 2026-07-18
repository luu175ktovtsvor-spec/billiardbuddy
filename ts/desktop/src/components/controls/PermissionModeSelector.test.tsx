import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => ({
    'permMode.askPermissions': 'Ask permissions',
    'permMode.askPermDesc': 'Ask before changing files or running commands',
    'permMode.autoAccept': 'Auto accept edits',
    'permMode.autoAcceptDesc': 'Automatically accept edit operations',
    'permMode.planMode': 'Plan mode',
    'permMode.planModeDesc': 'Plan before executing',
    'permMode.bypass': 'Bypass permissions',
    'permMode.bypassDesc': 'Run without permission prompts',
    'permMode.executionPermissions': 'Execution Permissions',
    'permMode.label.default': 'Ask permissions',
    'permMode.label.acceptEdits': 'Auto accept edits',
    'permMode.label.plan': 'Plan mode',
    'permMode.label.bypassPermissions': 'Bypass permissions',
    'permMode.label.dontAsk': 'Bypass permissions',
    'permMode.enableBypassTitle': 'Enable bypass mode',
    'permMode.enableBypassSubtitle': 'This is risky',
    'permMode.enableBypassBody': 'Bypass permissions for this workspace.',
    'permMode.permReadWrite': 'Read and write files',
    'permMode.permShell': 'Run shell commands',
    'permMode.permPackages': 'Install packages',
    'permMode.enableBypassBtn': 'Enable bypass',
    'common.cancel': 'Cancel',
    'tabs.close': 'Close',
  }[key] ?? key),
}))

import { PermissionModeSelector } from './PermissionModeSelector'
import { useChatStore } from '../../stores/chatStore'
import { useSettingsStore } from '../../stores/settingsStore'
import { useSessionStore } from '../../stores/sessionStore'
import { useTabStore } from '../../stores/tabStore'

describe('PermissionModeSelector', () => {
  beforeEach(() => {
    useSettingsStore.setState({ permissionMode: 'default' })
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    useTabStore.setState({ activeTabId: null, tabs: [] })
  })

  it('updates the active session without writing the global default mode', () => {
    const setGlobalPermissionMode = vi.fn()
    const setSessionPermissionMode = vi.fn()
    useSettingsStore.setState({
      permissionMode: 'default',
      setPermissionMode: setGlobalPermissionMode,
    })
    useChatStore.setState({
      setSessionPermissionMode,
    } as Partial<ReturnType<typeof useChatStore.getState>>)
    useSessionStore.setState({
      activeSessionId: 'current-tab',
      sessions: [
        {
          id: 'current-tab',
          title: 'Current',
          createdAt: '2026-05-24T00:00:00.000Z',
          modifiedAt: '2026-05-24T00:00:00.000Z',
          messageCount: 1,
          projectPath: '/repo',
          projectRoot: '/repo',
          workDir: '/repo',
          workDirExists: true,
          permissionMode: 'default',
        },
      ],
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector />)

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Auto accept edits/ }))

    expect(setGlobalPermissionMode).not.toHaveBeenCalled()
    expect(setSessionPermissionMode).toHaveBeenCalledWith('current-tab', 'acceptEdits')
  })

  it('uses the active tab workspace when showing the bypass confirmation path', () => {
    useSessionStore.setState({
      activeSessionId: 'previous-session',
      sessions: [
        {
          id: 'previous-session',
          title: 'Previous',
          createdAt: '2026-05-24T00:00:00.000Z',
          modifiedAt: '2026-05-24T00:00:00.000Z',
          messageCount: 1,
          projectPath: 'C:\\Users\\LinTan',
          projectRoot: 'C:\\Users\\LinTan',
          workDir: 'C:\\Users\\LinTan',
          workDirExists: true,
        },
        {
          id: 'current-tab',
          title: 'Current',
          createdAt: '2026-05-24T00:00:00.000Z',
          modifiedAt: '2026-05-24T00:00:00.000Z',
          messageCount: 1,
          projectPath: 'C:\\Users\\LinTan\\MyScript\\test5',
          projectRoot: 'C:\\Users\\LinTan\\MyScript\\test5',
          workDir: 'C:\\Users\\LinTan\\MyScript\\test5',
          workDirExists: true,
        },
      ],
    })
    useTabStore.setState({
      activeTabId: 'current-tab',
      tabs: [{ sessionId: 'current-tab', title: 'Current', type: 'session', status: 'idle' }],
    })

    render(<PermissionModeSelector compact />)

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))

    expect(screen.getByRole('dialog', { name: 'Enable bypass mode' })).toBeInTheDocument()
    expect(screen.getByText('C:\\Users\\LinTan\\MyScript\\test5')).toBeInTheDocument()
    expect(screen.queryByText('C:\\Users\\LinTan')).not.toBeInTheDocument()
  })
})
