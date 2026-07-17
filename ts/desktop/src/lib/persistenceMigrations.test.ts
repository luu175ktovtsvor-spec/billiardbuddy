import { beforeEach, describe, expect, test } from 'vitest'
import {
  CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION,
  DESKTOP_PERSISTENCE_VERSION_KEY,
  runDesktopPersistenceMigrations,
} from './persistenceMigrations'

describe('desktop persistence migrations', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('migrates legacy open-tab arrays into the current tab persistence shape', () => {
    window.localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify([
      { sessionId: 'session-1', title: 'Old tab' },
      { sessionId: '__terminal__legacy', title: 'Terminal 1', type: 'terminal' },
      { sessionId: 123, title: 'bad' },
    ]))

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('billiardbuddy-open-tabs')
    expect(JSON.parse(window.localStorage.getItem('billiardbuddy-open-tabs') || '{}')).toEqual({
      openTabs: [{ sessionId: 'session-1', title: 'Old tab', type: 'session' }],
      activeTabId: 'session-1',
    })
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })

  test('filters stale session runtime selections without clearing unrelated keys', () => {
    window.localStorage.setItem('unrelated-user-key', 'keep')
    window.localStorage.setItem('billiardbuddy-session-runtime', JSON.stringify({
      good: { providerId: null, modelId: 'claude-sonnet' },
      alsoGood: { providerId: 'provider-1', modelId: 'gpt-5.4' },
      bad: { providerId: 'provider-2' },
    }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(window.localStorage.getItem('billiardbuddy-session-runtime') || '{}')).toEqual({
      alsoGood: { providerId: 'provider-1', modelId: 'gpt-5.4' },
      good: { providerId: null, modelId: 'claude-sonnet' },
    })
    expect(window.localStorage.getItem('unrelated-user-key')).toBe('keep')
  })

  test('removes malformed known keys without throwing during startup', () => {
    window.localStorage.setItem('billiardbuddy-open-tabs', '{"openTabs":')
    window.localStorage.setItem('billiardbuddy-theme', 'sepia')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('billiardbuddy-open-tabs')
    expect(report.migratedKeys).toContain('billiardbuddy-theme')
    expect(window.localStorage.getItem('billiardbuddy-open-tabs')).toBeNull()
    expect(window.localStorage.getItem('billiardbuddy-theme')).toBeNull()
  })

  test('preserves a valid persisted theme and drops the retired pure white theme', () => {
    // 有效主题(light/dark/system)原样保留。
    window.localStorage.setItem('billiardbuddy-theme', 'dark')
    const validReport = runDesktopPersistenceMigrations()
    expect(validReport.migratedKeys).not.toContain('billiardbuddy-theme')
    expect(window.localStorage.getItem('billiardbuddy-theme')).toBe('dark')

    // 已退役的 'white' 不再是合法主题 → 迁移清除,由默认（跟随系统）接管。
    window.localStorage.setItem('billiardbuddy-theme', 'white')
    const retiredReport = runDesktopPersistenceMigrations()
    expect(retiredReport.migratedKeys).toContain('billiardbuddy-theme')
    expect(window.localStorage.getItem('billiardbuddy-theme')).toBeNull()
  })

  test('preserves valid app zoom and removes invalid app zoom values', () => {
    window.localStorage.setItem('billiardbuddy-app-zoom', '1.2')

    const validReport = runDesktopPersistenceMigrations()

    expect(validReport.migratedKeys).not.toContain('billiardbuddy-app-zoom')
    expect(window.localStorage.getItem('billiardbuddy-app-zoom')).toBe('1.2')

    window.localStorage.setItem('billiardbuddy-app-zoom', '4')

    const invalidReport = runDesktopPersistenceMigrations()

    expect(invalidReport.migratedKeys).toContain('billiardbuddy-app-zoom')
    expect(window.localStorage.getItem('billiardbuddy-app-zoom')).toBeNull()
  })

  test('migrates the legacy UI zoom key into app zoom storage', () => {
    window.localStorage.setItem('billiardbuddy-ui-zoom', '1.25')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toEqual(expect.arrayContaining([
      'billiardbuddy-app-zoom',
      'billiardbuddy-ui-zoom',
    ]))
    expect(window.localStorage.getItem('billiardbuddy-app-zoom')).toBe('1.25')
    expect(window.localStorage.getItem('billiardbuddy-ui-zoom')).toBeNull()
  })

  test('does not throw if schema version persistence is blocked', () => {
    const storage = {
      getItem: window.localStorage.getItem.bind(window.localStorage),
      removeItem: window.localStorage.removeItem.bind(window.localStorage),
      setItem: (key: string, value: string) => {
        if (key === DESKTOP_PERSISTENCE_VERSION_KEY) {
          throw new Error('storage blocked')
        }
        window.localStorage.setItem(key, value)
      },
    }

    expect(() => runDesktopPersistenceMigrations(storage)).not.toThrow()
    expect(runDesktopPersistenceMigrations(storage).migratedKeys).toContain(DESKTOP_PERSISTENCE_VERSION_KEY)
  })

  test('does not throw if storage reads and writes are blocked', () => {
    const storage = {
      getItem: () => {
        throw new Error('storage unavailable')
      },
      removeItem: () => {
        throw new Error('storage unavailable')
      },
      setItem: () => {
        throw new Error('storage unavailable')
      },
    }

    const report = runDesktopPersistenceMigrations(storage)

    expect(report.migratedKeys).toEqual(expect.arrayContaining([
      'billiardbuddy-open-tabs',
      'billiardbuddy-session-runtime',
      'billiardbuddy-theme',
      'billiardbuddy-locale',
      'billiardbuddy-app-zoom',
      DESKTOP_PERSISTENCE_VERSION_KEY,
    ]))
  })
})
