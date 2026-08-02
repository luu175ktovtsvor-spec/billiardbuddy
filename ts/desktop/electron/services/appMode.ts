import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import type { AppModeConfig, AppModeSetInput } from '../ipc/desktopShellTypes'

const APP_MODE_FILE = 'app-mode.json'

export type AppModeAppLike = {
  getPath(name: 'exe' | 'userData'): string
}

type PersistedAppModeConfig = {
  mode?: string
  portable_dir?: string | null
}

export type PortableDetection = {
  defaultPortableDir: string | null
  hasData: boolean
}

export function defaultPortableDir(app: AppModeAppLike): string {
  return path.join(path.dirname(app.getPath('exe')), 'BILLIARDBUDDY_DATA')
}

/**
 * BilliardBuddy's product data root. Desktop and sidecar processes receive the
 * same absolute directory and never discover another product's state.
 */
export function defaultProductDataDir(app: AppModeAppLike): string {
  return path.join(app.getPath('userData'), 'config')
}

/**
 * When neither a shell/ops override nor portable mode set BILLIARDBUDDY_CONFIG_DIR, point
 * it at BilliardBuddy's own data root so a fresh double-click install does not read
 * unrelated state. Marks BB_DEFAULT_CONFIG_DIR so getAppMode still reports this
 * as the normal "default/system" mode rather than a user "environment" override.
 * Must run AFTER applyStartupPortableMode so an explicit portable dir wins.
 */
export function applyDefaultConfigDir(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.BILLIARDBUDDY_CONFIG_DIR) return null
  const dir = defaultProductDataDir(app)
  fs.mkdirSync(dir, { recursive: true })
  env.BILLIARDBUDDY_CONFIG_DIR = dir
  env.BB_DEFAULT_CONFIG_DIR = '1'
  return dir
}

export function dirHasPortableData(dir: string): boolean {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false
  return [
    'settings.json',
    '.BilliardBuddy.json',
    '.mcp.json',
    'window-state.json',
  ].some(file => fs.existsSync(path.join(dir, file)) && fs.statSync(path.join(dir, file)).isFile())
    || [
      'Cache',
      'EBWebView',
      'projects',
      'skills',
      'plugins',
      'cowork_plugins',
      'billiardbuddy',
    ].some(file => fs.existsSync(path.join(dir, file)) && fs.statSync(path.join(dir, file)).isDirectory())
}

export function readAppModeConfig(configDir: string): PersistedAppModeConfig | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, APP_MODE_FILE), 'utf8')) as PersistedAppModeConfig
    return {
      mode: typeof parsed.mode === 'string' ? parsed.mode.toLowerCase() : 'default',
      portable_dir: typeof parsed.portable_dir === 'string' ? parsed.portable_dir : null,
    }
  } catch {
    return null
  }
}

export function writeAppModeConfig(configDir: string, config: PersistedAppModeConfig): void {
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, APP_MODE_FILE), JSON.stringify(config, null, 2))
}

export function determineStartupPortableDir(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.BILLIARDBUDDY_CONFIG_DIR) return null

  const defaultDir = defaultPortableDir(app)
  const defaultMode = readAppModeConfig(defaultDir)
  if (defaultMode) {
    if (defaultMode.mode === 'portable') {
      return dirHasPortableData(defaultDir) ? defaultDir : defaultMode.portable_dir ?? defaultDir
    }
    return null
  }

  const systemMode = readAppModeConfig(app.getPath('userData'))
  if (systemMode) {
    if (systemMode.mode === 'portable') return systemMode.portable_dir ?? defaultDir
    return null
  }

  return dirHasPortableData(defaultDir) ? defaultDir : null
}

export function applyStartupPortableMode(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const portableDir = determineStartupPortableDir(app, env)
  if (!portableDir) return null
  env.BILLIARDBUDDY_CONFIG_DIR = portableDir
  env.BB_APP_PORTABLE_DIR = '1'
  env.WEBVIEW2_USER_DATA_FOLDER = path.join(portableDir, 'EBWebView')
  fs.mkdirSync(env.WEBVIEW2_USER_DATA_FOLDER, { recursive: true })
  return portableDir
}

export function getAppMode(
  app: AppModeAppLike,
  env: NodeJS.ProcessEnv = process.env,
): AppModeConfig {
  const envConfigDir = env.BILLIARDBUDDY_CONFIG_DIR || null
  // The app-set BilliardBuddy default is NOT a user override: report it as default/system.
  const appDefault = envConfigDir != null && env.BB_DEFAULT_CONFIG_DIR === '1'
  const userOverride = envConfigDir != null && !appDefault
  const activeConfigDir = envConfigDir || app.getPath('userData')
  return {
    mode: userOverride ? 'portable' : 'default',
    portableDir: userOverride ? envConfigDir : defaultPortableDir(app),
    defaultPortableDir: defaultPortableDir(app),
    activeConfigDir,
    configDirSource: userOverride
      ? env.BB_APP_PORTABLE_DIR ? 'portable' : 'environment'
      : 'system',
  }
}

export function setAppMode(
  app: AppModeAppLike,
  input: AppModeSetInput,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const activeConfigDir = env.BILLIARDBUDDY_CONFIG_DIR || app.getPath('userData')
  let config: PersistedAppModeConfig = { mode: 'default', portable_dir: null }
  let targetPortableDir: string | null = null

  if (input.mode === 'portable') {
    const selectedDir = input.portableDir?.trim() || defaultPortableDir(app)
    if (fs.existsSync(selectedDir) && !fs.statSync(selectedDir).isDirectory()) {
      throw new Error(`portable config path is not a directory: ${selectedDir}`)
    }
    fs.mkdirSync(selectedDir, { recursive: true })
    targetPortableDir = selectedDir
    config = {
      mode: 'portable',
      portable_dir: selectedDir === defaultPortableDir(app) ? null : selectedDir,
    }
  }

  writeAppModeConfig(activeConfigDir, config)
  if (targetPortableDir && targetPortableDir !== activeConfigDir) {
    writeAppModeConfig(targetPortableDir, config)
  }

  const systemConfigDir = app.getPath('userData')
  if (systemConfigDir !== activeConfigDir) {
    writeAppModeConfig(systemConfigDir, config)
  }
}

export function detectPortableDir(app: AppModeAppLike): PortableDetection {
  const portableDir = defaultPortableDir(app)
  return {
    defaultPortableDir: portableDir,
    hasData: dirHasPortableData(portableDir),
  }
}
