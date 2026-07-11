// 跨请求(chat/reject/execute 各自独立 HTTP)的「本次对话都允许」记忆,按 conversationId 存进程内。
// 语义 = 老板点过「本次对话都允许」的动作,后续同参数自动放行(对齐 cc 会话级 allow)。
// 全故障安全:异常吞掉、退化成"无历史"。
//
// ⚠️ 2026-07-12 按 owner 拍板对齐 cc:**移除了"拒够 N 次就静默拒答"的拒绝计数机制**(cc 的用户五档
// 根本没有这套,只在 ant-only auto 模式才有)。项目里"不放行/静默拒答"这类限制没必要——审批就是审批,
// 老板拒了就拒了这一次,不攒计数、不自动替他永久拒答。只保留"本次对话都允许"的正向记忆。

import { stableStringify } from './canonical'

const MAX_CONVERSATIONS = 500

interface Bucket {
  approvedActions: Record<string, true>
}
export interface DenialTrackingState {
  approvedActions: Record<string, true>
}
const store = new Map<string, Bucket>()

export function createDenialTrackingState(): DenialTrackingState {
  return { approvedActions: {} }
}

export function actionKey(name: string, args: unknown): string {
  try {
    return `${name}:${stableStringify(args ?? {})}`
  } catch {
    // 故障安全:循环引用(sort 递归爆栈)/ BigInt 属性(JSON.stringify TypeError)等无法序列化 →
    // 返稳定回退,别抛进审批闸。刻意用 <unserializable> 而非 {},免得撞正当空参。
    return `${name}:<unserializable>`
  }
}

function bucket(conversationId: string | undefined): Bucket | null {
  if (!conversationId) return null
  let b = store.get(conversationId)
  if (!b) {
    if (store.size >= MAX_CONVERSATIONS) {
      const oldest = store.keys().next().value // Map 插入序,淘汰最旧
      if (oldest !== undefined) store.delete(oldest)
    }
    b = { approvedActions: {} }
    store.set(conversationId, b)
  }
  return b
}

export function recordApproval(conversationId: string | undefined, key: string): void {
  try {
    const b = bucket(conversationId)
    if (!b) return
    b.approvedActions[key] = true
  } catch {
    /* 故障安全:记住审批失败不拖垮执行 */
  }
}

export function recordLocalApproval(state: DenialTrackingState, key: string): void {
  try {
    state.approvedActions[key] = true
  } catch {
    /* 故障安全 */
  }
}

export function clearApproval(conversationId: string | undefined, key: string): void {
  try {
    const b = conversationId ? store.get(conversationId) : undefined
    if (!b) return
    delete b.approvedActions[key]
  } catch {
    /* 故障安全 */
  }
}

export function clearLocalApproval(state: DenialTrackingState, key: string): void {
  try {
    delete state.approvedActions[key]
  } catch {
    /* 故障安全 */
  }
}

export function shouldAutoApprove(conversationId: string | undefined, key: string): boolean {
  try {
    const b = conversationId ? store.get(conversationId) : undefined
    if (!b) return false
    return b.approvedActions[key] === true
  } catch {
    return false
  }
}

export function shouldLocalAutoApprove(state: DenialTrackingState, key: string): boolean {
  try {
    return state.approvedActions[key] === true
  } catch {
    return false
  }
}

/** 仅测试用:清空进程内记忆,保证用例互不串。 */
export function resetDenialStore(): void {
  store.clear()
}
