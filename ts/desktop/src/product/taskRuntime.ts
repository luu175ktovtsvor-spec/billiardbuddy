export type ProductTaskRuntimeState =
  | 'not_connected'
  | 'connecting'
  | 'awaiting_approval'
  | 'running'
  | 'needs_attention'
  | 'idle'

export const PRODUCT_TASK_RUNTIME_LABEL: Record<ProductTaskRuntimeState, string> = {
  not_connected: '未连接',
  connecting: '正在连接',
  awaiting_approval: '等待确认',
  running: '运行中',
  needs_attention: '需要处理',
  idle: '空闲',
}

export type ProductTaskStreamRuntime = {
  connectionState: 'disconnected' | 'connecting' | 'connected'
  runState: 'idle' | 'working' | 'awaiting_approval'
  pendingApproval: unknown | null
  error: unknown | null
}

/**
 * Product task pages own their stream state. Keep the task index on this
 * narrow contract instead of reaching through unrelated conversation state.
 */
export function getProductTaskRuntimeStateFromStream(
  runtime: ProductTaskStreamRuntime | undefined,
): ProductTaskRuntimeState {
  if (!runtime || runtime.connectionState === 'disconnected') return 'not_connected'
  if (runtime.pendingApproval != null || runtime.runState === 'awaiting_approval') {
    return 'awaiting_approval'
  }
  if (runtime.error != null) return 'needs_attention'
  if (runtime.runState === 'working') return 'running'
  if (runtime.connectionState === 'connecting') return 'connecting'
  return 'idle'
}
