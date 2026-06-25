/**
 * 全栈端到端测试驱动（Playwright-for-Electron + 后端日志/API + Claude 视觉判断）。
 * 取代 desktop/e2e/ 旧脚本。配套 skill: .claude/skills/fullstack-e2e/SKILL.md
 *
 * ── 为什么不是"纯 Playwright"──
 *   Playwright 只驱动【前端】(渲染进程 DOM)，看得到"界面卡住"却不知道后端干了啥 → 单边、会误判。
 *   真·端到端 + "把前后端问题拆开"，必须三边证据一起看：
 *     ① 前端：Playwright 查 DOM + electronApp.evaluate 查主进程 + 截图(交 Claude 视觉判断)
 *     ② 后端：读 qf-monitor.log 增量 + 直连 :8077 API（后端到底成没成）
 *     ③ 归因：前端失败 + 后端成功 = 前端/传输问题；前端失败 + 后端也失败 = 后端问题；都成 = 正常
 *   M1 实例：前端 spinner 卡死 + 后端日志"生图完成" → 归因=传输/前端(后端已出图、前端没渲染)，不是后端逻辑。
 *
 * 视觉判断【不调外部模型】：截图存盘 + 写清"应该是什么样"(expectation)，由 Claude 直接看截图判 {pass,reason}。
 * 不扰动装机版：挂到现成 :3100/:8077（DESKTOP_MANAGE_*=0 + DESKTOP_APP_URL），只另开一个被驱动的窗口。
 *
 * 跑法：node desktop/e2e-pw/run.js
 * 产出：desktop/e2e-pw/test-results/<场景>__<检查点>.png + manifest.json（前端断言 + 后端证据 + 归因 + 待 Claude 看图）
 */
const path = require("path");
const fs = require("fs");
const http = require("http");

const REPO = path.join(__dirname, "..", "..");
const { _electron: electron } = require(path.join(REPO, "web", "node_modules", "playwright"));
const electronPath = require(path.join(REPO, "desktop", "node_modules", "electron"));

const RESULTS = path.join(__dirname, "test-results");
const APP_URL = process.env.DESKTOP_APP_URL || "http://localhost:3100";
const BACKEND = process.env.DESKTOP_BACKEND_URL || "http://127.0.0.1:8077";
const LOG_FILE = process.env.BACKEND_LOG || path.join(process.env.HOME, "qf-monitor.log");

fs.rmSync(RESULTS, { recursive: true, force: true });
fs.mkdirSync(RESULTS, { recursive: true });
const manifest = [];
const log = (...a) => console.log("[fs-e2e]", ...a);

// ── 后端层 ──────────────────────────────────────────────
function logLineCount() {
  try { return fs.readFileSync(LOG_FILE, "utf8").split("\n").length; } catch { return 0; }
}
// 取后端日志自 sinceLine 起的"有意思"的行（生图/对话/模型/报错）
function backendLogDelta(sinceLine) {
  try {
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").slice(sinceLine);
    return lines.filter((l) => /生图|生视频|agent\/chat|xiaomimimo|39\.106|relay|ERROR|Error|Traceback|500|images/i.test(l))
      .map((l) => l.replace(/^\[backend\]\s*/, "").trim()).filter(Boolean).slice(-12);
  } catch { return []; }
}
function backendHealth() {
  return new Promise((res) => {
    const req = http.get(`${BACKEND}/api/v1/health`, (r) => { let b = ""; r.on("data", (d) => (b += d)); r.on("end", () => res({ ok: r.statusCode === 200, body: b.slice(0, 80) })); });
    req.on("error", (e) => res({ ok: false, body: String(e.code || e.message) }));
    req.setTimeout(3000, () => { req.destroy(); res({ ok: false, body: "timeout" }); });
  });
}
// 归因：前端通过/失败 × 后端是否有"成功完成"的迹象
function attribute(frontPass, backendLines, backendOk) {
  if (frontPass) return "正常";
  const ok = backendLines.join("\n");
  const backendSucceeded = /生图完成|生视频完成|agent\/chat HTTP\/1\.1" 200/.test(ok);
  const backendErrored = /ERROR|Traceback|500|" 4\d\d|" 5\d\d/.test(ok);
  if (backendSucceeded && !backendErrored) return "前端/传输（后端已完成/产出，前端未渲染或没收到）";
  if (backendErrored) return "后端（后端报错，见日志）";
  if (!backendOk) return "后端不可达/挂了";
  return "待人工拆分（后端日志无明确成功/失败迹象）";
}

// ── 前端层 ──────────────────────────────────────────────
async function checkpoint(win, scenario, name, expectation, front, backLogSince) {
  const file = `${scenario}__${name}.png`.replace(/[^\w.一-龥-]/g, "_");
  await win.screenshot({ path: path.join(RESULTS, file) });
  const backend = backendLogDelta(backLogSince);
  const health = await backendHealth();
  const verdict = attribute(front.machinePass, backend, health.ok);
  const entry = {
    scenario, checkpoint: name, expectation, screenshot: file,
    前端: { dom: front.dom, main: front.main || null, 机器判定: front.machinePass ? "PASS" : "FAIL/待看图" },
    后端: { health: health.ok ? "ok" : health.body, 日志增量: backend },
    归因: verdict,
    视觉判定: "（待 Claude 看 " + file + " 填 {pass, reason}）",
  };
  manifest.push(entry);
  log(`  📸 [${scenario}] ${name} → ${file}`);
  log(`     前端:${front.machinePass ? "PASS" : "FAIL"} | 后端health:${health.ok ? "ok" : health.body} | 归因:${verdict}`);
  if (backend.length) log(`     后端日志末行: ${backend[backend.length - 1].slice(0, 90)}`);
  return entry;
}

async function waitStreamSettle(win, maxMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const spinning = await win.locator("text=中断").count().catch(() => 0);
    if (!spinning) return { ended: true, waitedMs: Date.now() - t0 };
    await win.waitForTimeout(2000);
  }
  return { ended: false, waitedMs: Date.now() - t0 };
}
async function findInput(win) { return win.locator('[placeholder*="要办的事"], textarea, [contenteditable="true"]').first(); }
async function send(win, text) {
  const input = await findInput(win);
  await input.click();
  await input.fill(text).catch(async () => { await win.keyboard.type(text); });
  await win.waitForTimeout(300);
  await win.keyboard.press("Enter");
}
async function newChat(win) {
  const nc = win.locator('button:has-text("新会话")').first();
  if (await nc.count()) { await nc.click().catch(() => {}); await win.waitForTimeout(1200); }
}

(async () => {
  log(`启动 Playwright-Electron（挂 ${APP_URL}，后端 ${BACKEND}，日志 ${LOG_FILE}）…`);
  const app = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: path.join(REPO, "desktop"),
    env: { ...process.env, DESKTOP_MANAGE_BACKEND: "0", DESKTOP_MANAGE_FRONTEND: "0", DESKTOP_APP_URL: APP_URL },
    timeout: 30000,
  });
  const mainInfo = await app.evaluate(async ({ app, BrowserWindow }) => ({
    appName: app.getName(), version: app.getVersion(), isPackaged: app.isPackaged,
    windowCount: BrowserWindow.getAllWindows().length, electron: process.versions.electron, node: process.versions.node,
  }));
  log("主进程状态:", JSON.stringify(mainInfo));
  const win = await app.firstWindow({ timeout: 30000 });
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  await win.waitForTimeout(4000);
  const isDesktop = await win.evaluate(() => !!window.electron).catch(() => false);
  log("window.electron 注入(真桌面壳):", isDesktop, "| 后端直连:", (await backendHealth()).ok);

  // S1 门面（前端 DOM + 主进程 + 视觉；后端无关）
  log("S1 门面/欢迎页");
  await newChat(win);
  let since = logLineCount();
  const s1dom = {
    新会话: await win.locator("text=新会话").count(),
    输入框: await win.locator('textarea, [contenteditable="true"], [placeholder*="要办的事"]').count(),
    起始卡_做海报: await win.locator("text=做张拉新海报").count(),
  };
  await checkpoint(win, "S1门面", "欢迎页", "干净的新会话欢迎页：左侧「新会话」、中间大标题+一句话介绍、底部输入框+工具条(回形针/深度思考/权限/知识库)，可能有「今日建议」卡+4 张起始卡。不报错、无白屏。", { dom: s1dom, main: { windowCount: mainInfo.windowCount, isDesktop }, machinePass: s1dom.新会话 > 0 && s1dom.输入框 > 0 }, since);

  // S2 文字对话（对照组，前后端都该正常）
  log("S2 文字对话（对照）");
  since = logLineCount();
  await send(win, "用一句话介绍你能帮台球房老板做什么");
  const s2 = await waitStreamSettle(win, 60000);
  const s2dom = { 流结束: s2.ended, 等待ms: s2.waitedMs, 助手气泡: await win.locator(".markdown, .prose, [class*='assistant']").count().catch(() => -1), 仍在转圈: await win.locator("text=中断").count() };
  await checkpoint(win, "S2文字", "回复渲染", "用户那句话下面应渲染一段助手文字回复，spinner 消失。只剩转圈/空白=异常。", { dom: s2dom, main: null, machinePass: s2.ended && s2dom.助手气泡 > 0 }, since);

  // S3 做海报（M1：前端会卡，后端会出图 → 归因应为"前端/传输"）
  log("S3 做海报（复现 M1·验证前后端归因）");
  await newChat(win);
  since = logLineCount();
  await send(win, "做一张极简风格的台球馆开业海报，绿色调");
  const s3 = await waitStreamSettle(win, 100000);
  const s3dom = { 流结束: s3.ended, 等待ms: s3.waitedMs, 出现图片img: await win.locator('.markdown img, img[src*="uploads"], img[src*="posters"]').count().catch(() => -1), 仍在转圈: await win.locator("text=中断").count() };
  await checkpoint(win, "S3海报", "海报是否渲染", "理想：渲染出一张 AI 海报图。若长时间只有 spinner 无图=复现 M1。看图判断到底有没有图、还是空转。", { dom: s3dom, main: null, machinePass: s3dom.出现图片img > 0 && s3.ended }, since);

  fs.writeFileSync(path.join(RESULTS, "manifest.json"), JSON.stringify({ mainInfo, checkpoints: manifest }, null, 2));
  log(`✅ 完成。截图+manifest 在 ${RESULTS}`);
  manifest.forEach((m) => log(`  ${m.scenario}/${m.checkpoint}: 前端${m.前端.机器判定} | 归因=${m.归因}`));
  await app.close();
})().catch((e) => { console.error("[fs-e2e] ❌ 出错:", (e && e.stack) || e); process.exit(1); });
