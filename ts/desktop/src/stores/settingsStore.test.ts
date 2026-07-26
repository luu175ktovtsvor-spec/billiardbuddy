import { beforeEach, describe, expect, it, vi } from 'vitest'
import { browserHost } from '../lib/desktopHost/browserHost'

describe('settingsStore locale defaults', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })

  it('defaults to Chinese when no locale is stored', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().locale).toBe('zh')
  })

  it('keeps a stored locale override', async () => {
    window.localStorage.setItem('billiardbuddy-locale', 'en')

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().locale).toBe('en')
  })
})

describe('settingsStore UI zoom', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-app-zoom-percent')
    document.documentElement.style.removeProperty('--app-zoom')
    document.body.style.removeProperty('zoom')
  })

  it('hydrates from the app zoom storage key', async () => {
    window.localStorage.setItem('billiardbuddy-app-zoom', '1.25')

    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().uiZoom).toBe(1.25)
  })

  it('applies and persists UI zoom changes through the shared app zoom controller', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    useSettingsStore.getState().setUiZoom(1.25)

    await vi.waitFor(() => {
      expect(window.localStorage.getItem('billiardbuddy-app-zoom')).toBe('1.25')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(1.25)
    expect(document.documentElement.getAttribute('data-app-zoom-percent')).toBe('125')
  })

  it('clamps UI zoom changes to the supported range', async () => {
    const { useSettingsStore } = await import('./settingsStore')

    useSettingsStore.getState().setUiZoom(9)

    await vi.waitFor(() => {
      expect(window.localStorage.getItem('billiardbuddy-app-zoom')).toBe('2')
    })
    expect(useSettingsStore.getState().uiZoom).toBe(2)
  })
})

describe('settingsStore update proxy persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults old user settings to automatic system proxy mode', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().updateProxy).toEqual({
      mode: 'system',
      url: '',
    })
  })

  it('persists manual update proxy settings trimmed', async () => {
    const updateDesktop = vi.fn().mockResolvedValue({})
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn(),
        updateDesktop,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setUpdateProxy({
      mode: 'manual',
      url: '  http://127.0.0.1:7890  ',
    })

    expect(useSettingsStore.getState().updateProxy).toEqual({
      mode: 'manual',
      url: 'http://127.0.0.1:7890',
    })
    expect(updateDesktop).toHaveBeenCalledWith({
      updateProxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })
  })
})

describe('settingsStore network persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults old user settings to 600s direct network settings', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().network).toEqual({
      aiRequestTimeoutMs: 600_000,
      proxy: {
        mode: 'direct',
        url: '',
      },
    })
  })

  it('persists direct network proxy mode without keeping stale proxy URLs active', async () => {
    const updateRuntime = vi.fn().mockResolvedValue({})
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn(),
        updateRuntime,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setNetwork({
      aiRequestTimeoutMs: 600_000,
      proxy: {
        mode: 'direct',
        url: '  http://127.0.0.1:7890  ',
      },
    })

    expect(useSettingsStore.getState().network).toEqual({
      aiRequestTimeoutMs: 600_000,
      proxy: {
        mode: 'direct',
        url: '',
      },
    })
    expect(updateRuntime).toHaveBeenCalledWith({
      network: {
        aiRequestTimeoutMs: 600_000,
        proxy: {
          mode: 'direct',
          url: '',
        },
      },
    })
  })

  it('persists trimmed manual network proxy and clamps timeout', async () => {
    const updateRuntime = vi.fn().mockResolvedValue({})
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn(),
        updateRuntime,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setNetwork({
      aiRequestTimeoutMs: 9_999_999,
      proxy: {
        mode: 'manual',
        url: '  http://127.0.0.1:7890  ',
      },
    })

    expect(useSettingsStore.getState().network).toEqual({
      aiRequestTimeoutMs: 1_800_000,
      proxy: {
        mode: 'manual',
        url: 'http://127.0.0.1:7890',
      },
    })
    expect(updateRuntime).toHaveBeenCalledWith({
      network: {
        aiRequestTimeoutMs: 1_800_000,
        proxy: {
          mode: 'manual',
          url: 'http://127.0.0.1:7890',
        },
      },
    })
  })

  it('persists the chat send behavior preference and normalizes invalid values', async () => {
    const updateUser = vi.fn().mockResolvedValue({})
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({
          chatSendBehavior: 'unexpected',
        }),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().chatSendBehavior).toBe('enter')

    await useSettingsStore.getState().setChatSendBehavior('modifierEnter')

    expect(useSettingsStore.getState().chatSendBehavior).toBe('modifierEnter')
    expect(updateUser).toHaveBeenCalledWith({ chatSendBehavior: 'modifierEnter' })
  })
})

describe('settingsStore app mode', () => {
  const installElectronAppModeHost = (appMode: Partial<typeof browserHost.appMode>) => {
    window.desktopHost = {
      ...browserHost,
      kind: 'electron',
      isDesktop: true,
      capabilities: {
        ...browserHost.capabilities,
        appMode: true,
      },
      appMode: {
        ...browserHost.appMode,
        ...appMode,
      },
    }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    Reflect.deleteProperty(window, 'desktopHost')
  })

  it('hydrates app mode from the Electron desktop host', async () => {
    const getAppMode = vi.fn().mockResolvedValue({
      mode: 'portable',
      portableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      defaultPortableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
    })
    installElectronAppModeHost({ get: getAppMode })

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAppMode()

    expect(getAppMode).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'portable',
      portableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      defaultPortableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
    })
  })

  it('hydrates app mode from an injected desktop host', async () => {
    const getAppMode = vi.fn().mockResolvedValue({
      mode: 'portable',
      portableDir: 'D:\\billiardbuddy\\data',
      defaultPortableDir: 'D:\\billiardbuddy\\data',
    })
    installElectronAppModeHost({ get: getAppMode })

    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAppMode()

    expect(getAppMode).toHaveBeenCalledTimes(1)
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'portable',
      portableDir: 'D:\\billiardbuddy\\data',
      defaultPortableDir: 'D:\\billiardbuddy\\data',
    })
  })

  it('persists app mode through the Electron desktop host and marks restart required', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'default',
        portableDir: null,
        defaultPortableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('portable')

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'portable',
      portableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
    })
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'portable',
      portableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      defaultPortableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      activeConfigDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      configDirSource: 'portable',
    })
    expect(useSettingsStore.getState().appModeRequiresRestart).toBe(true)
  })

  it('persists app mode through an injected desktop host', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'default',
        portableDir: null,
        defaultPortableDir: 'D:\\billiardbuddy\\data',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('portable')

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'portable',
      portableDir: 'D:\\billiardbuddy\\data',
    })
    expect(useSettingsStore.getState().appModeRequiresRestart).toBe(true)
  })

  it('persists a user-selected portable directory', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'default',
        portableDir: null,
        defaultPortableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('portable', 'D:\\portable-data')

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'portable',
      portableDir: 'D:\\portable-data',
    })
    expect(useSettingsStore.getState().appMode).toMatchObject({
      mode: 'portable',
      portableDir: 'D:\\portable-data',
      activeConfigDir: 'D:\\portable-data',
      configDirSource: 'portable',
    })
  })

  it('switches app mode back to the system data source', async () => {
    const setAppMode = vi.fn().mockResolvedValue(undefined)
    installElectronAppModeHost({ set: setAppMode })

    const { useSettingsStore } = await import('./settingsStore')
    useSettingsStore.setState({
      appMode: {
        mode: 'portable',
        portableDir: 'D:\\portable-data',
        defaultPortableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
        activeConfigDir: 'D:\\portable-data',
        configDirSource: 'portable',
      },
      appModeRequiresRestart: false,
    })

    await useSettingsStore.getState().setAppMode('default', null)

    expect(setAppMode).toHaveBeenCalledWith({
      mode: 'default',
      portableDir: null,
    })
    expect(useSettingsStore.getState().appMode).toEqual({
      mode: 'default',
      portableDir: null,
      defaultPortableDir: 'C:\\billiardbuddy\\BILLIARDBUDDY_CONFIG_DIR',
      activeConfigDir: null,
      configDirSource: 'system',
    })
    expect(useSettingsStore.getState().appModeRequiresRestart).toBe(true)
  })
})

describe('settingsStore desktop notification persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults desktop notifications to explicit opt-in', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn(),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(false)
  })

  it('keeps desktop notifications disabled when user settings do not opt in', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(false)
  })

  it('persists the latest desktop notification toggle when saves overlap', async () => {
    const pendingSaves: Array<() => void> = []
    const updateUser = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          pendingSaves.push(() => resolve({ ok: true }))
        }),
    )

    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn(),
        updateUser,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    const firstSave = useSettingsStore.getState().setDesktopNotificationsEnabled(false)
    await vi.waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ desktopNotificationsEnabled: false })
    })

    const secondSave = useSettingsStore.getState().setDesktopNotificationsEnabled(true)
    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(true)

    pendingSaves.shift()?.()
    await vi.waitFor(() => {
      expect(updateUser).toHaveBeenCalledWith({ desktopNotificationsEnabled: true })
    })
    pendingSaves.shift()?.()
    await Promise.all([firstSave, secondSave])

    expect(updateUser).toHaveBeenLastCalledWith({ desktopNotificationsEnabled: true })
    expect(useSettingsStore.getState().desktopNotificationsEnabled).toBe(true)
  })
})

describe('settingsStore Product AutoMem persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults project memory on until the user opts out', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().productAutoMemoryEnabled).toBe(true)
    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().productAutoMemoryEnabled).toBe(true)
  })

  it('hydrates and persists the independent Product AutoMem switch', async () => {
    const updateUser = vi.fn().mockResolvedValue({})

    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({ productAutoMemoryEnabled: false }),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().productAutoMemoryEnabled).toBe(false)

    await useSettingsStore.getState().setProductAutoMemoryEnabled(true)

    expect(updateUser).toHaveBeenCalledWith({ productAutoMemoryEnabled: true })
    expect(useSettingsStore.getState().productAutoMemoryEnabled).toBe(true)
  })
})

describe('settingsStore deep thinking persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('defaults deep thinking on for settings created before the product preference existed', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().deepThinkingEnabled).toBe(true)
  })

  it('hydrates and persists the product-owned deep thinking switch', async () => {
    const updateUser = vi.fn().mockResolvedValue({})
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({ deepThinkingEnabled: false }),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().fetchAll()
    expect(useSettingsStore.getState().deepThinkingEnabled).toBe(false)

    await useSettingsStore.getState().setDeepThinkingEnabled(true)

    expect(updateUser).toHaveBeenCalledWith({ deepThinkingEnabled: true })
    expect(useSettingsStore.getState().deepThinkingEnabled).toBe(true)
  })
})

describe('settingsStore desktop terminal shell persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
  })

  it('hydrates desktop terminal settings from the desktop endpoint and falls back to system defaults', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({
          desktopTerminal: {
            startupShell: 'pwsh',
            customShellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
          },
        }),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    expect(useSettingsStore.getState().desktopTerminal).toEqual({
      startupShell: 'system',
      customShellPath: '',
    })

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().desktopTerminal).toEqual({
      startupShell: 'pwsh',
      customShellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    })
  })

  it('persists desktop terminal settings explicitly', async () => {
    const updateDesktop = vi.fn().mockResolvedValue({ ok: true })

    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn(),
        updateDesktop,
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')

    await useSettingsStore.getState().setDesktopTerminal({
      startupShell: 'custom',
      customShellPath: 'C:\\tools\\pwsh.exe',
    })

    expect(updateDesktop).toHaveBeenCalledWith({
      desktopTerminal: {
        startupShell: 'custom',
        customShellPath: 'C:\\tools\\pwsh.exe',
      },
    })
    expect(useSettingsStore.getState().desktopTerminal).toEqual({
      startupShell: 'custom',
      customShellPath: 'C:\\tools\\pwsh.exe',
    })
  })
})

describe('settingsStore theme persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
  })

  it('falls back to follow-system when user settings have no theme', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({}),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')
    const { useUIStore } = await import('./uiStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().theme).toBe('system')
    expect(useUIStore.getState().theme).toBe('system')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('hydrates an explicit dark theme from user settings', async () => {
    vi.doMock('../product/api/settings', () => ({
      productSettingsApi: {
        getUser: vi.fn().mockResolvedValue({ theme: 'dark' }),
        getRuntime: vi.fn().mockResolvedValue({}),
        getDesktop: vi.fn().mockResolvedValue({}),
        updateUser: vi.fn(),
      },
    }))
    const { useSettingsStore } = await import('./settingsStore')
    const { useUIStore } = await import('./uiStore')

    await useSettingsStore.getState().fetchAll()

    expect(useSettingsStore.getState().theme).toBe('dark')
    expect(useUIStore.getState().theme).toBe('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })
})
