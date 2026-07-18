import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'

import { Settings } from '../pages/Settings'
import { useSettingsStore } from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useUpdateStore } from '../stores/updateStore'
import type { AppMode, ChatSendBehavior, PermissionMode, ThemeMode } from '../types/settings'
import { browserHost } from '../lib/desktopHost/browserHost'

const desktopNotificationsMock = vi.hoisted(() => ({
  getDesktopNotificationPermission: vi.fn(),
  getDesktopNotificationPlatform: vi.fn(),
  notifyDesktop: vi.fn(),
  requestDesktopNotificationPermission: vi.fn(),
  openDesktopNotificationSettings: vi.fn(),
}))
const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}))
const tauriDialogMock = vi.hoisted(() => ({
  open: vi.fn(),
}))
const tauriProcessMock = vi.hoisted(() => ({
  relaunch: vi.fn(),
}))
vi.mock('../api/agents', () => ({
  agentsApi: {
    list: vi.fn().mockResolvedValue({ activeAgents: [], allAgents: [] }),
  },
}))

vi.mock('../lib/desktopNotifications', () => desktopNotificationsMock)
vi.mock('@tauri-apps/api/core', () => tauriCoreMock)
vi.mock('@tauri-apps/plugin-dialog', () => tauriDialogMock)
vi.mock('@tauri-apps/plugin-process', () => tauriProcessMock)
vi.mock('../pages/ProfileSettings', () => ({
  ProfileSettings: () => <div>Profile Settings Mock</div>,
}))

vi.mock('../stores/agentStore', () => ({
  useAgentStore: () => ({
    activeAgents: [],
    allAgents: [],
    isLoading: false,
    error: null,
    selectedAgent: null,
    fetchAgents: vi.fn(),
    selectAgent: vi.fn(),
  }),
}))

vi.mock('../stores/skillStore', () => ({
  useSkillStore: () => ({
    skills: [],
    selectedSkill: null,
    isLoading: false,
    isDetailLoading: false,
    error: null,
    fetchSkills: vi.fn(),
    fetchSkillDetail: vi.fn(),
    clearSelection: vi.fn(),
  }),
}))

vi.mock('../components/chat/CodeViewer', () => ({
  CodeViewer: ({ code }: { code: string }) => <pre data-testid="code-viewer">{code}</pre>,
}))

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
      open: vi.fn((options) => tauriDialogMock.open(options)),
    },
    shell: {
      ...browserHost.shell,
      open: vi.fn().mockResolvedValue(undefined),
    },
    appMode: {
      ...browserHost.appMode,
      prepareRestart: vi.fn(() => tauriCoreMock.invoke('prepare_for_app_mode_restart')),
      restart: vi.fn(() => tauriProcessMock.relaunch()),
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
    desktopNotificationsMock.getDesktopNotificationPermission.mockResolvedValue('default')
    desktopNotificationsMock.getDesktopNotificationPlatform.mockReturnValue('darwin')
    desktopNotificationsMock.notifyDesktop.mockResolvedValue(true)
    desktopNotificationsMock.requestDesktopNotificationPermission.mockResolvedValue('granted')
    desktopNotificationsMock.openDesktopNotificationSettings.mockResolvedValue(true)
    tauriCoreMock.invoke.mockReset()
    tauriCoreMock.invoke.mockResolvedValue(undefined)
    tauriDialogMock.open.mockReset()
    tauriDialogMock.open.mockResolvedValue('/Users/test/billiardbuddy-data')
    tauriProcessMock.relaunch.mockReset()
    tauriProcessMock.relaunch.mockResolvedValue(undefined)
    delete (window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__
    delete (window as unknown as { __TAURI__?: object }).__TAURI__
    installElectronDesktopHost()
    useSettingsStore.setState({
      locale: 'en',
      theme: 'light',
      permissionMode: 'default',
      thinkingEnabled: true,
      autoDreamEnabled: false,
      skipWebFetchPreflight: true,
      desktopNotificationsEnabled: true,
      chatSendBehavior: 'enter',
      responseLanguage: '',
      uiZoom: 1,
      webSearch: { mode: 'auto', tavilyApiKey: '', braveApiKey: '' },
      network: {
        aiRequestTimeoutMs: 120_000,
        proxy: { mode: 'direct', url: '' },
      },
      outputStyle: 'default',
      outputStyles: [
        {
          value: 'default',
          label: 'Default',
          description: 'Default response style',
          source: 'built-in',
        },
      ],
      outputStyleScope: 'userSettings',
      outputStyleWorkDir: null,
      outputStylesLoading: false,
      outputStyleError: null,
      fetchOutputStyles: vi.fn().mockResolvedValue(undefined),
      setOutputStyle: vi.fn().mockImplementation(async (outputStyle: string) => {
        useSettingsStore.setState({ outputStyle })
      }),
      setThinkingEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ thinkingEnabled: enabled })
      }),
      setAutoDreamEnabled: vi.fn().mockImplementation(async (enabled: boolean) => {
        useSettingsStore.setState({ autoDreamEnabled: enabled })
      }),
      setTheme: vi.fn().mockImplementation(async (theme: ThemeMode) => {
        useSettingsStore.setState({ theme })
      }),
      setPermissionMode: vi.fn().mockImplementation(async (permissionMode: PermissionMode) => {
        useSettingsStore.setState({ permissionMode })
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
        defaultPortableDir: '/Applications/BilliardBuddy/CLAUDE_CONFIG_DIR',
        activeConfigDir: null,
        configDirSource: 'system',
      },
      appModeRequiresRestart: false,
      fetchAppMode: vi.fn().mockResolvedValue(undefined),
      setAppMode: vi.fn().mockImplementation(async (mode: AppMode, portableDir?: string | null) => {
        useSettingsStore.setState({
          appMode: {
            mode,
            portableDir: mode === 'portable' ? portableDir ?? '/Applications/BilliardBuddy/CLAUDE_CONFIG_DIR' : null,
            defaultPortableDir: '/Applications/BilliardBuddy/CLAUDE_CONFIG_DIR',
            activeConfigDir: mode === 'portable' ? portableDir ?? '/Applications/BilliardBuddy/CLAUDE_CONFIG_DIR' : null,
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

  it('shows WebFetch preflight toggle enabled by default', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Skip WebFetch domain preflight')
    expect(toggle).toBeChecked()
  })

  it('keeps the selected settings tab when returning to Settings', () => {
    const { unmount } = render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByLabelText('Skip WebFetch domain preflight')).toBeInTheDocument()

    unmount()
    render(<Settings />)

    expect(screen.getByLabelText('Skip WebFetch domain preflight')).toBeInTheDocument()
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
    const networkHeading = screen.getByRole('heading', { name: 'Network' })
    const webFetchHeading = screen.getByRole('heading', { name: 'WebFetch Preflight' })

    expect((notificationsHeading.compareDocumentPosition(uiZoomHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((uiZoomHeading.compareDocumentPosition(networkHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect((networkHeading.compareDocumentPosition(webFetchHeading) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
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

  it('saves provider network timeout and manual proxy from General settings', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByRole('button', { name: /Direct connection/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /System proxy/i })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Manual proxy/i }))
    const proxyInput = screen.getByLabelText('Proxy URL')
    const saveButton = screen.getAllByRole('button', { name: 'Save' })[0]!

    expect(screen.getByText('Enter a proxy URL.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(proxyInput, { target: { value: 'socks5://127.0.0.1:7890' } })
    expect(screen.getByText('Enter an HTTP or HTTPS proxy URL.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(proxyInput, { target: { value: '  http://user:p%40ss@127.0.0.1:7890  ' } })
    expect(screen.getByText('HTTP and HTTPS proxy URLs are supported. For authenticated proxies, use http://user:password@127.0.0.1:7890; the URL is saved with network settings.')).toBeInTheDocument()
    const timeoutInput = screen.getByLabelText('AI request timeout')
    expect(timeoutInput).toHaveAttribute('type', 'number')
    expect(screen.queryByRole('slider', { name: 'AI request timeout' })).not.toBeInTheDocument()

    fireEvent.change(timeoutInput, { target: { value: '180' } })

    await act(async () => {
      fireEvent.click(saveButton)
    })

    expect(useSettingsStore.getState().setNetwork).toHaveBeenCalledWith({
      aiRequestTimeoutMs: 180_000,
      proxy: {
        mode: 'manual',
        url: 'http://user:p%40ss@127.0.0.1:7890',
      },
    })
    expect(useUIStore.getState().toasts[useUIStore.getState().toasts.length - 1]).toMatchObject({
      type: 'success',
      message: 'Network settings saved.',
    })
  })

  it('validates typed provider network timeout and supports precise step controls', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const timeoutInput = screen.getByLabelText('AI request timeout')
    const saveButton = screen.getAllByRole('button', { name: 'Save' })[0]!

    fireEvent.change(timeoutInput, { target: { value: '2000' } })
    expect(screen.getByText('Enter a whole number from 30 to 1800 seconds.')).toBeInTheDocument()
    expect(saveButton).toBeDisabled()

    fireEvent.change(timeoutInput, { target: { value: '90' } })
    fireEvent.click(screen.getByRole('button', { name: 'Increase by 30 seconds' }))
    expect(timeoutInput).toHaveValue(120)

    fireEvent.click(screen.getByRole('button', { name: 'Decrease by 30 seconds' }))
    fireEvent.click(screen.getByRole('button', { name: 'Decrease by 30 seconds' }))
    expect(timeoutInput).toHaveValue(60)
    expect(saveButton).not.toBeDisabled()
  })

  it('keeps data storage at the bottom of General settings', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const webSearchHeading = screen.getByRole('heading', { name: 'WebSearch' })
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
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('prepare_for_app_mode_restart')
      expect(tauriProcessMock.relaunch).toHaveBeenCalledTimes(1)
    })
  })

  it('switches back to the system directory without deleting portable data', async () => {
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: '/Users/test/billiardbuddy-data',
        defaultPortableDir: '/Applications/BilliardBuddy/CLAUDE_CONFIG_DIR',
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
      expect(tauriCoreMock.invoke).toHaveBeenCalledWith('prepare_for_app_mode_restart')
      expect(tauriProcessMock.relaunch).toHaveBeenCalledTimes(1)
    })
  })

  it('validates portable directory input and lets users reset to the app-side folder', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    const input = screen.getByLabelText('Portable data directory')

    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.getByText('Choose or enter a portable data directory first.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Use the default portable folder beside the app' }))
    expect(input).toHaveValue('/Applications/BilliardBuddy/CLAUDE_CONFIG_DIR')
    expect(screen.queryByText('Choose or enter a portable data directory first.')).not.toBeInTheDocument()
  })

  it('shows folder picker failures as an inline storage error', async () => {
    tauriDialogMock.open.mockRejectedValueOnce(new Error('dialog unavailable'))

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Choose Folder' }))

    expect(await screen.findByText('Could not open the folder picker. Paste the folder path manually.')).toBeInTheDocument()
  })

  it('treats external CLAUDE_CONFIG_DIR as the controlling data source', async () => {
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: '/env/claude-data',
        defaultPortableDir: '/Applications/BilliardBuddy/CLAUDE_CONFIG_DIR',
        activeConfigDir: '/env/claude-data',
        configDirSource: 'environment',
      },
    })

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    expect(screen.getByText(/The current directory is controlled by the CLAUDE_CONFIG_DIR environment variable/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Use system directory/ }))
    expect(screen.getByText(/Remove it from the launch environment before switching back/)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Portable data directory'), { target: { value: '/other/data' } })
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    expect(screen.queryByText('Switch data storage location?')).not.toBeInTheDocument()
    expect(screen.getByText(/Remove it from the launch environment before switching back/)).toBeInTheDocument()
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
    tauriCoreMock.invoke.mockRejectedValueOnce(new Error('restart preparation failed'))

    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    fireEvent.click(screen.getByRole('button', { name: 'Use This Folder and Restart' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save and Restart' }))

    expect(await screen.findByText('restart preparation failed')).toBeInTheDocument()
    expect(tauriProcessMock.relaunch).not.toHaveBeenCalled()
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

  it('does not expose the retired Token usage navigation item', () => {
    render(<Settings />)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.queryByText('Token usage')).not.toBeInTheDocument()
    expect(screen.getByText('Diagnostics')).toBeInTheDocument()
  })

  it('lets the user disable WebFetch preflight skipping', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Skip WebFetch domain preflight')
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setSkipWebFetchPreflight).toHaveBeenCalledWith(false)
  })

  it('lets the user disable thinking mode for new sessions', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable thinking mode')
    expect(toggle).toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setThinkingEnabled).toHaveBeenCalledWith(false)
  })

  it('lets the user choose a default permission mode for new sessions', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      await Promise.resolve()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Ask permissions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Bypass permissions/ }))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enable bypass' }))
      await Promise.resolve()
    })

    expect(useSettingsStore.getState().setPermissionMode).toHaveBeenCalledWith('bypassPermissions')
    expect(useSettingsStore.getState().permissionMode).toBe('bypassPermissions')
  })

  it('keeps Auto-dream disabled by default and confirms before enabling it', async () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    const toggle = screen.getByLabelText('Enable Auto-dream')
    expect(toggle).not.toBeChecked()
    fireEvent.click(toggle)

    expect(useSettingsStore.getState().setAutoDreamEnabled).not.toHaveBeenCalled()
    const dialog = screen.getByRole('dialog', { name: 'Enable Auto-dream?' })
    expect(within(dialog).getByText(/Keep the desktop app running/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/uses additional model tokens/i)).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Enable Auto-dream' }))
    })

    expect(useSettingsStore.getState().setAutoDreamEnabled).toHaveBeenCalledWith(true)
    expect(screen.getByLabelText('Enable Auto-dream')).toBeChecked()
  })

  it('lets the user disable Auto-dream without a confirmation dialog', async () => {
    useSettingsStore.setState({ autoDreamEnabled: true })
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Enable Auto-dream'))
    })

    expect(screen.queryByRole('dialog', { name: 'Enable Auto-dream?' })).not.toBeInTheDocument()
    expect(useSettingsStore.getState().setAutoDreamEnabled).toHaveBeenCalledWith(false)
  })

  it('keeps General checkbox inputs anchored inside their visible rows', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    for (const label of [
      'Enable thinking mode',
      'Enable Auto-dream',
      'Enable system notifications',
      'Skip WebFetch domain preflight',
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

  it('saves WebSearch fallback provider settings', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    fireEvent.click(screen.getByRole('button', { name: 'Tavily' }))
    fireEvent.change(screen.getByLabelText('Tavily API key'), {
      target: { value: 'tvly-test-key' },
    })
    const saveButtons = screen.getAllByRole('button', { name: 'Save' })
    fireEvent.click(saveButtons[saveButtons.length - 1]!)

    expect(useSettingsStore.getState().setWebSearch).toHaveBeenCalledWith({
      mode: 'tavily',
      tavilyApiKey: 'tvly-test-key',
      braveApiKey: '',
    })
  })

  it('links to WebSearch provider API key dashboards', () => {
    render(<Settings />)

    fireEvent.click(screen.getByText('General'))

    expect(screen.getByRole('link', { name: 'Get Tavily API key' })).toHaveAttribute(
      'href',
      'https://app.tavily.com/home',
    )
    expect(screen.getByRole('link', { name: 'Get Brave Search API key' })).toHaveAttribute(
      'href',
      'https://api-dashboard.search.brave.com/app/keys',
    )
  })

  it('keeps extension tabs available alongside the terminal tab', () => {
    render(<Settings />)
    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))

    expect(screen.queryByText('Install')).not.toBeInTheDocument()
    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(screen.getByText('MCP')).toBeInTheDocument()
    expect(screen.getByText('Plugins')).toBeInTheDocument()
  })
})


describe('Settings > About tab', () => {
  beforeEach(() => {
    useUIStore.setState({ activeSettingsTab: 'general', pendingSettingsTab: 'about' })
    useSettingsStore.setState({ locale: 'en' })
  })

  it('shows the product identity without an unconfigured update surface', async () => {
    render(<Settings />)

    expect(await screen.findByRole('heading', { name: 'BilliardBuddy' })).toBeInTheDocument()
    expect(screen.queryByText(/release notes/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /check for updates/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update proxy/i })).not.toBeInTheDocument()
  })
})
