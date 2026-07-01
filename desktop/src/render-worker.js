// V2 视频模板渲染 worker(离屏)—— 复用本 app 自带的 Chromium 逐帧渲染 template.html,
// 不额外打包 Playwright/第二个 Chromium(见开发文档 §8 方案A)。
// 由后端设 env QF_RENDER_MANIFEST / QF_RENDER_OUT 拉起本 app 的 electron 二进制触发(main.js 里守卫分支调用)。
// manifest 里带 template(html 绝对路径) + font + shots(每段帧目录) + 文案等。
const { BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

async function runRenderWorker(manifestPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) {
    try { fs.unlinkSync(path.join(outDir, f)); } catch { /* ignore */ }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const { width, height, totalFrames } = manifest;
  const templateHtml = manifest.template; // 后端传的 template.html 绝对路径

  const win = new BrowserWindow({
    width, height, show: false,
    webPreferences: { offscreen: true, sandbox: false, contextIsolation: false, nodeIntegration: false },
  });
  win.webContents.setFrameRate(60);
  await win.loadFile(templateHtml);
  await win.webContents.executeJavaScript(`window.init(${JSON.stringify(manifest)})`);
  await win.webContents.executeJavaScript(`document.fonts.ready.then(()=>true)`);

  for (let f = 0; f < totalFrames; f++) {
    // 渲染该帧 → 等图片 decode 完 → 再等两帧 rAF 确保已上屏,再截图(防截到未解码旧帧)
    await win.webContents.executeJavaScript(
      `Promise.resolve(window.renderFrame(${f})).then(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))`
    );
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, "f_" + String(f).padStart(5, "0") + ".jpg"), img.toJPEG(92));
  }
  win.destroy();
}

module.exports = { runRenderWorker };
