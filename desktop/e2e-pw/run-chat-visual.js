/**
 * 阶段0/1 + Task9 真机视觉验收(Playwright-Electron)——只截图不发对话(不污染、不烧钱)。
 * 看:首屏精简(Task8)、输入区精简(Task9·默认不露深度思考/输出风格)、深浅色开关(Task5)、字体(Task10)。
 * 跑法: node desktop/e2e-pw/run-chat-visual.js → test-results-studio/CHAT_*.png + manifest(Claude 看图判)
 */
const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..", "..");
const { _electron: electron } = require(path.join(REPO, "web", "node_modules", "playwright"));
const electronPath = require(path.join(REPO, "desktop", "node_modules", "electron"));
const RESULTS = path.join(__dirname, "test-results-studio");
const APP_URL = process.env.DESKTOP_APP_URL || "http://localhost:3100";
fs.mkdirSync(RESULTS, { recursive: true });
const manifest = [];
const log = (...a) => console.log("[chat-visual]", ...a);
async function shot(win, name, dom, pass) {
  await win.screenshot({ path: path.join(RESULTS, `${name}.png`) }).catch(() => {});
  manifest.push({ checkpoint: name, dom, 机器判定: pass ? "PASS" : "FAIL/待看图" });
  log(`  📸 ${name} | 机器:${pass ? "PASS" : "FAIL"} | ${JSON.stringify(dom)}`);
}
(async () => {
  const app = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: path.join(REPO, "desktop"),
    env: { ...process.env, DESKTOP_MANAGE_BACKEND: "0", DESKTOP_MANAGE_FRONTEND: "0", DESKTOP_APP_URL: APP_URL },
    timeout: 30000,
  });
  const win = await app.firstWindow({ timeout: 30000 });
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  await win.waitForTimeout(4000);

  // CHAT1: 首屏(Task8)+ 输入区(Task9 默认不露深度思考/输出风格)
  const c1 = {
    输入框: await win.locator('[placeholder*="要办的事"], textarea').count().catch(() => 0),
    附件: await win.locator('[aria-label="添加参考文件、图片或视频"]').count().catch(() => 0),
    运行权限: await win.locator('button:has-text("逐项确认"), button:has-text("自动接受修改"), button:has-text("跳过确认"), button:has-text("计划模式")').count().catch(() => 0),
    深度思考_默认隐藏: await win.locator('button:has-text("深度思考")').count().catch(() => 0),
    输出风格_默认隐藏: await win.locator('button:has-text("默认风格")').count().catch(() => 0),
    侧栏花费_默认隐藏: await win.locator("text=/本月 ≈/").count().catch(() => 0),
  };
  await shot(win, "CHAT1_首屏_输入区精简", c1,
    c1.输入框 > 0 && c1.附件 > 0 && c1.运行权限 > 0 && c1.深度思考_默认隐藏 === 0 && c1.输出风格_默认隐藏 === 0 && c1.侧栏花费_默认隐藏 === 0);

  // CHAT2: 深浅色开关(Task5)——开设置→点"暗"→<html> 应有 .dark
  await win.locator('button[aria-label="设置"]').last().click().catch(() => {});
  await win.waitForTimeout(1500);
  const hasAppearance = await win.locator("text=外观").count().catch(() => 0);
  await win.locator('button:has-text("暗")').first().click().catch(() => {});
  await win.waitForTimeout(800);
  const isDark = await win.evaluate(() => document.documentElement.classList.contains("dark")).catch(() => false);
  await shot(win, "CHAT2_深浅色_暗", { 外观开关: hasAppearance, html有dark类: isDark }, hasAppearance > 0 && isDark);
  // 切回跟随系统,别留暗
  await win.locator('button:has-text("跟随系统")').first().click().catch(() => {});
  await win.waitForTimeout(500);

  fs.writeFileSync(path.join(RESULTS, "manifest-chat.json"), JSON.stringify({ checkpoints: manifest }, null, 2));
  manifest.forEach((m) => log(`  ${m.checkpoint}: ${m.机器判定}`));
  await app.close();
})().catch((e) => { console.error("[chat-visual] ❌", (e && e.stack) || e); process.exit(1); });
