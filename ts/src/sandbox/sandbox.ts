import type { Workspace } from '../workspace/workspace'
import { buildRuntimeConfig, ensureInitialized, isOsSandboxSupported, wrapArgv } from './osSandbox'
import { WindowsJobObjectLauncher } from './windowsLauncher'

export interface WrappedCommand {
  argv: string[]
  env: NodeJS.ProcessEnv
}

/**
 * 双层沙箱门面(§5)。wrapCommand 返回 {argv,env} = 包进 OS 盒子跑;返回 null = 按明文命令跑(plain spawn)。
 * W3 姿态:enabled 默认 false(opt-in,照 cc-haha);"默认开 / 按命令决定沙箱 / 自动放行" = W4。
 */
export class Sandbox {
  readonly workspace: Workspace
  private readonly enabled: boolean
  private readonly platform: NodeJS.Platform
  private readonly winLauncher = new WindowsJobObjectLauncher()
  private initialized = false

  constructor(opts: { workspace: Workspace; enabled?: boolean; platform?: NodeJS.Platform }) {
    this.workspace = opts.workspace
    this.enabled = opts.enabled ?? false
    this.platform = opts.platform ?? process.platform
  }

  isOsSandboxActive(): boolean {
    return this.enabled && isOsSandboxSupported(this.platform)
  }

  async wrapCommand(command: string, opts: { signal?: AbortSignal } = {}): Promise<WrappedCommand | null> {
    if (this.isOsSandboxActive()) {
      if (!this.initialized) {
        await ensureInitialized(buildRuntimeConfig({ writablePaths: [this.workspace.root] }))
        this.initialized = true
      }
      return await wrapArgv(command, opts.signal)
    }
    if (this.platform === 'win32') {
      return this.winLauncher.wrap(command, opts) // W3:null(回退明文);W3b:Job Object
    }
    return null
  }

  /** 序列化进 run_command 工具说明给模型看(§5:沙箱配置实时给模型)。 */
  describeForPrompt(): string {
    if (this.isOsSandboxActive()) {
      return `命令在 OS 沙箱中运行：可写目录仅限工作区（${this.workspace.root}），越界写入会被系统拒绝。`
    }
    if (this.platform === 'win32') {
      return '命令在本机直接运行（受应用层护栏：路径沙箱 + 改前备份 + 审批闸）。Windows Job Object 隔离待后续启用。'
    }
    return '命令在本机直接运行（受应用层护栏：路径沙箱 + 改前备份 + 审批闸）。'
  }
}
