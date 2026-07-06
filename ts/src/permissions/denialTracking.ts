// 跨请求(chat/reject/execute 各自独立 HTTP)拒绝计数,按 conversationId 存进程内。
// 我们的语义 = 拒够了就"别再烦老板"(跟 cc-haha 的"回退去问人"相反)。全故障安全:异常吞掉、退化成"无历史拒绝"。

import { stableStringify } from './canonical'

export const DENIAL_FALLBACK = { perAction: 2, global: 20 } as const
const MAX_CONVERSATIONS = 500

interface Bucket {
  byAction: Record<string, number>
  total: number
}
const store = new Map<string, Bucket>()

export function actionKey(name: string, args: unknown): string {
  try {
    return `${name}:${stableStringify(args ?? {})}`
  } catch {
    // 故障安全:循环引用(sort 递归爆栈)/ BigInt 属性(JSON.stringify TypeError)等无法序列化 →
    // 返稳定回退,别抛进 Task 5 审批闸。刻意用 <unserializable> 而非 {},免得撞正当空参拒绝。
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
    b = { byAction: {}, total: 0 }
    store.set(conversationId, b)
  }
  return b
}

export function recordDenial(conversationId: string | undefined, key: string): void {
  try {
    const b = bucket(conversationId)
    if (!b) return
    b.byAction[key] = (b.byAction[key] ?? 0) + 1
    b.total += 1
  } catch {
    /* 故障安全:计数失败不拖垮审批 */
  }
}

export function clearDenial(conversationId: string | undefined, key: string): void {
  try {
    const b = conversationId ? store.get(conversationId) : undefined
    if (!b) return
    delete b.byAction[key]
    b.total = 0 // 老板在正常配合、解除全局回退锁,否则长会话零散攒够 20 会永久吞掉审批
  } catch {
    /* 故障安全 */
  }
}

export function shouldStopAsking(conversationId: string | undefined, key: string): boolean {
  try {
    const b = conversationId ? store.get(conversationId) : undefined
    if (!b) return false
    return b.total >= DENIAL_FALLBACK.global || (b.byAction[key] ?? 0) >= DENIAL_FALLBACK.perAction
  } catch {
    return false
  }
}

/** 仅测试用:清空进程内计数,保证用例互不串。 */
export function resetDenialStore(): void {
  store.clear()
}
