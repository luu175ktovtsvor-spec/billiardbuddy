import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { ComputerUseSettings } from './ComputerUseSettings'
import { useSettingsStore } from '../stores/settingsStore'

const computerUseApiMock = vi.hoisted(() => ({
  getStatus: vi.fn(),
  runSetup: vi.fn(),
  openSettings: vi.fn(),
}))

vi.mock('../api/computerUse', () => ({
  computerUseApi: computerUseApiMock,
}))

const readyStatus = {
  platform: 'darwin',
  supported: true,
  python: {
    installed: true,
    version: '3.12.0',
    path: '/usr/bin/python3',
    source: 'system',
    error: null,
  },
  venv: {
    created: false,
    path: '/tmp/venv',
  },
  dependencies: {
    installed: false,
    requirementsFound: true,
  },
  permissions: {
    accessibility: null,
    screenRecording: null,
  },
}

describe('ComputerUseSettings', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
    computerUseApiMock.getStatus.mockReset()
    computerUseApiMock.runSetup.mockReset()
    computerUseApiMock.openSettings.mockReset()
    computerUseApiMock.getStatus.mockResolvedValue(readyStatus)
    computerUseApiMock.runSetup.mockResolvedValue({ success: true, steps: [] })
  })

  it('keeps persistent app authorization controls out of ordinary settings', async () => {
    render(<ComputerUseSettings />)

    await screen.findByText('Computer Use')
    expect(computerUseApiMock.getStatus).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('Enabled')).not.toBeInTheDocument()
    expect(screen.queryByText('Authorized Apps')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Python Interpreter Path')).not.toBeInTheDocument()
  })

  it('sets up the local runtime and refreshes status without changing grants', async () => {
    render(<ComputerUseSettings />)

    await screen.findByText('Install Environment')
    await act(async () => {
      fireEvent.click(screen.getByText('Install Environment'))
    })

    expect(computerUseApiMock.runSetup).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(computerUseApiMock.getStatus).toHaveBeenCalledTimes(2))
  })

  it('opens only the selected macOS permission pane', async () => {
    computerUseApiMock.getStatus.mockResolvedValue({
      ...readyStatus,
      venv: { ...readyStatus.venv, created: true },
      dependencies: { ...readyStatus.dependencies, installed: true },
      permissions: { accessibility: false, screenRecording: false },
    })

    render(<ComputerUseSettings />)

    await screen.findByText('Open Accessibility Settings')
    await act(async () => {
      fireEvent.click(screen.getByText('Open Accessibility Settings'))
    })

    expect(computerUseApiMock.openSettings).toHaveBeenCalledWith('Privacy_Accessibility')
  })

  it('keeps the default Chinese setup errors product-facing', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    computerUseApiMock.getStatus.mockRejectedValue(new Error('private setup failure'))

    render(<ComputerUseSettings />)

    expect(await screen.findByText('暂时无法检查安装状态。')).toBeInTheDocument()
    expect(screen.queryByText(/private setup failure/i)).not.toBeInTheDocument()
  })

  it('does not show a raw setup failure in the default Chinese interface', async () => {
    useSettingsStore.setState({ locale: 'zh' })
    computerUseApiMock.runSetup.mockRejectedValue(new Error('private setup failure'))

    render(<ComputerUseSettings />)

    await screen.findByText('安装环境')
    await act(async () => {
      fireEvent.click(screen.getByText('安装环境'))
    })

    expect(await screen.findByText('安装请求未能完成，请稍后重试。')).toBeInTheDocument()
    expect(screen.queryByText(/private setup failure/i)).not.toBeInTheDocument()
  })
})
