import { contextBridge } from 'electron'

// 最小 contextBridge:前端从 location.host 直接连 sidecar,暂只暴露平台信息供未来原生能力(通知/文件对话框等)扩展。
// 后续 IPC 通道(集中白名单 + payload 校验)按 §3.402 桌面壳架构逐步补。
contextBridge.exposeInMainWorld('desktopHost', {
  platform: process.platform,
  isDesktop: true,
})
