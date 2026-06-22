/** Playwright-Electron：打开设置抽屉，截图 + 抓文本，评 BYOK 配置对非技术店主的友好度。 */
const path = require("path");
const { _electron: electron } = require(path.join(__dirname, "..", "..", "web", "node_modules", "playwright"));
const APP = path.join(__dirname, "..", "dist", "mac-arm64", "台球运营管家.app", "Contents", "MacOS", "台球运营管家");

(async () => {
  const app = await electron.launch({ executablePath: APP });
  const win = await app.firstWindow({ timeout: 90000 });
  await win.waitForTimeout(18000);
  const phone = win.locator('input[placeholder*="手机"]');
  if (await phone.count()) {
    await phone.first().fill("13900000001");
    await win.locator('input[type="password"], input[placeholder*="密码"]').first().fill("test123456");
    await win.locator('button:has-text("登录")').first().click();
    await win.waitForTimeout(7000);
  }
  const gear = win.locator('[aria-label*="模型"]').first();
  if (!(await gear.count())) { console.log("✗ 没找到设置按钮"); await app.close(); return; }
  await gear.click();
  await win.waitForTimeout(7000);
  await win.screenshot({ path: "/tmp/_pw_set.png" });
  const text = await win.evaluate(() => document.body.innerText);
  console.log("=== 设置抽屉可见文本 ===\n" + text.slice(0, 1400));
  await app.close();
  console.log("\n✅ 设置抽屉已截图 /tmp/_pw_set.png");
})().catch((e) => { console.error("✗ 出错:", e.message); process.exit(1); });
