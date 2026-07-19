import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ScheduledTasks } from '../pages/ScheduledTasks'
import { AttachmentGallery } from '../components/chat/AttachmentGallery'
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
    expect(
      screen.getByText(/Scheduled tasks never bypass permissions/i),
    ).toBeInTheDocument()
    expect(container.innerHTML).toContain('Scheduled tasks')
  })
})

describe('Task attachments', () => {
  it('AttachmentGallery opens image gallery when an attachment is clicked', () => {
    render(
      <AttachmentGallery
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
