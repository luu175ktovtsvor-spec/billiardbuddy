import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// 老 server/(Python 线)已整体退役,`../server/.env.bundled.local` 死引用移除;内置 key 走 desktop/bundled.env。
export const DEFAULT_MODEL_ENV_FILES = ['../desktop/bundled.env'] as const

export function parseDotEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  return env
}

export function loadEnvFiles(paths: readonly string[], cwd = process.cwd()): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const p of paths) {
    const abs = resolve(cwd, p)
    if (!existsSync(abs)) continue
    Object.assign(merged, parseDotEnv(readFileSync(abs, 'utf-8')))
  }
  return merged
}

export function applyEnvFiles(paths: readonly string[] = DEFAULT_MODEL_ENV_FILES, cwd = process.cwd()): Record<string, string> {
  const loaded = loadEnvFiles(paths, cwd)
  Object.assign(process.env, loaded)
  return loaded
}
