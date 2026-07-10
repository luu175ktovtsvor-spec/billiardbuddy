import type { Workspace } from '../workspace/workspace'
import { buildRuntimeConfig, ensureInitialized, isOsSandboxSupported, realpathIfExists, sandboxDenyWritePaths, wrapArgv } from './osSandbox'
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
    // fullDiskAccess 会话(app 层 Workspace.resolve 已放行工作区外任意路径读写)与"默认开的 OS 沙箱只认
    // workspace.root"冲突:会把这个已文档化的能力(run_command.description "desktop full-disk sessions
    // can run from external directories")在内核层静默拦死(EPERM)。cc 没有"全盘会话"这个概念,其最接近
    // 的等价状态就是 sandbox.enabled=false(默认关=不设写围栏);故这里让 fullDiskAccess 会话视为沙箱不
    // 激活,而非试图放宽 allowWrite("/" 这类写法 Linux 不认 glob、跨平台语义不稳,风险高于收益)。
    return this.enabled && !this.degraded && !this.workspace.fullDiskAccess && isOsSandboxSupported(this.platform)
  }

  async wrapCommand(
    command: string,
    opts: { signal?: AbortSignal; extraWritablePaths?: string[] } = {},
  ): Promise<WrappedCommand | null> {
    if (this.isOsSandboxActive()) {
      // 优雅降级:初始化/包裹一旦抛错(缺依赖/环境不支持),记 degraded 并退回明文执行,绝不因沙箱阻断命令。
      try {
        // 工作区根落在 symlink 路径下时(macOS /tmp、/var、os.tmpdir() 均如此)统一 realpath 一次;
        // allow(writablePaths)与 deny(sandboxDenyWritePaths)两边永远拼同一份已解析前缀(R4
        // CONFIRMED #2 修复,详见 osSandbox.realpathIfExists 注释)。
        const root = realpathIfExists(this.workspace.root)
        if (!this.initialized) {
          await ensureInitialized(buildRuntimeConfig({
            writablePaths: [root],
            denyWritePaths: sandboxDenyWritePaths(root),
          }))
          this.initialized = true
        }
        // 每次调用都无条件带上该工作区完整的 filesystem 覆盖(allowWrite/denyWrite 全量),不再只在
        // extraWritablePaths 变化时才传——SandboxManager 是进程级单例,并发的另一个工作区的 Sandbox
        // 实例随时可能通过 ensureInitialized→updateConfig() 把全局 config 整体覆写成它自己的
        // workspace(R4 CONFIRMED #1);customConfig.filesystem 各字段都显式填满时,wrapWithSandbox
        // 完全不读全局残留状态,本次调用因此不受任何并发工作区影响(见 osSandbox.wrapArgv 注释)。
        const extra = opts.extraWritablePaths ?? []
        const perCallFilesystem = buildRuntimeConfig({
          writablePaths: [root, ...extra],
          denyWritePaths: sandboxDenyWritePaths(root),
        }).filesystem
        return await wrapArgv(command, opts.signal, { filesystem: perCallFilesystem })
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
