import { app, BrowserWindow } from 'electron'
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
let serverPort = 0

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

async function boot(): Promise<void> {
  try {
    await startSidecar()
    createWindow()
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
})
