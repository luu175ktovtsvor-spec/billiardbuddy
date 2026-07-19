import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ScheduledTasks } from '../pages/ScheduledTasks'
import { UserMessage } from '../components/chat/UserMessage'
import { useSettingsStore } from '../stores/settingsStore'

beforeEach(() => {
  useSettingsStore.setState({ locale: 'en' })
})

afterEach(async () => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  cleanup()
})

describe('Content-only pages render without errors', () => {
  it('ScheduledTasks renders (store-connected)', async () => {
    const { container } = render(<ScheduledTasks />)
    await screen.findByText('Scheduled tasks')
    expect(container.innerHTML).toContain('Scheduled tasks')
  })
})

describe('Chat attachments', () => {
  it('UserMessage opens image gallery when an attachment is clicked', () => {
    render(
      <UserMessage
        content=""
        attachments={[
          {
            type: 'image',
            name: 'diagram.png',
            data: 'data:image/png;base64,abc123',
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByText('diagram.png')).toBeInTheDocument()
  })
})
