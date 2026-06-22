/**
 * 桌面 App 端到端测试（Playwright 驱动【真 Electron 壳】，不是浏览器）。
 *
 * 在真正的桌面 App 里验证：真实登录 → 会话页渲染 → 切完全自主 → 发命令 → 终端式执行块（完整命令+输出+退出码）。
 * 这是「只有在桌面 App 上测过才放心」的那道关。
 *
 * 前置：先起好 后端(8077)/前端(3000)/mock 大模型(8090)，测试账号已配 BYOK→mock。
 *   DESKTOP_MANAGE_BACKEND=0 让 Electron 不自管后端（用我们起的）；DESKTOP_APP_URL 指向前端。
 * 跑：node desktop/test/desktop-agent.e2e.js
 */
const path = require("path");
const REPO = path.join(__dirname, "..", "..");
const { _electron: electron } = require(path.join(REPO, "web/node_modules/playwright"));
const electronPath = require(path.join(REPO, "desktop/node_modules/electron"));

const FRONTEND = process.env.DESKTOP_APP_URL || "http://localhost:3000";
const PHONE = process.env.E2E_PHONE || "13800138000";
const PASS = process.env.E2E_PASS || "test1234";

const fails = [];
const log = (...a) => console.log("[desktop-e2e]", ...a);
const check = (name, cond) => { if (cond) log("PASS:", name); else { log("FAIL:", name); fails.push(name); } };

async function main() {
  // 启动【真 Electron 桌面壳】（dev：连本地前端，后端用我们起的）
  const app = await electron.launch({
    executablePath: electronPath, args: ["."], cwd: path.join(REPO, "desktop"),
    env: { ...process.env, DESKTOP_MANAGE_BACKEND: "0", DESKTOP_MANAGE_FRONTEND: "0", DESKTOP_APP_URL: FRONTEND },
    timeout: 30000,
  });
  const win = await app.firstWindow({ timeout: 30000 });
  await win.waitForLoadState("domcontentloaded").catch(() => {});

  const isDesktop = await win.evaluate(() => !!window.electron);
  check("运行在真 Electron 桌面壳（window.electron 注入）", isDesktop);

  // 初始路由稳定：未登录→/login，已登录(localStorage 持久化)→/dashboard/chat
  await win.waitForTimeout(2000);
  if ((await win.locator("#phone").count()) > 0) {
    // 真实登录（在桌面 App 里走登录表单）
    await win.fill("#phone", PHONE);
    await win.fill("#password", PASS);
    await win.getByRole("button", { name: "登录" }).click();
    await win.waitForURL("**/dashboard/chat", { timeout: 20000 }).catch(() => {});
    log("已走登录表单");
  } else {
    log("已是登录态，跳过登录表单");
  }
  // 确保在会话页
  if (!win.url().includes("/dashboard/chat")) {
    await win.goto(`${FRONTEND}/dashboard/chat`);
    await win.waitForLoadState("networkidle").catch(() => {});
  }

  // 切权限=完全自主（让 run_command 自动执行），reload 使其生效
  await win.evaluate(() => localStorage.setItem("agent_permission_mode", "full"));
  await win.reload();
  await win.waitForLoadState("networkidle").catch(() => {});
  await win.waitForTimeout(1200);

  check("登录后进入会话页 /dashboard/chat", win.url().includes("/dashboard/chat"));
  const composer = win.getByPlaceholder("描述你要完成的任务…");
  check("桌面会话 UI 渲染（输入框在）", (await composer.count()) > 0);
  check("权限已切完全自主", (await win.getByRole("button", { name: "完全自主" }).count()) > 0);

  // 发命令 → 期待终端式执行块
  await composer.fill("列出 /tmp 目录里的文件");
  await composer.press("Enter");
  await win.waitForSelector("text=exit 0", { timeout: 30000 }).catch(() => {});
  const body = await win.locator("body").innerText().catch(() => "");
  check("命令终端块·退出码 exit 0", body.includes("exit 0"));
  check("命令终端块·命令原文 ls /tmp", body.includes("ls /tmp"));
  check("通用助手模式应答（通用 Agent，未 @ 知识库）", body.includes("通用助手模式"));

  await win.screenshot({ path: path.join(REPO, "verify-desktop-app.png") });
  log("截图 -> verify-desktop-app.png");
  await app.close();
}

main()
  .then(() => {
    if (fails.length) { console.log("[desktop-e2e] 结果：FAIL ->", fails.join("; ")); process.exit(1); }
    console.log("[desktop-e2e] 结果：全部通过 ✅"); process.exit(0);
  })
  .catch((e) => { console.log("[desktop-e2e] 异常:", (e && e.stack) || e); process.exit(2); });
