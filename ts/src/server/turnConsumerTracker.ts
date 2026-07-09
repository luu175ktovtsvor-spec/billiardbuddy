type TimerHandle = ReturnType<typeof setTimeout>

export interface TurnConsumerTrackerOptions {
  /** 最后一个消费者断连后,无人重连的宽限期(ms),超时且回合仍在跑则中止。 */
  graceMs: number
  isRunning: (conversationId: string) => boolean
  abort: (conversationId: string) => void
  /** 可注入定时器(测试用);缺省 setTimeout/clearTimeout。 */
  scheduleTimer?: (fn: () => void, ms: number) => TimerHandle
  cancelTimer?: (handle: TimerHandle) => void
}

/**
 * WS 断连宽限清理(对齐 cc disconnectGrace):跟踪每个 conversation 的活连接数,最后一个消费者断连后
 * 若回合仍在跑,宽限期内无人重连则中止该回合——防"被前端遗弃的回合"永远跑到底造成资源/成本泄漏。
 * 重连(onConnect)会取消挂起的中止计时器。
 */
export class TurnConsumerTracker {
  private readonly consumers = new Map<string, number>()
  private readonly timers = new Map<string, TimerHandle>()
  private readonly schedule: (fn: () => void, ms: number) => TimerHandle
  private readonly cancel: (handle: TimerHandle) => void

  constructor(private readonly opts: TurnConsumerTrackerOptions) {
    this.schedule = opts.scheduleTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.cancel = opts.cancelTimer ?? (handle => clearTimeout(handle))
  }

  onConnect(conversationId: string): void {
    this.consumers.set(conversationId, (this.consumers.get(conversationId) ?? 0) + 1)
    this.cancelPending(conversationId)
  }

  onDisconnect(conversationId: string): void {
    const next = Math.max(0, (this.consumers.get(conversationId) ?? 0) - 1)
    if (next > 0) {
      this.consumers.set(conversationId, next)
      return
    }
    this.consumers.delete(conversationId)
    this.cancelPending(conversationId)
    const handle = this.schedule(() => {
      this.timers.delete(conversationId)
      if (this.opts.isRunning(conversationId)) this.opts.abort(conversationId)
    }, this.opts.graceMs)
    this.timers.set(conversationId, handle)
  }

  private cancelPending(conversationId: string): void {
    const existing = this.timers.get(conversationId)
    if (existing !== undefined) {
      this.cancel(existing)
      this.timers.delete(conversationId)
    }
  }
}
