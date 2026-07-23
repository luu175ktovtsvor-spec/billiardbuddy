import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  grant: vi.fn(),
  revoke: vi.fn(),
}))

vi.mock('../../lib/desktopRuntime', () => ({
  whenDesktopServerReady: () => Promise.resolve(),
}))

vi.mock('../api/dataEgressConsent', () => ({
  productDataEgressConsentApi: mocks,
}))

import { RemoteDataEgressConsentGate, RemoteDataEgressSettings } from './RemoteDataEgressConsent'

const baseStatus = {
  available: true,
  active: false,
  policy_revision: 'bb-04f-managed-remote-v1' as const,
  receipt: null,
  disclosure: {
    purpose: '完成任务',
    data: ['文字', '图片', '音频'],
    receivers: [
      { capability: 'TextReasoning' as const, provider: 'DeepSeek', region: '中国大陆', retention: '最短必要期间' },
      { capability: 'VisualEvidence' as const, provider: 'Xiaomi MiMo', region: '中国大陆', retention: '目的所需期间' },
      { capability: 'SpeechTranscription' as const, provider: 'Alibaba Cloud Model Studio Fun-ASR', region: '中国大陆（北京端点）', retention: '按服务协议保存' },
    ],
    billable: true as const,
    revocable: true as const,
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.status.mockResolvedValue(baseStatus)
  mocks.grant.mockResolvedValue({
    ...baseStatus,
    active: true,
    receipt: {
      receipt_id: 'a'.repeat(64),
      policy_revision: baseStatus.policy_revision,
      capabilities: ['TextReasoning', 'VisualEvidence', 'SpeechTranscription'],
      purpose: 'managed_ai_tasks',
      billable: true,
      granted_at: '2026-07-24T00:00:00.000Z',
      revoked_at: null,
    },
  })
  mocks.revoke.mockResolvedValue(baseStatus)
})

describe('remote data egress consent', () => {
  it('shows purpose, receivers, retention, billing and revocation before granting', async () => {
    render(<RemoteDataEgressConsentGate />)
    await screen.findByRole('dialog', { name: '使用远程智能能力前，请先确认' })
    expect(screen.getByText(/DeepSeek/)).toBeInTheDocument()
    expect(screen.getByText(/Xiaomi MiMo/)).toBeInTheDocument()
    expect(screen.getByText(/Fun-ASR/)).toBeInTheDocument()
    expect(screen.getByText(/可能产生服务费用/)).toBeInTheDocument()
    expect(screen.getByText(/随时在“设置/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '同意并继续' }))
    await waitFor(() => expect(mocks.grant).toHaveBeenCalledTimes(1))
  })

  it('keeps the disclosure visible in settings and can revoke an active receipt', async () => {
    mocks.status.mockResolvedValueOnce(await mocks.grant())
    render(<RemoteDataEgressSettings />)
    await screen.findByText('已允许')
    fireEvent.click(screen.getByRole('button', { name: '撤销允许' }))
    await waitFor(() => expect(mocks.revoke).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(/DeepSeek/)).toBeInTheDocument()
  })
})
