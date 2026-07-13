import { test, expect } from './fixtures'
import { PNG } from 'pngjs'
import * as QRCode from 'qrcode'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

test.describe('首次启动', () => {
  test.use({ onboarded: false })

  test('显示引导并可跳过进入真实对话界面', async ({ desktop }) => {
    await expect(desktop.window.getByTestId('onboarding')).toBeVisible()
    await desktop.window.getByRole('button', { name: '跳过引导' }).click()
    await expect(desktop.window.getByTestId('chat-input')).toBeVisible()
  })
})

test('Electron、preload、React 和 sidecar 启动链路接通', async ({ desktop }) => {
  await expect(desktop.window.getByTestId('chat-input')).toBeVisible()
  await expect.poll(async () => {
    try {
      return (await fetch(`${desktop.sidecarBase}/health`)).ok
    } catch {
      return false
    }
  }).toBe(true)

  const visible = await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)
  expect(visible).toBe(true)
})

test('斜杠面板使用 sidecar 的真实命令和技能分组', async ({ desktop }) => {
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/')
  const panel = desktop.window.getByTestId('token-panel')
  await expect(panel).toBeVisible()
  await expect.poll(() => desktop.window.getByTestId('slash-item').count()).toBeGreaterThanOrEqual(5)
  await expect(panel).toContainText('技能')
  await expect(panel).toContainText(/系统|个人|项目/)

  const result = await desktop.api<{ commands: Array<{ source?: string; layer?: string; kind?: string }> }>('/api/v1/agent/commands')
  expect(result.commands.some(command => command.kind === 'skill' && command.source === 'skill' && command.layer)).toBe(true)
})

test('斜杠筛选、Esc 重开和 Enter 选择保持键盘语义', async ({ desktop }) => {
  const input = desktop.window.getByTestId('chat-input')
  const panel = desktop.window.getByTestId('token-panel')

  await input.fill('/mc')
  await expect(panel).toBeVisible()
  await expect(desktop.window.getByTestId('slash-item').first()).toContainText('mcp')

  await input.press('Escape')
  await expect(panel).toBeHidden()
  await expect(input).toHaveValue('/mc')

  await input.press('Backspace')
  await expect(panel).toBeVisible()
  await input.fill('/mcp')
  await input.press('Enter')
  await expect(input).toHaveValue('/mcp ')
  await expect(panel).toBeHidden()
})

test('最小窗口尺寸下输入区仍可用且页面不横向溢出', async ({ desktop }) => {
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(720, 480))
  await expect.poll(() => desktop.window.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(720)
  await expect(desktop.window.getByTestId('chat-input')).toBeVisible()

  const layout = await desktop.window.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    content: document.documentElement.scrollWidth,
  }))
  expect(layout.content).toBeLessThanOrEqual(layout.viewport + 1)

  const inputBox = await desktop.window.getByTestId('chat-input').boundingBox()
  expect(inputBox).not.toBeNull()
  expect((inputBox?.x ?? 0) + (inputBox?.width ?? 0)).toBeLessThanOrEqual(layout.viewport + 1)
})

test('插件页通过显式确认启用插件并可启停 MCP 服务', async ({ desktop }, testInfo) => {
  const libraryRoot = path.join(path.dirname(desktop.stateRoot), 'library')
  const pluginDir = path.join(libraryRoot, 'plugins', 'e2e-plugin')
  mkdirSync(path.join(pluginDir, 'skills', 'e2e-skill'), { recursive: true })
  mkdirSync(path.join(pluginDir, 'commands'), { recursive: true })
  mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true })
  writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({ name: 'E2E 插件', description: '桌面扩展闭环测试' }))
  writeFileSync(path.join(pluginDir, 'skills', 'e2e-skill', 'SKILL.md'), '---\nname: e2e-skill\ndescription: E2E plugin skill\n---\nE2E skill body.\n')
  writeFileSync(path.join(pluginDir, 'commands', 'e2e-command.md'), '---\ndescription: E2E plugin command\n---\nE2E command body.\n')
  writeFileSync(path.join(pluginDir, 'hooks', 'hooks.json'), JSON.stringify({ hooks: {} }))
  writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify({ mcpServers: {} }))

  const mcpServer = path.join(libraryRoot, 'e2e-mcp-server.ts')
  writeFileSync(mcpServer, `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
const server = new McpServer({ name: 'desktopfixture', version: '1.0.0' })
server.registerTool('ping', { description: 'Ping', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
await server.connect(new StdioServerTransport())
`)
  writeFileSync(path.join(libraryRoot, '.mcp.json'), JSON.stringify({
    mcpServers: { desktopfixture: { command: process.execPath, args: [mcpServer], disabled: true } },
  }))

  await desktop.window.getByRole('button', { name: '插件', exact: true }).click()
  await expect(desktop.window.getByTestId('plugins-page')).toBeVisible()
  const pluginSwitch = desktop.window.getByRole('switch', { name: '启用插件 E2E 插件', exact: true })
  await expect(pluginSwitch).toHaveAttribute('aria-checked', 'false')
  await pluginSwitch.click()
  await expect(desktop.window.getByTestId('enable-plugin')).toContainText('只启用你信任的来源')
  await desktop.window.getByRole('button', { name: '确认启用', exact: true }).click()
  await expect(desktop.window.getByRole('switch', { name: '停用插件 E2E 插件', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(desktop.window.getByTestId('plugins-page')).toContainText('/e2e-skill')

  await expect.poll(async () => {
    const result = await desktop.api<{ commands: Array<{ name: string; source: string; layer?: string; kind: string }> }>('/api/v1/agent/commands')
    return result.commands.some(command => command.name === 'e2e-skill' && command.source === 'plugin' && command.layer === 'plugin' && command.kind === 'skill')
      && result.commands.some(command => command.name === 'e2e-command' && command.source === 'plugin' && command.kind === 'command')
  }).toBe(true)
  const listed = await desktop.api<{ plugins: Array<Record<string, unknown>> }>('/api/v1/agent/plugins')
  expect(listed.plugins[0]).not.toHaveProperty('dir')

  const mcpSwitch = desktop.window.getByRole('switch', { name: '启用 MCP 服务 desktopfixture', exact: true })
  await expect(mcpSwitch).toHaveAttribute('aria-checked', 'false')
  await mcpSwitch.click()
  await expect(desktop.window.getByRole('switch', { name: '停用 MCP 服务 desktopfixture', exact: true })).toHaveAttribute('aria-checked', 'true')

  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(720, 480))
  await expect.poll(() => desktop.window.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true)
  await testInfo.attach('plugins-compact-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })
})

test('生成图片页面在初始状态保持任务层级与无横向溢出', async ({ desktop }, testInfo) => {
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生成图片')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()

  const assertNoPageOverflow = async () => {
    const layout = await desktop.window.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(layout.content).toBeLessThanOrEqual(layout.viewport + 1)
  }

  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 760))
  await expect.poll(() => desktop.window.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1180)
  await expect(desktop.window.getByTestId('image-prompt-input')).toBeVisible()
  await expect(desktop.window.getByTestId('whole-edit-input')).toBeHidden()
  await expect(desktop.window.getByRole('tab', { name: '描述', exact: true })).toBeHidden()
  await assertNoPageOverflow()
  await desktop.window.getByTestId('image-prompt-input').fill('做一张海报，价格 39.9 元，6月15日，地址：中山路 18 号，电话 13800138000，立即扫码报名')
  await desktop.window.getByTestId('image-generate-button').click()
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 15_000 }).toBe(3)
  await desktop.window.getByRole('tab', { name: '描述', exact: true }).click()
  await expect(desktop.window.getByTestId('poster-quick-form')).toBeVisible()
  await expect(desktop.window.getByPlaceholder('价格')).toHaveValue(/39\.9/)
  await expect(desktop.window.getByTestId('poster-address-input')).toHaveValue('中山路 18 号')
  await expect(desktop.window.getByTestId('poster-phone-input')).toHaveValue(/13800138000/)
  await expect(desktop.window.getByTestId('poster-cta-input')).toHaveValue('立即扫码报名')
  await testInfo.attach('workbench-wide-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })
  await desktop.window.getByRole('button', { name: '切换主题' }).click()
  await expect.poll(() => desktop.window.evaluate(() => document.documentElement.dataset.theme)).toBe('dark')
  await desktop.window.waitForTimeout(250)
  await expect.poll(() => desktop.window.evaluate(() => {
    const nav = document.querySelector('[data-testid="sidebar"] nav button')
    return nav ? getComputedStyle(nav).color : null
  })).toBe('rgb(255, 255, 255)')
  await assertNoPageOverflow()
  await testInfo.attach('workbench-wide-dark-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })
  await desktop.window.getByRole('button', { name: '切换主题' }).click()
  await expect.poll(() => desktop.window.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
  await desktop.window.waitForTimeout(250)

  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 760))
  await expect.poll(() => desktop.window.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(900)
  await expect(desktop.window.getByTestId('image-prompt-input')).toBeVisible()
  await expect(desktop.window.getByTestId('whole-edit-input')).toBeHidden()
  await assertNoPageOverflow()
  await testInfo.attach('workbench-two-column-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })

  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(720, 650))
  await expect.poll(() => desktop.window.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(720)
  await expect(desktop.window.getByRole('tab', { name: '描述', exact: true })).toBeVisible()
  await expect(desktop.window.getByRole('tab', { name: '描述', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(desktop.window.getByTestId('image-workflow-poster')).toHaveAttribute('aria-selected', 'true')
  await expect(desktop.window.getByTestId('whole-edit-input')).toBeHidden()
  await assertNoPageOverflow()
  await testInfo.attach('workbench-compact-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })
})

test('生成图片页面可以取消正在生成的任务，并重试一次性失败', async ({ desktop }) => {
  test.setTimeout(30_000)
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生成图片')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()

  const prompt = desktop.window.getByTestId('image-prompt-input')
  const generate = desktop.window.getByTestId('image-generate-button')
  await desktop.window.getByTestId('image-output-settings').getByText('图片设置').click()
  await desktop.window.getByTestId('image-ratio-select').selectOption('2:5')
  await prompt.fill('做一张周末畅打活动海报')
  await generate.click()
  await expect(desktop.window.getByTestId('cancel-image-job')).toBeVisible()
  await desktop.window.getByTestId('cancel-image-job').click()
  await expect(desktop.window.getByTestId('workbench-retry')).toContainText('已取消')

  await desktop.window.getByRole('tab', { name: '描述', exact: true }).click()
  await desktop.window.getByTestId('image-ratio-select').selectOption('1:1')
  await prompt.fill('做一张会员日充值活动海报')
  await generate.click()
  await expect(desktop.window.getByTestId('workbench-retry').getByRole('button', { name: '重试' })).toBeVisible({ timeout: 15_000 })
  await desktop.window.getByTestId('workbench-retry').getByRole('button', { name: '重试' }).click()
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 15_000 }).toBe(3)
})

test('生成图片页面完成生成挑图局部改字导出并在重启后恢复', async ({ desktop }, testInfo) => {
  test.setTimeout(60_000)
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生成图片')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()
  await expect(desktop.window.getByTestId('sidebar')).toBeVisible()
  await expect(desktop.window.getByTestId('topbar')).toContainText('生成图片')

  const logo = new PNG({ width: 320, height: 120 })
  for (let i = 0; i < logo.data.length; i += 4) {
    logo.data[i] = 16
    logo.data[i + 1] = 112
    logo.data[i + 2] = 86
    logo.data[i + 3] = 255
  }
  await desktop.window.getByText('Logo 和二维码', { exact: true }).click()
  await desktop.window.getByTestId('brand-logo-input').setInputFiles({
    name: 'store-logo.png',
    mimeType: 'image/png',
    buffer: PNG.sync.write(logo),
  })
  await expect(desktop.window.getByTestId('brand-logo-preview')).toBeVisible()
  await desktop.window.getByTestId('brand-qrcode-input').setInputFiles({
    name: 'store-qrcode.png',
    mimeType: 'image/png',
    buffer: await QRCode.toBuffer('https://example.com/store', { type: 'png', width: 256, margin: 4 }),
  })
  await expect(desktop.window.getByTestId('brand-qrcode-preview')).toBeVisible()
  const savedBrand = await desktop.api<{ logo_url?: string; qrcode_url?: string; logo_width?: number }>('/api/v1/stores/me')
  expect(savedBrand.logo_url).toContain('/uploads/workbench/assets/reference/')
  expect(savedBrand.qrcode_url).toContain('/uploads/workbench/assets/reference/')
  expect(savedBrand.logo_width).toBe(320)

  const reference = new PNG({ width: 768, height: 768 })
  for (let i = 0; i < reference.data.length; i += 4) {
    reference.data[i] = 32
    reference.data[i + 1] = 92
    reference.data[i + 2] = 76
    reference.data[i + 3] = 255
  }
  await desktop.window.locator('input[type="file"][multiple]').setInputFiles({
    name: 'poster-reference.png',
    mimeType: 'image/png',
    buffer: PNG.sync.write(reference),
  })
  await desktop.window.getByTestId('poster-type-select').selectOption('opening_anniversary')
  await desktop.window.getByTestId('image-generate-button').click()
  await expect(desktop.window.getByTestId('brief-understanding')).toBeVisible({ timeout: 15_000 })
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 15_000 }).toBe(3)
  await desktop.window.getByTestId('candidate-select').first().click()
  await expect(desktop.window.getByTestId('selected-candidate-preview')).toBeVisible()
  await expect(desktop.window.getByTestId('ab-compare')).toBeVisible()
  await testInfo.attach('workbench-candidate-selection', { body: await desktop.window.screenshot(), contentType: 'image/png' })
  await desktop.window.getByTestId('quick-download-candidate').click()
  await expect.poll(async () => {
    const body = await desktop.api<{ projects: Array<{ versions: Array<{ kind: string }> }> }>('/api/v1/studio/workbench/projects')
    return body.projects.some(project => project.versions.some(version => version.kind === 'text_export'))
  }, { timeout: 15_000 }).toBe(true)
  await desktop.window.getByTestId('open-selected-candidate').click()
  await expect(desktop.window.getByTestId('workbench-title')).toContainText('开业或门店焕新')
  await expect(desktop.window.getByTestId('workbench-canvas-viewport')).toBeVisible()
  await expect.poll(() => desktop.window.getByTestId('workbench-canvas-viewport').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await expect(desktop.window.getByTestId('whole-edit-input')).toBeHidden()
  await desktop.window.getByRole('tab', { name: '修改', exact: true }).click()
  await expect(desktop.window.getByTestId('whole-edit-input')).toBeVisible()

  const versionCount = async () => desktop.window.getByTestId('version-item').count()
  const versionsBeforeWholeEdit = await versionCount()
  await desktop.window.getByTestId('whole-edit-input').fill('背景换成更明亮的球房实景')
  await desktop.window.getByTestId('whole-edit-button').click()
  await expect.poll(versionCount, { timeout: 15_000 }).toBeGreaterThan(versionsBeforeWholeEdit)

  await desktop.window.getByRole('tab', { name: '修改', exact: true }).click()
  await desktop.window.getByRole('button', { name: '框选' }).click()
  const canvas = desktop.window.locator('canvas.upper-canvas').last()
  await canvas.scrollIntoViewIfNeeded()
  await expect(canvas).toBeVisible()
  const canvasBox = await canvas.boundingBox()
  expect(canvasBox).not.toBeNull()
  const viewport = desktop.window.viewportSize() ?? { width: 1280, height: 900 }
  const startX = Math.min(Math.max((canvasBox?.x ?? 0) + 60, 16), viewport.width - 160)
  const startY = Math.min(Math.max((canvasBox?.y ?? 0) + 60, 48), viewport.height - 180)
  await desktop.window.mouse.move(startX, startY)
  await desktop.window.mouse.down()
  await desktop.window.mouse.move(startX + 120, startY + 90)
  await desktop.window.mouse.up()
  await desktop.window.getByTestId('inpaint-input').fill('把选区里的桌布换成墨绿色')
  await expect(desktop.window.getByTestId('inpaint-button')).toBeEnabled()
  const versionsBeforeInpaint = await versionCount()
  await desktop.window.getByTestId('inpaint-button').click()
  await expect.poll(versionCount, { timeout: 15_000 }).toBeGreaterThan(versionsBeforeInpaint)

  await desktop.window.getByRole('tab', { name: '修改', exact: true }).click()
  await desktop.window.getByTestId('add-text-button').click()
  await desktop.window.getByPlaceholder('选中文字层后编辑').fill('会员日特惠')
  await desktop.window.getByTestId('text-align-center').click()
  await desktop.window.getByTestId('text-undo-button').click()
  await desktop.window.getByTestId('text-redo-button').click()
  await desktop.window.getByRole('button', { name: '保存', exact: true }).click()

  await desktop.window.getByTestId('version-item').last().click()
  await desktop.window.getByTestId('export-png-button').click()
  await expect.poll(async () => {
    const body = await desktop.api<{ projects: Array<{ versions: Array<{ kind: string }> }> }>('/api/v1/studio/workbench/projects')
    return body.projects[0]?.versions.some((version) => version.kind === 'text_export') ?? false
  }, { timeout: 15_000 }).toBe(true)
  await desktop.window.getByTestId('save-library-button').click()
  await expect(desktop.window.getByText('使用前检查')).toBeVisible()
  await expect(desktop.window.getByTestId('creation-page').getByText(/工作台|候选|质检|蒙版|重绘|硬闸|高保真|OCR|素材库/)).toHaveCount(0)
  await testInfo.attach('workbench-friendly-editing', { body: await desktop.window.screenshot(), contentType: 'image/png' })

  const body = await desktop.api<{
    projects: Array<{
      canvas: { width: number; height: number; image_layers: Array<{ type: string }> }
      reference_assets: Array<{ role: string }>
      versions: Array<{ kind: string; image_url: string }>
    }>
  }>('/api/v1/studio/workbench/projects')
  const project = body.projects[0]
  expect(project).toBeTruthy()
  expect(project!.reference_assets[0]?.role).toBe('environment_reference')
  expect(project!.canvas.image_layers.map(layer => layer.type).sort()).toEqual(['logo', 'qrcode'])
  const exported = project!.versions.find((version) => version.kind === 'text_export')
  expect(exported).toBeTruthy()
  const pngRes = await fetch(`${desktop.sidecarBase}${exported!.image_url}`)
  expect(pngRes.ok).toBe(true)
  const png = PNG.sync.read(Buffer.from(await pngRes.arrayBuffer()))
  expect(png.width).toBe(project!.canvas.width)
  expect(png.height).toBe(project!.canvas.height)
  await testInfo.attach('workbench-export-size', {
    body: Buffer.from(`${png.width}x${png.height}`),
    contentType: 'text/plain',
  })

  const restarted = await desktop.restart()
  await restarted.window.getByText('生成图片').click()
  await expect(restarted.window.getByTestId('creation-page')).toBeVisible()
  await expect(restarted.window.getByTestId('workbench-title')).toBeHidden()
  await restarted.window.getByText('最近图片', { exact: true }).click()
  await restarted.window.getByTestId('workbench-project-item').filter({ hasText: '开业或门店焕新' }).click()
  await expect(restarted.window.getByTestId('workbench-title')).toContainText('开业或门店焕新')
  await restarted.window.getByRole('tab', { name: '描述', exact: true }).click()
  await restarted.window.getByText('Logo 和二维码', { exact: true }).click()
  await expect(restarted.window.getByTestId('brand-logo-preview')).toBeVisible()
  await expect(restarted.window.getByTestId('brand-qrcode-preview')).toBeVisible()
  await restarted.window.getByRole('tab', { name: '结果', exact: true }).click()
  await expect(restarted.window.getByTestId('image-quality-status')).toContainText(/尚未自动检查|画面检查|文字检查|人物照片|发布前/)
})

test('授权随拍照片图生图要求授权、保留参考角色并由用户确认本人', async ({ desktop }, testInfo) => {
  test.setTimeout(60_000)
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生成图片')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()

  const brandLogo = new PNG({ width: 240, height: 80 })
  brandLogo.data.fill(120)
  await desktop.window.getByText('Logo 和二维码', { exact: true }).click()
  await desktop.window.getByTestId('brand-logo-input').setInputFiles({
    name: 'portrait-test-brand.png',
    mimeType: 'image/png',
    buffer: PNG.sync.write(brandLogo),
  })
  await expect(desktop.window.getByTestId('brand-logo-preview')).toBeVisible()
  await desktop.window.getByTestId('image-workflow-photo').click()

  const png = new PNG({ width: 768, height: 768 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 128
    png.data[i + 1] = 96
    png.data[i + 2] = 82
    png.data[i + 3] = 255
  }
  await desktop.window.locator('input[type="file"][multiple]').setInputFiles({
    name: 'authorized-person.png',
    mimeType: 'image/png',
    buffer: PNG.sync.write(png),
  })
  await desktop.window.getByTestId('portrait-authorization').getByRole('checkbox').check()

  const assertNoPageOverflow = async () => {
    const layout = await desktop.window.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(layout.content).toBeLessThanOrEqual(layout.viewport + 1)
  }
  await desktop.window.waitForTimeout(2_300)
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 760))
  await expect.poll(() => desktop.window.evaluate(() => window.innerWidth)).toBeGreaterThanOrEqual(1180)
  await assertNoPageOverflow()
  await testInfo.attach('photo-edit-wide-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(720, 760))
  await expect.poll(() => desktop.window.evaluate(() => window.innerWidth)).toBeLessThanOrEqual(720)
  await assertNoPageOverflow()
  await testInfo.attach('photo-edit-compact-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })
  await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1180, 760))

  await desktop.window.getByTestId('image-generate-button').click()
  await expect(desktop.window.getByTestId('brief-understanding')).toContainText('照片编辑', { timeout: 15_000 })
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 20_000 }).toBe(3)
  await desktop.window.getByTestId('open-selected-candidate').click()
  await expect(desktop.window.getByTestId('confirm-portrait-button')).toBeVisible()
  await desktop.window.getByTestId('confirm-portrait-button').click()
  await expect(desktop.window.getByTestId('portrait-user-confirmed')).toBeVisible()
  await expect(desktop.window.getByTestId('image-quality-status').getByText(/质检|模型|成图|人工把关|高保真|端点/)).toHaveCount(0)

  const body = await desktop.api<{ projects: Array<{ canvas: { image_layers: Array<{ type: string }> }; reference_assets: Array<{ role: string }>; versions: Array<{ review?: { portrait_quality_state?: string; portrait_user_confirmed?: boolean } }> }> }>('/api/v1/studio/workbench/projects')
  expect(body.projects[0]?.reference_assets[0]?.role).toBe('identity_primary')
  expect(body.projects[0]?.canvas.image_layers).toEqual([])
  expect(body.projects[0]?.versions[0]?.review).toMatchObject({ portrait_quality_state: 'user_confirmed', portrait_user_confirmed: true })
})

test('剪视频双工作台完成 Scene 融合、撤销重做、正式导出、重启恢复和语音回填', async ({ desktop }, testInfo) => {
  test.setTimeout(90_000)
  await desktop.setVideoFiles()
  await desktop.window.getByTestId('sidebar').getByText('剪视频', { exact: true }).click()
  await expect(desktop.window.getByTestId('video-studio-page')).toBeVisible()
  await desktop.window.getByTestId('video-view-ambient').click()
  await desktop.window.getByTestId('video-goal-input').fill('把真实素材剪成自然的空间与日常短片，不添加不存在的营销信息')
  await desktop.window.getByLabel('内容类型').selectOption('venue_atmosphere')
  await desktop.window.getByTestId('video-pick-files').click()
  await expect(desktop.window.getByTestId('video-imported-files').locator('> div')).toHaveCount(2)
  await desktop.window.getByTestId('video-create-project').click()
  await expect(desktop.window.getByTestId('video-brief-understanding')).toBeVisible({ timeout: 30_000 })
  await expect(desktop.window.getByTestId('video-generate-drafts')).toBeVisible()
  await expect(desktop.window.getByText('已自动保存')).toBeVisible()
  await desktop.window.getByTestId('video-generate-drafts').click()
  await expect.poll(() => desktop.window.getByTestId('video-scene-card').count(), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(desktop.window.getByTestId('video-ambient-workspace')).toBeVisible()
  await expect(desktop.window.getByTestId('video-source-basket')).toBeHidden()
  await expect(desktop.window.getByTestId('video-alternatives')).toBeHidden()
  const sceneVideo = desktop.window.getByTestId('video-scene-preview').locator('video')
  await expect.poll(() => sceneVideo.evaluate(video => (video as HTMLVideoElement).readyState), { timeout: 10_000 }).toBeGreaterThanOrEqual(2)
  await sceneVideo.evaluate(async video => {
    const element = video as HTMLVideoElement
    element.currentTime = Math.min(0.5, Math.max(0, element.duration / 2))
    if (!element.seeking) return
    await new Promise<void>(resolve => element.addEventListener('seeked', () => resolve(), { once: true }))
  })
  await testInfo.attach('video-ambient-workbench', { body: await desktop.window.screenshot(), contentType: 'image/png' })
  await desktop.window.getByRole('tab', { name: '调整', exact: true }).click()
  await expect(desktop.window.getByTestId('video-alternatives')).toContainText('表达更完整')

  await desktop.window.setViewportSize({ width: 720, height: 900 })
  await expect(desktop.window.getByRole('tab', { name: '视频素材', exact: true })).toBeVisible()
  await desktop.window.getByRole('tab', { name: '调整', exact: true }).click()
  await desktop.window.getByText('画面位置与速度', { exact: true }).click()
  await expect(desktop.window.getByTestId('video-visual-controls')).toBeVisible()
  await expect(desktop.window.getByText(/revision|Scene|ASR|CTA|Take/)).toHaveCount(0)
  const responsiveSize = await desktop.window.evaluate(() => ({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }))
  expect(responsiveSize.scrollWidth).toBeLessThanOrEqual(responsiveSize.width + 1)
  await testInfo.attach('video-workbench-720px', { body: await desktop.window.screenshot(), contentType: 'image/png' })
  await desktop.window.setViewportSize({ width: 1360, height: 900 })

  await desktop.window.getByTitle('修改内容理解').click()
  await desktop.window.getByTestId('video-brief-editor').getByRole('textbox').first().fill('把真实素材剪成自然、安静的空间与日常短片，不添加不存在的营销信息')
  await desktop.window.getByRole('button', { name: '更新理解' }).click()
  await expect(desktop.window.getByTestId('video-brief-understanding')).toContainText('自然、安静')

  const sceneCount = await desktop.window.getByTestId('video-scene-card').count()
  await desktop.window.getByTestId('video-scene-card').first().click()
  await desktop.window.getByTestId('video-speed').selectOption('1.25')
  await expect.poll(async () => {
    const body = await desktop.api<{ projects: Array<{ scenes: Array<{ video_layers: Array<{ speed: number }> }> }> }>('/api/v1/video-edit/projects')
    return body.projects[0]?.scenes[0]?.video_layers[0]?.speed
  }).toBe(1.25)
  await desktop.window.getByTestId('video-crop-fit').selectOption('cover')
  await expect.poll(async () => {
    const body = await desktop.api<{ projects: Array<{ scenes: Array<{ video_layers: Array<{ crop: { fit: string } }> }> }> }>('/api/v1/video-edit/projects')
    return body.projects[0]?.scenes[0]?.video_layers[0]?.crop.fit
  }).toBe('cover')
  await desktop.window.getByTestId('video-narration-source').first().selectOption({ index: 1 })
  await desktop.window.getByTestId('video-narration-input').first().fill('这是用户确认的短旁白')
  await desktop.window.getByTestId('video-add-narration').first().click()
  await expect(desktop.window.getByTestId('video-remove-narration').first()).toBeVisible()

  await desktop.window.getByTestId('video-view-talking').click()
  await expect(desktop.window.getByTestId('video-talking-workspace')).toBeVisible()
  const displayText = desktop.window.getByLabel(/片段 \d+ 显示字幕/).first()
  await displayText.fill('用户修正后的显示字幕')
  await desktop.window.getByRole('button', { name: '保存字幕' }).first().click()
  const brollCandidate = desktop.window.getByTestId('video-broll-candidates').first().getByRole('button').first()
  if (await brollCandidate.isVisible().catch(() => false)) await brollCandidate.click()

  const projects = await desktop.api<{ projects: Array<{ project_id: string; revision: number; sources: Array<{ id: string; file_uri: string }>; scenes: Array<{ dialogue?: { origin?: string; display_text?: string }; video_layers: Array<{ role: string }>; audio_layers: Array<{ role: string; owner: boolean }> }> }> }>('/api/v1/video-edit/projects')
  const project = projects.projects[0]!
  const fused = project.scenes.find(scene => scene.dialogue?.origin === 'narration')!
  expect(fused.dialogue?.display_text).toBe('用户修正后的显示字幕')
  expect(fused.audio_layers.filter(layer => layer.owner)).toEqual([expect.objectContaining({ role: 'speech' })])
  if (fused.video_layers.some(layer => layer.role === 'broll')) expect(fused.video_layers.some(layer => layer.role === 'broll')).toBe(true)

  await desktop.window.getByTestId('video-split-scene').first().click()
  await expect.poll(() => desktop.window.getByTestId('video-scene-card').count()).toBe(sceneCount + 1)
  await desktop.window.getByTestId('video-undo').click()
  await expect.poll(() => desktop.window.getByTestId('video-scene-card').count()).toBe(sceneCount)
  await desktop.window.getByTestId('video-redo').click()
  await expect.poll(() => desktop.window.getByTestId('video-scene-card').count()).toBe(sceneCount + 1)

  const originalSource = project.sources[0]!
  const relocatedSource = path.join(path.dirname(originalSource.file_uri), `relocated-${path.basename(originalSource.file_uri)}`)
  copyFileSync(originalSource.file_uri, relocatedSource)
  unlinkSync(originalSource.file_uri)
  await desktop.window.getByRole('tab', { name: '视频素材', exact: true }).click()
  await desktop.window.getByTitle('刷新项目').click()
  await expect(desktop.window.getByText('找不到原视频', { exact: false }).first()).toBeVisible()
  await desktop.setVideoFiles([relocatedSource])
  await desktop.window.getByRole('button', { name: '重新选择原视频' }).first().click()
  await expect(desktop.window.getByText('找不到原视频', { exact: false })).toHaveCount(0)

  await desktop.window.getByRole('tab', { name: '调整', exact: true }).click()
  desktop.setVideoRenderDelay(true)
  await desktop.window.getByTestId('video-final-render').click()
  await expect(desktop.window.getByTestId('video-cancel-job')).toBeVisible()
  await desktop.window.getByTestId('video-cancel-job').click()
  await expect(desktop.window.getByTestId('video-retry-job')).toBeVisible()
  desktop.setVideoRenderDelay(false)
  await desktop.window.getByTestId('video-retry-job').click()
  await expect(desktop.window.getByTestId('video-download')).toBeVisible({ timeout: 30_000 })
  const sourceUrl = await desktop.window.getByTestId('video-export-preview').getAttribute('src')
  expect(sourceUrl).toBeTruthy()
  const encoded = Buffer.from(await (await fetch(sourceUrl!)).arrayBuffer())
  expect(encoded.subarray(4, 8).toString('ascii')).toBe('ftyp')
  const exportDir = path.join(desktop.stateRoot, 'uploads', 'edits', project.project_id, 'exports')
  const manifestName = readdirSync(exportDir).find(name => name.endsWith('.manifest.json'))
  expect(manifestName).toBeTruthy()
  const manifest = JSON.parse(readFileSync(path.join(exportDir, manifestName!), 'utf8')) as { revision: number; scene_ids: string[]; visual_semantics: Array<{ layers: Array<{ speed: number; crop: { fit: string } }> }> }
  expect(manifest.revision).toBeGreaterThanOrEqual(project.revision)
  expect(manifest.scene_ids.length).toBeGreaterThan(0)
  expect(manifest.visual_semantics.flatMap(item => item.layers).some(layer => layer.speed === 1.25 && layer.crop.fit === 'cover')).toBe(true)
  await testInfo.attach('video-export-manifest', { body: Buffer.from(JSON.stringify(manifest, null, 2)), contentType: 'application/json' })

  const restarted = await desktop.restart()
  await restarted.window.getByTestId('sidebar').getByText('剪视频', { exact: true }).click()
  await expect(restarted.window.getByTestId('video-project-item').first()).toBeVisible()
  await restarted.window.getByTestId('video-project-item').first().click()
  await expect.poll(() => restarted.window.getByTestId('video-scene-card').count()).toBe(sceneCount + 1)

  await restarted.window.getByTestId('sidebar').getByText('新建任务').click()
  await restarted.window.evaluate(() => {
    class FakeMediaRecorder {
      static isTypeSupported() { return true }
      state: 'inactive' | 'recording' = 'inactive'
      mimeType = 'audio/webm'
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      constructor(..._args: unknown[]) {}
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['recorded-audio'], { type: this.mimeType }) })
        this.onstop?.()
      }
    }
    Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: FakeMediaRecorder })
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } })
  })
  await restarted.window.getByTestId('voice-input').click()
  await expect(restarted.window.getByTestId('voice-recording')).toBeVisible()
  await restarted.window.getByRole('button', { name: '取消录音' }).click()
  await expect(restarted.window.getByTestId('voice-input')).toBeVisible()
  await expect(restarted.window.getByTestId('chat-input')).toHaveValue('')
  await restarted.window.getByTestId('voice-input').click()
  await expect(restarted.window.getByTestId('voice-recording')).toBeVisible()
  await restarted.window.getByRole('button', { name: '停止并转写' }).click()
  await expect(restarted.window.getByTestId('chat-input')).toHaveValue('语音回填内容', { timeout: 15_000 })
  await expect(restarted.window.getByTestId('chat-input')).toBeEditable()
})
