import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
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
  // prod:随包编译二进制(build-sidecar 产物,放在 resources/binaries)
  const triple = `${platform() === 'win32' ? 'windows' : platform() === 'darwin' ? 'darwin' : 'linux'}`
  const binName = `backend-sidecar-${triple}${platform() === 'win32' ? '.exe' : ''}`
  const binary = join(process.resourcesPath, 'binaries', binName)
  return { command: existsSync(binary) ? binary : binName, args, env }
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
