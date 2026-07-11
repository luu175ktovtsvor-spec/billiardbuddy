import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, Tray, nativeImage, screen, shell, type MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { platform } from 'node:os'
import {
  SERVER_BIND_HOST,
  reserveServerPort,
  spawnSidecar,
  waitForServer,
  SidecarSupervisor,
  type SidecarPlan,
} from './services/sidecarManager'
import { installProcessCrashGuards, installAppCrashGuards } from './services/crashGuard'
// 桌面基建(对齐 cc-haha,能抄就抄):窗口状态持久化 / 防休眠 / 钥匙串弹窗拦截 / 导航守卫 / Windows 通知身份 / 单实例聚焦。
import { readWindowState, windowOptionsFromState, restoreWindowMaximized, installWindowStatePersistence, MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT } from './services/windows'
import { startPreventSleep, stopPreventSleep, forceStopPreventSleep, isPreventingSleep } from './services/preventSleep'
import { installMacOsChromiumKeychainPromptGuard } from './services/keychain'
import { installMainWindowNavigationGuards } from './services/navigationGuards'
import { applyWindowsAppUserModelId } from './services/appIdentity'
import { acquireSingleInstanceLock } from './services/singleInstance'
import { resolveCredentialKey } from './services/credentialKey'

const here = dirname(fileURLToPath(import.meta.url))
const PREFERRED_PORTS = [8850, 8851, 8852, 8877]

let sidecarSupervisor: SidecarSupervisor | null = null
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let serverPort = 0
let sidecarDownNotified = false

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
  // 凭据 at-rest 加密密钥(DEK):主进程用 safeStorage(底层 macOS Keychain / Windows DPAPI)保护一把随机 DEK、
  // 以密文落盘 userData/credential-key.enc,启动时解出后经环境 QF_CRED_KEY 传给 sidecar;sidecar 用它 AES-256-GCM
  // 加密 providers.json 里的 apiKey/authToken(密文落盘,不再明文)。safeStorage 不可用时不传 → sidecar 回退明文(不倒退)。
  try {
    const credKey = resolveCredentialKey(safeStorage, join(app.getPath('userData'), 'credential-key.enc'))
    if (credKey) env.QF_CRED_KEY = credKey
    else console.warn('[main] safeStorage 不可用,凭据将以明文落盘(providers.json)。')
  } catch (err) {
    console.error('[main] 凭据加密密钥初始化失败,回退明文存储:', err)
  }
  // 显式给 sidecar 一个稳定可写的 cwd:打包后从 Finder/开始菜单启动,Electron 进程 cwd=`/` 或 `/Applications`,
  // 若不显式传,sidecar 继承这个坏 cwd 会导致相对路径解析/落盘失败。userData 目录永远存在且可写。
  const cwd = app.getPath('userData')
  const args = ['server', '--host', SERVER_BIND_HOST, '--port', String(port)]
  if (!app.isPackaged) {
    // dev:用 bun 直跑 sidecar 入口(bun 绝对路径)。内置 env 显式指到仓库 desktop/bundled.env:
    // sidecar 的 cwd=userData,靠 cwd 相对路径永远指不到仓库文件(envLoader 的候选链会先认这个显式路径)。
    const devBundledEnv = join(here, '../bundled.env')
    if (existsSync(devBundledEnv)) env.QF_BUNDLED_ENV = devBundledEnv
    return { command: resolveBun(), args: ['run', join(here, '../sidecars/backend-sidecar.ts'), ...args], env, cwd }
  }
  // prod:随包编译二进制(build-sidecar 产物,放在 resources/binaries,命名用完整 target triple)。
  const binariesDir = join(process.resourcesPath, 'binaries')
  const exact = join(binariesDir, `backend-sidecar-${sidecarTriple()}${platform() === 'win32' ? '.exe' : ''}`)
  if (existsSync(exact)) return { command: exact, args, env, cwd }
  // 兜底:扫 binaries 目录里匹配当前平台的 backend-sidecar-*(triple 未精确命中时)。
  const platformMark = platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'apple-darwin' : 'linux'
  try {
    const match = readdirSync(binariesDir).find(f => f.startsWith('backend-sidecar-') && f.includes(platformMark))
    if (match) return { command: join(binariesDir, match), args, env, cwd }
  } catch { /* 目录不存在 */ }
  return { command: exact, args, env, cwd } // 找不到:返回预期路径,spawnSidecar 会给出清晰"binary not found"错误
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
  // 端口只抢一次并全程复用:sidecar 崩溃重启时用同一个口拉起,renderer 的 baseUrl 不失效、
  // 现有 WS 指数退避重连即可自动复连。
  serverPort = await reserveServerPort(SERVER_BIND_HOST, PREFERRED_PORTS)
  sidecarSupervisor = new SidecarSupervisor(
    () => spawnSidecar(buildSidecarPlan(serverPort)),
    {
      onSpawn: (child) => {
        child.stdout.on('data', d => process.stdout.write(`[sidecar] ${d}`))
        child.stderr.on('data', d => process.stderr.write(`[sidecar] ${d}`))
      },
      onExit: (code, willRestart) => {
        if (code) console.error(`[sidecar] exited code=${code}${willRestart ? '(将自动重启)' : ''}`)
      },
      onRestartScheduled: (attempt, delayMs) => {
        console.warn(`[sidecar] 意外退出,${Math.round(delayMs / 1000)}s 后第 ${attempt} 次重启`)
      },
      onGaveUp: (restarts) => {
        console.error(`[sidecar] 短时间内连续崩溃 ${restarts} 次,已停止自动重启`)
        notifySidecarDown()
      },
    },
  )
  sidecarSupervisor.start()
  await waitForServer(SERVER_BIND_HOST, serverPort, 30_000)
}

/** sidecar 反复崩溃、放弃自动重启时提示用户(一次性,避免弹窗风暴)。 */
function notifySidecarDown(): void {
  if (sidecarDownNotified) return
  sidecarDownNotified = true
  const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
  const opts = {
    type: 'error' as const,
    title: '后端服务已停止',
    message: '后端服务多次异常退出,已暂停自动重启。',
    detail: '请重启本应用。如果反复出现,请把这条信息反馈给我们。',
    buttons: ['重启应用', '暂不'],
    defaultId: 0,
    cancelId: 1,
  }
  const handleChoice = (index: number) => { if (index === 0) { app.relaunch(); app.exit(0) } }
  if (win) void dialog.showMessageBox(win, opts).then(r => handleChoice(r.response))
  else void dialog.showMessageBox(opts).then(r => handleChoice(r.response))
}

function createWindow(): void {
  // 窗口状态持久化:读回上次的尺寸/位置(漂到屏外或换屏时已在 readWindowState 内校正/丢弃),没有历史就用默认尺寸。
  const restoredState = readWindowState(app, screen.getAllDisplays())
  const bounds = windowOptionsFromState(restoredState)
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
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
  // 上次是最大化的就恢复最大化。
  restoreWindowMaximized(mainWindow, restoredState)
  // 导航守卫(安全):window.open/外链走系统浏览器,拒绝渲染进程弹出不受控子窗口。
  installMainWindowNavigationGuards(mainWindow.webContents, { openExternal: (url) => { void shell.openExternal(url) } })
  // 移动/缩放/关闭时保存窗口状态(去抖写盘)。
  installWindowStatePersistence(app, mainWindow)
  loadRenderer(mainWindow)
  mainWindow.on('closed', () => { mainWindow = null })
}

/** 前端加载切换(过渡式,别破坏现有 vanilla):
 *  - QF_UI_REACT=1 → React 壳:优先 ELECTRON_RENDERER_URL(Vite dev HMR),否则 file:// 加载 renderer-dist;
 *    React 通过 IPC runtime:getServerUrl 拿 sidecar 地址再 fetch/WS(前端与 sidecar 解耦)。
 *  - 默认(未设 env) → 现有 vanilla:loadURL(sidecar http),same-origin 相对路径,行为完全不变。 */
function loadRenderer(win: BrowserWindow): void {
  if (process.env.QF_UI_REACT === '1') {
    const devUrl = process.env.ELECTRON_RENDERER_URL // Vite dev server(HMR),仅 loopback
    if (devUrl) { void win.loadURL(devUrl); return }
    const entry = join(here, '..', 'renderer-dist', 'index.html')
    if (existsSync(entry)) { void win.loadFile(entry); return }
    console.error(`[main] QF_UI_REACT=1 但缺 ${entry};回退 vanilla。请先 bun run ui:build。`)
  }
  void win.loadURL(`http://${SERVER_BIND_HOST}:${serverPort}/`)
}

/** 重载主窗口内容(渲染进程崩溃恢复用):窗口还在就 reload,没了就重建。返回是否发起了恢复。 */
function reloadMainWindow(): boolean {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload()
    return true
  }
  createWindow()
  return true
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
  // 后端地址发现(对齐 cc runtime:getServerUrl):main 已 reserveServerPort 抢到 serverPort,
  // React 壳(QF_UI_REACT,file:// 加载)经此拿 sidecar 地址再 fetch/WS。vanilla 默认路径不用它,注册无副作用。
  ipcMain.handle('runtime:getServerUrl', () => `http://${SERVER_BIND_HOST}:${serverPort}`)

  // 原生文件夹选择器(§7 用户选择工作区):无 payload,返回选中目录或 null。
  ipcMain.handle('desktop:pickWorkspace', async () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '选择工作区文件夹' })
    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })

  // 原生视频文件多选(剪视频看板导入素材):返回选中视频的绝对路径数组或 null。
  ipcMain.handle('desktop:pickVideoFiles', async () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要剪的视频素材',
      filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'flv', 'wmv', '3gp'] }],
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
  })

  // 通用「文件和文件夹」多选(对话框附件:把选中路径插进输入框,让本机 agent 去读)。文件夹与文件都可选(macOS 原生支持同时)。
  ipcMain.handle('desktop:pickPaths', async () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      title: '选择文件或文件夹',
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths
  })

  // 防休眠:长任务(生图/渲染/长 agent 循环)开始时调 start、结束时调 stop,阻止系统睡眠打断任务。
  // 引用计数式,可并发多个长任务;渲染层从 desktopHost.preventSleep.start()/stop() 成对调用。
  ipcMain.handle('desktop:preventSleep:start', () => { startPreventSleep(); return isPreventingSleep() })
  ipcMain.handle('desktop:preventSleep:stop', () => { stopPreventSleep(); return isPreventingSleep() })
}

async function boot(): Promise<void> {
  try {
    // Windows 通知身份:必须在建窗口前设好,否则原生 toast 通知不显示应用名/图标。
    applyWindowsAppUserModelId(app)
    // app 级崩溃兜底:渲染进程崩溃自动重载恢复、子进程挂掉记录。
    installAppCrashGuards(app, {
      reloadWindow: reloadMainWindow,
      onReloadGaveUp: () => notifySidecarDown(),
    })
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

// process 级全局兜底:未捕获异常/未处理 Promise 拒绝只记录、不静默崩;尽早挂,好接住启动早期的错。
installProcessCrashGuards({
  onFirstFatal: (kind, error) => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    const message = error instanceof Error ? error.message : String(error)
    const opts = {
      type: 'warning' as const,
      title: '出了点小状况',
      message: '程序遇到一个内部错误,但仍在继续运行。',
      detail: `${kind}: ${message}\n\n如果界面异常,可从「视图 → 重新加载」恢复。`,
      buttons: ['知道了'],
    }
    // app 未 ready 时 dialog 不可用,吞掉即可(已有 console 记录)。
    try { if (win) void dialog.showMessageBox(win, opts); else void dialog.showMessageBox(opts) } catch { /* app 未 ready */ }
  },
})

// macOS 钥匙串弹窗拦截:必须在 app ready 前追加命令行开关才生效。
installMacOsChromiumKeychainPromptGuard(app)

// 单实例聚焦:拿不到锁说明已有实例在跑(内部已 app.quit()),这里直接不再进入启动流程。
if (acquireSingleInstanceLock(app, showMainWindow)) {
  app.whenReady().then(boot).catch(err => { console.error(err); app.quit() })
}

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  forceStopPreventSleep()
  // 主动停守护:标记 stopped 后 sidecar 退出不再触发重启,并同步杀干净子进程。
  if (sidecarSupervisor) { sidecarSupervisor.stop(true); sidecarSupervisor = null }
  if (tray) { tray.destroy(); tray = null }
})
