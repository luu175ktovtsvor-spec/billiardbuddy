import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION,
  DESKTOP_PERSISTENCE_BACKUP_KEY,
  DESKTOP_PERSISTENCE_VERSION_KEY,
  runDesktopPersistenceMigrations,
} from './persistenceMigrations'

describe('desktop persistence migrations', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  test('drops legacy open-tab arrays instead of recreating raw Core session tabs', () => {
    window.localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify([
      { sessionId: 'session-1', title: 'Old tab' },
      { sessionId: '__terminal__legacy', title: 'Terminal 1', type: 'terminal' },
      { sessionId: 123, title: 'bad' },
    ]))

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('billiardbuddy-open-tabs')
    expect(window.localStorage.getItem('billiardbuddy-open-tabs')).toBeNull()
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })

  test('preserves only supported product tabs', () => {
    window.localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: '__settings__', title: '设置', type: 'settings' },
        { sessionId: '__scheduled__', title: '定时任务', type: 'scheduled' },
        { sessionId: '__creation__', title: '创作', type: 'creation' },
        { sessionId: '__operations__', title: '经营', type: 'operations' },
        { sessionId: '__image_workbench__', title: '生成图片', type: 'image-workbench' },
        { sessionId: '__video_studio__', title: '剪视频', type: 'video-studio' },
        { sessionId: '__product_tasks__', title: '任务中心', type: 'product-tasks' },
        {
          sessionId: '__product_task__task-1',
          title: '球房排班',
          type: 'product-task',
          taskId: 'task-1',
        },
        { sessionId: '__product_task__missing', title: '不完整任务', type: 'product-task' },
        { sessionId: 'session-1', title: '旧会话', type: 'session' },
        { sessionId: '__terminal__legacy', title: '终端', type: 'terminal' },
      ],
      activeTabId: '__product_task__task-1',
    }))

    runDesktopPersistenceMigrations()

    expect(JSON.parse(window.localStorage.getItem('billiardbuddy-open-tabs') || '{}')).toEqual({
      openTabs: [
        { sessionId: '__settings__', title: '设置', type: 'settings' },
        { sessionId: '__scheduled__', title: '定时任务', type: 'scheduled' },
        { sessionId: '__creation__', title: '创作', type: 'creation' },
        { sessionId: '__operations__', title: '经营', type: 'operations' },
        { sessionId: '__image_workbench__', title: '生成图片', type: 'image-workbench' },
        { sessionId: '__video_studio__', title: '剪视频', type: 'video-studio' },
        { sessionId: '__product_tasks__', title: '任务中心', type: 'product-tasks' },
        {
          sessionId: '__product_task__task-1',
          title: '球房排班',
          type: 'product-task',
          taskId: 'task-1',
        },
      ],
      activeTabId: '__product_task__task-1',
    })
  })

  test('drops retired traces and raw sessions instead of restoring their inspection state', () => {
    window.localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: '__traces__', title: 'Trace list', type: 'traces' },
        { sessionId: '__trace__session-1', title: 'Trace', type: 'trace' },
        { sessionId: 'session-1', title: 'Current task', type: 'session' },
      ],
      activeTabId: '__trace__session-1',
    }))
    window.localStorage.setItem('billiardbuddy-active-settings-tab', 'trace')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toEqual(expect.arrayContaining([
      'billiardbuddy-open-tabs',
      'billiardbuddy-active-settings-tab',
    ]))
    expect(window.localStorage.getItem('billiardbuddy-open-tabs')).toBeNull()
    expect(window.localStorage.getItem('billiardbuddy-active-settings-tab')).toBeNull()
  })

  test('removes retired session runtime selections without clearing unrelated keys', () => {
    window.localStorage.setItem('unrelated-user-key', 'keep')
    window.localStorage.setItem('billiardbuddy-session-runtime', 'legacy-override')

    runDesktopPersistenceMigrations()

    expect(window.localStorage.getItem('billiardbuddy-session-runtime')).toBeNull()
    expect(window.localStorage.getItem('unrelated-user-key')).toBe('keep')
  })

  test.each(['providers', 'memory', 'agents', 'diagnostics'])('drops retired %s settings tab selections', (retiredTab) => {
    window.localStorage.setItem('billiardbuddy-active-settings-tab', retiredTab)

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('billiardbuddy-active-settings-tab')
    expect(window.localStorage.getItem('billiardbuddy-active-settings-tab')).toBeNull()
  })

  test('falls back from the retired activity tab to General settings', () => {
    window.localStorage.setItem('billiardbuddy-active-settings-tab', 'activity')

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).toContain('billiardbuddy-active-settings-tab')
    expect(window.localStorage.getItem('billiardbuddy-active-settings-tab')).toBe('general')
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

  test.each([
    ['dark', false],
    ['white', true],
  ])('migrates persisted theme %s according to the current theme contract', (theme, removed) => {
    window.localStorage.setItem('billiardbuddy-theme', theme)

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys.includes('billiardbuddy-theme')).toBe(removed)
    expect(window.localStorage.getItem('billiardbuddy-theme')).toBe(removed ? null : theme)
  })

  test.each(['zh-TW', 'jp', 'kr'])('preserves the supported %s locale on restart', (locale) => {
    window.localStorage.setItem('billiardbuddy-locale', locale)

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys).not.toContain('billiardbuddy-locale')
    expect(window.localStorage.getItem('billiardbuddy-locale')).toBe(locale)
  })

  test.each([
    ['1.2', false],
    ['4', true],
  ])('migrates persisted app zoom %s according to the supported range', (zoom, removed) => {
    window.localStorage.setItem('billiardbuddy-app-zoom', zoom)

    const report = runDesktopPersistenceMigrations()

    expect(report.migratedKeys.includes('billiardbuddy-app-zoom')).toBe(removed)
    expect(window.localStorage.getItem('billiardbuddy-app-zoom')).toBe(removed ? null : zoom)
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

  test('restores exact source values when the version commit fails', () => {
    window.localStorage.setItem('billiardbuddy-theme', 'white')
    window.localStorage.setItem('billiardbuddy-open-tabs', '{"openTabs":')
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

    expect(() => runDesktopPersistenceMigrations(storage)).toThrow('storage blocked')
    expect(window.localStorage.getItem('billiardbuddy-theme')).toBe('white')
    expect(window.localStorage.getItem('billiardbuddy-open-tabs')).toBe('{"openTabs":')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBeNull()
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_BACKUP_KEY)).not.toBeNull()
  })

  test('fails closed if storage reads and writes are blocked', () => {
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

    expect(() => runDesktopPersistenceMigrations(storage)).toThrow('storage unavailable')
  })

  test('rejects a future schema before creating a backup or changing user state', () => {
    window.localStorage.setItem(DESKTOP_PERSISTENCE_VERSION_KEY, String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION + 1))
    window.localStorage.setItem('billiardbuddy-theme', 'dark')

    expect(() => runDesktopPersistenceMigrations()).toThrow('newer than supported schema')
    expect(window.localStorage.getItem('billiardbuddy-theme')).toBe('dark')
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_BACKUP_KEY)).toBeNull()
  })

  test('recovers a prepared migration backup before retrying after a crash', () => {
    window.localStorage.setItem('billiardbuddy-theme', 'white')
    const failAtVersionCommit = {
      getItem: window.localStorage.getItem.bind(window.localStorage),
      removeItem: window.localStorage.removeItem.bind(window.localStorage),
      setItem: (key: string, value: string) => {
        if (key === DESKTOP_PERSISTENCE_VERSION_KEY) throw new Error('simulated crash')
        window.localStorage.setItem(key, value)
      },
    }
    expect(() => runDesktopPersistenceMigrations(failAtVersionCommit)).toThrow('simulated crash')

    window.localStorage.setItem('billiardbuddy-theme', 'partially-written')
    const report = runDesktopPersistenceMigrations()

    expect(report.backupKey).toBe(DESKTOP_PERSISTENCE_BACKUP_KEY)
    expect(window.localStorage.getItem('billiardbuddy-theme')).toBeNull()
    expect(window.localStorage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)).toBe(String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
  })

  test('is an exact no-op after the current schema version is committed', () => {
    window.localStorage.setItem('billiardbuddy-theme', 'dark')
    runDesktopPersistenceMigrations()
    const storage = {
      getItem: window.localStorage.getItem.bind(window.localStorage),
      removeItem: vi.fn(window.localStorage.removeItem.bind(window.localStorage)),
      setItem: vi.fn(window.localStorage.setItem.bind(window.localStorage)),
    }

    const report = runDesktopPersistenceMigrations(storage)

    expect(report).toEqual({ migratedKeys: [] })
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(storage.removeItem).not.toHaveBeenCalled()
  })
})
