/**
 * backend-sidecar 进程级顶层崩溃兜底(P0,审计 `16-trace-errors.md` #6.1)。
 *
 * backend-sidecar 是常驻跑 harness 循环的 Bun 进程,一处未被 request 级 try/catch 兜住的异常
 * (后台任务 / WS 分支 / hooks 聚合器之外的路径…)按运行时默认行为会直接打崩整个进程、拖死当时
 * **所有**并发会话。策略与 Electron 侧 `desktop/electron/services/crashGuard.ts`(记录 + 永不退出,
 * 因为那是给用户交互用的主进程,崩了用户直接感知)以及 cc-haha `utils/gracefulShutdown.ts`
 * (CLI 单进程语境,同样只记录不退出)都刻意不同:
 *
 *   - `uncaughtException` → 写崩溃日志后按 Node 惯例 `exit(1)`,让 Electron 侧 `sidecarManager`
 *     的指数退避自动重启接手。此时进程状态已不可信,"记录但带伤跑下去"比干脆重启更危险
 *     (半初始化的服务 / 残留连接可能悄悄污染后续请求)。
 *   - `unhandledRejection` → 只记录,不退出。很多第三方库场景下一次 rejection 不代表进程整体已经
 *     坏了,真崩掉会比"漏抓一次 rejection"误杀更多正在跑的正常会话。
 *
 * 依赖注入(`proc`/`exit`)使其可用假 emitter 单测,不必真起子进程
 * (对齐 `desktop/electron/services/crashGuard.ts` + 其 `crashGuard.test.ts` 的做法)。
 */
import { getLogger, writeCrashLog, type LoggerEnv } from './logger'

/** 只依赖 EventEmitter 的 on()(process 满足;测试可注入假 emitter)。 */
interface EventOn {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

export interface SidecarCrashGuardOptions {
  /** 默认 process;测试注入假 emitter。 */
  proc?: EventOn
  /** 默认 `process.exit`;测试注入 spy,断言调没调、传的 code。 */
  exit?: (code: number) => void
  /** 崩溃日志 / 调试日志落盘目录(通常 `<stateRoot>/logs`)。 */
  logDir: string
  env?: LoggerEnv
  /** debug.log 里的模块名前缀,默认 `backend-sidecar`。 */
  moduleName?: string
}

function toErrorDetail(value: unknown): { message: string; stack?: string } {
  if (value instanceof Error) return { message: value.message, stack: value.stack }
  return { message: String(value) }
}

/** 挂 backend-sidecar 进程级崩溃兜底。见文件头注释:两类异常的处理策略刻意不同。 */
export function installSidecarCrashGuards(options: SidecarCrashGuardOptions): void {
  const proc = options.proc ?? process
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const logger = getLogger(options.moduleName ?? 'backend-sidecar', { logDir: options.logDir, env: options.env })

  proc.on('uncaughtException', (error: unknown) => {
    const detail = toErrorDetail(error)
    logger.error(`uncaughtException: ${detail.message}`)
    writeCrashLog('uncaughtException', detail, { logDir: options.logDir, env: options.env })
    exit(1)
  })

  proc.on('unhandledRejection', (reason: unknown) => {
    const detail = toErrorDetail(reason)
    logger.error(`unhandledRejection: ${detail.message}`)
    writeCrashLog('unhandledRejection', detail, { logDir: options.logDir, env: options.env })
    // 有意不退出,见文件头注释。
  })
}
