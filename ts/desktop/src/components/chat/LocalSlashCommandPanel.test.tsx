import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'

const { skillsApiMock } = vi.hoisted(() => ({
  skillsApiMock: {
    list: vi.fn(),
  },
}))

vi.mock('../../api/skills', () => ({
  skillsApi: skillsApiMock,
}))

import { LocalSlashCommandPanel } from './LocalSlashCommandPanel'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTabStore, SETTINGS_TAB_ID } from '../../stores/tabStore'
import { useUIStore } from '../../stores/uiStore'
import { useSkillStore } from '../../stores/skillStore'

describe('LocalSlashCommandPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState(useTabStore.getInitialState(), true)
    useUIStore.setState({
      pendingMemoryPath: null,
      pendingSettingsTab: null,
    })
    useSkillStore.setState(useSkillStore.getInitialState(), true)
  })

  it('keeps retired session inspection commands out of the help panel', () => {
    render(
      <LocalSlashCommandPanel
        command="help"
        commands={[
          { name: 'help', description: 'Show commands' },
          { name: 'status', description: 'Inspect the session' },
          { name: 'cost', description: 'Inspect costs' },
          { name: 'context', description: 'Inspect context' },
        ]}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('/help')).toBeInTheDocument()
    expect(screen.queryByText('/status')).not.toBeInTheDocument()
    expect(screen.queryByText('/cost')).not.toBeInTheDocument()
    expect(screen.queryByText('/context')).not.toBeInTheDocument()
  })

  it('opens read-only detail for a bundled skill without surfacing an API error', async () => {
    skillsApiMock.list.mockResolvedValue({
      skills: [{
        name: 'image-workbench',
        displayName: '生成图片',
        description: '准备可复核的图片草稿',
        source: 'bundled',
        userInvocable: true,
        contentLength: 120,
        hasDirectory: true,
      }],
    })
    const fetchSkillDetail = vi.fn(async () => {
      useSkillStore.setState({ error: null })
    })
    useSkillStore.setState({ fetchSkillDetail, error: null })
    const onClose = vi.fn()

    render(
      <LocalSlashCommandPanel
        command="skills"
        cwd="/workspace/demo"
        onClose={onClose}
      />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /image-workbench/i }))

    await waitFor(() => {
      expect(fetchSkillDetail).toHaveBeenCalledWith(
        'bundled',
        'image-workbench',
        '/workspace/demo',
        'skills',
      )
      expect(useSkillStore.getState().error).toBeNull()
      expect(useUIStore.getState().pendingSettingsTab).toBe('skills')
      expect(useTabStore.getState().activeTabId).toBe(SETTINGS_TAB_ID)
      expect(onClose).toHaveBeenCalled()
    })
  })
})
