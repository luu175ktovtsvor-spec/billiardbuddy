import type { Workspace } from '../workspace/workspace'
import { buildRuntimeConfig, ensureInitialized, isOsSandboxSupported, wrapArgv } from './osSandbox'
import { WindowsJobObjectLauncher } from './windowsLauncher'

export interface WrappedCommand {
  argv: string[]
  env: NodeJS.ProcessEnv
}

/**
 * 双层沙箱门面(§5)。wrapCommand 返回 {argv,env} = 包进 OS 盒子跑;返回 null = 按明文命令跑(plain spawn)。
 * W3 姿态:enabled 默认 false(opt-in);"默认开 / 按命令决定沙箱 / 自动放行" = W4。
 */
export class Sandbox {
  readonly workspace: Workspace
  private readonly enabled: boolean
  private readonly platform: NodeJS.Platform
  private readonly winLauncher = new WindowsJobObjectLauncher()
  private initialized = false
  /** OS 沙箱初始化/包裹失败(缺依赖如 Linux 无 bwrap、seatbelt 环境异常)后降级明文,避免默认开时阻断命令执行。 */
  private degraded = false

  constructor(opts: { workspace: Workspace; enabled?: boolean; platform?: NodeJS.Platform }) {
    this.workspace = opts.workspace
    this.enabled = opts.enabled ?? false
    this.platform = opts.platform ?? process.platform
  }

  isOsSandboxActive(): boolean {
    return this.enabled && !this.degraded && isOsSandboxSupported(this.platform)
  }

  async wrapCommand(command: string, opts: { signal?: AbortSignal } = {}): Promise<WrappedCommand | null> {
    if (this.isOsSandboxActive()) {
      // 优雅降级:初始化/包裹一旦抛错(缺依赖/环境不支持),记 degraded 并退回明文执行,绝不因沙箱阻断命令。
      try {
        if (!this.initialized) {
          await ensureInitialized(buildRuntimeConfig({ writablePaths: [this.workspace.root] }))
          this.initialized = true
        }
        return await wrapArgv(command, opts.signal)
      } catch {
        this.degraded = true
        return null
      }
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
      return '命令直接在本机运行，仅拦截红线危险命令（删根/提权/格式化等）；OS 写围栏与审批闸、Windows Job Object 隔离待后续启用。'
    }
    return '命令直接在本机运行，仅拦截红线危险命令（删根/提权/格式化等）；OS 写围栏与审批闸待启用。'
  }
}
