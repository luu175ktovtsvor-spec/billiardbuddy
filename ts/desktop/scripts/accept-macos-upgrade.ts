import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { auditPackagedResources } from './audit-packaged-resources'
import { waitForReadyProductWindow } from './package-window-smoke'
import desktopPackage from '../package.json'
import { useTemporaryAcceptanceKeychain, type TemporaryAcceptanceKeychain } from './macos-acceptance-keychain'
import { startPackageAuthGateway, type PackageAuthGateway } from './package-auth-gateway'
import { OLDEST_SUPPORTED_PRODUCT_VERSION } from '../../src/server/services/productStorageMigrations'
import {
  seedInterruptedProductStorage,
  verifyRollbackProductStorage,
  waitForProductStorageUpgrade,
} from './package-upgrade-storage'
import {
  reserveLoopbackPort as reservePort,
  terminatePackagedApp as terminate,
} from './packaged-renderer-driver'
import { probePackageRenderer } from './package-renderer-product-api'

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

async function launchAndVerify(
  appPath: string,
  configDir: string,
  userDataDir: string,
  useLegacyGateway: boolean,
  expectedTaskId?: string,
  createTaskWorkDir?: string,
): Promise<{ url: string, createdTaskId?: string }> {
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
        CLAUDE_CONFIG_DIR: configDir,
        QF_GATEWAY_URL: 'https://example.test/gw',
        QF_GATEWAY_TOKEN: 'YOUR_API_KEY_1234',
        QF_GATEWAY_MODEL: 'qwen3.5-plus',
      } : {}),
    },
    stdio: 'ignore',
  })
  try {
    return await probePackageRenderer({
      port,
      child,
      ...(expectedTaskId ? { expectedTaskId } : {}),
      ...(createTaskWorkDir ? { createTaskWorkDir } : {}),
    })
  } finally {
    await terminate(child)
  }
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
  const oldWorkspace = join(tempRoot, 'old-workspace')
  mkdirSync(configDir)
  mkdirSync(userDataDir)
  mkdirSync(oldWorkspace)
  let keychain: TemporaryAcceptanceKeychain | null = null
  let authGateway: PackageAuthGateway | null = null

  try {
    keychain = useTemporaryAcceptanceKeychain(tempRoot)
    installFromDmg(oldDmg, appPath, tempRoot)
    const oldVersion = packageVersion(appPath)
    if (oldVersion !== OLDEST_SUPPORTED_PRODUCT_VERSION) throw new Error(`最老支持包版本不正确: ${oldVersion}`)
    const oldLaunch = await launchAndVerify(appPath, configDir, userDataDir, true, undefined, oldWorkspace)
    if (!oldLaunch.createdTaskId) throw new Error('最老支持安装包没有返回真实任务标识')
    const upgradeEvidence = seedInterruptedProductStorage(configDir, oldLaunch.createdTaskId)

    installFromDmg(newDmg, appPath, tempRoot)
    const newVersion = packageVersion(appPath)
    if (newVersion !== desktopPackage.version) throw new Error(`当前包版本不正确: ${newVersion}`)
    auditPackagedResources({ platform: 'darwin', resourcesDir: join(appPath, 'Contents', 'Resources') })
    authGateway = await startPackageAuthGateway()
    const windowSmokeLog = join(tempRoot, 'current-window-smoke.jsonl')
    const currentRendererPort = await reservePort()
    const newChild = spawn(join(appPath, 'Contents', 'MacOS', 'BilliardBuddy'), [
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${currentRendererPort}`,
    ], {
      env: {
        ...process.env,
        BILLIARDBUDDY_CONFIG_DIR: configDir,
        BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK: '1',
        BB_ELECTRON_WINDOW_SMOKE_LOG: windowSmokeLog,
        BB_GATEWAY_URL: authGateway.url,
        BB_GATEWAY_BOOTSTRAP_CREDENTIAL: authGateway.bootstrapCredential,
        BB_LICENSE_KEY: authGateway.licenseKey,
        NODE_EXTRA_CA_CERTS: authGateway.caPath,
      },
      stdio: 'ignore',
    })
    let currentRendererUrl = ''
    let upgrade: { backupId: string, taskId: string }
    try {
      await waitForReadyProductWindow(windowSmokeLog)
      try {
        upgrade = await waitForProductStorageUpgrade(configDir, upgradeEvidence)
        currentRendererUrl = (await probePackageRenderer({
          port: currentRendererPort,
          child: newChild,
          expectedTaskId: upgrade.taskId,
        })).url
      } catch (error) {
        const backendFailure = backendFailureReason(windowSmokeLog)
        throw new Error(`${String(error)}${backendFailure ? `; ${backendFailure}` : ''}`)
      }
    } finally {
      await terminate(newChild)
    }

    installFromDmg(oldDmg, appPath, tempRoot)
    const rollbackLaunch = await launchAndVerify(appPath, configDir, userDataDir, true, upgrade.taskId)
    verifyRollbackProductStorage(configDir, upgrade.taskId)

    console.log(JSON.stringify({
      accepted: true,
      oldVersion,
      newVersion,
      interruptedMigrationRecovered: true,
      backupId: upgrade.backupId,
      migratedTaskId: upgrade.taskId,
      rollbackRelaunched: true,
      rendererUrls: [oldLaunch.url, currentRendererUrl, rollbackLaunch.url],
    }))
  } finally {
    await authGateway?.close()
    keychain?.restore()
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
