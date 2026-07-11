import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// 老 server/(Python 线)已整体退役,`../server/.env.bundled.local` 死引用移除;内置 key 走 desktop/bundled.env。
export const DEFAULT_MODEL_ENV_FILES = ['../desktop/bundled.env'] as const

/**
 * 内置 env(bundled.env)的候选绝对路径,按优先级:
 *  1. QF_BUNDLED_ENV 显式指定(dev:electron main 传仓库内 desktop/bundled.env 的绝对路径);
 *  2. 相对可执行文件:<execDir>/../bundled.env(打包版:sidecar 二进制在 Resources/binaries/,
 *     electron-builder 把 bundled.env 发到 Resources/bundled.env)——sidecar 的 cwd 是 userData,
 *     cwd 相对路径在 dev/打包两态都指不到包内文件,必须按 execPath 定位;
 *  3. 旧的 cwd 相对路径(从 ts/ 直跑 `bun run server` 的本地开发兼容)。
 */
export function bundledEnvCandidates(env: Record<string, string | undefined> = process.env, execPath: string = process.execPath, cwd = process.cwd()): string[] {
  const out: string[] = []
  if (env.QF_BUNDLED_ENV) out.push(env.QF_BUNDLED_ENV)
  out.push(resolve(dirname(execPath), '../bundled.env'))
  for (const p of DEFAULT_MODEL_ENV_FILES) out.push(resolve(cwd, p))
  return out
}

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

export function applyEnvFiles(paths?: readonly string[], cwd = process.cwd()): Record<string, string> {
  let loaded: Record<string, string>
  if (paths) {
    loaded = loadEnvFiles(paths, cwd)
  } else {
    // 不显式传 paths:按候选链找内置 env(QF_BUNDLED_ENV → exec 相对 → cwd 相对),命中第一份就用。
    const hit = bundledEnvCandidates(process.env, process.execPath, cwd).find(p => existsSync(p))
    loaded = hit ? parseDotEnv(readFileSync(hit, 'utf-8')) : {}
  }
  Object.assign(process.env, loaded)
  return loaded
}
