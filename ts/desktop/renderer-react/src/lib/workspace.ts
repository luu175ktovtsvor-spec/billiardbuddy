// 选工作目录:店主用原生文件夹选择器指定"程序在哪读写/执行"。
// 侧栏"选目录"按钮 + 原生菜单「文件 → 选择工作区…」共用这一份(避免菜单变死按钮)。
import { getDesktopHost } from './desktopHost'
import { useSettingsStore } from '../stores/settingsStore'
import { useFilePreviewStore } from '../stores/filePreviewStore'
import { useUiStore } from '../stores/uiStore'
import { toast } from '../stores/toastStore'

/** 弹原生文件夹选择器 → 存工作目录 + 重载右侧工作区面板。浏览器/无壳时提示走默认。 */
export async function pickWorkspaceFolder(): Promise<void> {
  const host = getDesktopHost()
  if (!host.pickWorkspace) {
    toast('桌面版里可以选工作目录;当前用默认目录')
    useFilePreviewStore.getState().setPanelOpen(true)
    return
  }
  const dir = await host.pickWorkspace()
  if (!dir) return
  useSettingsStore.getState().setWorkspaceRoot(dir)
  useFilePreviewStore.setState({ tree: null }) // 换目录后强制重载树(带新 working_dir)
  useUiStore.getState().setNav('chat')
  useFilePreviewStore.getState().setPanelOpen(true)
  useFilePreviewStore.getState().loadWorkspace()
  toast(`工作目录已设为:${dir.split(/[\\/]/).pop() || dir}`)
}
