import { beforeEach, describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { BackgroundTasksBar } from './BackgroundTasksBar'
import { useSettingsStore } from '../../stores/settingsStore'

describe('BackgroundTasksBar', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('keeps token usage out of the ordinary background-task drawer', () => {
    render(
      <BackgroundTasksBar
        tasks={[{
          taskId: 'agent-task-1',
          status: 'running',
          taskType: 'local_bash',
          summary: 'Checking the booking page',
          usage: { totalTokens: 1200, durationMs: 45_000 },
          startedAt: 1,
          updatedAt: 2,
        }]}
      />,
    )

    fireEvent.click(screen.getByTestId('background-tasks-button'))

    const drawer = screen.getByTestId('background-tasks-drawer')
    expect(drawer.textContent).toContain('Checking the booking page')
    expect(drawer.textContent).toContain('45s')
    expect(drawer.textContent).not.toContain('1.2k tokens')
  })
})
