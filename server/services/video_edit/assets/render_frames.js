// V2 模板渲染器(Phase 1):Playwright 驱动 Chromium 逐帧渲染同目录 template.html。
// 用法: node render_frames.js <manifest.json> <outDir>
// Phase 2 打包时改走 Electron 自带的离屏 BrowserWindow(见开发文档 §8),此脚本作 dev/回退。
// playwright 从 web/node_modules 解析(env PLAYWRIGHT_DIR 可覆盖);仓库根 = 本文件往上 5 层。
const path = require('path');
const fs = require('fs');

function loadChromium() {
  const candidates = [
    process.env.PLAYWRIGHT_DIR,
    path.resolve(__dirname, '../../../../web/node_modules/playwright'),
    'playwright',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c).chromium; } catch (_) { /* try next */ }
  }
  throw new Error('找不到 playwright(设 env PLAYWRIGHT_DIR 或在 web 装 playwright)');
}

(async () => {
  const manifestPath = process.argv[2], outDir = process.argv[3];
  if (!manifestPath || !outDir) { console.error('用法: node render_frames.js <manifest> <outDir>'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(outDir)) fs.unlinkSync(path.join(outDir, f));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const { width, height, totalFrames } = manifest;

  const chromium = loadChromium();
  const browser = await chromium.launch({ args: ['--allow-file-access-from-files', '--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(__dirname, 'template.html'));
  await page.evaluate((m) => window.init(m), manifest);
  await page.evaluate(() => document.fonts.ready);
  for (let f = 0; f < totalFrames; f++) {
    await page.evaluate((f) => window.renderFrame(f), f);
    // JPEG(q92)比 PNG 截图快约一倍;成片视觉无损。导出是一次性动作,这已够。
    await page.screenshot({ path: path.join(outDir, 'f_' + String(f).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 92 });
  }
  await browser.close();
  console.log('rendered ' + totalFrames + ' frames');
})().catch((e) => { console.error(e); process.exit(1); });
