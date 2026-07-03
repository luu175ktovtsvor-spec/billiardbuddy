// preload:用 contextBridge 把【白名单】原生能力暴露成 window.electron.*
// 渲染层(web 前端)只能调这些函数,拿不到 Node/ipcRenderer 本体。
// web 前端检测 window.electron 存在 → 启用"发布/剪辑"入口;浏览器版没有它,自动隐藏。

const { contextBridge, ipcRenderer, webUtils } = require("electron");

// 事件订阅小工具:返回取消函数,组件卸载时调用,防泄漏
function on(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("electron", {
  // 桌面信息(前端据 isDesktop 决定显不显发布/剪辑入口)
  info: () => ipcRenderer.invoke("desktop:info"),
  newWindow: () => ipcRenderer.invoke("desktop:newWindow"),
  openStudio: () => ipcRenderer.invoke("desktop:openStudio"),
  openVideoStudio: () => ipcRenderer.invoke("desktop:openVideoStudio"),
  // M2 工作室成品同步：子窗报一声、其它窗口订阅刷新"最近作品"
  notifyStudioArtifact: (payload) => ipcRenderer.invoke("desktop:studioArtifact", payload),
  onStudioArtifact: (cb) => {
    const h = (_e, payload) => cb(payload);
    ipcRenderer.on("studio:artifact", h);
    return () => ipcRenderer.removeListener("studio:artifact", h);
  },
  captureScreen: () => ipcRenderer.invoke("desktop:captureScreen"),

  // ── 系统通知(跨平台原生通知 · F1b) ──
  // 渲染进程持久轮询后端通知中心(GET /api/v1/notifications?after=)，拿到新条目就调这里弹一条
  // 系统原生通知(mac 通知中心 / Windows Toast)；不支持/失败会走 { ok:false }，故障安全不抛异常。
  notification: {
    show: (opts) => ipcRenderer.invoke("notification:show", opts || {}),
  },

  // ── 开机自动启动(D-Task-4：定时任务要 app 开着才会跑) ──
  app: {
    getAutoLaunch: () => ipcRenderer.invoke("app:getAutoLaunch"),
    setAutoLaunch: (enabled) => ipcRenderer.invoke("app:setAutoLaunch", { enabled }),
  },

  // ── 口播模型按需下载(whisper 1.4G,首启后台下;下好前口播功能灰掉) ──
  models: {
    // 拿当前态 {phase:idle|downloading|ready|error, percent, error?}
    status: () => ipcRenderer.invoke("model:status"),
    // 下载失败后手动重试
    retry: () => ipcRenderer.invoke("model:retry"),
    // 订阅进度推送(返回取消订阅函数)
    onProgress: (cb) => on("model:progress", cb),
  },

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
    // 在系统文件管理器里定位/打开文件，保存后帮用户马上找得到。
    showInFolder: (path) => ipcRenderer.invoke("files:showInFolder", { path }),
    openPath: (path) => ipcRenderer.invoke("files:openPath", { path }),
    // 贴图/拖图：把粘贴/拖入的图片(base64)存临时文件，返回 { ok, path?, error? }；路径塞 selected_files 给 AI 看。
    saveTemp: (opts) => ipcRenderer.invoke("files:saveTemp", opts || {}),
    // Electron 33+ 移除了 File.path，用 webUtils.getPathForFile 替代：拖入/粘贴文件拿本机路径。
    getPathForFile: (file) => webUtils.getPathForFile(file),
    // C1 首启特例：扫 桌面+作品文件夹 找最近一份表格报表(只读文件名)，返回 { name, path } | null。
    scanReports: () => ipcRenderer.invoke("files:scanReports"),
  },
});
