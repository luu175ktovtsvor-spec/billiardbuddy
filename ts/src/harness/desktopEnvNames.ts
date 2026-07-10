/**
 * 桌面 app「本地模式 + 库目录」的**共享环境契约**(白标:BILLIARDBUDDY_* / .billiardbuddy)。
 *
 * 旧品牌名 `DESKTOP_LOCAL` / `DESKTOP_LIBRARY_DIR` / `~/.billiards-desktop` 是跨模块共享契约——
 * pluginLoader / configStore / outputStyleLoader / server 都读同一套。白标统一后集中在此一处,
 * 日后再改名只动这个文件(仿 memoryNames.ts 的做法)。库根点目录名复用
 * memoryNames.MEMORY_DOT_DIR(`.billiardbuddy`),保证与记忆/指令目录同一套品牌命名。
 */
import { homedir } from 'node:os'
import { mkdir } from 'node:fs/promises'
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

// ─────────────────────────────────────────────────────────────────────────────
// 显式全局默认工作区(§2.2)—— 不选文件夹时模型干活的地方,顶掉隐式 process.cwd() 兜底。
// 集中一处、日后改名/换位置只动这里(仿 memoryNames.getUserConfigHomeDir 的 env 覆盖风格)。
// ─────────────────────────────────────────────────────────────────────────────

/** 默认工作区 env 覆盖(测试/多环境;不设时落 ~/Documents/球房管家/)。 */
export const WORKSPACE_DIR_ENV = 'BILLIARDBUDDY_WORKSPACE_DIR'
/** 用户可见的产品中文名(与 Electron 壳 APP_NAME 一致);默认工作区 = ~/Documents/<此名>/。 */
const DEFAULT_WORKSPACE_FOLDER_NAME = '球房管家'

/**
 * 显式全局默认工作区(不选文件夹时的落点)。owner 拍板方案 A:放用户可见的
 * `~/Documents/球房管家/` —— AI 生成的生图/报表/剪辑产物用户在「文档」里找得到;
 * 而不是隐式 `process.cwd()`(打包后从 Finder 启动可能落 `/` 或隐藏的 App 支持目录 → 找不到甚至写不下)。
 * env `BILLIARDBUDDY_WORKSPACE_DIR` 可覆盖(测试/多环境)。
 */
export function getDefaultWorkspaceDir(): string {
  const override = process.env[WORKSPACE_DIR_ENV]
  return (
    override && override.length > 0 ? override : join(homedir(), 'Documents', DEFAULT_WORKSPACE_FOLDER_NAME)
  ).normalize('NFC')
}

/** 首启确保默认工作区存在(mkdir -p,尽力而为、绝不阻塞启动)。返回该路径。 */
export async function ensureDefaultWorkspace(): Promise<string> {
  const dir = getDefaultWorkspaceDir()
  try {
    await mkdir(dir, { recursive: true })
  } catch {
    // 尽力而为:目录建不出来(权限/只读盘)不拦启动;真正写文件时工具会再报清晰错误。
  }
  return dir
}
