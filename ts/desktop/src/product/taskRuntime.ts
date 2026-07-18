import { hasRunningBackgroundTasks } from '../lib/backgroundTasks'
import type { PerSessionState } from '../stores/chatStore'
import type { Tab } from '../stores/tabStore'

export type ProductTaskRuntimeState =
  | 'not_connected'
  | 'connecting'
  | 'awaiting_approval'
  | 'running'
  | 'needs_attention'
  | 'idle'

export type ProductTaskSessionRuntime = Pick<
  PerSessionState,
  | 'chatState'
  | 'connectionState'
  | 'pendingPermission'
  | 'pendingComputerUsePermission'
  | 'backgroundAgentTasks'
>

export const PRODUCT_TASK_RUNTIME_LABEL: Record<ProductTaskRuntimeState, string> = {
  not_connected: '未连接',
  connecting: '正在连接',
  awaiting_approval: '等待确认',
  running: '运行中',
  needs_attention: '需要处理',
  idle: '空闲',
}

/**
 * This is a read-only projection of the Agent Core session. Product task
 * lifecycle and worktree provisioning deliberately stay outside this state.
 */
export function getProductTaskRuntimeState(
  session: ProductTaskSessionRuntime | undefined,
  tabStatus?: Tab['status'],
): ProductTaskRuntimeState {
  if (
    session?.chatState === 'permission_pending' ||
    session?.pendingPermission != null ||
    session?.pendingComputerUsePermission != null
  ) {
    return 'awaiting_approval'
  }

  if (
    (session && (session.chatState !== 'idle' || hasRunningBackgroundTasks(session.backgroundAgentTasks))) ||
    tabStatus === 'running'
  ) {
    return 'running'
  }

  if (tabStatus === 'error') return 'needs_attention'
  if (session?.connectionState === 'connecting' || session?.connectionState === 'reconnecting') return 'connecting'
  if (!session || session.connectionState === 'disconnected') return 'not_connected'
  return 'idle'
}
