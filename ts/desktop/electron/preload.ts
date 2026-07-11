import { contextBridge, ipcRenderer } from 'electron'

// contextBridge 白名单:前端从 location.host 直接连 sidecar;原生能力经白名单 IPC 暴露(§3.402 桌面壳架构:
// 只暴露显式列出的通道,不给渲染进程裸 ipcRenderer)。
contextBridge.exposeInMainWorld('desktopHost', {
  platform: process.platform,
  isDesktop: true,
  // 后端地址发现(对齐 cc DesktopHost.runtime.getServerUrl):React 壳(QF_UI_REACT)从 file:// 加载,
  // 经此 IPC 拿到 sidecar 地址再 fetch/WS。vanilla 默认路径不用它(走 same-origin),暴露无副作用。
  runtime: {
    getServerUrl: (): Promise<string> => ipcRenderer.invoke('runtime:getServerUrl'),
  },
  // 原生文件夹选择器(§7 选择工作区):无 payload,返回目录路径或 null。
  pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke('desktop:pickWorkspace'),
  // 原生视频文件多选(剪视频看板导入):返回视频绝对路径数组或 null。
  pickVideoFiles: (): Promise<string[] | null> => ipcRenderer.invoke('desktop:pickVideoFiles'),
  // 原生「文件和文件夹」多选(对话框附件):返回选中路径数组或 null。
  pickPaths: (): Promise<string[] | null> => ipcRenderer.invoke('desktop:pickPaths'),
  // 原生菜单动作回渲染进程(§8 菜单):目前只有"选择工作区";白名单单向 main→renderer。
  onMenu: (cb: (action: string) => void): void => {
    ipcRenderer.on('desktop:menu', (_e, action: string) => cb(action))
  },
  // 防休眠:长任务(生图/渲染/长 agent 循环)开始时 start()、结束时 stop(),阻止系统睡眠打断任务。
  // 引用计数式,支持并发多个长任务,务必成对调用(每个 start 对应一个 stop)。返回当前是否正在防睡。
  preventSleep: {
    start: (): Promise<boolean> => ipcRenderer.invoke('desktop:preventSleep:start'),
    stop: (): Promise<boolean> => ipcRenderer.invoke('desktop:preventSleep:stop'),
  },
})
