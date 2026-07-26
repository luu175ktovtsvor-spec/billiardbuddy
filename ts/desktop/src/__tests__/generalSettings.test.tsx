import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useUpdateStore } from '../stores/updateStore'
import { PRODUCT_TASKS_TAB_ID, useTabStore } from '../stores/tabStore'
import type { AppMode, ChatSendBehavior, ThemeMode } from '../types/settings'
import { browserHost } from '../lib/desktopHost/browserHost'

const desktopNotificationsMock = vi.hoisted(() => ({
  getDesktopNotificationPermission: vi.fn(),
  getDesktopNotificationPlatform: vi.fn(),
  notifyDesktop: vi.fn(),
  requestDesktopNotificationPermission: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
}))
const prepareRestartMock = vi.hoisted(() => vi.fn())
const dialogOpenMock = vi.hoisted(() => vi.fn())
const restartMock = vi.hoisted(() => vi.fn())
vi.mock('../lib/desktopNotifications', () => desktopNotificationsMock)
function installElectronDesktopHost() {
  window.desktopHost = {
    ...browserHost,
    kind: 'electron',
    isDesktop: true,
    capabilities: {
      ...browserHost.capabilities,
      appMode: true,
      dialogs: true,
      notifications: true,
      shell: true,
      updates: true,
      zoom: true,
    },
    app: {
      getVersion: vi.fn().mockResolvedValue('0.3.2'),
    },
    dialogs: {
      ...browserHost.dialogs,
      open: vi.fn((options) => dialogOpenMock(options)),
    },
    shell: {
      ...browserHost.shell,
      open: vi.fn().mockResolvedValue(undefined),
    },
    appMode: {
      ...browserHost.appMode,
      prepareRestart: prepareRestartMock,
      restart: restartMock,
    },
  }
}

describe('Settings > General tab', () => {
  beforeEach(() => {
    vi.useRealTimers()
    desktopNotificationsMock.getDesktopNotificationPermission.mockReset()
    desktopNotificationsMock.getDesktopNotificationPlatform.mockReset()
    desktopNotificationsMock.notifyDesktop.mockReset()
    desktopNotificationsMock.requestDesktopNotificationPermission.mockReset()
    desktopNotificationsMock.openDesktopNotificationSettings.mockReset()
    // Most cases do not exercise notification discovery. Keep that mount-time
    // request pending so unrelated assertions cannot finish while an async
    // state update is still queued; the dedicated notification cases exercise
    // the user-triggered permission request below.
    desktopNotificationsMock.getDesktopNotificationPermission.mockImplementation(() => new Promise(() => undefined))
    desktopNotificationsMock.getDesktopNotificationPlatform.mockReturnValue('darwin')
    desktopNotificationsMock.notifyDesktop.mockResolvedValue(true)
    desktopNotificationsMock.requestDesktopNotificationPermission.mockResolvedValue('granted')
    desktopNotificationsMock.openDesktopNotificationSettings.mockResolvedValue(true)
    prepareRestartMock.mockReset()
    prepareRestartMock.mockResolvedValue(undefined)
    dialogOpenMock.mockReset()
    dialogOpenMock.mockResolvedValue('/Users/test/billiardbuddy-data')
    restartMock.mockReset()
    restartMock.mockResolvedValue(undefined)
    installElectronDesktopHost()
    useSettingsStore.setState({
      locale: 'en',
      theme: 'light',
      productAutoMemoryEnabled: false,
      deepThinkingEnabled: true,
      preventSleepWhileRunning: false,
      skipWebFetchPreflight: true,
      desktopNotificationsEnabled: true,
      chatSendBehavior: 'enter',
      responseLanguage: '',
      uiZoom: 1,
      webSearch: { enabled: true },
      network: {
        aiRequestTimeoutMs: 120_000,
        proxy: { mode: 'direct', url: '' },
      },
      setProductAutoMemoryEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ productAutoMemoryEnabled: enabled })
      }),
      setDeepThinkingEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ deepThinkingEnabled: enabled })
      }),
      setPreventSleepWhileRunning: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ preventSleepWhileRunning: enabled })
      }),
      setTheme: vi.fn().mockImplementation(async (theme: ThemeMode) => {
        useSettingsStore.setState({ theme })
      }),
      setSkipWebFetchPreflight: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ skipWebFetchPreflight: enabled })
      }),
      setDesktopNotificationsEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ desktopNotificationsEnabled: enabled })
      }),
      setChatSendBehavior: vi.fn().mockImplementation(async (chatSendBehavior: ChatSendBehavior) => {
        useSettingsStore.setState({ chatSendBehavior })
      }),
      setResponseLanguage: vi.fn().mockImplementation(async (language: string) => {
        useSettingsStore.setState({ responseLanguage: language })
      }),
      setUiZoom: vi.fn().mockImplementation((uiZoom: number) => {
        useSettingsStore.setState({ uiZoom })
      }),
      setWebSearch: vi.fn().mockImplementation(async (webSearch) => {
        useSettingsStore.setState({ webSearch })
      }),
      setNetwork: vi.fn().mockImplementation(async (network) => {
        useSettingsStore.setState({ network })
      }),
      appMode: {
        mode: 'default',
        portableDir: null,
        defaultPortableDir: '/Applications/BilliardBuddy/BILLIARDBUDDY_CONFIG_DIR',
        activeConfigDir: null,
        configDirSource: 'system',
      },
      appModeRequiresRestart: false,
      fetchAppMode: vi.fn().mockResolvedValue(undefined),
      setAppMode: vi.fn().mockImplementation(async (mode: AppMode, portableDir?: string | null) => {
        useSettingsStore.setState({
          appMode: {
            mode,
            portableDir: mode === 'portable' ? portableDir ?? '/Applications/BilliardBuddy/BILLIARDBUDDY_CONFIG_DIR' : null,
            defaultPortableDir: '/Applications/BilliardBuddy/BILLIARDBUDDY_CONFIG_DIR',
            activeConfigDir: mode === 'portable' ? portableDir ?? '/Applications/BilliardBuddy/BILLIARDBUDDY_CONFIG_DIR' : null,
            configDirSource: mode === 'portable' ? 'portable' : 'system',
          },
          appModeRequiresRestart: true,
        })
      }),
    })

    useUIStore.setState({ activeSettingsTab: 'general', pendingSettingsTab: null, toasts: [] })
    useUpdateStore.setState({
      status: 'idle',
      availableVersion: null,
      releaseNotes: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: false,
      initialize: vi.fn().mockResolvedValue(undefined),
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
      dismissPrompt: vi.fn(),
    })
  })

  it('does not expose technical network or WebFetch controls', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.queryByRole('heading', { name: 'Network' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Skip WebFetch domain preflight')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Proxy URL')).not.toBeInTheDocument()
  })

  it('keeps the selected settings tab when returning to Settings', () => {
    const { unmount } = render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()

    unmount()
    render(<Settings />)

    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeInTheDocument()
  })

  it('offers the light, dark, and follow-system appearance themes', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const light = screen.getByRole('button', { name: 'Light' })
    const dark = screen.getByRole('button', { name: 'Dark' })
    const system = screen.getByRole('button', { name: 'System' })

    expect((light.compareDocumentPosition(dark) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((dark.compareDocumentPosition(system) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'System' }))

    expect(useSettingsStore.getState().setTheme).toHaveBeenCalledWith('system')
  })

  it('marks the active appearance theme as selected', () => {
    useSettingsStore.setState({ theme: 'dark' })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'Light' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('keeps UI zoom below system notifications because it is a secondary setting', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const notificationsHeading = screen.getByRole('heading', { name: 'System Notifications' })
    const uiZoomHeading = screen.getByRole('heading', { name: 'UI Zoom' })
    const webSearchHeading = screen.getByRole('heading', { name: 'Online Research' })
    const storageHeading = screen.getByRole('heading', { name: 'Data Storage Location' })

    expect((notificationsHeading.compareDocumentPosition(uiZoomHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((uiZoomHeading.compareDocumentPosition(webSearchHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((webSearchHeading.compareDocumentPosition(storageHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
  })

  it('lets users choose Ctrl or Command Enter as the chat send shortcut', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: /Ctrl\/Cmd\+Enter sends/i }))

    await waitFor(() => {
      expect(useSettingsStore.getState().setChatSendBehavior).toHaveBeenCalledWith('modifierEnter')
    })
    expect(screen.getByRole('button', { name: /Ctrl\/Cmd\+Enter sends/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('restores the prevent-sleep preference for running tasks', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const toggle = screen.getByLabelText('Prevent sleep while tasks run')
    expect(toggle).not.toBeChecked()

    fireEvent.click(toggle)

    await waitFor(() => {
      expect(useSettingsStore.getState().setPreventSleepWhileRunning).toHaveBeenCalledWith(true)
    })
    expect(toggle).toBeChecked()
  })

  it('keeps data storage at the bottom of General settings', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const webSearchHeading = screen.getByRole('heading', { name: 'Online Research' })
    const storageHeading = screen.getByRole('heading', { name: 'Data Storage Location' })

    expect((webSearchHeading.compareDocumentPosition(storageHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect(screen.getByText(/Switching directories does not migrate existing data/)).toBeInTheDocument()
  })

  it('lets desktop users choose a portable data directory and relaunch immediately', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))

    await waitFor(() => {
      expect(screen.getByLabelText('Portable data directory')).toHaveValue('/Users/test/billiardbuddy-data')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.getByText('Switch data storage location?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().setAppMode).toHaveBeenCalledWith('portable', '/Users/test/billiardbuddy-data')
      expect(prepareRestartMock).toHaveBeenCalledTimes(1)
      expect(restartMock).toHaveBeenCalledTimes(1)
    })
  })

  it('switches back to the system directory without deleting portable data', async () => {
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: '/Users/test/billiardbuddy-data',
        defaultPortableDir: '/Applications/BilliardBuddy/BILLIARDBUDDY_CONFIG_DIR',
        activeConfigDir: '/Users/test/billiardbuddy-data',
        configDirSource: 'portable',
      },
    })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: /Use system directory/ }))

    expect(screen.getByText(/Data in the portable directory is not deleted/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart' }))

    await waitFor(() => {
      expect(useSettingsStore.getState().setAppMode).toHaveBeenCalledWith('default', null)
      expect(prepareRestartMock).toHaveBeenCalledTimes(1)
      expect(restartMock).toHaveBeenCalledTimes(1)
    })
  })

  it('validates portable directory input and lets users reset to the app-side folder', async () => {
    useSettingsStore.setState({
      appMode: {
        ...useSettingsStore.getState().appMode,
        defaultPortableDir: '/Applications/BilliardBuddy/data',
      },
    })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const input = screen.getByLabelText('Portable data directory')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.getByText('Choose or enter a portable data directory first.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Use the default portable folder beside the app' }))
    expect(input).toHaveValue('/Applications/BilliardBuddy/data')
    expect(screen.queryByText('Choose or enter a portable data directory first.')).not.toBeInTheDocument()
  })

  it('masks managed agent data locations while retaining the configured app mode', () => {
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: '/Users/test/.BilliardBuddy',
        defaultPortableDir: '/Applications/BilliardBuddy/BILLIARDBUDDY_CONFIG_DIR',
        activeConfigDir: '/Users/test/.BilliardBuddy',
        configDirSource: 'portable',
      },
    })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const input = screen.getByLabelText('Portable data directory')
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', 'BilliardBuddy-managed data location')
    expect(screen.getAllByText('BilliardBuddy-managed data location').length).toBeGreaterThanOrEqual(2)
    expect(screen.queryByText('/Users/test/.BilliardBuddy')).not.toBeInTheDocument()
  })

  it('shows folder picker failures as an inline storage error', async () => {
    dialogOpenMock.mockRejectedValueOnce(new Error('dialog unavailable'))

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))

    expect(await screen.findByText('Could not open the folder picker. Paste the folder path manually.')).toBeInTheDocument()
  })

  it('treats a launch-time data-directory override as the controlling data source', async () => {
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: '/env/billiardbuddy-data',
        defaultPortableDir: '/Applications/BilliardBuddy/BILLIARDBUDDY_CONFIG_DIR',
        activeConfigDir: '/env/billiardbuddy-data',
        configDirSource: 'environment',
      },
    })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByText(/The current directory was set when the app launched/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Use system directory/ }))
    expect(screen.getByText(/Remove it before switching back to the system directory/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Portable data directory'), { target: { value: '/other/data' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.queryByText('Switch data storage location?')).not.toBeInTheDocument()
    expect(screen.getByText(/Remove it before switching back to the system directory/)).toBeInTheDocument()
  })

  it('keeps mode switch confirmation cancelable before restart starts', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.getByText('Switch data storage location?')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByText('Switch data storage location?')).not.toBeInTheDocument()
    })
    expect(useSettingsStore.getState().setAppMode).not.toHaveBeenCalled()
  })

  it('shows restart preparation failures without relaunching', async () => {
    prepareRestartMock.mockRejectedValueOnce(new Error('restart preparation failed'))

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart' }))

    expect(await screen.findByText('The change was saved, but automatic restart failed. Restart the app manually.')).toBeInTheDocument()
    expect(screen.queryByText('restart preparation failed')).not.toBeInTheDocument()
    expect(restartMock).not.toHaveBeenCalled()
  })

  it('shows the saved restart-required state inside the storage section', () => {
    useSettingsStore.setState({ appModeRequiresRestart: true })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByText('The storage change has been saved. Restart the app for the new data directory to take effect.')).toBeInTheDocument()
  })

  it('previews UI zoom while dragging and applies it once on release', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByText('Shortcuts are faster:')).toBeInTheDocument()
    expect(screen.getByText('macOS')).toBeInTheDocument()
    expect(screen.getByText('Windows')).toBeInTheDocument()
    expect(screen.getByText('0 resets zoom to 100%.')).toBeInTheDocument()

    const slider = screen.getByLabelText('UI Zoom')
    expect(slider).toHaveAttribute('step', '0.01')

    fireEvent.pointerDown(slider, { pointerId: 1 })
    await act(async () => {
      fireEvent.change(slider, {
        target: { value: '1.25', valueAsNumber: 1.25 },
      })
    })

    expect(screen.getAllByText('125%')).toHaveLength(2)
    expect(useSettingsStore.getState().setUiZoom).not.toHaveBeenCalledWith(1.25)
    expect(useSettingsStore.getState().uiZoom).toBe(1)
    expect(slider).toHaveValue('1.25')
    expect(slider).toHaveClass('settings-zoom-range')
    expect(slider.closest('.settings-zoom-control')).toHaveClass('is-dragging')
    expect(slider.closest('.settings-zoom-control')).toHaveStyle({ '--settings-zoom-range-progress': '50%' })

    await act(async () => {
      fireEvent.pointerUp(slider, { pointerId: 1 })
    })

    expect(useSettingsStore.getState().setUiZoom).toHaveBeenCalledWith(1.25)
    expect(slider.closest('.settings-zoom-control')).not.toHaveClass('is-dragging')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset UI zoom to 100%' }))
    })

    expect(useSettingsStore.getState().setUiZoom).toHaveBeenLastCalledWith(1)
  })

  it('updates the UI zoom slider when shortcut zoom changes the shared setting while Settings is open', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const slider = screen.getByLabelText('UI Zoom')

    await act(async () => {
      useSettingsStore.setState({ uiZoom: 1.1 })
    })

    expect(slider).toHaveValue('1.1')
    expect(screen.getAllByText('110%')).toHaveLength(2)
    expect(slider.closest('.settings-zoom-control')).toHaveStyle({ '--settings-zoom-range-progress': '40%' })
  })

  it('does not expose retired runtime inspection navigation items', () => {
    render(<Settings />)

    expect(screen.queryByText('Token usage')).not.toBeInTheDocument()
    expect(screen.queryByText('Diagnostics')).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
  })

  it('exposes the product deep-thinking switch without exposing provider internals', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable deep thinking')
    expect(toggle).toBeVisible()
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setDeepThinkingEnabled).toHaveBeenCalledWith(false)
    expect(screen.queryByText(/DeepSeek/)).not.toBeInTheDocument()
    expect(screen.queryByText(/--thinking/)).not.toBeInTheDocument()
  })

  it('keeps project long-term memory inside collapsed task run options without a background-task confirmation', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByLabelText('Enable project long-term memory')).not.toBeVisible()

    fireEvent.click(screen.getByText('Task run options'))

    const toggle = screen.getByLabelText('Enable project long-term memory')
    expect(toggle).toBeVisible()
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setProductAutoMemoryEnabled).toHaveBeenCalledWith(true)
    expect(screen.queryByText(/background memory consolidation/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Enable project long-term memory')).toBeChecked()
  })

  it('lets the user disable project long-term memory without changing task session context', async () => {
    useSettingsStore.setState({ productAutoMemoryEnabled: true })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByText('Task run options'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable project long-term memory'))
    })

    expect(useSettingsStore.getState().setProductAutoMemoryEnabled).toHaveBeenCalledWith(false)
  })

  it('keeps General checkbox inputs anchored inside their visible rows', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByText('Task run options'))

    for (const label of [
      'Enable project long-term memory',
      'Enable system notifications',
      'Enable online research',
    ]) {
      const toggle = screen.getByLabelText(label)
      const row = toggle.closest('label') as HTMLElement | null
      expect(toggle).toHaveClass('settings-checkbox-input')
      expect(toggle).not.toHaveClass('sr-only')
      expect(row).not.toBeNull()
      expect(row!).toHaveClass('relative')
    }
  })

  it('uses the shared dropdown for response language', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.queryByRole('combobox', { name: 'Response Language' })).not.toBeInTheDocument()
    expect(screen.queryByRole('radiogroup', { name: 'Response Language' })).not.toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: 'Response Language' })
    expect(trigger).toHaveTextContent('Default (English)')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: '中文 (Chinese)' }))

    expect(useSettingsStore.getState().setResponseLanguage).toHaveBeenCalledWith('chinese')
  })

  it('lets the user disable desktop system notifications', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable system notifications')
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setDesktopNotificationsEnabled).toHaveBeenCalledWith(false)
    expect(desktopNotificationsMock.requestDesktopNotificationPermission).not.toHaveBeenCalled()
  })

  it('requests native notification permission when desktop notifications are enabled', async () => {
    useSettingsStore.setState({ desktopNotificationsEnabled: false })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable system notifications'))
    })

    expect(useSettingsStore.getState().setDesktopNotificationsEnabled).toHaveBeenCalledWith(true)
    await vi.waitFor(() => {
      expect(desktopNotificationsMock.requestDesktopNotificationPermission).toHaveBeenCalledTimes(1)
    })
    expect(desktopNotificationsMock.notifyDesktop).toHaveBeenCalledWith({
      title: 'BilliardBuddy notifications are enabled',
      body: 'Permission prompts and completed agent replies will now use system notifications.',
    })
  })

  it('does not fire the enable smoke notification on Windows Electron', async () => {
    useSettingsStore.setState({ desktopNotificationsEnabled: false })
    desktopNotificationsMock.getDesktopNotificationPlatform.mockReturnValue('win32')
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable system notifications'))
    })

    expect(useSettingsStore.getState().setDesktopNotificationsEnabled).toHaveBeenCalledWith(true)
    await vi.waitFor(() => {
      expect(desktopNotificationsMock.requestDesktopNotificationPermission).toHaveBeenCalledTimes(1)
    })
    expect(desktopNotificationsMock.notifyDesktop).not.toHaveBeenCalled()
    expect(desktopNotificationsMock.openDesktopNotificationSettings).not.toHaveBeenCalled()
  })

  it('shows the system settings action when enabling notifications finds system denial', async () => {
    useSettingsStore.setState({ desktopNotificationsEnabled: false })
    desktopNotificationsMock.requestDesktopNotificationPermission.mockResolvedValue('denied')
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable system notifications'))
    })

    await vi.waitFor(() => {
      expect(screen.getByText('Permission: Blocked by system settings')).toBeInTheDocument()
    })
    expect(desktopNotificationsMock.openDesktopNotificationSettings).not.toHaveBeenCalled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))
    })

    expect(desktopNotificationsMock.openDesktopNotificationSettings).toHaveBeenCalledTimes(1)
  })

  it('keeps online research as a product toggle without provider credentials', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable online research')
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setWebSearch).toHaveBeenCalledWith({
      enabled: false,
    })
    expect(screen.queryByText('Tavily')).not.toBeInTheDocument()
    expect(screen.queryByText('Brave')).not.toBeInTheDocument()
    expect(document.querySelector('input[type="password"]')).toBeNull()
  })

  it('keeps agent extension and task environment management in Settings', () => {
    render(<Settings />)

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'MCP servers' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Plugins' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Skills' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Recruiting browser' })).toBeInTheDocument()
    expect(screen.queryByText('Agents')).not.toBeInTheDocument()
  })

  it('returns from settings to the latest product surface', () => {
    useTabStore.setState({
      tabs: [
        { sessionId: PRODUCT_TASKS_TAB_ID, title: '任务中心', type: 'product-tasks' },
        { sessionId: '__settings__', title: 'Settings', type: 'settings' },
      ],
      activeTabId: '__settings__',
    })

    render(<Settings />)
    fireEvent.click(screen.getByTestId('settings-back'))

    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
  })

  it('opens the task index when settings is the only open surface', () => {
    useTabStore.setState({
      tabs: [{ sessionId: '__settings__', title: 'Settings', type: 'settings' }],
      activeTabId: '__settings__',
    })

    render(<Settings />)
    fireEvent.click(screen.getByTestId('settings-back'))

    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
    expect(useTabStore.getState().tabs).toContainEqual({
      sessionId: PRODUCT_TASKS_TAB_ID,
      title: '任务中心',
      type: 'product-tasks',
    })
  })
})


describe('Settings > About tab', () => {
  beforeEach(() => {
    installElectronDesktopHost()
    useUIStore.setState({ activeSettingsTab: 'general', pendingSettingsTab: 'about' })
    useSettingsStore.setState({ locale: 'en' })
    useUpdateStore.setState({
      status: 'idle',
      availableVersion: null,
      releaseNotes: null,
      progressPercent: 0,
      downloadedBytes: 0,
      totalBytes: null,
      error: null,
      checkedAt: null,
      shouldPrompt: false,
      checkForUpdates: vi.fn().mockResolvedValue(null),
      installUpdate: vi.fn().mockResolvedValue(undefined),
    })
  })

  it('lets desktop users check the configured release feed from About', async () => {
    render(<Settings />)

    expect(await screen.findByRole('heading', { name: 'BilliardBuddy' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /check now/i }))

    expect(useUpdateStore.getState().checkForUpdates).toHaveBeenCalledWith({
      autoDownload: true,
      autoInstall: true,
    })
  })
})
