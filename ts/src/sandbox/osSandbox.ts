import {
  getDefaultWritePaths,
  SandboxManager,
  type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime'

export interface OsSandboxSeed {
  writablePaths: string[]
  denyWritePaths?: string[]
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
): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }> {
  return SandboxManager.wrapWithSandboxArgv(command, undefined, undefined, signal)
}

export async function resetOsSandbox(): Promise<void> {
  initialized = false
  await SandboxManager.reset()
}
