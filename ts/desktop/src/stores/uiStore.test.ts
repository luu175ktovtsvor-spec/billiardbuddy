import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('uiStore theme handling', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    document.documentElement.style.colorScheme = ''
    // jsdom 默认无 matchMedia → system 兜底浅色;需要深色系统的用例自行 mock。
    ;(window as unknown as { matchMedia?: unknown }).matchMedia = undefined
  })

  function mockSystemDark(dark: boolean) {
    ;(window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
      ({
        matches: dark && query.includes('dark'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  }

  it('defaults new installs to follow-system (light when the OS is not dark)', async () => {
    const { initializeTheme, useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('system')
    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })

  it('resolves system mode to dark when the OS prefers dark', async () => {
    mockSystemDark(true)
    const { initializeTheme, useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('system')
    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('hydrates and applies an explicit dark theme', async () => {
    window.localStorage.setItem('billiardbuddy-theme', 'dark')

    const { initializeTheme, useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('dark')
    initializeTheme()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
  })

  it('falls back to follow-system when the persisted value is a retired theme', async () => {
    window.localStorage.setItem('billiardbuddy-theme', 'white')

    const { useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().theme).toBe('system')
  })

  it('cycles light -> dark -> system', async () => {
    window.localStorage.setItem('billiardbuddy-theme', 'light')

    const { useUIStore } = await import('./uiStore')
    expect(useUIStore.getState().theme).toBe('light')

    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('system')

    useUIStore.getState().toggleTheme()
    expect(useUIStore.getState().theme).toBe('light')
    expect(document.documentElement.style.colorScheme).toBe('light')
  })
})

describe('uiStore settings tab persistence', () => {
  beforeEach(() => {
    vi.resetModules()
    window.localStorage.clear()
  })

  it('hydrates the last selected Settings tab after the renderer store is recreated', async () => {
    const first = await import('./uiStore')

    first.useUIStore.getState().setActiveSettingsTab('general')

    expect(window.localStorage.getItem('billiardbuddy-active-settings-tab')).toBe('general')

    vi.resetModules()
    const recreated = await import('./uiStore')

    expect(recreated.useUIStore.getState().activeSettingsTab).toBe('general')
  })

  it('ignores an invalid persisted Settings tab', async () => {
    window.localStorage.setItem('billiardbuddy-active-settings-tab', 'not-a-settings-tab')

    const { useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().activeSettingsTab).toBe('general')
  })

  it('falls back to General when the retired Activity tab has not been migrated yet', async () => {
    window.localStorage.setItem('billiardbuddy-active-settings-tab', 'activity')

    const { useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().activeSettingsTab).toBe('general')
  })

  it('falls back to General when the retired Diagnostics tab is persisted', async () => {
    window.localStorage.setItem('billiardbuddy-active-settings-tab', 'diagnostics')

    const { useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().activeSettingsTab).toBe('general')
  })

  it('falls back to General when the retired static Agents tab is persisted', async () => {
    window.localStorage.setItem('billiardbuddy-active-settings-tab', 'agents')

    const { useUIStore } = await import('./uiStore')

    expect(useUIStore.getState().activeSettingsTab).toBe('general')
  })
})
