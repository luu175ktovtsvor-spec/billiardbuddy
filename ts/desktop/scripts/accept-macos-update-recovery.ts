import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { auditPackagedResources } from './audit-packaged-resources'
import { useTemporaryAcceptanceKeychain, type TemporaryAcceptanceKeychain } from './macos-acceptance-keychain'
import { startPackageAuthGateway, type PackageAuthGateway } from './package-auth-gateway'
import { startPackageUpdateGateway, type PackageUpdateGateway } from './package-update-gateway'
import { waitForReadyProductWindow } from './package-window-smoke'
import {
  reserveLoopbackPort,
  terminatePackagedApp,
  waitForPackagedRenderer,
} from './packaged-renderer-driver'
import {
  attemptPackageUpdate,
  requireFailedPackageUpdate,
  requireRecoveredPackageUpdate,
} from './package-update-renderer-probe'

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'ignore' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 退出码为 ${String(result.status)}`)
}

function parseArgs(argv: string[]): { dmgPath: string, zipPath: string } {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !value || !['--dmg', '--zip'].includes(name)) {
      throw new Error('用法: bun run accept:update-recovery:mac -- --dmg <BilliardBuddy.dmg> --zip <BilliardBuddy.zip>')
    }
    values.set(name, value)
  }
  const dmgPath = values.get('--dmg')
  const zipPath = values.get('--zip')
  if (!dmgPath || !zipPath) throw new Error('更新恢复验收同时需要 DMG 和 ZIP')
  return { dmgPath: resolve(dmgPath), zipPath: resolve(zipPath) }
}

function installFromDmg(dmgPath: string, appPath: string, tempRoot: string): void {
  const mountDir = join(tempRoot, 'mounted')
  let mounted = false
  try {
    mkdirSync(mountDir)
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountDir, dmgPath])
    mounted = true
    mkdirSync(dirname(appPath), { recursive: true })
    run('ditto', [join(mountDir, 'BilliardBuddy.app'), appPath])
    auditPackagedResources({
      platform: 'darwin',
      resourcesDir: join(appPath, 'Contents', 'Resources'),
    })
    run('codesign', ['--verify', '--deep', '--strict', appPath])
  } finally {
    if (mounted) run('hdiutil', ['detach', mountDir])
  }
}

function configureLocalUpdateFeed(appPath: string, gateway: PackageUpdateGateway, cacheName: string): void {
  const updateConfigPath = join(appPath, 'Contents', 'Resources', 'app-update.yml')
  writeFileSync(updateConfigPath, [
    'provider: generic',
    `url: ${gateway.url}`,
    `updaterCacheDirName: ${cacheName}`,
    '',
  ].join('\n'))
  run('codesign', ['--force', '--deep', '--sign', '-', appPath])
  run('codesign', ['--verify', '--deep', '--strict', appPath])
}

function launchApp(input: {
  appPath: string
  configDir: string
  userDataDir: string
  smokeLog: string
  rendererPort: number
  authGateway: PackageAuthGateway
  certificatePin: string
}): ChildProcess {
  return spawn(join(input.appPath, 'Contents', 'MacOS', 'BilliardBuddy'), [
    `--user-data-dir=${input.userDataDir}`,
    `--remote-debugging-port=${input.rendererPort}`,
    `--ignore-certificate-errors-spki-list=${input.certificatePin}`,
  ], {
    env: {
      ...process.env,
      BILLIARDBUDDY_CONFIG_DIR: input.configDir,
      BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK: '1',
      BB_ELECTRON_WINDOW_SMOKE_LOG: input.smokeLog,
      BB_GATEWAY_URL: input.authGateway.url,
      BB_GATEWAY_BOOTSTRAP_CREDENTIAL: input.authGateway.bootstrapCredential,
      BB_LICENSE_KEY: input.authGateway.licenseKey,
      NODE_EXTRA_CA_CERTS: input.authGateway.caPath,
    },
    stdio: 'inherit',
  })
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS 更新恢复验收只能在 macOS 运行')
  const { dmgPath, zipPath } = parseArgs(process.argv.slice(2))
  const tempRoot = mkdtempSync(join(tmpdir(), 'billiardbuddy-update-recovery-'))
  const appPath = join(tempRoot, 'installed', 'BilliardBuddy.app')
  const configDir = join(tempRoot, 'config')
  const userDataDir = join(tempRoot, 'user-data')
  const updateCacheName = `billiardbuddy-updater-acceptance-${basename(tempRoot)}`
  const updateCacheDir = join(homedir(), 'Library', 'Caches', updateCacheName)
  let child: ChildProcess | null = null
  let keychain: TemporaryAcceptanceKeychain | null = null
  let authGateway: PackageAuthGateway | null = null
  let updateGateway: PackageUpdateGateway | null = null

  try {
    mkdirSync(configDir)
    mkdirSync(userDataDir)
    keychain = useTemporaryAcceptanceKeychain(tempRoot)
    installFromDmg(dmgPath, appPath, tempRoot)
    authGateway = await startPackageAuthGateway()
    updateGateway = await startPackageUpdateGateway(zipPath, { platform: 'mac' })
    configureLocalUpdateFeed(appPath, updateGateway, updateCacheName)
    const certificatePin = updateGateway.certificatePin

    const firstPort = await reserveLoopbackPort()
    const firstSmokeLog = join(tempRoot, 'first-window.jsonl')
    child = launchApp({
      appPath,
      configDir,
      userDataDir,
      smokeLog: firstSmokeLog,
      rendererPort: firstPort,
      authGateway,
      certificatePin,
    })
    await waitForReadyProductWindow(firstSmokeLog)
    const firstTarget = await waitForPackagedRenderer(firstPort, child)
    const failedAttempt = await attemptPackageUpdate(firstTarget)
    requireFailedPackageUpdate(failedAttempt, updateGateway.version)
    await terminatePackagedApp(child)
    child = null

    updateGateway.allowDownloads()
    const secondPort = await reserveLoopbackPort()
    const secondSmokeLog = join(tempRoot, 'second-window.jsonl')
    child = launchApp({
      appPath,
      configDir,
      userDataDir,
      smokeLog: secondSmokeLog,
      rendererPort: secondPort,
      authGateway,
      certificatePin,
    })
    await waitForReadyProductWindow(secondSmokeLog)
    const secondTarget = await waitForPackagedRenderer(secondPort, child)
    const recoveredAttempt = await attemptPackageUpdate(secondTarget)
    requireRecoveredPackageUpdate(recoveredAttempt, updateGateway.version)

    console.log(JSON.stringify({
      accepted: true,
      package: basename(dmgPath),
      updateArtifact: basename(zipPath),
      failedBeforeRestart: true,
      recoveredAfterRestart: true,
      updateVersion: updateGateway.version,
      interruptedRequests: updateGateway.requests.filter(request => !request.allowed).length,
      recoveredRequests: updateGateway.requests.filter(request => request.allowed).length,
    }))
  } finally {
    await terminatePackagedApp(child)
    await updateGateway?.close()
    await authGateway?.close()
    keychain?.restore()
    rmSync(updateCacheDir, { recursive: true, force: true })
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
