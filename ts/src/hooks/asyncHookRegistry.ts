// 后台 async hook(asyncRewake)的跨回合唤醒暂存(对齐 cc messageQueueManager 的 flat commandQueue)。
//
// ⚠️ 机制对齐订正(批5二次审查):cc 的 asyncRewake **绕过** AsyncHookRegistry/pendingHooks(那套只服务纯
// async:true 的 async_hook_response attachment),走的是 `enqueuePendingNotification()` → messageQueueManager
// 的【进程唯一、不分会话】flat 队列,始终流向主线程下一轮消费(cc utils/hooks.ts:208-249 + messageQueueManager.ts:142-149)。
//
// 为什么必须 flat、不能按 conversationId 分区:async hook 常在【子代理】工具调用期间触发(子代理有独立
// conversationId=agentId、一次性、结束后没人再当主会话 drain),若按 conversationId 存 agentId,子代理触发的
// 唤醒会永久沉底(审查逮到的真丢消息)。flat 队列让任何来源的唤醒都进同一队列、由下一个主循环 drain,不丢。
//
// 生命周期:队列由"主循环每回合起点必 drain"兜底清空;桌面单用户主活跃会话通常唯一,不会无界增长。
// 多会话并行时唤醒可能被另一活跃会话 drain(串会话)——与 cc 进程唯一队列同款取舍,消息带事件名不致误解,可接受。

const pendingWakes: string[] = []

/** 后台 async hook(asyncRewake)完成后把唤醒消息入进程级 flat 队列,等下一个主循环 drain。不分会话(对齐 cc)。 */
export function pushAsyncHookWake(message: string): void {
  pendingWakes.push(message)
}

/** 取走并清空全部积压的 async hook 唤醒消息(FIFO)。主循环每回合起点调用,作 system-reminder 注入。 */
export function drainAsyncHookWakes(): string[] {
  if (pendingWakes.length === 0) return []
  return pendingWakes.splice(0)
}

/** 测试用:清空全部积压。 */
export function clearAsyncHookWakes(): void {
  pendingWakes.length = 0
}
