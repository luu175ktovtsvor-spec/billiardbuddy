import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
}))

vi.mock('../product/api/taskCommands', () => ({
  productTaskCommandsApi: {
    listSkills: mocks.listSkills,
  },
}))

function switchToSkillsTab() {
  fireEvent.click(screen.getByText('Skills'))
}

describe('Settings > Skills tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useUIStore.setState({ activeSettingsTab: 'skills', pendingSettingsTab: null })
    mocks.listSkills.mockResolvedValue({
      commands: [{
        runtimeName: 'private-runtime-name',
        displayName: 'Weekly venue review',
        description: 'Review operations, risks, and next actions.',
      }],
    })
  })

  it('lists the safe Skill projection available to the current task context', async () => {
    render(<Settings />)
    switchToSkillsTab()

    expect(screen.getAllByText('Available workflows')).toHaveLength(2)
    expect(screen.getByText('Ready workflows')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Weekly venue review')).toBeInTheDocument())
    expect(screen.getByText('Review operations, risks, and next actions.')).toBeInTheDocument()
    expect(screen.getByText('Available in this conversation')).toBeInTheDocument()
    expect(mocks.listSkills).toHaveBeenCalledWith('')
    expect(screen.queryByPlaceholderText('Search by command name...')).not.toBeInTheDocument()
    expect(screen.queryByText('private-runtime-name')).not.toBeInTheDocument()
    expect(screen.queryByText('SKILL.md')).not.toBeInTheDocument()
  })
})
