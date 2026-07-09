/**
 * 桌面 app「本地模式 + 库目录」的**共享环境契约**(白标:BILLIARDBUDDY_* / .billiardbuddy)。
 *
 * 旧品牌名 `DESKTOP_LOCAL` / `DESKTOP_LIBRARY_DIR` / `~/.billiards-desktop` 是跨模块共享契约——
 * pluginLoader / configStore / outputStyleLoader / server 都读同一套。白标统一后集中在此一处,
 * 日后再改名只动这个文件(仿 memoryNames.ts 的做法)。库根点目录名复用
 * memoryNames.MEMORY_DOT_DIR(`.billiardbuddy`),保证与记忆/指令目录同一套品牌命名。
 */
import { join } from 'node:path'
import { MEMORY_DOT_DIR } from './memoryNames'

/** 本地模式开关 env(旧名 `DESKTOP_LOCAL`);=== '1' 时走内置库路径而非用户全局配置目录。 */
export const LOCAL_MODE_ENV = 'BILLIARDBUDDY_LOCAL'
/** 桌面库根目录 env 覆盖(旧名 `DESKTOP_LIBRARY_DIR`)。 */
export const LIBRARY_DIR_ENV = 'BILLIARDBUDDY_LIBRARY_DIR'
/** 库根点目录名(旧名 `.billiards-desktop`),统一为 `.billiardbuddy`(= MEMORY_DOT_DIR)。 */
export const LIBRARY_DOT_DIR = MEMORY_DOT_DIR
/** 库根下的子目录名。 */
export const LIBRARY_SUBDIR = 'library'

function homeFrom(env: Record<string, string | undefined>): string {
  return env.HOME || env.USERPROFILE || process.cwd()
}

/** 是否本地模式(env BILLIARDBUDDY_LOCAL === '1')。 */
export function isLocalMode(env: Record<string, string | undefined>): boolean {
  return env[LOCAL_MODE_ENV] === '1'
}

/** 桌面库根目录:env 覆盖(BILLIARDBUDDY_LIBRARY_DIR)优先,否则 ~/.billiardbuddy/library。 */
export function desktopLibraryBase(env: Record<string, string | undefined>): string {
  return env[LIBRARY_DIR_ENV] || join(homeFrom(env), LIBRARY_DOT_DIR, LIBRARY_SUBDIR)
}
