import { contextBridge, ipcRenderer } from 'electron'

// contextBridge 白名单:前端从 location.host 直接连 sidecar;原生能力经白名单 IPC 暴露(§3.402 桌面壳架构:
// 只暴露显式列出的通道,不给渲染进程裸 ipcRenderer)。
contextBridge.exposeInMainWorld('desktopHost', {
  platform: process.platform,
  isDesktop: true,
  // 原生文件夹选择器(§7 选择工作区):无 payload,返回目录路径或 null。
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('desktop:pickWorkspace'),
})
