import { WorkspaceLayout } from './WorkspaceLayout'
import { ConversationColumn } from '../conversation/ConversationColumn'
import { WorkspaceColumn } from '../workspace3/WorkspaceColumn'
import { FileTreeColumn } from '../filetree/FileTreeColumn'
import { BottomTerminalDock } from './BottomTerminalDock'
import { ComputerUsePermissionModal } from '../chat/ComputerUsePermissionModal'
import { useSessionStore } from '../../stores/sessionStore'
import { useChatStore } from '../../stores/chatStore'

/**
 * 桌面会话主视图 = Codex 四栏的栏2/3/4 + 底部终端（railless）。
 *
 * 栏1（导航）由外壳 AppShell 的 Sidebar 承担，故此处不再重复 rail。
 * 活动会话由调用方（ContentRouter，源 = tabStore.activeTabId）传入 sessionId；
 * 各栏直接复用现有 chatStore / workspacePanelStore / terminalPanelStore（数据零改）。
 *
 * ⚠️ computer-use 权限弹窗随本视图挂载：ActiveSession 里的 ComputerUsePermissionModal
 * 是会话级 overlay，四栏转正后必须保留，否则 computer-use 授权交互会静默丢失。
 */
export function SessionWorkspace({ sessionId }: { sessionId: string }) {
  const workDir = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.workDir ?? undefined)
  const pendingComputerUse = useChatStore((s) => s.sessions[sessionId]?.pendingComputerUsePermission ?? null)

  return (
    <>
      <WorkspaceLayout
        conversation={<ConversationColumn sessionId={sessionId} />}
        workspace={<WorkspaceColumn sessionId={sessionId} />}
        fileTree={<FileTreeColumn sessionId={sessionId} />}
        terminal={<BottomTerminalDock sessionId={sessionId} cwd={workDir} />}
      />
      <ComputerUsePermissionModal sessionId={sessionId} request={pendingComputerUse?.request ?? null} />
    </>
  )
}
