// 会话开合的编排小助手(把 tabStore + chatStore 串起来,避免组件里到处 prop 传递)。
import { useChatStore } from '../stores/chatStore'
import { useTabStore } from '../stores/tabStore'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useFilePreviewStore } from '../stores/filePreviewStore'
import { rememberLastConversation } from './sessionRecovery'

function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 切会话后同步右侧工作区视图:不同会话工作目录不同,旧的文件树/打开的文件 tab 都是上个目录的,要清掉重取,
 * 否则会显示别的会话的文件夹(与按会话隔离的工作目录冲突)。tabs 里是绝对路径、跨目录无意义,一并清。
 */
function syncWorkspaceView(): void {
  const fp = useFilePreviewStore.getState()
  useFilePreviewStore.setState({ tree: null, git: null, root: null, tabs: [], activePath: null })
  if (fp.panelOpen) fp.loadWorkspace() // 面板开着才立刻重载(读的是刚切好的 activeConv 工作目录)
}

/** 开一个全新会话(新 conversationId + 新 tab + 起 WS)。 */
export function openNewConversation(): string {
  const id = genId()
  useTabStore.getState().openSession(id, '新对话')
  useChatStore.getState().startConversation(id) // 内部会 activateConversation(id)
  syncWorkspaceView()
  rememberLastConversation(id) // 记为"上次活跃",下次启动可恢复
  return id
}

/** 在指定项目(工作目录)里开新会话(对齐 Codex 侧栏项目组的 newThreadInGroup):
 *  新会话 + 绑定该目录(此刻 activeConvId=新会话,setWorkspaceRoot 落 per-conv 映射) + 右侧视图按新目录再同步。 */
export function openNewConversationInProject(root: string): string {
  const id = openNewConversation()
  useSettingsStore.getState().setWorkspaceRoot(root)
  syncWorkspaceView()
  return id
}

/** 打开已有会话:开/聚焦 tab + 起 WS 并请求历史事件重放。 */
export function openExistingConversation(id: string, title?: string): void {
  useTabStore.getState().openSession(id, title)
  useChatStore.getState().startConversation(id, { replay: true }) // 内部会 activateConversation(id)
  // 采纳后端记录的工作目录 + 挂件:本地还没记该会话时,用后端 meta 兜底(跨重启记得每个窗口的目录和开没开台球)。
  // ⚠️ 必须在这里 adopt——否则前端 per-conv 挂件为空,下一条消息会带空集合、误清后端持久化的挂件(见 settingsStore setEnabledPacks 的持久化)。
  const meta = useSessionStore.getState().sessions.find((s) => s.id === id)
  if (meta?.workspaceRoot) useSettingsStore.getState().adoptConversationWorkspace(id, meta.workspaceRoot)
  useSettingsStore.getState().adoptConversationPacks(id, meta?.enabledPacks)
  syncWorkspaceView() // adopt 之后再同步,右侧树读到的就是该会话自己的目录
  rememberLastConversation(id) // 记为"上次活跃",下次启动可恢复
}
