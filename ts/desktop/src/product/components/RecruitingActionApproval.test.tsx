import '@testing-library/jest-dom/vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RecruitingActionApproval } from './RecruitingActionApproval'

const mocks = vi.hoisted(() => ({
  listActions: vi.fn(),
  resolveAction: vi.fn(),
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    capabilities: { recruitingBrowser: true },
    recruitingBrowser: {
      listActions: mocks.listActions,
      resolveAction: mocks.resolveAction,
    },
  }),
}))

const pending = {
  id: 'browser_action_1234',
  task_id: 'product_task_1234',
  revision: 0,
  session_id: 'browser_session_1234',
  page_revision: 'page_revision_1234',
  kind: 'send_message' as const,
  candidate_ref: 'candidate_ref_1234',
  target_label: '示例候选人',
  message: '你好，想聊聊门店助教岗位。',
  state: 'awaiting_confirmation' as const,
  created_at: '2026-07-26T08:00:00.000Z',
  updated_at: '2026-07-26T08:00:00.000Z',
}

describe('RecruitingActionApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    mocks.listActions.mockReset().mockResolvedValue([pending])
    mocks.resolveAction.mockReset().mockResolvedValue({ ...pending, revision: 1, state: 'dispatching' })
  })

  it('shows the exact target and message before Electron Main receives confirmation', async () => {
    render(<RecruitingActionApproval taskId="product_task_1234" />)
    expect(await screen.findByText('招聘操作需要你确认')).toBeInTheDocument()
    expect(screen.getByText('示例候选人')).toBeInTheDocument()
    expect(screen.getByText('你好，想聊聊门店助教岗位。')).toBeInTheDocument()
    expect(mocks.resolveAction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }))
    await waitFor(() => expect(mocks.resolveAction).toHaveBeenCalledWith(
      'product_task_1234', 'browser_action_1234', 0, true,
    ))
  })

  it('can reject without dispatching the action', async () => {
    render(<RecruitingActionApproval taskId="product_task_1234" />)
    await screen.findByText('招聘操作需要你确认')
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    await waitFor(() => expect(mocks.resolveAction).toHaveBeenCalledWith(
      'product_task_1234', 'browser_action_1234', 0, false,
    ))
  })
})
