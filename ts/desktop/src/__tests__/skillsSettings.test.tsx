import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useTabStore } from '../stores/tabStore'
import { useUIStore } from '../stores/uiStore'

function switchToSkillsTab() {
  fireEvent.click(screen.getByText('Skills'))
}

describe('Settings > Skills tab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({ tabs: [], activeTabId: null })
    useUIStore.setState({ activeSettingsTab: 'skills', pendingSettingsTab: null })
  })

  it('explains ready workflows without enumerating private Skill data', () => {
    render(<Settings />)
    switchToSkillsTab()

    expect(screen.getAllByText('Available workflows')).toHaveLength(2)
    expect(screen.getByText('Ready workflows')).toBeInTheDocument()
    expect(screen.getByText('Available in this conversation')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText('Search by command name...')).not.toBeInTheDocument()
    expect(screen.queryByText('/alpha')).not.toBeInTheDocument()
    expect(screen.queryByText('/telegram:access')).not.toBeInTheDocument()
    expect(screen.queryByText('Frontmatter description')).not.toBeInTheDocument()
    expect(screen.queryByText('SKILL.md')).not.toBeInTheDocument()
  })
})
