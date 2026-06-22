/**
 * Playwright-Electron 冒烟回归（DOM 驱动，替代坐标点击的 desktop-control）。
 *
 * 为什么用它：坐标点击太飘（齿轮点偏、面板时序不稳）；Playwright 直接按 DOM 选择器
 * 操作，稳定可复现，适合每次改前端后跑一遍门面/登录/关键元素是否正常。
 *
 * 跑法：先确保 8077/3100 没被别的后端占用（app 会起自己的）。
 *   node desktop/e2e/smoke-electron.js
 * 产出：/tmp/_pw_门面.png 截图 + 控制台断言结果。
 *
 * 注：测的是 dist/ 里打包好的 .app。改了前端要先重打包，这里才看得到新文案。
 */
const path = require("path");
const { _electron: electron } = require(path.join(__dirname, "..", "..", "web", "node_modules", "playwright"));

const APP = path.join(__dirname, "..", "dist", "mac-arm64", "台球运营管家.app", "Contents", "MacOS", "台球运营管家");

(async () => {
  console.log("启动打包 app…");
  const app = await electron.launch({ executablePath: APP });
  const win = await app.firstWindow({ timeout: 90000 });
  console.log("窗口标题:", await win.title());

  // 等后端(8077)+前端(3100)起来、页面加载
  await win.waitForTimeout(18000);

  // 若在登录页 → 用测试账号登录（DOM 填表，稳）
  const phone = win.locator('input[placeholder*="手机"]');
  if (await phone.count()) {
    console.log("检测到登录页 → 登录");
    await phone.first().fill("13900000001");
    await win.locator('input[type="password"], input[placeholder*="密码"]').first().fill("test123456");
    await win.locator('button:has-text("登录")').first().click();
    await win.waitForTimeout(7000);
  }

  await win.screenshot({ path: "/tmp/_pw_门面.png" });

  // 门面关键元素断言
  const checks = {
    "门面·新会话": await win.locator("text=新会话").count(),
    "输入框": await win.locator("textarea, [contenteditable]").count(),
    "知识库按钮": await win.locator('button:has-text("知识库")').count(),
    "起手卡·朋友圈": await win.locator("text=朋友圈").count(),
  };
  for (const [k, v] of Object.entries(checks)) console.log(`  ${k}: ${v > 0 ? "✓" : "✗ 未找到"}`);

  // 打印知识库按钮文字（看是不是新文案"台球运营知识库"）
  const kb = win.locator('button:has-text("知识库")').first();
  if (await kb.count()) console.log("知识库按钮文字:", (await kb.innerText()).replace(/\s+/g, " ").trim());

  await app.close();
  console.log("✅ Playwright-Electron 冒烟跑通");
})().catch((e) => {
  console.error("❌ 出错:", e.message);
  process.exit(1);
});
