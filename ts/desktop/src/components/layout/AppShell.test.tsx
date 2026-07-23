import { act, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useUIStore } from '../../stores/uiStore'

const mocks = vi.hoisted(() => ({
  initializeDesktopServerUrl: vi.fn(),
  fetchAll: vi.fn(),
  restoreTabs: vi.fn(),
  openTab: vi.fn(),
  tabState: {
    activeTabId: null as string | null,
    tabs: [] as Array<{ sessionId: string; title: string; type: string }>,
  },
}))

vi.mock('../../lib/desktopRuntime', () => ({
  initializeDesktopServerUrl: mocks.initializeDesktopServerUrl,
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: { fetchAll: typeof mocks.fetchAll }) => unknown) =>
    selector({ fetchAll: mocks.fetchAll }),
}))

vi.mock('../../stores/tabStore', () => ({
  SETTINGS_TAB_ID: '__settings__',
  useTabStore: {
    getState: () => ({
      restoreTabs: mocks.restoreTabs,
      activeTabId: mocks.tabState.activeTabId,
      tabs: mocks.tabState.tabs,
      openTab: mocks.openTab,
    }),
  },
}))

vi.mock('../../hooks/useKeyboardShortcuts', () => ({
  useKeyboardShortcuts: vi.fn(),
}))

vi.mock('../../hooks/useElectronWindowDragRegions', () => ({
  useElectronWindowDragRegions: vi.fn(),
}))

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => key,
}))

vi.mock('./DesktopSidebar', () => ({
  DesktopSidebar: () => <aside>sidebar loaded</aside>,
}))

vi.mock('./TopBar', () => ({
  TopBar: () => <nav>topbar loaded</nav>,
}))

vi.mock('./ContentRouter', () => ({
  ContentRouter: () => <section>content loaded</section>,
}))

vi.mock('./StartupErrorView', () => ({
  StartupErrorView: ({ error }: { error: string }) => <section data-testid="startup-error">{error}</section>,
}))

vi.mock('../shared/Toast', () => ({
  ToastContainer: () => <div>toasts loaded</div>,
}))

vi.mock('../shared/UpdateChecker', () => ({
  UpdateChecker: () => <div>updates loaded</div>,
}))

vi.mock('../../product/components/TaskSearchModal', () => ({
  TaskSearchModal: ({ open }: { open: boolean }) => (
    open ? <div data-testid="task-search-modal">task search loaded</div> : null
  ),
}))

vi.mock('../../product/components/RemoteDataEgressConsent', () => ({
  RemoteDataEgressConsentGate: () => <div data-testid="remote-data-egress-gate" />,
}))

import { AppShell } from './AppShell'

describe('AppShell desktop boot flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.initializeDesktopServerUrl.mockResolvedValue('http://127.0.0.1:3456')
    mocks.fetchAll.mockResolvedValue(undefined)
    mocks.restoreTabs.mockResolvedValue(undefined)
    mocks.tabState.activeTabId = null
    mocks.tabState.tabs = []
    useUIStore.setState({ sidebarOpen: true, pendingSettingsTab: null, activeModal: null })
    Reflect.deleteProperty(window, 'desktopHost')
    window.history.pushState({}, '', '/')
  })

  it('renders the BilliardBuddy desktop task shell after bootstrap', async () => {
    render(<AppShell />)

    expect(screen.getByText('app.launching')).toBeInTheDocument()
    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByText('topbar loaded')).toBeInTheDocument()
    expect(screen.getByText('content loaded')).toBeInTheDocument()
    expect(screen.getByText('toasts loaded')).toBeInTheDocument()
    expect(screen.getByText('updates loaded')).toBeInTheDocument()
  })

  it('keeps settings inside the product shell instead of swapping to the retired renderer', async () => {
    mocks.tabState.activeTabId = '__settings__'
    mocks.tabState.tabs = [
      { sessionId: '__settings__', title: 'Settings', type: 'settings' },
    ]

    render(<AppShell />)

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    expect(screen.getByText('topbar loaded')).toBeInTheDocument()
    expect(screen.getByText('content loaded')).toBeInTheDocument()
  })

  it('shows startup diagnostics when bootstrap fails', async () => {
    mocks.fetchAll.mockRejectedValueOnce(new Error('settings file could not be read'))

    render(<AppShell />)

    expect(await screen.findByTestId('startup-error')).toHaveTextContent('settings file could not be read')
    expect(screen.queryByText('sidebar loaded')).not.toBeInTheDocument()
  })

  it('keeps the task shell usable when persisted tab restore fails', async () => {
    mocks.restoreTabs.mockRejectedValueOnce(new Error('old tab payload is invalid'))

    render(<AppShell />)

    expect(await screen.findByText('sidebar loaded')).toBeInTheDocument()
    await waitFor(() => expect(mocks.restoreTabs).toHaveBeenCalled())
    expect(screen.queryByTestId('startup-error')).not.toBeInTheDocument()
  })

  it('completes tab restoration with a product task tab', async () => {
    mocks.tabState.activeTabId = '__product_task__task-1'
    mocks.tabState.tabs = [
      { sessionId: '__product_task__task-1', title: 'Existing task', type: 'product-task' },
    ]

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => expect(mocks.restoreTabs).toHaveBeenCalled())
  })

  it('routes native settings navigation through the desktop host', async () => {
    let navigate: ((target: string) => void) | undefined
    const unlisten = vi.fn()
    const onNativeMenuNavigate = vi.fn((handler: (target: string) => void) => {
      navigate = handler
      return Promise.resolve(unlisten)
    })
    window.desktopHost = {
      isDesktop: true,
      window: { onNativeMenuNavigate },
    } as any

    render(<AppShell />)

    await screen.findByText('sidebar loaded')
    await waitFor(() => expect(onNativeMenuNavigate).toHaveBeenCalledTimes(1))

    act(() => navigate?.('about'))

    expect(useUIStore.getState().pendingSettingsTab).toBe('about')
    expect(mocks.openTab).toHaveBeenCalledWith('__settings__', 'Settings', 'settings')
  })

  it('can collapse the product sidebar without hiding the active task page', async () => {
    useUIStore.setState({ sidebarOpen: false })

    render(<AppShell />)

    expect(await screen.findByText('content loaded')).toBeInTheDocument()
    expect(screen.getByTestId('sidebar-shell')).toHaveAttribute('data-state', 'closed')
    expect(screen.queryByText('sidebar loaded')).not.toBeInTheDocument()
    expect(screen.getByText('topbar loaded')).toBeInTheDocument()
  })

  it('mounts product task search from the dedicated task-search modal state', async () => {
    useUIStore.setState({ activeModal: 'task-search' })

    render(<AppShell />)

    expect(await screen.findByTestId('task-search-modal')).toHaveTextContent('task search loaded')
  })
})
