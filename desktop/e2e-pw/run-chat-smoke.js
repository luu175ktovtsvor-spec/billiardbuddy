/**
 * 对话真机冒烟(merged main)——真 Electron 发一句、等回复渲染、截图。
 * 验:对话路径在真壳里能正常一问一答(且超时兜底在场不误伤正常对话)。
 * 跑法: node desktop/e2e-pw/run-chat-smoke.js → test-results-studio/CHATSMOKE_*.png
 */
const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..", "..");
const { _electron: electron } = require(path.join(REPO, "web", "node_modules", "playwright"));
const electronPath = require(path.join(REPO, "desktop", "node_modules", "electron"));
const RESULTS = path.join(__dirname, "test-results-studio");
const APP_URL = process.env.DESKTOP_APP_URL || "http://localhost:3100";
fs.mkdirSync(RESULTS, { recursive: true });
const log = (...a) => console.log("[chat-smoke]", ...a);
(async () => {
  const app = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: path.join(REPO, "desktop"),
    env: { ...process.env, DESKTOP_MANAGE_BACKEND: "0", DESKTOP_MANAGE_FRONTEND: "0", DESKTOP_APP_URL: APP_URL },
    timeout: 30000,
  });
  const win = await app.firstWindow({ timeout: 30000 });
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  await win.waitForTimeout(4000);

  const box = win.locator('[placeholder*="要办的事"], textarea').first();
  await box.waitFor({ timeout: 15000 });
  await box.click();
  await box.fill("用一句话回复:你好");
  await win.waitForTimeout(300);
  await box.press("Enter");
  log("已发送,等回复…");

  // 等流结束:spinner(含"中断")出现后消失,或最多 70s(超时兜底 150s 之内;模型健康约几秒)
  let settled = false;
  for (let i = 0; i < 70; i++) {
    await win.waitForTimeout(1000);
    const spinning = await win.locator("text=中断").count().catch(() => 0);
    const replied = await win.locator('[data-role="assistant"], .markdown').count().catch(() => 0);
    if (i > 2 && spinning === 0 && replied > 0) { settled = true; log(`流已结束(${i}s),有回复`); break; }
    if (i > 2 && spinning === 0 && i > 8) { settled = true; log(`流已结束(${i}s)`); break; }
  }
  await win.screenshot({ path: path.join(RESULTS, "CHATSMOKE_对话回复.png") }).catch(() => {});
  // 抓最后一条助手消息文本(给机器初判)
  const lastText = await win.evaluate(() => {
    const nodes = [...document.querySelectorAll('.markdown, [data-role="assistant"]')];
    return nodes.length ? (nodes[nodes.length - 1].innerText || "").slice(0, 120) : "(未找到助手消息)";
  }).catch(() => "(读取失败)");
  log("settled=" + settled + " | 末条助手消息:", JSON.stringify(lastText));
  fs.writeFileSync(path.join(RESULTS, "chatsmoke.json"), JSON.stringify({ settled, lastText }, null, 2));
  await app.close();
})().catch((e) => { console.error("[chat-smoke] ❌", (e && e.stack) || e); process.exit(1); });
