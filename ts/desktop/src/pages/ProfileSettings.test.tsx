import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ProfileSettings } from './ProfileSettings'
import { useSettingsStore } from '../stores/settingsStore'

const {
  getPreferencesMock,
  updateProfilePreferencesMock,
  uploadProfileAvatarMock,
  deleteProfileAvatarMock,
} = vi.hoisted(() => ({
  getPreferencesMock: vi.fn(),
  updateProfilePreferencesMock: vi.fn(),
  uploadProfileAvatarMock: vi.fn(),
  deleteProfileAvatarMock: vi.fn(),
}))

vi.mock('../api/desktopUiPreferences', () => ({
  desktopUiPreferencesApi: {
    getPreferences: getPreferencesMock,
    updateProfilePreferences: updateProfilePreferencesMock,
    uploadProfileAvatar: uploadProfileAvatarMock,
    deleteProfileAvatar: deleteProfileAvatarMock,
  },
  getProfileAvatarUrl: () => '/api/desktop-ui/preferences/profile/avatar?mock=1',
}))

function preferences(profile: {
  displayName: string
  subtitle: string
  avatarFile: string | null
  avatarUpdatedAt: string | null
}) {
  return {
    ok: true as const,
    preferences: {
      schemaVersion: 2,
      profile,
      sidebar: {
        projectOrder: [],
        pinnedProjects: [],
        hiddenProjects: [],
        projectOrganization: 'recentProject' as const,
        projectSortBy: 'updatedAt' as const,
      },
    },
  }
}

describe('ProfileSettings', () => {
  beforeEach(() => {
    getPreferencesMock.mockReset()
    updateProfilePreferencesMock.mockReset()
    uploadProfileAvatarMock.mockReset()
    deleteProfileAvatarMock.mockReset()
    getPreferencesMock.mockResolvedValue(preferences({
      displayName: 'Pool Room',
      subtitle: 'Local profile',
      avatarFile: null,
      avatarUpdatedAt: null,
    }))
    updateProfilePreferencesMock.mockImplementation((profile) => Promise.resolve(preferences({
      displayName: profile.displayName,
      subtitle: profile.subtitle,
      avatarFile: null,
      avatarUpdatedAt: null,
    })))
    uploadProfileAvatarMock.mockResolvedValue(preferences({
      displayName: 'Pool Room',
      subtitle: 'Local profile',
      avatarFile: 'profile/avatar.png',
      avatarUpdatedAt: '2026-07-19T08:00:00.000Z',
    }))
    deleteProfileAvatarMock.mockResolvedValue(preferences({
      displayName: 'Pool Room',
      subtitle: 'Local profile',
      avatarFile: null,
      avatarUpdatedAt: null,
    }))
    useSettingsStore.setState({ locale: 'en' })
  })

  it('keeps display-name and subtitle editing in General settings', async () => {
    render(<ProfileSettings />)

    const displayName = await screen.findByLabelText('Display name')
    const subtitle = screen.getByLabelText('Second line')
    expect(displayName).toHaveValue('Pool Room')
    expect(subtitle).toHaveValue('Local profile')

    fireEvent.change(displayName, { target: { value: 'Corner Pocket' } })
    fireEvent.change(subtitle, { target: { value: 'Home table' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }))

    await waitFor(() => {
      expect(updateProfilePreferencesMock).toHaveBeenCalledWith({
        displayName: 'Corner Pocket',
        subtitle: 'Home table',
      })
    })
    expect(screen.getByText('Saved locally')).toBeInTheDocument()
  })

  it('keeps avatar upload and removal connected to the profile API', async () => {
    render(<ProfileSettings />)

    await screen.findByLabelText('Display name')
    const avatarInput = screen.getByLabelText('Avatar')
    const avatar = new File(['avatar'], 'avatar.png', { type: 'image/png' })
    fireEvent.change(avatarInput, { target: { files: [avatar] } })

    await waitFor(() => expect(uploadProfileAvatarMock).toHaveBeenCalledWith(avatar))
    const removeButton = await screen.findByRole('button', { name: 'Remove avatar' })
    fireEvent.click(removeButton)

    await waitFor(() => expect(deleteProfileAvatarMock).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove avatar' })).not.toBeInTheDocument())
  })

  it('shows localized profile errors without exposing raw service details', async () => {
    getPreferencesMock.mockRejectedValueOnce(new Error('gateway rejected request with secret details'))

    render(<ProfileSettings />)

    expect(await screen.findByText('Could not load profile')).toBeInTheDocument()
    expect(screen.queryByText('gateway rejected request with secret details')).not.toBeInTheDocument()
  })
})
