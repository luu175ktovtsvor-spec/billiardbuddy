import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom'
import type { ProductCapabilitySnapshot } from '../../../../shared/product/capabilitySnapshot'
import { useSettingsStore } from '../../stores/settingsStore'
import { useUIStore } from '../../stores/uiStore'
import { ProductCapabilitySettings } from './ProductCapabilitySettings'

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  install: vi.fn(),
  prepareRestart: vi.fn(),
  restart: vi.fn(),
}))

vi.mock('../api/capabilities', () => ({ getProductCapabilitySnapshot: mocks.getSnapshot }))
vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    capabilities: { recruitingBrowser: true },
    recruitingBrowser: { install: mocks.install },
    appMode: { prepareRestart: mocks.prepareRestart, restart: mocks.restart },
  }),
}))

function snapshot(overrides: Partial<ProductCapabilitySnapshot['capabilities'][number]> = {}): ProductCapabilitySnapshot {
  const ids = ['assistant', 'image_understanding', 'image_creation', 'voice_input', 'video_editing', 'scheduled_tasks', 'recruiting_browser'] as const
  return {
    schema_version: 1,
    observed_at: '2026-07-26T10:00:00.000Z',
    capabilities: ids.map(id => id === overrides.id ? { id, state: 'available', ...overrides } : { id, state: 'available' }),
  }
}

describe('ProductCapabilitySettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ locale: 'zh' })
    useUIStore.setState({ activeSettingsTab: 'capabilities' })
    mocks.install.mockResolvedValue({})
    mocks.prepareRestart.mockResolvedValue(undefined)
    mocks.restart.mockResolvedValue(undefined)
  })

  it('renders the server snapshot, quota and reason without technical service details', async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot({
      id: 'assistant',
      state: 'degraded',
      reason_code: 'daily_quota_used',
      repair_action: 'wait_for_reset',
      quota: { remaining_percent: 0, resets_at: '2026-07-27T00:00:00.000Z' },
    }))
    render(<ProductCapabilitySettings />)

    expect(await screen.findByText('任务助手')).toBeInTheDocument()
    expect(screen.getByText('今日额度已用完，将在重置时间自动恢复。')).toBeInTheDocument()
    expect(screen.getByText('0%')).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/DeepSeek|MiMo|provider|model|api.?key|token|queue/i)
  })

  it('routes update repairs to the actionable product page', async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot({
      id: 'video_editing', state: 'degraded', reason_code: 'media_tools_missing', repair_action: 'check_update',
    }))
    render(<ProductCapabilitySettings />)
    fireEvent.click(await screen.findByRole('button', { name: '检查更新' }))
    expect(useUIStore.getState().activeSettingsTab).toBe('about')
  })

  it('routes browser repair to setup and executes installation restart through the desktop host', async () => {
    mocks.getSnapshot.mockResolvedValue(snapshot({
      id: 'recruiting_browser', state: 'configured', reason_code: 'browser_extension_disconnected', repair_action: 'install_recruiting_browser',
    }))
    const { unmount } = render(<ProductCapabilitySettings />)
    fireEvent.click(await screen.findByRole('button', { name: '设置浏览器' }))
    expect(useUIStore.getState().activeSettingsTab).toBe('recruitingBrowser')
    expect(mocks.install).not.toHaveBeenCalled()

    unmount()
    mocks.getSnapshot.mockResolvedValue(snapshot({
      id: 'assistant', state: 'configured', reason_code: 'installation_activation_required', repair_action: 'restart_app',
    }))
    render(<ProductCapabilitySettings />)
    fireEvent.click(await screen.findByRole('button', { name: '重启应用' }))
    await waitFor(() => expect(mocks.prepareRestart).toHaveBeenCalledTimes(1))
    expect(mocks.restart).toHaveBeenCalledTimes(1)
  })
})
