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
    // 发布功能是否可用(发布内核存在或本机有 python3)。前端显入口前先问。
    available: () => ipcRenderer.invoke("publish:available"),
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

  // ── 本地文件(让 AI"长在电脑上":选定文件→授权 Agent 读/改) ──
  files: {
    // 弹系统文件选择器,返回 { canceled, paths: [绝对路径] }。
    // 选定的文件随对话以 selected_files 传给后端,Agent 才被授权读/改它(沙箱机制)。
    pick: (opts) => ipcRenderer.invoke("files:pick", opts || {}),
    // 系统「另存为」：把成品(base64)写到老板选的位置，返回 { canceled, path?, error? }。
    save: (opts) => ipcRenderer.invoke("files:save", opts || {}),
  },
});
