// 全局崩溃兜底(主进程):长会话 agent 循环里,主进程任一未捕获异常/未处理 Promise 拒绝、渲染
// 进程崩溃、子进程(GPU/utility)挂掉,都不该让整个应用静默死掉。这里集中挂三类兜底:
//   1) process 级 uncaughtException / unhandledRejection —— 记录、保持存活、不静默崩(首次弹一次提示)。
//   2) app 级 render-process-gone —— 渲染进程崩溃/OOM 时自动重载窗口恢复(带循环护栏,别反复重载烧 CPU)。
//   3) app 级 child-process-gone —— GPU/utility 子进程挂掉只记录(Electron 通常自行重建)。
// 全部依赖注入,便于单测断言"handler 挂上了 + 触发时记录且不 exit"。

/** 只依赖 EventEmitter 的 on()(process / app 都满足)。 */
interface EventOn {
  on(event: string, listener: (...args: unknown[]) => void): unknown
}

interface Logger {
  error: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
}

export interface ProcessCrashGuardDeps {
  /** 默认 process;测试注入假 emitter。 */
  proc?: EventOn
  logger?: Logger
  /** 首次致命错误时的一次性提示(如 dialog);不传则只记录。做成一次性避免弹窗风暴。 */
  onFirstFatal?: (kind: 'uncaughtException' | 'unhandledRejection', error: unknown) => void
}

/** 挂 process 级兜底。记录但绝不主动 exit —— 静默崩溃比留着一个降级运行的进程更糟。 */
export function installProcessCrashGuards(deps: ProcessCrashGuardDeps = {}): void {
  const proc = deps.proc ?? process
  const logger = deps.logger ?? console
  let firstFatalShown = false

  const handleFatal = (kind: 'uncaughtException' | 'unhandledRejection', error: unknown): void => {
    logger.error(`[main] 未捕获${kind === 'uncaughtException' ? '异常' : ' Promise 拒绝'}:`, error)
    if (!firstFatalShown) {
      firstFatalShown = true
      try {
        deps.onFirstFatal?.(kind, error)
      } catch (hookErr) {
        logger.error('[main] 崩溃提示回调本身出错(忽略):', hookErr)
      }
    }
    // 有意不 process.exit:保持应用存活,让用户能存/续会话,而不是白屏猝死。
  }

  proc.on('uncaughtException', (error: unknown) => handleFatal('uncaughtException', error))
  proc.on('unhandledRejection', (reason: unknown) => handleFatal('unhandledRejection', reason))
}

export interface AppCrashGuardDeps {
  logger?: Logger
  /** 渲染进程崩溃后重载窗口(恢复界面)。返回是否成功发起重载。 */
  reloadWindow?: () => boolean
  /** 短时间内重载次数触顶时的兜底提示(别陷入重载死循环)。 */
  onReloadGaveUp?: (reloads: number) => void
  /** 重载循环护栏:窗口内最多重载几次。默认 3。 */
  maxReloads?: number
  /** 重载计数滚动窗口(ms)。默认 60s。 */
  reloadWindowMs?: number
  now?: () => number
}

interface RenderProcessGoneDetails {
  reason?: string
  exitCode?: number
}

/** 挂 app 级崩溃兜底(render-process-gone / child-process-gone),带自动重载与循环护栏。 */
export function installAppCrashGuards(app: EventOn, deps: AppCrashGuardDeps = {}): void {
  const logger = deps.logger ?? console
  const maxReloads = deps.maxReloads ?? 3
  const reloadWindowMs = deps.reloadWindowMs ?? 60_000
  const now = deps.now ?? (() => Date.now())
  let reloadTimes: number[] = []

  app.on('render-process-gone', (...args: unknown[]) => {
    const details = (args[2] ?? {}) as RenderProcessGoneDetails
    const reason = details.reason ?? 'unknown'
    // 'clean-exit'/'killed' 是正常关闭,不当崩溃处理。
    if (reason === 'clean-exit' || reason === 'killed') return
    logger.error(`[main] 渲染进程异常退出 reason=${reason} exitCode=${details.exitCode ?? '?'}`)

    const cutoff = now() - reloadWindowMs
    reloadTimes = reloadTimes.filter((t) => t >= cutoff)
    if (reloadTimes.length >= maxReloads) {
      logger.error(`[main] 渲染进程 ${reloadTimes.length} 次内反复崩溃,停止自动重载`)
      deps.onReloadGaveUp?.(reloadTimes.length)
      return
    }
    reloadTimes.push(now())
    const ok = deps.reloadWindow?.() ?? false
    logger.warn(`[main] 自动重载窗口${ok ? '' : '失败(窗口不存在)'}(第 ${reloadTimes.length} 次)`)
  })

  app.on('child-process-gone', (...args: unknown[]) => {
    const details = (args[1] ?? {}) as { type?: string; reason?: string }
    logger.warn(`[main] 子进程退出 type=${details.type ?? '?'} reason=${details.reason ?? '?'}(通常自行重建)`)
  })
}
