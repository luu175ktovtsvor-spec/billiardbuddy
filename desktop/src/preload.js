// preload:用 contextBridge 把【白名单】原生能力暴露成 window.electron.*
// 渲染层(web 前端)只能调这些函数,拿不到 Node/ipcRenderer 本体。
// web 前端检测 window.electron 存在 → 启用"发布/剪辑"入口;浏览器版没有它,自动隐藏。

const { contextBridge, ipcRenderer } = require("electron");

// 事件订阅小工具:返回取消函数,组件卸载时调用,防泄漏
function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("electron", {
  // 桌面信息(前端据 isDesktop 决定显不显发布/剪辑入口)
  info: () => ipcRenderer.invoke("desktop:info"),

  // ── 发布(RPA · 半自动 · 扫码登录 · 人点确认才发) ──
  publish: {
    platforms: () => ipcRenderer.invoke("publish:platforms"),
    startLogin: (platform) => ipcRenderer.invoke("publish:login:start", { platform }),
    checkLogin: (platform) => ipcRenderer.invoke("publish:login:check", { platform }),
    post: (platform, content) => ipcRenderer.invoke("publish:post", { platform, content }),
    // 事件:二维码就绪 / 登录状态 / 发布进度
    onQrcode: (cb) => on("publish:login:qrcode", cb),
    onLoginStatus: (cb) => on("publish:login:status", cb),
    onProgress: (cb) => on("publish:progress", cb),
  },

  // ── 视频剪辑(ffmpeg) ──
  video: {
    probe: (inputPath) => ipcRenderer.invoke("video:probe", { inputPath }),
    run: (op, args) => ipcRenderer.invoke("video:run", { op, args }),
    onProgress: (cb) => on("video:progress", cb),
  },
});
