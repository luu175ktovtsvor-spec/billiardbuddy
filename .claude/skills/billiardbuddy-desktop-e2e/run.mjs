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

// --- playwright(用 ts/ 里装的;ESM import 从本文件位置解析找不到 ts/node_modules,须 createRequire 锚定 ts/) ---
let _electron
try {
  const { createRequire } = await import('node:module')
  ;({ _electron } = createRequire(join(TS, 'package.json'))('playwright'))
} catch { console.error('× 缺 playwright。装: cd ts && bun add -d playwright'); process.exit(2) }

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
  {
    name: 'slash-popup',
    expectation: '输入 / 弹出命令浮层:真实命令(≥5 条,非 4 条 fallback)、「技能」分组标题、作用域灰字(系统/个人);后端 commands API 带 source+layer',
    async run(ctx) {
      let frontendPass = false, note = ''
      try {
        const input = ctx.window.locator('[data-testid="chat-input"]')
        await input.click()
        await input.fill('/')
        const panel = ctx.window.locator('[data-testid="token-panel"]')
        await panel.waitFor({ state: 'visible', timeout: 5000 })
        await ctx.window.waitForTimeout(400) // 等真实命令列表替换 fallback
        const items = await ctx.window.locator('[data-testid="slash-item"]').count()
        const panelText = await panel.innerText()
        const hasSkillGroup = panelText.includes('技能')
        const hasScope = panelText.includes('系统') || panelText.includes('个人') || panelText.includes('项目')
        frontendPass = items >= 5 && hasSkillGroup && hasScope
        note = `行数=${items}, 技能组=${hasSkillGroup}, 作用域标注=${hasScope}`
      } catch (e) { note = `前端异常: ${e.message}` }
      await ctx.shot('slash-popup')
      const resp = await ctx.backend.api('/api/v1/agent/commands')
      const cmds = resp?.commands ?? []
      const backendOk = cmds.length > 0 && cmds.some((c) => c.source === 'skill' && c.layer)
      return { frontendPass, backendOk, note: note + ` | 后端命令数=${cmds.length}, 含 skill+layer=${backendOk}` }
    },
  },
  {
    name: 'slash-filter-highlight',
    expectation: '输入 /mc 过滤:首行 /mcp(前缀分最高),/compact 靠子序列命中;匹配字符深色、未匹配变灰(截图视觉判)。注:默认通用会话不挂台球包,pack 命令不在列表是设计行为,过滤词用 builtin 必有的',
    async run(ctx) {
      let frontendPass = false, note = ''
      try {
        const input = ctx.window.locator('[data-testid="chat-input"]')
        await input.fill('/mc')
        await ctx.window.waitForTimeout(200)
        const first = ctx.window.locator('[data-testid="slash-item"]').first()
        const firstText = await first.innerText()
        frontendPass = firstText.includes('mcp')
        note = `首行=${firstText.slice(0, 40).replaceAll('\n', ' ')}`
      } catch (e) { note = `前端异常: ${e.message}` }
      await ctx.shot('slash-filter-highlight')
      return { frontendPass, backendOk: await ctx.backend.healthy(), note }
    },
  },
  {
    name: 'slash-esc-reopen',
    expectation: 'Esc 收起浮层且保留文本;继续输入自动重弹',
    async run(ctx) {
      let frontendPass = false, note = ''
      try {
        const input = ctx.window.locator('[data-testid="chat-input"]')
        const panel = ctx.window.locator('[data-testid="token-panel"]')
        await input.press('Escape')
        await panel.waitFor({ state: 'hidden', timeout: 3000 })
        const textKept = (await input.inputValue()) === '/mc'
        await input.press('Backspace') // 值变化 → dismissed 复位重弹
        await panel.waitFor({ state: 'visible', timeout: 3000 })
        frontendPass = textKept
        note = `Esc 后文本保留=${textKept}, 再输入重弹=true`
      } catch (e) { note = `前端异常: ${e.message}` }
      await ctx.shot('slash-esc-reopen')
      return { frontendPass, backendOk: await ctx.backend.healthy(), note }
    },
  },
  {
    name: 'slash-pick-enter',
    expectation: '回车选中当前高亮命令:命令名 + 空格填入输入框,浮层关闭',
    async run(ctx) {
      let frontendPass = false, note = ''
      try {
        const input = ctx.window.locator('[data-testid="chat-input"]')
        await input.fill('/mcp')
        await ctx.window.waitForTimeout(200)
        await input.press('Enter')
        const val = await input.inputValue()
        const panelGone = await ctx.window.locator('[data-testid="token-panel"]').isHidden().catch(() => true)
        frontendPass = val === '/mcp ' && panelGone
        note = `回车后输入框="${val}", 浮层关=${panelGone}`
        await input.fill('') // 清场
      } catch (e) { note = `前端异常: ${e.message}` }
      await ctx.shot('slash-pick-enter')
      return { frontendPass, backendOk: await ctx.backend.healthy(), note }
    },
  },
  // TODO 补: 发消息→流式回显 / 工具卡展开看 diff / 生图工作台出图 ...
]

// ================= driver 主体(框架,一般不用改) =================
function attribute(fe, be) {
  if (fe && be) return 'ok'
  if (!fe && be) return 'frontend-or-transport'          // 后端做了、前端没渲染
  if (!fe && !be) return 'backend'
  return 'transport-or-false-success'                    // 前端"成功"但后端报错,重点查
}

async function getSidecarBase(app, window) {
  // main.ts reserveServerPort 动态端口;preload 白名单暴露 desktopHost.getServerUrl()(IPC runtime:getServerUrl)。
  try {
    const base = await window.evaluate(() => globalThis.desktopHost?.runtime?.getServerUrl?.() ?? null)
    if (base) return base
  } catch {}
  return process.env.QF_SERVER_PORT ? `http://127.0.0.1:${process.env.QF_SERVER_PORT}` : null
}

async function main() {
  const app = await _electron.launch({ args: [MAIN], env: { ...process.env, QF_UI_REACT: '1' } })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded').catch(() => {})
  const sidecarBase = await getSidecarBase(app, window)
  const backend = {
    base: sidecarBase,
    async healthy() {
      if (!sidecarBase) return false            // 拿不到基址=后端证据未接(见 getSidecarBase TODO)
      try { return (await fetch(`${sidecarBase}/health`)).ok } catch { return false }
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
