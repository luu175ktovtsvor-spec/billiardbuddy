// 后台 async hook 的跨回合唤醒暂存(对齐 cc AsyncHookRegistry 的意图,桌面精简版)。
//
// 为什么不能用 ctx.steerInbox:steerInbox 是【回合级】数组(server 每回合 `steerInboxes.get(id) ?? []` 新建、
// 回合末 `steerInboxes.delete(id)` 销毁)。async hook 后台跑,完成时回合往往已结束,push 进 steerInbox 的消息
// 会随那个已被丢弃的数组一起永久丢失(审查逮到的真丢消息 bug)。cc 用【进程级】pendingHooks Map + 每轮轮询 drain
// 从根子上避免。本模块是同款:按 conversationId 存进程级队列,由 loop 每回合起点 drain 注入,跨回合不丢。
//
// 生命周期:push 无界增长风险由"回合起点必 drain"兜底(每个活跃会话每回合清空一次);会话永不再开则残留,
// 属可接受的小泄漏(桌面单用户、会话数有限),不引入定时清理避免复杂度。

const pendingWakes = new Map<string, string[]>()

/** 后台 async hook(asyncRewake)完成后,把唤醒消息按会话入队,等该会话下一回合 drain。conversationId 为空则丢弃(无处投递)。 */
export function pushAsyncHookWake(conversationId: string | undefined, message: string): void {
  if (!conversationId) return
  const arr = pendingWakes.get(conversationId)
  if (arr) arr.push(message)
  else pendingWakes.set(conversationId, [message])
}

/** 取走并清空某会话积压的 async hook 唤醒消息(FIFO)。loop 每回合起点调用,把它们作 system-reminder 注入。 */
export function drainAsyncHookWakes(conversationId: string | undefined): string[] {
  if (!conversationId) return []
  const arr = pendingWakes.get(conversationId)
  if (!arr || arr.length === 0) return []
  pendingWakes.delete(conversationId)
  return arr
}

/** 测试用:清空全部积压。 */
export function clearAsyncHookWakes(): void {
  pendingWakes.clear()
}
