/**
 * 剪辑台专项 E2E(Playwright-Electron):真壳 + 真后端 + 真 whisper/ffmpeg。
 * 挂到已跑的 :3100 前端 + :8077 后端(DESKTOP_MANAGE_*=0)。原生文件对话框打桩成返回测试短片。
 * 跑法:node desktop/e2e-pw/run-video-studio.js
 * 产出:desktop/e2e-pw/test-results/VS__*.png(Claude 逐张看判)
 */
const path = require("path");
const fs = require("fs");

const REPO = path.join(__dirname, "..", "..");
const { _electron: electron } = require(path.join(REPO, "web", "node_modules", "playwright"));
const electronPath = require(path.join(REPO, "desktop", "node_modules", "electron"));

const RESULTS = path.join(__dirname, "test-results");
const APP_URL = process.env.DESKTOP_APP_URL || "http://localhost:3100";
const TEST_VIDEO = process.env.VS_TEST_VIDEO ||
  "/private/tmp/claude-502/-Users-swl-Desktop-----AI------/deeedb8b-3972-4b44-ba6f-d86b38e110aa/scratchpad/test8s.mp4";

fs.mkdirSync(RESULTS, { recursive: true });
const log = (...a) => console.log("[vs-e2e]", ...a);
const shot = async (win, name) => {
  const f = path.join(RESULTS, `VS__${name}.png`);
  await win.screenshot({ path: f });
  log(`📸 ${name}`);
};

(async () => {
  log(`启动 Electron(挂 ${APP_URL}),测试片 ${TEST_VIDEO}`);
  if (!fs.existsSync(TEST_VIDEO)) throw new Error("测试视频不存在: " + TEST_VIDEO);

  const app = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: path.join(REPO, "desktop"),
    env: { ...process.env, DESKTOP_MANAGE_BACKEND: "0", DESKTOP_MANAGE_FRONTEND: "0", DESKTOP_APP_URL: APP_URL },
    timeout: 30000,
  });
  // 原生文件对话框打桩 → 直接返回测试短片(Playwright 点不了原生弹窗)
  await app.evaluate(async ({ dialog }, videoPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [videoPath] });
  }, TEST_VIDEO);

  const win = await app.firstWindow({ timeout: 30000 });
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  await win.waitForTimeout(4000);
  const isDesktop = await win.evaluate(() => !!window.electron).catch(() => false);
  log("window.electron 注入:", isDesktop);
  win.on("console", (m) => { if (m.type() === "error") log("  [前端console.error]", m.text().slice(0, 200)); });
  win.on("pageerror", (e) => log("  [前端pageerror]", String(e).slice(0, 200)));
  const errBanner = async () => (await win.locator('.text-red-600, [class*="text-red"]').first().innerText().catch(() => "")) || "";

  // ① 打开剪辑台(slash 命令)
  const input = win.locator('textarea, [contenteditable="true"], [placeholder*="要办"]').first();
  await input.click();
  await input.fill("/剪辑台");
  await win.waitForTimeout(800);
  // 选中 palette 里的"剪辑台"项(点它;兜底按 Enter)
  const pal = win.locator('text=剪辑台').first();
  if (await pal.count()) await pal.click().catch(() => win.keyboard.press("Enter"));
  else await win.keyboard.press("Enter");
  await win.waitForTimeout(1500);
  await shot(win, "1_面板打开");
  const panelOpen = await win.locator("text=AI 剪辑台").count();
  log("面板打开:", panelOpen > 0);

  // ② 选视频(走打桩对话框)
  await win.locator('button:has-text("选本机视频")').first().click().catch(() => {});
  await win.waitForTimeout(2000);
  await shot(win, "2_已选视频");
  log("已选视频区出现:", await win.locator("text=已选").count());

  // ③ 理解素材(真 whisper,等候选出现)
  await win.locator('button:has-text("理解素材")').first().click().catch(() => {});
  log("理解素材中(真 whisper 转录,等候选片段)…");
  let candidateBtns = 0;
  for (let i = 0; i < 50; i++) {  // 最长 ~100s
    candidateBtns = await win.locator('button:has-text("s]")').count().catch(() => 0);
    const failed = await win.locator("text=/出错|失败|找不到/").count().catch(() => 0);
    if (candidateBtns > 0 || failed > 0) break;
    await win.waitForTimeout(2000);
  }
  await shot(win, "3_候选片段");
  log("候选片段按钮数:", candidateBtns, "| 错误banner:", await errBanner());

  // ④ 点两个候选进片
  const segs = win.locator('button:has-text("s]")');
  const n = await segs.count();
  if (n > 0) { await segs.nth(0).click().catch(() => {}); await win.waitForTimeout(1500); }
  if (n > 1) { await segs.nth(1).click().catch(() => {}); await win.waitForTimeout(1500); }
  await shot(win, "4_挑了片段");
  const myClips = await win.locator("text=我的片子").count();
  log("我的片子区出现:", myClips > 0);

  // ⑤ 自动配字幕
  await win.locator('button:has-text("自动配字幕")').first().click().catch(() => {});
  await win.waitForTimeout(4000);
  await shot(win, "5_配字幕后");

  // ⑥ 出片(真 ffmpeg,等 video 出现)
  await win.locator('button:has-text("出片")').last().click().catch(() => {});
  log("出片中(真 ffmpeg)…");
  let hasVideo = 0;
  for (let i = 0; i < 40; i++) {  // ~80s
    hasVideo = await win.locator("video").count().catch(() => 0);
    const failed = await win.locator("text=/出错|失败/").count().catch(() => 0);
    if (hasVideo > 0 || failed > 0) break;
    await win.waitForTimeout(2000);
  }
  await win.waitForTimeout(1500);
  await shot(win, "6_成片预览");
  log("成片 video 元素:", hasVideo > 0);

  const videoSrc = await win.locator("video").first().getAttribute("src").catch(() => null);
  log("成片 src:", videoSrc);

  fs.writeFileSync(path.join(RESULTS, "VS_summary.json"), JSON.stringify({
    isDesktop, panelOpen: panelOpen > 0, candidateBtns, myClips: myClips > 0, hasVideo: hasVideo > 0, videoSrc,
  }, null, 2));
  log("✅ 完成");
  await app.close();
})().catch((e) => { console.error("[vs-e2e] ❌", (e && e.stack) || e); process.exit(1); });
