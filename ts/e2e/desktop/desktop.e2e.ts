import { test, expect } from './fixtures'
import { PNG } from 'pngjs'

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

test('生图工作台完成生成挑图局部改字导出并在重启后恢复', async ({ desktop }, testInfo) => {
  test.setTimeout(60_000)
  const input = desktop.window.getByTestId('chat-input')
  await input.fill('/生图工作台')
  await input.press('Enter')
  await expect(desktop.window.getByTestId('creation-page')).toBeVisible()
  await expect(desktop.window.getByTestId('sidebar')).toBeHidden()
  await expect(desktop.window.getByTestId('topbar')).toBeHidden()
  await expect(desktop.window.getByTestId('workspace-drag-strip')).toBeVisible()
  await expect(desktop.window.getByTestId('workbench-back-chat')).toBeVisible()

  await desktop.window.getByRole('button', { name: '活动海报' }).click()
  await desktop.window.getByTestId('image-generate-button').click()
  await expect.poll(() => desktop.window.getByTestId('candidate-card').count(), { timeout: 15_000 }).toBe(3)
  await desktop.window.getByTestId('candidate-select').first().click()
  await expect(desktop.window.getByTestId('selected-candidate-preview')).toBeVisible()
  await expect(desktop.window.getByTestId('ab-compare')).toBeVisible()
  await desktop.window.getByTestId('open-selected-candidate').click()
  await expect(desktop.window.getByTestId('workbench-title')).toContainText('台球室活动海报')

  await desktop.window.getByTestId('whole-edit-input').fill('背景换成更明亮的球房实景')
  await desktop.window.getByTestId('whole-edit-button').click()
  await expect.poll(async () => desktop.window.getByTestId('version-item').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2)

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
  await desktop.window.getByTestId('inpaint-button').click()
  await expect.poll(async () => desktop.window.getByTestId('version-item').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3)

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
      canvas: { width: number; height: number }
      versions: Array<{ kind: string; image_url: string }>
    }>
  }>('/api/v1/studio/workbench/projects')
  const project = body.projects[0]
  expect(project).toBeTruthy()
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
  await expect(restarted.window.getByTestId('workbench-title')).toContainText('台球室活动海报')
  await expect(restarted.window.getByTestId('image-quality-status')).toContainText(/未自动质检|OCR|人像|投放/)
})
