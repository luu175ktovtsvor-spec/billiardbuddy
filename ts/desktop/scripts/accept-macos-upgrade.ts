import { createServer } from 'node:net'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { auditPackagedResources } from './audit-packaged-resources'
import { waitForReadyProductWindow } from './package-window-smoke'
import desktopPackage from '../package.json'
import {
  CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
  OLDEST_SUPPORTED_PRODUCT_VERSION,
} from '../../src/server/services/productStorageMigrations'

type DevToolsTarget = {
  type?: unknown
  title?: unknown
  url?: unknown
  webSocketDebuggerUrl?: unknown
}

type ProductRuntimeSnapshot = {
  status?: unknown
  tasks?: Array<{ id?: unknown }>
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 退出码为 ${String(result.status)}`)
}

function parseArgs(argv: string[]): { oldDmg: string, newDmg: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !['--old-dmg', '--new-dmg'].includes(name)) {
      throw new Error('用法: bun run accept:upgrade:mac -- --old-dmg <0.4.9.dmg> --new-dmg <当前.dmg>')
    }
    values.set(name, value)
  }
  const oldDmg = values.get('--old-dmg')
  const newDmg = values.get('--new-dmg')
  if (!oldDmg || !newDmg) throw new Error('升级验收同时需要 --old-dmg 和 --new-dmg')
  return { oldDmg: resolve(oldDmg), newDmg: resolve(newDmg) }
}

function packageVersion(appPath: string): string {
  const result = spawnSync('plutil', [
    '-extract',
    'CFBundleShortVersionString',
    'raw',
    join(appPath, 'Contents', 'Info.plist'),
  ], { encoding: 'utf8' })
  if (result.error || result.status !== 0) throw new Error('安装包缺少发行版本')
  const version = result.stdout.trim()
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`安装包发行版本无效: ${version}`)
  return version
}

function installFromDmg(dmgPath: string, appPath: string, tempRoot: string): void {
  const mountDir = mkdtempSync(join(tempRoot, 'mount-'))
  let mounted = false
  try {
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountDir, dmgPath])
    mounted = true
    rmSync(appPath, { recursive: true, force: true })
    mkdirSync(dirname(appPath), { recursive: true })
    run('ditto', [join(mountDir, 'BilliardBuddy.app'), appPath])
    run('codesign', ['--verify', '--deep', '--strict', appPath])
  } finally {
    if (mounted) run('hdiutil', ['detach', mountDir])
    rmSync(mountDir, { recursive: true, force: true })
  }
}

async function reservePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法分配 renderer 验收端口')
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  return address.port
}

async function waitForRenderer(port: number, child: ChildProcess): Promise<DevToolsTarget> {
  const deadline = Date.now() + 60_000
  let lastError: unknown = new Error('DevTools 目标尚未就绪')
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`BilliardBuddy 在 renderer 就绪前退出: ${child.exitCode}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1_000),
      })
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`)
      const targets = await response.json() as DevToolsTarget[]
      const target = targets.find(value => value.type === 'page'
        && value.title === 'BilliardBuddy'
        && typeof value.url === 'string'
        && value.url.includes('/dist/index.html'))
      if (target) return target
      lastError = new Error('未找到正式 BilliardBuddy renderer')
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`安装包 renderer 未在 60 秒内就绪: ${String(lastError)}`)
}

async function evaluateInRenderer<T>(target: DevToolsTarget, expression: string): Promise<T> {
  if (typeof target.webSocketDebuggerUrl !== 'string') throw new Error('renderer 缺少 DevTools 调试地址')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  return await new Promise<T>((resolveValue, rejectValue) => {
    let settled = false
    const finish = (error?: unknown, value?: T) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      socket.close()
      if (error) rejectValue(error)
      else resolveValue(value as T)
    }
    const timeout = setTimeout(() => finish(new Error('renderer 产品 API 验收超时')), 30_000)
    socket.addEventListener('error', () => finish(new Error('无法连接 renderer DevTools')))
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }))
    })
    socket.addEventListener('message', event => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          id?: unknown
          error?: { message?: unknown }
          result?: {
            exceptionDetails?: { text?: unknown }
            result?: { value?: T, description?: unknown }
          }
        }
        if (payload.id !== 1) return
        if (payload.error) throw new Error(`renderer DevTools 调用失败: ${String(payload.error.message)}`)
        if (payload.result?.exceptionDetails) {
          throw new Error(`renderer 产品 API 调用失败: ${String(
            payload.result.result?.description ?? payload.result.exceptionDetails.text,
          )}`)
        }
        finish(undefined, payload.result?.result?.value)
      } catch (error) {
        finish(error)
      }
    })
  })
}

async function inspectProductRuntime(target: DevToolsTarget, expectedTaskId?: string): Promise<void> {
  const snapshot = await evaluateInRenderer<ProductRuntimeSnapshot>(target, `(async () => {
    const serverUrl = await window.desktopHost.runtime.getServerUrl()
    const response = await fetch(serverUrl.replace(/\\/$/, '') + '/api/product/tasks')
    const body = await response.json()
    return { status: response.status, tasks: body.tasks }
  })()`)
  if (snapshot.status !== 200 || !Array.isArray(snapshot.tasks)) {
    throw new Error('安装包没有返回可用的权威任务列表')
  }
  if (expectedTaskId && !snapshot.tasks.some(task => task.id === expectedTaskId)) {
    throw new Error(`安装包没有读到迁移任务: ${expectedTaskId}`)
  }
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>(resolveExit => child.once('exit', () => resolveExit())),
    new Promise<void>(resolveTimeout => setTimeout(resolveTimeout, 5_000)),
  ])
  if (child.exitCode === null) {
    child.kill('SIGKILL')
    await new Promise<void>((resolveExit, reject) => {
      child.once('exit', () => resolveExit())
      child.once('error', reject)
    })
  }
}

async function launchAndVerify(
  appPath: string,
  configDir: string,
  userDataDir: string,
  useLegacyGateway: boolean,
  expectedTaskId?: string,
): Promise<DevToolsTarget> {
  const port = await reservePort()
  const child = spawn(join(appPath, 'Contents', 'MacOS', 'BilliardBuddy'), [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
  ], {
    env: {
      ...process.env,
      BILLIARDBUDDY_CONFIG_DIR: configDir,
      BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK: '1',
      ...(useLegacyGateway ? {
        QF_GATEWAY_URL: 'https://example.test/gw',
        QF_GATEWAY_TOKEN: 'YOUR_API_KEY_1234',
        QF_GATEWAY_MODEL: 'qwen3.5-plus',
      } : {}),
    },
    stdio: 'ignore',
  })
  try {
    const target = await waitForRenderer(port, child)
    await inspectProductRuntime(target, expectedTaskId)
    return target
  } finally {
    await terminate(child)
  }
}

function seedInterruptedOldStorage(configDir: string): string {
  const productDir = join(configDir, 'billiardbuddy')
  const storePath = join(productDir, 'product-tasks.json')
  const backupId = 'v3-20260726T000000Z-a1b2c3d4'
  const backupDir = join(productDir, 'storage-migration-backups', backupId)
  const original = `${JSON.stringify({
    version: 1,
    tasks: {
      'fixture-core-v1': {
        title: 'Oldest supported package task',
        lifecycle: 'active',
        kind: 'main',
        createdAt: '2025-01-01T00:00:00.000Z',
        updatedAt: '2025-01-01T00:00:00.000Z',
        worktreeState: 'not_requested',
      },
    },
    sideTasks: {},
  }, null, 2)}\n`
  const journal = {
    schema_version: 1,
    target_version: CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION,
    backup_id: backupId,
    existing_paths: ['billiardbuddy/product-tasks.json'],
    backed_up_files: [{ path: 'billiardbuddy/product-tasks.json', mode: 0o600 }],
  }
  mkdirSync(dirname(storePath), { recursive: true })
  mkdirSync(join(backupDir, 'files', 'billiardbuddy'), { recursive: true })
  writeFileSync(join(backupDir, 'files', 'billiardbuddy', 'product-tasks.json'), original, { mode: 0o600 })
  writeFileSync(join(backupDir, 'manifest.json'), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(join(productDir, 'storage-migration-journal.json'), `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 })
  writeFileSync(storePath, '{"version":4,"tasks":{},"sideTasks":{}}\n', { mode: 0o600 })
  return original
}

async function waitForUpgrade(configDir: string, original: string): Promise<{ backupId: string }> {
  const productDir = join(configDir, 'billiardbuddy')
  const statePath = join(productDir, 'storage-migration-state.json')
  const deadline = Date.now() + 60_000
  let lastError: unknown = new Error('迁移状态尚未生成')
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      if (state.completed_version !== CURRENT_PRODUCT_STORAGE_MIGRATION_VERSION
        || state.oldest_supported_product_version !== OLDEST_SUPPORTED_PRODUCT_VERSION
        || typeof state.backup_id !== 'string') {
        throw new Error('迁移状态不符合发行合同')
      }
      if (existsSync(join(productDir, 'storage-migration-journal.json'))) {
        throw new Error('迁移日志未完成结算')
      }
      const store = JSON.parse(readFileSync(join(productDir, 'product-tasks.json'), 'utf8')) as {
        version?: unknown
        tasks?: Record<string, { title?: unknown }>
      }
      if (store.version !== 4 || store.tasks?.['fixture-core-v1']?.title !== 'Oldest supported package task') {
        throw new Error('旧任务没有迁移到当前存储版本')
      }
      const backup = readFileSync(join(
        productDir,
        'storage-migration-backups',
        state.backup_id,
        'files',
        'billiardbuddy',
        'product-tasks.json',
      ), 'utf8')
      if (backup !== original) throw new Error('升级备份没有保留恢复后的旧版本原始字节')
      return { backupId: state.backup_id }
    } catch (error) {
      lastError = error
    }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  throw new Error(`安装包升级未在 60 秒内完成: ${String(lastError)}`)
}

function backendFailureReason(windowSmokeLog: string): string | null {
  if (!existsSync(windowSmokeLog)) return null
  const reasons = readFileSync(windowSmokeLog, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line) as { reason?: unknown })
    .map(value => value.reason)
    .filter(reason => reason === 'backend-failed' || reason === 'backend-initialization-failed')
  return reasons.length > 0 ? String(reasons.at(-1)) : null
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS 升级验收只能在 macOS 运行')
  const { oldDmg, newDmg } = parseArgs(process.argv.slice(2))
  const tempRoot = mkdtempSync(join(tmpdir(), 'billiardbuddy-upgrade-acceptance-'))
  const appPath = join(tempRoot, 'installed', 'BilliardBuddy.app')
  const configDir = join(tempRoot, 'config')
  const userDataDir = join(tempRoot, 'user-data')
  mkdirSync(configDir)
  mkdirSync(userDataDir)

  try {
    installFromDmg(oldDmg, appPath, tempRoot)
    const oldVersion = packageVersion(appPath)
    if (oldVersion !== OLDEST_SUPPORTED_PRODUCT_VERSION) throw new Error(`最老支持包版本不正确: ${oldVersion}`)
    const oldRenderer = await launchAndVerify(appPath, configDir, userDataDir, true)
    const original = seedInterruptedOldStorage(configDir)

    installFromDmg(newDmg, appPath, tempRoot)
    const newVersion = packageVersion(appPath)
    if (newVersion !== desktopPackage.version) throw new Error(`当前包版本不正确: ${newVersion}`)
    auditPackagedResources({ platform: 'darwin', resourcesDir: join(appPath, 'Contents', 'Resources') })
    const windowSmokeLog = join(tempRoot, 'current-window-smoke.jsonl')
    const newChild = spawn(join(appPath, 'Contents', 'MacOS', 'BilliardBuddy'), [
      `--user-data-dir=${userDataDir}`,
    ], {
      env: {
        ...process.env,
        BILLIARDBUDDY_CONFIG_DIR: configDir,
        BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK: '1',
        BB_ELECTRON_WINDOW_SMOKE_LOG: windowSmokeLog,
      },
      stdio: 'ignore',
    })
    let currentRenderer: { url?: unknown }
    let upgrade: { backupId: string }
    try {
      currentRenderer = await waitForReadyProductWindow(windowSmokeLog)
      try {
        upgrade = await waitForUpgrade(configDir, original)
      } catch (error) {
        const backendFailure = backendFailureReason(windowSmokeLog)
        throw new Error(`${String(error)}${backendFailure ? `; ${backendFailure}` : ''}`)
      }
    } finally {
      await terminate(newChild)
    }

    installFromDmg(oldDmg, appPath, tempRoot)
    const rollbackRenderer = await launchAndVerify(appPath, configDir, userDataDir, true, 'fixture-core-v1')
    const rolledBackStore = JSON.parse(readFileSync(join(configDir, 'billiardbuddy', 'product-tasks.json'), 'utf8')) as {
      version?: unknown
      tasks?: Record<string, unknown>
    }
    if (rolledBackStore.version !== 4 || !rolledBackStore.tasks?.['fixture-core-v1']) {
      throw new Error('回退旧包后迁移数据不可读')
    }

    console.log(JSON.stringify({
      accepted: true,
      oldVersion,
      newVersion,
      interruptedMigrationRecovered: true,
      backupId: upgrade.backupId,
      rollbackRelaunched: true,
      rendererUrls: [oldRenderer.url, currentRenderer.url, rollbackRenderer.url],
    }))
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
