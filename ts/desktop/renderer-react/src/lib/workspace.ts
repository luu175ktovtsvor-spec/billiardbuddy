// 选工作目录:店主用原生文件夹选择器指定"程序在哪读写/执行"。
// 侧栏"选目录"按钮 + 原生菜单「文件 → 选择工作区…」共用这一份(避免菜单变死按钮)。
//
// ⚠️ 对齐 cc-haha 模型:一个会话归属一个固定工作目录(transcript 按 cwd slug 分区)。所以——
//   · 当前会话还是空的(没对话记录)→ 就地把目录绑到它;
//   · 当前会话已经聊过了 → 换目录 = **开一个新会话**绑过去(对齐 cc「改目录 = branch 新会话」),
//     绝不原地改老会话的工作目录:否则后端会把它的 transcript 劈到另一个 projects/<slug>/ 目录、丢历史。
import { getDesktopHost } from './desktopHost'
import { useSettingsStore } from '../stores/settingsStore'
import { useFilePreviewStore } from '../stores/filePreviewStore'
import { useChatStore } from '../stores/chatStore'
import { useUiStore } from '../stores/uiStore'
import { useProjectStore } from '../stores/projectStore'
import { toast } from '../stores/toastStore'
import { openNewConversation } from './conversations'

/** 弹原生文件夹选择器 → 按 cc 模型绑到(空会话就地 / 有记录则开新会话)+ 重载右侧工作区面板。浏览器/无壳时提示走默认。 */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const host = getDesktopHost()
  if (!host.pickWorkspace) {
    toast('桌面版里可以选工作目录;当前用默认目录')
    useFilePreviewStore.getState().setPanelOpen(true)
    return null
  }
  const dir = await host.pickWorkspace({ defaultPath: useSettingsStore.getState().workspaceRoot ?? undefined })
  if (!dir) return null
  const folderName = dir.split(/[\\/]/).pop() || dir
  // 项目身份是用户选择的目录；先持久化，不能等首条消息创建会话后才出现在侧栏。
  useProjectStore.getState().remember(dir)
  // 当前会话已经有对话记录 → 换目录开新会话(避免劈裂老会话 transcript);空会话则就地绑。
  const hasHistory = useChatStore.getState().blocks.length > 0
  if (hasHistory) {
    openNewConversation() // 内部 startConversation → activateConversation(新会话),右侧视图也随之重置
    useSettingsStore.getState().setWorkspaceRoot(dir) // 绑到刚开的新会话
    toast(`已在新对话里打开「${folderName}」(原对话保留)`)
  } else {
    useSettingsStore.getState().setWorkspaceRoot(dir) // 空会话就地绑
    toast(`工作目录已设为:${folderName}`)
  }
  useUiStore.getState().setNav('chat')
  useFilePreviewStore.setState({ tree: null, tabs: [], activePath: null }) // 换目录后强制重载树(带新 working_dir)
  useFilePreviewStore.getState().setPanelOpen(true)
  useFilePreviewStore.getState().loadWorkspace()
  void useProjectStore.getState().refresh() // 合并后端已有会话统计，空项目仍由本地目录记录保留
  return dir
}
