import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

import { LocalSlashCommandPanel } from './LocalSlashCommandPanel'
import { useSettingsStore } from '../../stores/settingsStore'

describe('LocalSlashCommandPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
  })

  it('keeps retired session inspection commands out of the help panel', () => {
    render(
      <LocalSlashCommandPanel
        command="help"
        commands={[
          { name: 'help', description: '' },
          { name: 'status', description: '' },
          { name: 'cost', description: '' },
          { name: 'context', description: '' },
        ]}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('/help')).toBeInTheDocument()
    expect(screen.queryByText('/status')).not.toBeInTheDocument()
    expect(screen.queryByText('/cost')).not.toBeInTheDocument()
    expect(screen.queryByText('/context')).not.toBeInTheDocument()
  })

})
