import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const { settingsApiMock } = vi.hoisted(() => ({
  settingsApiMock: {
    getUser: vi.fn(),
    updateUser: vi.fn(),
    getOutputStyles: vi.fn(),
    setOutputStyle: vi.fn(),
  },
}))

vi.mock('../product/api/settings', () => ({
  productSettingsApi: settingsApiMock,
}))

vi.mock('../lib/desktopNotifications', () => ({
  getDesktopNotificationPermission: vi.fn().mockResolvedValue('unsupported'),
  notifyDesktop: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
  requestDesktopNotificationPermission: vi.fn().mockResolvedValue('unsupported'),
}))

vi.mock('../lib/desktopRuntime', () => ({
  isDesktopRuntime: () => false,
}))

import { GeneralSettings } from './Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { PRODUCT_TASK_TAB_PREFIX, useTabStore } from '../stores/tabStore'
import { EMPTY_PRODUCT_TASK_INDEX, useProductTaskStore } from '../product/stores/productTaskStore'

describe('GeneralSettings output style', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState(useSettingsStore.getInitialState(), true)
    useTabStore.setState({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
    useProductTaskStore.setState({ index: EMPTY_PRODUCT_TASK_INDEX })
    useSettingsStore.setState({ locale: 'en' })
    useTabStore.setState({
      activeTabId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
      lastActiveProductTaskId: 'task-1',
      tabs: [{
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        title: 'Project task',
        type: 'product-task',
        taskId: 'task-1',
      }],
    })
    useProductTaskStore.setState({
      index: {
        schemaVersion: 1,
        projects: [],
        tasks: [{
          id: 'task-1',
          projectId: 'project-1',
          workDir: '/repo',
          title: 'Project task',
          lifecycle: 'active',
          kind: 'main',
          createdAt: '2026-06-09T00:00:00.000Z',
          updatedAt: '2026-06-09T00:00:00.000Z',
          worktreeState: 'not_requested',
          actions: ['rename'],
        }],
        total: 1,
        capabilities: { createTask: true },
      },
    })
    settingsApiMock.getOutputStyles.mockResolvedValue({
      outputStyle: 'Project Style',
      scope: 'localSettings',
      workDir: '/repo',
      styles: [
        {
          value: 'default',
          label: 'Default',
          description: 'Default style',
          source: 'built-in',
        },
        {
          value: 'Project Style',
          label: 'Project Style',
          description: 'Project custom voice',
          source: 'projectSettings',
        },
        {
          value: 'Learning',
          label: 'Learning',
          description: 'Hands-on practice',
          source: 'built-in',
        },
      ],
    })
    settingsApiMock.setOutputStyle.mockResolvedValue({
      ok: true,
      outputStyle: 'Learning',
      scope: 'localSettings',
      workDir: '/repo',
    })
  })

  it('renders project output styles and saves the selected style', async () => {
    render(<GeneralSettings />)

    expect(await screen.findByText('Project Style')).toBeInTheDocument()
    expect(settingsApiMock.getOutputStyles).toHaveBeenCalledWith('/repo')
    expect(screen.getByText('Saved with the active project\'s local settings.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Select output style' }))
    fireEvent.click(screen.getByText('Learning'))

    await waitFor(() => {
      expect(settingsApiMock.setOutputStyle).toHaveBeenCalledWith('Learning', '/repo')
    })

    await act(async () => {
      await Promise.resolve()
    })
    expect(useSettingsStore.getState().outputStyle).toBe('Learning')
  })
})
