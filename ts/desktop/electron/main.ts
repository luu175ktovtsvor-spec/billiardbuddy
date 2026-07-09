import { app, BrowserWindow, dialog, ipcMain, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { platform } from 'node:os'
import {
  SERVER_BIND_HOST,
  reserveServerPort,
  spawnSidecar,
  waitForServer,
  killSidecar,
  type SidecarChild,
  type SidecarPlan,
} from './services/sidecarManager'

const here = dirname(fileURLToPath(import.meta.url))
const PREFERRED_PORTS = [8850, 8851, 8852, 8877]

let sidecar: SidecarChild | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let serverPort = 0

const APP_NAME = '球房管家'

/** 解析 bun 绝对路径(spawnSidecar 要 existsSync 通过,不能只给裸命令 'bun')。 */
function resolveBun(): string {
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, 'bin', 'bun') : '',
    process.env.HOME ? join(process.env.HOME, '.bun', 'bin', 'bun') : '',
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ].filter(Boolean)
  for (const c of candidates) if (existsSync(c)) return c
  return 'bun'
}

/** dev:bun 直跑 sidecar 源码;prod:随包的编译二进制。 */
function buildSidecarPlan(port: number): SidecarPlan {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    QF_DESKTOP: '1',
  }
  const args = ['server', '--host', SERVER_BIND_HOST, '--port', String(port)]
  if (!app.isPackaged) {
    // dev:用 bun 直跑 sidecar 入口(bun 绝对路径)
    return { command: resolveBun(), args: ['run', join(here, '../sidecars/backend-sidecar.ts'), ...args], env }
  }
  // prod:随包编译二进制(build-sidecar 产物,放在 resources/binaries,命名用完整 target triple)。
  const binariesDir = join(process.resourcesPath, 'binaries')
  const exact = join(binariesDir, `backend-sidecar-${sidecarTriple()}${platform() === 'win32' ? '.exe' : ''}`)
  if (existsSync(exact)) return { command: exact, args, env }
  // 兜底:扫 binaries 目录里匹配当前平台的 backend-sidecar-*(triple 未精确命中时)。
  const platformMark = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'apple-darwin' : 'linux'
  try {
    const match = readdirSync(binariesDir).find(f => f.startsWith('backend-sidecar-') && f.includes(platformMark))
    if (match) return { command: join(binariesDir, match), args, env }
  } catch { /* 目录不存在 */ }
  return { command: exact, args, env } // 找不到:返回预期路径,spawnSidecar 会给出清晰"binary not found"错误
}

/** 与 desktop/scripts/build-sidecar.ts 同款 target triple(命名一致才能在包里找到二进制)。 */
function sidecarTriple(): string {
  const p = process.platform, a = process.arch
  if (p === 'darwin' && a === 'arm64') return 'aarch64-apple-darwin'
  if (p === 'darwin' && a === 'x64') return 'x86_64-apple-darwin'
  if (p === 'win32' && a === 'x64') return 'x86_64-pc-windows-msvc'
  if (p === 'win32' && a === 'arm64') return 'aarch64-pc-windows-msvc'
  if (p === 'linux' && a === 'x64') return 'x86_64-unknown-linux-gnu'
  return `${a}-${p}`
}

async function startSidecar(): Promise<void> {
  serverPort = await reserveServerPort(SERVER_BIND_HOST, PREFERRED_PORTS)
  sidecar = spawnSidecar(buildSidecarPlan(serverPort))
  sidecar.stdout.on('data', d => process.stdout.write(`[sidecar] ${d}`))
  sidecar.stderr.on('data', d => process.stderr.write(`[sidecar] ${d}`))
  sidecar.on('exit', code => { if (code) console.error(`[sidecar] exited code=${code}`) })
  await waitForServer(SERVER_BIND_HOST, serverPort, 30_000)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    title: '球房管家',
    // macOS 原生质感:隐藏式标题栏 + 原生红绿灯;Windows 用叠加标题栏
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  void mainWindow.loadURL(`http://${SERVER_BIND_HOST}:${serverPort}/`)
  mainWindow.on('closed', () => { mainWindow = null })
}

/** 让主窗口回到前台(托盘/菜单"显示"共用);窗口没了就重建。 */
function showMainWindow(): void {
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    createWindow()
  }
}

/** 原生应用菜单(§8/§3.402 原生能力):macOS 走标准 app 菜单模板,Windows/Linux 给精简菜单。 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `关于 ${APP_NAME}` },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${APP_NAME}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${APP_NAME}` },
      ],
    })
  }

  template.push({
    label: '文件',
    submenu: [
      {
        label: '选择工作区…',
        accelerator: 'CmdOrCtrl+O',
        click: () => { void mainWindow?.webContents.send('desktop:menu', 'pick-workspace') },
      },
      { type: 'separator' },
      isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' },
    ],
  })

  template.push({
    label: '编辑',
    submenu: [
      { role: 'undo', label: '撤销' },
      { role: 'redo', label: '重做' },
      { type: 'separator' },
      { role: 'cut', label: '剪切' },
      { role: 'copy', label: '复制' },
      { role: 'paste', label: '粘贴' },
      { role: 'selectAll', label: '全选' },
    ],
  })

  template.push({
    label: '视图',
    submenu: [
      { role: 'reload', label: '重新加载' },
      { role: 'toggleDevTools', label: '开发者工具' },
      { type: 'separator' },
      { role: 'resetZoom', label: '实际大小' },
      { role: 'zoomIn', label: '放大' },
      { role: 'zoomOut', label: '缩小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全屏' },
    ],
  })

  template.push({
    label: '窗口',
    submenu: [
      { role: 'minimize', label: '最小化' },
      { role: 'zoom', label: '缩放' },
      ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const, label: '前置全部窗口' }] : []),
    ],
  })

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 系统托盘(§8 原生能力):非 macOS 常驻托盘,右键菜单显示/退出;macOS 用 Dock,不建托盘。
 *  没有图标资源时用空 nativeImage 兜底,保证不因缺图崩溃(托盘用系统默认呈现)。 */
function createTray(): void {
  if (process.platform === 'darwin') return // macOS 靠 Dock,不额外占用菜单栏
  try {
    tray = new Tray(nativeImage.createEmpty())
    tray.setToolTip(APP_NAME)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `显示 ${APP_NAME}`, click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]))
    tray.on('click', showMainWindow)
  } catch (err) {
    console.error('[main] 托盘创建失败(忽略):', err)
  }
}

/** 集中注册 IPC(白名单 + 无 payload 或 payload 校验;§3.402 桌面壳架构:主↔渲染只走白名单通道)。 */
function registerIpc(): void {
  // 原生文件夹选择器(§7 用户选择工作区):无 payload,返回选中目录或 null。
  ipcMain.handle('desktop:pickWorkspace', async () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择工作区文件夹' })
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })
}

async function boot(): Promise<void> {
  try {
    registerIpc()
    buildAppMenu()
    await startSidecar()
    createWindow()
    createTray()
  } catch (err) {
    console.error('[main] 启动失败:', err)
    app.quit()
  }
}

app.whenReady().then(boot).catch(err => { console.error(err); app.quit() })

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (sidecar) { killSidecar(sidecar, true); sidecar = null }
  if (tray) { tray.destroy(); tray = null }
})
