import { DESKTOP_LOCALES, THEME_MODES } from '../types/settings'
import {
  APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
  isValidStoredAppZoomLevel,
  normalizeAppZoomLevel,
} from './appZoom'

export const CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION = 8
export const DESKTOP_PERSISTENCE_VERSION_KEY = 'billiardbuddy.persistence.schemaVersion'
export const DESKTOP_PERSISTENCE_BACKUP_KEY = 'billiardbuddy.persistence.backup.v8'

type DesktopMigrationReport = {
  migratedKeys: string[]
  backupKey?: typeof DESKTOP_PERSISTENCE_BACKUP_KEY
}

type DesktopPersistenceBackup = {
  targetSchemaVersion: typeof CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION
  sourceSchemaVersion: number
  values: Record<string, string | null>
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const TAB_STORAGE_KEY = 'billiardbuddy-open-tabs'
const RETIRED_SESSION_RUNTIME_STORAGE_KEY = 'billiardbuddy-session-runtime'
const THEME_STORAGE_KEY = 'billiardbuddy-theme'
const LOCALE_STORAGE_KEY = 'billiardbuddy-locale'
const ACTIVE_SETTINGS_TAB_STORAGE_KEY = 'billiardbuddy-active-settings-tab'
const MIGRATED_STORAGE_KEYS = [
  TAB_STORAGE_KEY,
  RETIRED_SESSION_RUNTIME_STORAGE_KEY,
  THEME_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
  ACTIVE_SETTINGS_TAB_STORAGE_KEY,
  APP_ZOOM_STORAGE_KEY,
  LEGACY_UI_ZOOM_STORAGE_KEY,
] as const
const BACKED_UP_STORAGE_KEYS = [
  ...MIGRATED_STORAGE_KEYS,
  DESKTOP_PERSISTENCE_VERSION_KEY,
] as const
const SETTINGS_TABS = [
  'general',
  'capabilities',
  'privacy',
  'terminal',
  'mcp',
  'skills',
  'plugins',
  'computerUse',
  'about',
]

function readJson(storage: StorageLike, key: string): unknown {
  const raw = storage.getItem(key)
  if (!raw) return null
  return JSON.parse(raw)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function writeJson(storage: StorageLike, key: string, value: unknown): void {
  storage.setItem(key, JSON.stringify(value))
}

function readSchemaVersion(storage: StorageLike): number {
  const raw = storage.getItem(DESKTOP_PERSISTENCE_VERSION_KEY)
  if (raw === null) return 0
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid desktop persistence schema version: ${raw}`)
  }
  const version = Number(raw)
  if (!Number.isSafeInteger(version)) {
    throw new Error(`Invalid desktop persistence schema version: ${raw}`)
  }
  if (version > CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION) {
    throw new Error(
      `Desktop persistence schema ${version} is newer than supported schema ${CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION}`,
    )
  }
  return version
}

function captureBackup(storage: StorageLike, sourceSchemaVersion: number): DesktopPersistenceBackup {
  return {
    targetSchemaVersion: CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION,
    sourceSchemaVersion,
    values: Object.fromEntries(BACKED_UP_STORAGE_KEYS.map((key) => [key, storage.getItem(key)])),
  }
}

function parseBackup(raw: string): DesktopPersistenceBackup {
  const parsed: unknown = JSON.parse(raw)
  if (
    !isRecord(parsed)
    || parsed.targetSchemaVersion !== CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION
    || typeof parsed.sourceSchemaVersion !== 'number'
    || !Number.isSafeInteger(parsed.sourceSchemaVersion)
    || parsed.sourceSchemaVersion < 0
    || parsed.sourceSchemaVersion >= CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION
    || !isRecord(parsed.values)
  ) {
    throw new Error('Invalid desktop persistence migration backup')
  }
  for (const key of BACKED_UP_STORAGE_KEYS) {
    const value = parsed.values[key]
    if (value !== null && typeof value !== 'string') {
      throw new Error(`Invalid desktop persistence migration backup value: ${key}`)
    }
  }
  return parsed as DesktopPersistenceBackup
}

function restoreBackup(storage: StorageLike, backup: DesktopPersistenceBackup): void {
  for (const key of BACKED_UP_STORAGE_KEYS) {
    const value = backup.values[key]
    if (value === null) storage.removeItem(key)
    else if (typeof value === 'string') storage.setItem(key, value)
    else throw new Error(`Invalid desktop persistence migration backup value: ${key}`)
  }
}

function migrateTabs(storage: StorageLike, report: DesktopMigrationReport): void {
  const raw = storage.getItem(TAB_STORAGE_KEY)
  if (!raw) return

  try {
    const parsed = readJson(storage, TAB_STORAGE_KEY)
    const rawTabs = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.openTabs)
        ? parsed.openTabs
        : []
    const openTabs = rawTabs
      .filter((tab): tab is Record<string, unknown> => isRecord(tab))
      .filter((tab) => typeof tab.sessionId === 'string' && typeof tab.title === 'string')
      .flatMap((tab) => {
        const sessionId = tab.sessionId as string
        const title = tab.title as string

        if (
          tab.type === 'settings'
          || tab.type === 'scheduled'
          || tab.type === 'creation'
          || tab.type === 'operations'
          || tab.type === 'image-workbench'
          || tab.type === 'video-studio'
          || tab.type === 'product-tasks'
        ) {
          return [{ sessionId, title, type: tab.type }]
        }

        if (tab.type === 'product-task' && typeof tab.taskId === 'string' && tab.taskId.trim()) {
          return [{ sessionId, title, type: 'product-task', taskId: tab.taskId.trim() }]
        }

        return []
      })
    const activeTabId =
      isRecord(parsed) &&
      typeof parsed.activeTabId === 'string' &&
      openTabs.some((tab) => tab.sessionId === parsed.activeTabId)
        ? parsed.activeTabId
        : (openTabs[0]?.sessionId ?? null)

    if (openTabs.length === 0) {
      storage.removeItem(TAB_STORAGE_KEY)
    } else {
      writeJson(storage, TAB_STORAGE_KEY, { openTabs, activeTabId })
    }
  } catch {
    storage.removeItem(TAB_STORAGE_KEY)
  }
  report.migratedKeys.push(TAB_STORAGE_KEY)
}

function removeRetiredSessionRuntime(storage: StorageLike, report: DesktopMigrationReport): void {
  if (storage.getItem(RETIRED_SESSION_RUNTIME_STORAGE_KEY) === null) return
  storage.removeItem(RETIRED_SESSION_RUNTIME_STORAGE_KEY)
  report.migratedKeys.push(RETIRED_SESSION_RUNTIME_STORAGE_KEY)
}

function normalizeEnumKey(
  storage: StorageLike,
  key: string,
  allowedValues: string[],
  report: DesktopMigrationReport,
): void {
  const value = storage.getItem(key)
  if (value !== null && !allowedValues.includes(value)) {
    storage.removeItem(key)
    report.migratedKeys.push(key)
  }
}

function migrateRetiredSettingsTab(storage: StorageLike, report: DesktopMigrationReport): void {
  if (storage.getItem(ACTIVE_SETTINGS_TAB_STORAGE_KEY) === 'activity') {
    storage.setItem(ACTIVE_SETTINGS_TAB_STORAGE_KEY, 'general')
    report.migratedKeys.push(ACTIVE_SETTINGS_TAB_STORAGE_KEY)
    return
  }

  normalizeEnumKey(storage, ACTIVE_SETTINGS_TAB_STORAGE_KEY, SETTINGS_TABS, report)
}

function normalizeAppZoomKey(storage: StorageLike, report: DesktopMigrationReport): void {
  const value = storage.getItem(APP_ZOOM_STORAGE_KEY)
  if (value !== null && !isValidStoredAppZoomLevel(value)) {
    storage.removeItem(APP_ZOOM_STORAGE_KEY)
    report.migratedKeys.push(APP_ZOOM_STORAGE_KEY)
  }

  const currentValue = storage.getItem(APP_ZOOM_STORAGE_KEY)
  const legacyValue = storage.getItem(LEGACY_UI_ZOOM_STORAGE_KEY)
  if (currentValue === null && legacyValue !== null && isValidStoredAppZoomLevel(legacyValue)) {
    storage.setItem(APP_ZOOM_STORAGE_KEY, String(normalizeAppZoomLevel(legacyValue)))
    report.migratedKeys.push(APP_ZOOM_STORAGE_KEY)
  }
  if (legacyValue !== null) {
    storage.removeItem(LEGACY_UI_ZOOM_STORAGE_KEY)
    report.migratedKeys.push(LEGACY_UI_ZOOM_STORAGE_KEY)
  }
}

function getDefaultStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export function runDesktopPersistenceMigrations(storage: StorageLike | null = getDefaultStorage()): DesktopMigrationReport {
  const report: DesktopMigrationReport = { migratedKeys: [] }
  if (!storage) return report

  let sourceSchemaVersion = readSchemaVersion(storage)
  if (sourceSchemaVersion === CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION) return report

  const existingBackupRaw = storage.getItem(DESKTOP_PERSISTENCE_BACKUP_KEY)
  let backup: DesktopPersistenceBackup
  if (existingBackupRaw !== null) {
    backup = parseBackup(existingBackupRaw)
    restoreBackup(storage, backup)
    sourceSchemaVersion = readSchemaVersion(storage)
    if (sourceSchemaVersion !== backup.sourceSchemaVersion) {
      throw new Error('Desktop persistence migration backup did not restore its source schema')
    }
  } else {
    backup = captureBackup(storage, sourceSchemaVersion)
    storage.setItem(DESKTOP_PERSISTENCE_BACKUP_KEY, JSON.stringify(backup))
  }
  report.backupKey = DESKTOP_PERSISTENCE_BACKUP_KEY

  try {
    migrateTabs(storage, report)
    removeRetiredSessionRuntime(storage, report)
    normalizeEnumKey(storage, THEME_STORAGE_KEY, [...THEME_MODES], report)
    normalizeEnumKey(storage, LOCALE_STORAGE_KEY, [...DESKTOP_LOCALES], report)
    migrateRetiredSettingsTab(storage, report)
    normalizeAppZoomKey(storage, report)
    storage.setItem(DESKTOP_PERSISTENCE_VERSION_KEY, String(CURRENT_DESKTOP_PERSISTENCE_SCHEMA_VERSION))
    report.migratedKeys.push(DESKTOP_PERSISTENCE_VERSION_KEY)
  } catch (error) {
    try {
      restoreBackup(storage, backup)
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Desktop persistence migration and rollback failed')
    }
    throw error
  }

  return report
}
