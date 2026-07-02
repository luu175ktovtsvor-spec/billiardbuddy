// 自动更新（electron-updater）。
//
// 发布源 = package.json build.publish 的 generic 私服（https://zzyppz.cn/desktop/）。
// CI 在 Windows 云机出包后，把安装包 + latest.yml 传到该目录；客户端启动时拉 latest.yml 比对版本。
// 全量更新（不做差量）。Mac 自动更新需签名 → Mac 暂缓时此模块在 mac 上静默跳过。
//
// 设计原则:
// - 只在打包后(app.isPackaged)生效;dev 直接 return,不打扰开发。
// - electron-updater 用 try/catch 包 require:dev 没装该依赖也不崩(CI/打包时才装)。
// - 不阻塞启动:静默后台查,查到新版弹无模态提示,下载完再问"重启更新"。用户拒绝不打断使用。

const { dialog } = require("electron");

let _started = false;

function init({ app, getWindow, onLog }) {
  if (_started) return;
  _started = true;
  const log = (s) => onLog && onLog(`[updater] ${s}\n`);

  // 仅打包后生效;dev/未打包直接跳过。
  if (!app.isPackaged) { log("dev 未打包,跳过自动更新"); return; }
  // Mac 未签名无法自动更新(Squirrel.Mac 硬要求),暂缓阶段直接跳过,避免报错。
  if (process.platform === "darwin") { log("mac 未签名,暂跳过自动更新"); return; }

  let autoUpdater;
  try {
    ({ autoUpdater } = require("electron-updater"));
  } catch (e) {
    log(`electron-updater 未安装,跳过:${e.message}`);
    return;
  }

  autoUpdater.autoDownload = true;          // 查到就后台下,不打扰
  autoUpdater.autoInstallOnAppQuit = true;  // 用户拒绝立即重启时,退出 app 时自动装
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

  autoUpdater.on("update-available", (info) => log(`发现新版 ${info.version},后台下载中…`));
  autoUpdater.on("update-not-available", () => log("已是最新版"));
  autoUpdater.on("error", (err) => log(`更新检查出错(忽略,不影响使用):${err && err.message}`));
  autoUpdater.on("download-progress", (p) => log(`下载 ${Math.round(p.percent)}%`));

  autoUpdater.on("update-downloaded", async (info) => {
    log(`新版 ${info.version} 已下载`);
    const win = getWindow && getWindow();
    const { response } = await dialog.showMessageBox(win || undefined, {
      type: "info",
      buttons: ["立即重启更新", "下次启动再更新"],
      defaultId: 0,
      cancelId: 1,
      title: "有新版本",
      message: `台球运营助手 ${info.version} 已下载完成`,
      detail: "重启后即可用上新版本。也可以稍后退出软件时自动更新。",
    });
    if (response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
  });

  // 启动后台查一次(不 await,不阻塞)。失败已被 error 事件吞掉。
  autoUpdater.checkForUpdates().catch((e) => log(`检查失败(忽略):${e && e.message}`));
}

module.exports = { init };
