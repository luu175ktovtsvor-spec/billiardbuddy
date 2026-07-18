import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

describe('Settings > Agents tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'agents', pendingSettingsTab: null })
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
})
