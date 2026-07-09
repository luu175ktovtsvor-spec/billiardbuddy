#!/usr/bin/env node
/**
 * 球房管家 · 桌面全栈 E2E 驱动骨架(playwright-electron)
 * 框架已通:启动当前分支 dev 版 app → 逐检查点跑前端断言+截图+后端证据 → 自动归因 → 写 manifest。
 * 具体测试用例(检查点)往下方 CHECKPOINTS 数组补;现在放了 app-boot 一个占位样板。
 * 用法: cd ts && bun run ui:build && bun run desktop:build && node ../.claude/skills/billiardbuddy-desktop-e2e/run.mjs
 */
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(__dirname, '../../..')                 // 仓库根
const TS = join(REPO, 'ts')
const MAIN = join(TS, 'desktop/electron/main.mjs')          // desktop:build 产物
const RENDERER = join(TS, 'desktop/renderer-dist/index.html') // ui:build 产物(QF_UI_REACT 要它)
const OUT = join(TS, 'test-results')
const SCENARIO = 'smoke'

// --- playwright(用本地已装的) ---
let _electron
try { ({ _electron } = await import('playwright')) }
catch { console.error('× 缺 playwright。装: cd ts && bun add -d playwright'); process.exit(2) }

// --- 前置:必须先 build 当前分支(别测装机版旧编译) ---
for (const [p, hint] of [[MAIN, 'bun run desktop:build'], [RENDERER, 'bun run ui:build']]) {
  if (!existsSync(p)) { console.error(`× 缺 ${p}\n  先在 ts/ 跑: ${hint}`); process.exit(2) }
}
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true })

// ================= 检查点(测试用例)——以后往这里补 =================
const CHECKPOINTS = [
  {
    name: 'app-boot',
    expectation: 'app 启动后主窗口可见、React 根节点渲染出内容(非白屏)',
    async run(ctx) {
      let frontendPass = false, note = ''
      try {
        await ctx.window.waitForLoadState('domcontentloaded', { timeout: 15000 })
        // TODO 换成真实选择器(如主对话框容器 data-testid);现在只验非白屏
        const bodyText = await ctx.window.locator('body').innerText().catch(() => '')
        const winVisible = await ctx.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
        frontendPass = winVisible && bodyText.trim().length > 0
        note = `窗口可见=${winVisible}, body 文本长度=${bodyText.trim().length}`
      } catch (e) { note = `前端异常: ${e.message}` }
      await ctx.shot('app-boot')
      const backendOk = await ctx.backend.healthy()   // sidecar 健康检查
      return { frontendPass, backendOk, note }
    },
  },
  // TODO 补: 发消息→流式回显 / 斜杠面板列命令(含 /台球) / 工具卡展开看 diff / 生图工作台出图 ...
]

// ================= driver 主体(框架,一般不用改) =================
function attribute(fe, be) {
  if (fe && be) return 'ok'
  if (!fe && be) return 'frontend-or-transport'          // 后端做了、前端没渲染
  if (!fe && !be) return 'backend'
  return 'transport-or-false-success'                    // 前端"成功"但后端报错,重点查
}

async function getSidecarBase(app) {
  // main.ts 起 sidecar 用 reserveServerPort 动态端口;React 壳经 IPC 拿地址(见 main.ts:~299)。
  // TODO(接后端证据): 确认 main.ts 暴露 sidecar url 的确切方式,三选一:
  //  (a) 起前设 env 固定端口,直连 http://127.0.0.1:<port>;
  //  (b) app.evaluate 读主进程存的 url(下面先试 globalThis.__QF_SIDECAR_URL__);
  //  (c) 在 renderer evaluate preload 暴露的 getServerUrl()。
  try {
    const base = await app.evaluate(() => globalThis.__QF_SIDECAR_URL__ ?? null)
    if (base) return base
  } catch {}
  return process.env.QF_SERVER_PORT ? `http://127.0.0.1:${process.env.QF_SERVER_PORT}` : null
}

async function main() {
  const app = await _electron.launch({ args: [MAIN], env: { ...process.env, QF_UI_REACT: '1' } })
  const window = await app.firstWindow()
  const sidecarBase = await getSidecarBase(app)
  const backend = {
    base: sidecarBase,
    async healthy() {
      if (!sidecarBase) return false            // 拿不到基址=后端证据未接(见 getSidecarBase TODO)
      try { return (await fetch(`${sidecarBase}/healthz`)).ok } catch { return false }
    },
    async api(path) {
      if (!sidecarBase) return null
      try { return await (await fetch(`${sidecarBase}${path}`)).json() } catch { return null }
    },
  }
  const shot = (name) => window.screenshot({ path: join(OUT, `${SCENARIO}__${name}.png`) })

  const results = []
  for (const cp of CHECKPOINTS) {
    let r
    try { r = await cp.run({ app, window, backend, shot }) }
    catch (e) { r = { frontendPass: false, backendOk: false, note: `检查点抛错: ${e.message}` } }
    results.push({
      name: cp.name, expectation: cp.expectation,
      frontendPass: r.frontendPass, backendOk: r.backendOk,
      attribution: attribute(r.frontendPass, r.backendOk),
      note: r.note ?? '', screenshot: `${SCENARIO}__${cp.name}.png`,
    })
  }

  writeFileSync(join(OUT, 'manifest.json'),
    JSON.stringify({ scenario: SCENARIO, sidecarBase, checkpoints: results }, null, 2))
  await app.close()

  console.log(`\n=== E2E 骨架跑完 → ${OUT} ===`)
  for (const r of results)
    console.log(`  [${r.attribution}] ${r.name}: 前端=${r.frontendPass} 后端=${r.backendOk} — ${r.note}`)
  console.log('\n下一步: Claude 用 Read 看 test-results/*.png 做视觉判断;往 CHECKPOINTS 补真实用例。')
}

main().catch((e) => { console.error(e); process.exit(1) })
