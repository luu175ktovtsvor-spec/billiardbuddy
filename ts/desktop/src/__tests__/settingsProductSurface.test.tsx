import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom'
import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'

describe('Settings product surface', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    useUIStore.setState({ activeSettingsTab: 'about', pendingSettingsTab: null })
  })

  it('keeps agent extensions and task environment settings without provider management', async () => {
    await act(async () => {
      render(<Settings />)
    })

    for (const available of [
      'General',
      'Privacy',
      'Capability status',
      'Skills',
      'Plugins',
      'MCP servers',
      'Terminal',
      'Recruiting browser',
      'About',
    ]) {
      expect(screen.getByRole('button', { name: available })).toBeInTheDocument()
    }
    expect(screen.queryByText('Provider')).not.toBeInTheDocument()
    expect(screen.queryByText('Model')).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })
})
