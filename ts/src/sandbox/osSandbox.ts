import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  getDefaultWritePaths,
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'
import { MEMORY_DOT_DIR, getUserConfigHomeDir } from '../harness/memoryNames'

export interface OsSandboxSeed {
  writablePaths: string[]
  denyWritePaths?: string[]
}

/**
 * 存在才 realpath,不存在(或探测出错)保持原样——用于给 OS 沙箱层拼路径前统一"拆 symlink 外壳"
 * (R4 CONFIRMED #2 修复)。macOS 的 `/tmp`、`/var`、`os.tmpdir()` 都是指向 `/private/*` 的 symlink;
 * `@anthropic-ai/sandbox-runtime` 自己的 `normalizePathForSandbox` 也会 realpath,但只在"目标路径
 * 已存在"时生效(`fs.realpathSync` 对不存在的路径抛 ENOENT 后原样回退)——workspace root 本身通常已
 * 建出来(realpath 成功),而 `.billiardbuddy/settings.json` 这类 denyWrite 目标此刻大概率还不存在
 * (正是要被沙箱内命令新建/覆写的对象),于是 allow 规则(root,已 realpath)与 deny 规则(root 的
 * symlink 原串 + 后缀,未 realpath)落地成两个不同前缀的字符串,细粒度 deny 悄悄失效。这里在拼接
 * 前就把 root 本身 realpath 掉,allow/deny 两边永远共用同一份已解析前缀,不依赖库对"目标文件是否
 * 已存在"的隐式行为。
 */
export function realpathIfExists(path: string): string {
  try {
    return existsSync(path) ? realpathSync(path) : path
  } catch {
    return path
  }
}

/**
 * OS 沙箱层敏感配置保护清单(对齐 cc sandbox-adapter.ts 拒写 settings.json 各 source +
 * `.claude/skills` 的思路,白标成我们自己的 `.billiardbuddy` 系,§8 修复)。
 * app 层已有信任门(permissionsSettings.ts 未受信工作区丢弃 allow 规则)作缓解,这里补 OS 层这道防线:
 * 防沙箱内被跑起来的命令(prompt injection 等)直接改写自己的权限/技能配置逃逸。
 *
 * workspaceRoot 入参先 realpathIfExists 一次(R4 CONFIRMED #2):调用方不管传 symlink 形式还是
 * 已解析形式,这里落地的 deny 路径永远是同一份规范化前缀,不会因为调用方没管 symlink 而悄悄失效。
 */
export function sandboxDenyWritePaths(workspaceRoot: string): string[] {
  const root = realpathIfExists(workspaceRoot)
  const userConfigHome = getUserConfigHomeDir()
  return [
    join(root, MEMORY_DOT_DIR, 'settings.json'),
    join(root, MEMORY_DOT_DIR, 'settings.local.json'),
    join(root, MEMORY_DOT_DIR, 'skills'),
    join(userConfigHome, 'settings.json'),
    join(userConfigHome, 'skills'),
  ]
}

/**
 * 从工作区种出运行时配置。写=allow-only(只放工作区 + 包自带的默认写目录如 /tmp、/dev/null,
 * 让常见命令能跑);读=默认全放;网络=空 allowedDomains(实际放行靠 initialize 的 askCallback=allow,
 * W3 只做文件系统围栏,网络收紧交 W4)。
 */
export function buildRuntimeConfig(seed: OsSandboxSeed): SandboxRuntimeConfig {
  return {
    filesystem: {
      allowWrite: Array.from(new Set([...seed.writablePaths, ...getDefaultWritePaths()])),
      denyWrite: seed.denyWritePaths ?? [],
      allowRead: [],
      denyRead: [],
    },
    network: { allowedDomains: [], deniedDomains: [] },
  }
}

/** OS 真沙箱仅 mac/linux;Windows 走 app 护栏(见 sandbox.ts)。 */
export function isOsSandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin' && platform !== 'linux') return false
  return SandboxManager.isSupportedPlatform()
}

// SandboxManager 是 @anthropic-ai/sandbox-runtime 的进程级单例(库内 module-scope config 变量),
// 这个 `initialized` flag 只跟踪"进程有没有调过一次 initialize()",**不区分是哪个工作区**——
// 生产每个 agent turn/子代理/后台任务都各自 new Sandbox({workspace: ...}),workspace 各不相同
// (server/index.ts buildSandbox)。第二个及之后任何工作区首次调这里都会落进 updateConfig() 分支,
// 把 SandboxManager 全局 config 整个覆写成"最后调用者的工作区"(R4 CONFIRMED #1)。
// 这本身**不再是 bug**:Sandbox.wrapCommand()(sandbox.ts)现在每次调用都自带该工作区完整的
// filesystem customConfig(allowWrite/denyWrite 全量,见下方 wrapArgv 注释),不依赖这里落地的
// 全局残留状态——哪个工作区的 config 被 updateConfig() 盖成全局当前值,不影响其它工作区后续调用
// 的正确性。这个函数继续存在只是为了首次建立 SandboxManager 的会话基础设施(网络代理/askCallback/
// 凭证注册等),以及避免每次都重新走一遍较重的 initialize()。
let initialized = false

export async function ensureInitialized(config: SandboxRuntimeConfig): Promise<void> {
  if (initialized) {
    SandboxManager.updateConfig(config)
    return
  }
  // askCallback 恒 allow = 网络放行(W3 姿态);enableLogMonitor=false 减开销。
  await SandboxManager.initialize(config, async () => true, false)
  initialized = true
}

export async function wrapArgv(
  command: string,
  signal?: AbortSignal,
  /**
   * 按次 filesystem 覆盖。库语义(sandbox-manager.js wrapWithSandboxArgv → wrapWithSandbox):
   * macOS/Linux 上 `customConfig.filesystem.{allowWrite,denyWrite,allowRead,denyRead}` 每个字段
   * 各自用 `??` 回退到 `initialize()`/`updateConfig()` 时落地的全局 config,互不 merge——只要调用方
   * 把这几个字段**全部显式填满**(哪怕是空数组),这次 wrap 就完全不读全局残留状态。
   * Sandbox.wrapCommand()(sandbox.ts)正是这样用的:每次调用都无条件传入该工作区完整算出的
   * filesystem 覆盖,不只是 extraWritablePaths 变化时才传(R4 CONFIRMED #1 修复:全局 config 被
   * 别的并发工作区 ensureInitialized→updateConfig() 覆写,不再影响本次调用)。
   */
  customConfig?: Partial<SandboxRuntimeConfig>,
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  return SandboxManager.wrapWithSandboxArgv(command, undefined, customConfig, signal)
}

export async function resetOsSandbox(): Promise<void> {
  initialized = false
  await SandboxManager.reset()
}
