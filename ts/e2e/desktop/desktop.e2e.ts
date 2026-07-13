import { test, expect } from './fixtures'
import { PNG } from 'pngjs'
import * as QRCode from 'qrcode'

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

  const result = await desktop.api<{ commands: Array<{ source?: string; layer?: string }> }>('/api/v1/agent/commands')
  expect(result.commands.some(command => command.source === 'skill' && command.layer)).toBe(true)
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

test('生图工作台在初始创作态保持任务层级与无横向溢出', async ({ desktop }, testInfo) => {
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生图工作台')
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
  await expect(desktop.window.getByRole('tab', { name: '创作', exact: true })).toBeHidden()
  await assertNoPageOverflow()
  await desktop.window.getByTestId('image-prompt-input').fill('做一张海报，价格 39.9 元，6月15日，地址：中山路 18 号，电话 13800138000，立即扫码报名')
  await desktop.window.getByTestId('image-generate-button').click()
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
  await expect(desktop.window.getByRole('tab', { name: '创作', exact: true })).toBeHidden()
  await expect(desktop.window.getByTestId('image-workflow-poster')).toHaveAttribute('aria-selected', 'true')
  await expect(desktop.window.getByTestId('whole-edit-input')).toBeHidden()
  await assertNoPageOverflow()
  await testInfo.attach('workbench-compact-layout', { body: await desktop.window.screenshot(), contentType: 'image/png' })
})

test('生图工作台可以取消正在生成的任务，并重试一次性失败', async ({ desktop }) => {
  test.setTimeout(30_000)
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生图工作台')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()

  const prompt = desktop.window.getByTestId('image-prompt-input')
  const generate = desktop.window.getByTestId('image-generate-button')
  await desktop.window.getByTestId('image-output-settings').getByText('输出设置').click()
  await desktop.window.getByTestId('image-ratio-select').selectOption('2:5')
  await prompt.fill('做一张周末畅打活动海报')
  await generate.click()
  await expect(desktop.window.getByTestId('brief-understanding')).toBeVisible()
  await generate.click()
  await expect(desktop.window.getByTestId('cancel-image-job')).toBeVisible()
  await desktop.window.getByTestId('cancel-image-job').click()
  await expect(desktop.window.getByTestId('workbench-retry')).toContainText('已取消')

  await desktop.window.getByTestId('image-ratio-select').selectOption('1:1')
  await prompt.fill('做一张会员日充值活动海报')
  await generate.click()
  await expect(desktop.window.getByTestId('brief-understanding')).toBeVisible()
  await generate.click()
  await expect(desktop.window.getByTestId('workbench-retry').getByRole('button', { name: '重试' })).toBeVisible({ timeout: 15_000 })
  await desktop.window.getByTestId('workbench-retry').getByRole('button', { name: '重试' }).click()
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 15_000 }).toBe(3)
})

test('生图工作台完成生成挑图局部改字导出并在重启后恢复', async ({ desktop }, testInfo) => {
  test.setTimeout(60_000)
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生图工作台')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()
  await expect(desktop.window.getByTestId('sidebar')).toBeVisible()
  await expect(desktop.window.getByTestId('topbar')).toContainText('生图工作台')

  const logo = new PNG({ width: 320, height: 120 })
  for (let i = 0; i < logo.data.length; i += 4) {
    logo.data[i] = 16
    logo.data[i + 1] = 112
    logo.data[i + 2] = 86
    logo.data[i + 3] = 255
  }
  await desktop.window.getByText('品牌素材', { exact: true }).click()
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
  await expect(desktop.window.getByTestId('brief-understanding')).toBeVisible()
  await desktop.window.getByTestId('image-generate-button').click()
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 15_000 }).toBe(3)
  await desktop.window.getByTestId('candidate-select').first().click()
  await expect(desktop.window.getByTestId('selected-candidate-preview')).toBeVisible()
  await expect(desktop.window.getByTestId('ab-compare')).toBeVisible()
  await desktop.window.getByTestId('quick-download-candidate').click()
  await expect.poll(async () => {
    const body = await desktop.api<{ projects: Array<{ versions: Array<{ kind: string }> }> }>('/api/v1/studio/workbench/projects')
    return body.projects.some(project => project.versions.some(version => version.kind === 'text_export'))
  }, { timeout: 15_000 }).toBe(true)
  await desktop.window.getByTestId('open-selected-candidate').click()
  await expect(desktop.window.getByTestId('workbench-title')).toContainText('开业或门店焕新')

  const versionCount = async () => desktop.window.getByTestId('version-item').count()
  const versionsBeforeWholeEdit = await versionCount()
  await desktop.window.getByTestId('whole-edit-input').fill('背景换成更明亮的球房实景')
  await desktop.window.getByTestId('whole-edit-button').click()
  await expect.poll(versionCount, { timeout: 15_000 }).toBeGreaterThan(versionsBeforeWholeEdit)

  await desktop.window.getByRole('button', { name: '矩形' }).click()
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

  await desktop.window.getByTestId('add-text-button').click()
  await desktop.window.getByPlaceholder('选中文字层后编辑').fill('会员日特惠')
  await desktop.window.getByTestId('text-align-center').click()
  await desktop.window.getByTestId('text-undo-button').click()
  await desktop.window.getByTestId('text-redo-button').click()
  await desktop.window.getByRole('button', { name: '保存' }).click()

  await desktop.window.getByTestId('version-item').last().click()
  await desktop.window.getByTestId('export-png-button').click()
  await expect.poll(async () => {
    const body = await desktop.api<{ projects: Array<{ versions: Array<{ kind: string }> }> }>('/api/v1/studio/workbench/projects')
    return body.projects[0]?.versions.some((version) => version.kind === 'text_export') ?? false
  }, { timeout: 15_000 }).toBe(true)
  await desktop.window.getByTestId('save-library-button').click()

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
  await restarted.window.getByText('生图工作台').click()
  await expect(restarted.window.getByTestId('creation-page')).toBeVisible()
  await expect(restarted.window.getByTestId('workbench-title')).toContainText('开业或门店焕新')
  await restarted.window.getByText('品牌素材', { exact: true }).click()
  await expect(restarted.window.getByTestId('brand-logo-preview')).toBeVisible()
  await expect(restarted.window.getByTestId('brand-qrcode-preview')).toBeVisible()
  await expect(restarted.window.getByTestId('image-quality-status')).toContainText(/未自动质检|OCR|人像|投放/)
})

test('授权随拍照片图生图要求授权、保留参考角色并由用户确认本人', async ({ desktop }, testInfo) => {
  test.setTimeout(60_000)
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生图工作台')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()

  const brandLogo = new PNG({ width: 240, height: 80 })
  brandLogo.data.fill(120)
  await desktop.window.getByText('品牌素材', { exact: true }).click()
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
  await expect(desktop.window.getByTestId('brief-understanding')).toContainText('真人照片优化')
  await desktop.window.getByTestId('image-generate-button').click()
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 20_000 }).toBe(3)
  await desktop.window.getByTestId('open-selected-candidate').click()
  await expect(desktop.window.getByTestId('confirm-portrait-button')).toBeVisible()
  await desktop.window.getByTestId('confirm-portrait-button').click()
  await expect(desktop.window.getByTestId('portrait-user-confirmed')).toBeVisible()

  const body = await desktop.api<{ projects: Array<{ canvas: { image_layers: Array<{ type: string }> }; reference_assets: Array<{ role: string }>; versions: Array<{ review?: { portrait_quality_state?: string; portrait_user_confirmed?: boolean } }> }> }>('/api/v1/studio/workbench/projects')
  expect(body.projects[0]?.reference_assets[0]?.role).toBe('identity_primary')
  expect(body.projects[0]?.canvas.image_layers).toEqual([])
  expect(body.projects[0]?.versions[0]?.review).toMatchObject({ portrait_quality_state: 'user_confirmed', portrait_user_confirmed: true })
})
