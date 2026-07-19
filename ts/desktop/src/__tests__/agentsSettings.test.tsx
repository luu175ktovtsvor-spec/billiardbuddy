import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}))

vi.mock('../api/agents', () => ({
  agentsApi: {
    list: mocks.list,
  },
}))

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { PRODUCT_TASKS_TAB_ID, useTabStore } from '../stores/tabStore'

describe('Settings > Agents tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'agents', pendingSettingsTab: null })
    useTabStore.setState({ tabs: [], activeTabId: null })
    window.localStorage.clear()
  })

  it('keeps assistant settings as a generic usage guide without loading Agent definitions', () => {
    mocks.list.mockResolvedValue({
      agents: [{
        displayName: 'assistant-1',
        runtimeName: 'private-runtime-name',
        description: 'PRIVATE_AGENT_DESCRIPTION',
        source: 'projectSettings',
        baseDir: '/private/project/.claude/agents',
        tools: ['Read'],
      }],
    })

    render(<Settings />)

    expect(screen.getByText('Collaborative assistants')).toBeInTheDocument()
    expect(screen.getByText('How to use it')).toBeInTheDocument()
    expect(screen.getByText(/Type \/agent in the message box/)).toBeInTheDocument()
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.queryByText('PRIVATE_AGENT_DESCRIPTION')).not.toBeInTheDocument()
    expect(screen.queryByText('projectSettings')).not.toBeInTheDocument()
    expect(screen.queryByText('/private/project/.claude/agents')).not.toBeInTheDocument()
    expect(screen.queryByText('Read')).not.toBeInTheDocument()
  })

  it('uses the product label for the Simplified Chinese navigation item', () => {
    useSettingsStore.setState({ locale: 'zh' })

    render(<Settings />)

    expect(screen.getAllByText('协作助手').length).toBeGreaterThan(0)
  })

  it('returns to the latest non-session tab instead of reopening a legacy Core session', () => {
    useTabStore.setState({
      tabs: [
        { sessionId: PRODUCT_TASKS_TAB_ID, title: '任务中心', type: 'product-tasks', status: 'idle' },
        { sessionId: 'session-1', title: '旧会话', type: 'session', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__settings__',
    })

    render(<Settings />)
    fireEvent.click(screen.getByTestId('settings-back'))

    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
  })

  it('opens the product task index when settings is the only non-session surface', () => {
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: '旧会话', type: 'session', status: 'idle' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings', status: 'idle' },
      ],
      activeTabId: '__settings__',
    })

    render(<Settings />)
    fireEvent.click(screen.getByTestId('settings-back'))

    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
    expect(useTabStore.getState().tabs).toContainEqual({
      sessionId: PRODUCT_TASKS_TAB_ID,
      title: '任务中心',
      type: 'product-tasks',
      status: 'idle',
    })
  })
})
