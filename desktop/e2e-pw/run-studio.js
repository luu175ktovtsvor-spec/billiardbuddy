/**
 * 生成工作室 真机E2E(Playwright-for-Electron)——聚焦【浏览器 dev 测不到的 Electron 专属部分】:
 *   window.electron.files.saveTemp(局部改图存蒙版)、window.electron.video.run(多镜 ffmpeg 合成)是否真存在;
 *   工作室在真 Electron 壳里渲染、真出图、konva 蒙版画布加载真图。
 * 配套 skill: .claude/skills/fullstack-e2e。挂现成 :3100/:8077,不扰动。
 * 跑法: node desktop/e2e-pw/run-studio.js  → 产出 test-results-studio/*.png + manifest.json(Claude 看图判)
 */
const path = require("path");
const fs = require("fs");

const REPO = path.join(__dirname, "..", "..");
const { _electron: electron } = require(path.join(REPO, "web", "node_modules", "playwright"));
const electronPath = require(path.join(REPO, "desktop", "node_modules", "electron"));

const RESULTS = path.join(__dirname, "test-results-studio");
const APP_URL = process.env.DESKTOP_APP_URL || "http://localhost:3100";
fs.rmSync(RESULTS, { recursive: true, force: true });
fs.mkdirSync(RESULTS, { recursive: true });
const manifest = [];
const log = (...a) => console.log("[studio-e2e]", ...a);

async function shot(win, name, expectation, dom, machinePass) {
  const file = `${name}.png`.replace(/[^\w.一-龥-]/g, "_");
  await win.screenshot({ path: path.join(RESULTS, file) }).catch(() => {});
  manifest.push({ checkpoint: name, expectation, screenshot: file, dom, 机器判定: machinePass ? "PASS" : "FAIL/待看图", 视觉判定: `(待 Claude 看 ${file})` });
  log(`  📸 ${name} → ${file} | 机器:${machinePass ? "PASS" : "FAIL"}`);
}

(async () => {
  log(`启动 Playwright-Electron(挂 ${APP_URL})…`);
  const app = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: path.join(REPO, "desktop"),
    env: { ...process.env, DESKTOP_MANAGE_BACKEND: "0", DESKTOP_MANAGE_FRONTEND: "0", DESKTOP_APP_URL: APP_URL },
    timeout: 30000,
  });
  const win = await app.firstWindow({ timeout: 30000 });
  await win.waitForLoadState("domcontentloaded").catch(() => {});
  await win.waitForTimeout(3000);

  // 进生成工作室路由(独立窗口的页;这里直接在被驱动窗口里 goto 它)
  await win.goto(new URL("/dashboard/studio", APP_URL).toString(), { waitUntil: "domcontentloaded" }).catch(() => {});
  await win.waitForTimeout(2500);

  // C1: 工作室在真 Electron 渲染 + Electron 专属胶水(video.run / files.saveTemp)真存在
  const glue = await win.evaluate(() => ({
    hasElectron: !!window.electron,
    hasVideoRun: typeof window.electron?.video?.run === "function",
    hasSaveTemp: typeof window.electron?.files?.saveTemp === "function",
    hasFilesSave: typeof window.electron?.files?.save === "function",
  })).catch(() => ({}));
  const c1 = {
    ...glue,
    标题: await win.locator("text=生成工作室").count().catch(() => 0),
    提示词框: await win.locator('textarea[placeholder*="一句话说清楚"]').count().catch(() => 0),
    比例竖版: await win.locator('button:has-text("竖版 9:16")').count().catch(() => 0),
    出几版: await win.locator("text=出几版").count().catch(() => 0),
    生成按钮: await win.locator('button:has-text("生成")').count().catch(() => 0),
  };
  await shot(win, "C1_工作室渲染+Electron胶水", "真 Electron 壳里工作室正常渲染(标题/提示词框/比例/出几版/生成);window.electron.video.run 与 files.saveTemp 真存在(=多镜合成与局部改图的本机能力可用,这是浏览器 dev 验不到的关键)。",
    c1, c1.hasElectron && c1.hasVideoRun && c1.hasSaveTemp && c1.标题 > 0 && c1.提示词框 > 0 && c1.生成按钮 > 0);

  // C2: 真出图(点生成→等→图渲染)
  await win.locator('textarea[placeholder*="一句话说清楚"]').first().fill("做一张9:16台球之夜霓虹海报，醒目标题，给报名留白").catch(() => {});
  await win.waitForTimeout(300);
  await win.locator('button:has-text("生成")').first().click().catch(() => {});
  // 等出图(gpt-image-2 几十秒~几分钟);出图按钮变"出图中…",成图后中间 <img>
  let imaged = false;
  for (let i = 0; i < 90; i++) {
    await win.waitForTimeout(4000);
    imaged = (await win.locator('main img[alt="生成结果"]').count().catch(() => 0)) > 0;
    const failed = (await win.locator("text=/生成失败|红线|网络/").count().catch(() => 0)) > 0;
    if (imaged || failed) break;
  }
  const c2 = {
    成图: imaged,
    操控台_基于这张改: await win.locator("text=基于这张改").count().catch(() => 0),
    操控台_圈一块局部改: await win.locator('button:has-text("圈一块局部改")').count().catch(() => 0),
    操控台_做成视频: await win.locator('button:has-text("做成视频")').count().catch(() => 0),
  };
  await shot(win, "C2_真出图+操控台", "真 key 在工作室出一张 9:16 海报,中间显示图,右侧操控台出现 基于这张改/圈一块局部改/做成视频。",
    c2, c2.成图 && c2.操控台_圈一块局部改 > 0 && c2.操控台_做成视频 > 0);

  // C3: 进局部改图 → konva 蒙版画布加载真图
  if (imaged) {
    await win.locator('button:has-text("圈一块局部改")').first().click().catch(() => {});
    await win.waitForTimeout(2000);
    const c3 = {
      konva画布: await win.evaluate(() => document.querySelectorAll(".konvajs-content canvas").length).catch(() => 0),
      笔粗: await win.locator("text=笔粗").count().catch(() => 0),
      改这一块: await win.locator('button:has-text("改这一块")').count().catch(() => 0),
      提示: await win.locator("text=/在要改的地方涂一笔/").count().catch(() => 0),
    };
    await shot(win, "C3_局部改图konva画布", "点'圈一块局部改'后,中间出现 react-konva 蒙版画布(加载了刚出的真图)、笔粗滑块、'改这一块'按钮——证明 konva 在真 Electron 里渲染、局部改图链路就绪(存蒙版用 files.saveTemp,C1 已验存在)。",
      c3, c3.konva画布 > 0 && c3.笔粗 > 0 && c3.改这一块 > 0);
  }

  fs.writeFileSync(path.join(RESULTS, "manifest.json"), JSON.stringify({ checkpoints: manifest }, null, 2));
  log(`✅ 完成。截图+manifest 在 ${RESULTS}`);
  manifest.forEach((m) => log(`  ${m.checkpoint}: ${m.机器判定}`));
  await app.close();
})().catch((e) => { console.error("[studio-e2e] ❌", (e && e.stack) || e); process.exit(1); });
