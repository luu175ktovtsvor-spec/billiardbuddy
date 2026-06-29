/**
 * 台球房真实使用场景·真机测试(用户视角)——从 scenarios.json 逐条跑,每条:新会话→打那句话→等结果→截图+抓回复文本。
 * 产出:test-results-scenarios/<n>_<who>.png + results.json(供 Claude 看图+读文,从老板/助教视角判好不好用)。
 * 跑法: node desktop/e2e-pw/run-scenarios.js  (读 desktop/e2e-pw/scenarios.json)
 * 可选: SCN_ONLY=3,7 只跑某几条; SCN_MAXWAIT=200 每条最多等秒数。
 */
const path = require("path");
const fs = require("fs");
const REPO = path.join(__dirname, "..", "..");
const { _electron: electron } = require(path.join(REPO, "web", "node_modules", "playwright"));
const electronPath = require(path.join(REPO, "desktop", "node_modules", "electron"));
const RESULTS = path.join(__dirname, "test-results-scenarios");
const APP_URL = process.env.DESKTOP_APP_URL || "http://localhost:3100";
const MAXWAIT = parseInt(process.env.SCN_MAXWAIT || "150", 10);
const ONLY = (process.env.SCN_ONLY || "").split(",").map(s => s.trim()).filter(Boolean);
fs.mkdirSync(RESULTS, { recursive: true });
const log = (...a) => console.log("[scenarios]", ...a);
const scenarios = JSON.parse(fs.readFileSync(path.join(__dirname, "scenarios.json"), "utf8"));

(async () => {
  const app = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: path.join(REPO, "desktop"),
    env: { ...process.env, DESKTOP_MANAGE_BACKEND: "0", DESKTOP_MANAGE_FRONTEND: "0", DESKTOP_APP_URL: APP_URL },
    timeout: 30000,
  });
  const win = await app.firstWindow({ timeout: 30000 });
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  await win.waitForTimeout(4000);
  const results = [];

  for (let idx = 0; idx < scenarios.length; idx++) {
    const sc = scenarios[idx];
    const n = sc.n || (idx + 1);
    if (ONLY.length && !ONLY.includes(String(n))) continue;
    log(`--- 场景${n} [${sc.who}] ${sc.say.slice(0, 30)}…`);
    // 新会话(干净起)
    await win.locator('button:has-text("新会话")').first().click().catch(() => {});
    await win.waitForTimeout(800);
    const box = win.locator('[placeholder*="要办的事"], textarea').first();
    await box.waitFor({ timeout: 15000 }).catch(() => {});
    await box.click().catch(() => {});
    await box.fill(sc.say).catch(() => {});
    await win.waitForTimeout(300);
    const t0 = Date.now();
    await box.press("Enter").catch(() => {});

    // 等结果:spinner("中断")消失 / 出现审批卡 / 出图 / 超时
    let how = "timeout";
    for (let i = 0; i < MAXWAIT; i++) {
      await win.waitForTimeout(1000);
      const spinning = await win.locator("text=中断").count().catch(() => 0);
      const approval = await win.locator('button:has-text("确认"), button:has-text("批准"), text=需要你确认').count().catch(() => 0);
      const img = await win.locator(".markdown img, img[src*='/uploads/']").count().catch(() => 0);
      if (i > 3 && approval > 0) { how = "approval_card"; break; }
      if (i > 3 && spinning === 0 && i > 6) { how = img > 0 ? "image" : "text"; break; }
    }
    const elapsed = Math.round((Date.now() - t0) / 1000);
    await win.waitForTimeout(500);
    const shot = `${String(n).padStart(2, "0")}_${(sc.who || "user").replace(/[^\w一-龥]/g, "")}.png`;
    await win.screenshot({ path: path.join(RESULTS, shot), fullPage: false }).catch(() => {});
    const replyText = await win.evaluate(() => {
      const sels = ['.markdown', '[class*="assistant"]', '[class*="message"]'];
      let nodes = [];
      for (const s of sels) { nodes = [...document.querySelectorAll(s)]; if (nodes.length) break; }
      return nodes.length ? (nodes[nodes.length - 1].innerText || "").slice(0, 600) : "(未抓到文本)";
    }).catch(() => "(读取失败)");
    log(`   结果=${how} 用时=${elapsed}s 截图=${shot}`);
    results.push({ n, who: sc.who, theme: sc.theme, say: sc.say, expect: sc.expect, how, elapsed, shot, replyText });
    fs.writeFileSync(path.join(RESULTS, "results.json"), JSON.stringify(results, null, 2));
  }
  log(`完成 ${results.length} 条 → ${RESULTS}/results.json`);
  await app.close();
})().catch((e) => { console.error("[scenarios] ❌", (e && e.stack) || e); process.exit(1); });
