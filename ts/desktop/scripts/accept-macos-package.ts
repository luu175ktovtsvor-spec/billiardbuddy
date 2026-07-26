import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { auditPackagedResources } from './audit-packaged-resources'
import { waitForReadyProductWindow } from './package-window-smoke'
import { startPackageAuthGateway, type PackageAuthGateway } from './package-auth-gateway'

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} 退出码为 ${String(result.status)}`)
}

function parseDmgPath(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--dmg' || !argv[1]) {
    throw new Error('用法: bun run accept:package:mac -- --dmg <BilliardBuddy.dmg>')
  }
  const dmgPath = resolve(argv[1])
  if (!dmgPath.endsWith('.dmg')) throw new Error('macOS 成品验收需要 .dmg 安装包')
  return dmgPath
}

async function terminate(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return
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

async function main() {
  if (process.platform !== 'darwin') throw new Error('macOS 成品验收只能在 macOS 运行')
  const dmgPath = parseDmgPath(process.argv.slice(2))
  const tempRoot = mkdtempSync(join(tmpdir(), 'billiardbuddy-package-acceptance-'))
  const mountDir = join(tempRoot, 'mounted')
  const installDir = join(tempRoot, 'installed')
  const configDir = join(tempRoot, 'config')
  const userDataDir = join(tempRoot, 'user-data')
  const smokeLog = join(tempRoot, 'window-smoke.jsonl')
  const installedApp = join(installDir, 'BilliardBuddy.app')
  let mounted = false
  let child: ChildProcess | null = null
  let authGateway: PackageAuthGateway | null = null

  try {
    mkdirSync(mountDir)
    mkdirSync(installDir)
    mkdirSync(configDir)
    mkdirSync(userDataDir)
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountDir, dmgPath])
    mounted = true
    const mountedApp = join(mountDir, 'BilliardBuddy.app')
    auditPackagedResources({
      platform: 'darwin',
      resourcesDir: join(mountedApp, 'Contents', 'Resources'),
    })
    run('ditto', [mountedApp, installedApp])
    run('codesign', ['--verify', '--deep', '--strict', installedApp])
    run('hdiutil', ['detach', mountDir])
    mounted = false
    authGateway = await startPackageAuthGateway()

    child = spawn(join(installedApp, 'Contents', 'MacOS', 'BilliardBuddy'), [
      `--user-data-dir=${userDataDir}`,
    ], {
      env: {
        ...process.env,
        BILLIARDBUDDY_CONFIG_DIR: configDir,
        BB_ELECTRON_DISABLE_SINGLE_INSTANCE_LOCK: '1',
        BB_ELECTRON_WINDOW_SMOKE_LOG: smokeLog,
        BB_GATEWAY_URL: authGateway.url,
        BB_GATEWAY_BOOTSTRAP_CREDENTIAL: authGateway.bootstrapCredential,
        BB_LICENSE_KEY: authGateway.licenseKey,
        NODE_EXTRA_CA_CERTS: authGateway.caPath,
      },
      stdio: 'inherit',
    })
    const finalWindow = await waitForReadyProductWindow(smokeLog)
    console.log(JSON.stringify({
      accepted: true,
      package: basename(dmgPath),
      installedCopy: true,
      window: finalWindow,
    }))
  } finally {
    await terminate(child)
    await authGateway?.close()
    if (mounted) {
      spawnSync('hdiutil', ['detach', mountDir], { stdio: 'ignore' })
    }
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  await main()
}
