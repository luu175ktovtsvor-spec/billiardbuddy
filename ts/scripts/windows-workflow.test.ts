import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

type WorkflowStep = {
  name?: string
  if?: string
  run?: string
  env?: Record<string, string>
  uses?: string
  with?: Record<string, unknown>
}

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

const workflowPath = path.resolve(
  import.meta.dir,
  '../../.github/workflows/desktop-build-win.yml',
)
const macWorkflowPath = path.resolve(
  import.meta.dir,
  '../../.github/workflows/desktop-build-mac.yml',
)
const baselineScriptPath = path.resolve(
  import.meta.dir,
  '../desktop/scripts/prepare-published-windows-upgrade-baseline.ps1',
)
const installerRunnerPath = path.resolve(
  import.meta.dir,
  '../desktop/scripts/windows-installer-runner.ps1',
)
const upgradeAcceptancePath = path.resolve(
  import.meta.dir,
  '../desktop/scripts/accept-windows-upgrade.ps1',
)
const updateRecoveryAcceptancePath = path.resolve(
  import.meta.dir,
  '../desktop/scripts/accept-windows-update-recovery.ps1',
)
const localMacBuildPath = path.resolve(
  import.meta.dir,
  '../desktop/scripts/build-macos-arm64.sh',
)
const desktopPackagePath = path.resolve(import.meta.dir, '../desktop/package.json')
const nsisMultiUserTemplatePath = path.resolve(
  import.meta.dir,
  '../desktop/node_modules/app-builder-lib/templates/nsis/multiUser.nsh',
)

function steps(): WorkflowStep[] {
  const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow
  return workflow.jobs?.['verify-and-build']?.steps ?? []
}

function macSteps(): WorkflowStep[] {
  const workflow = parse(readFileSync(macWorkflowPath, 'utf8')) as Workflow
  return workflow.jobs?.['verify-and-build']?.steps ?? []
}

describe('Desktop release workflow contract', () => {
  test('audits tracked sources before injecting build-only inputs', () => {
    const workflowSteps = steps()
    const auditIndex = workflowSteps.findIndex(step => step.run?.includes('check-release-tracked-files.ts'))
    const injectionIndex = workflowSteps.findIndex(step => step.run?.includes('BB_WINDOWS_MEDIA_TOOLCHAIN_SHA256'))

    expect(auditIndex).toBeGreaterThanOrEqual(0)
    expect(injectionIndex).toBeGreaterThan(auditIndex)
  })

  test('requires and validates every build-only input', () => {
    const preparation = steps().find(step => step.run?.includes('BB_WINDOWS_MEDIA_TOOLCHAIN_SHA256'))
    expect(preparation?.env).toEqual(expect.objectContaining({
      BB_RELEASE_UPLOAD_SSH_KEY_B64: '${{ secrets.BB_RELEASE_UPLOAD_SSH_KEY_B64 }}',
      BB_WINDOWS_MEDIA_TOOLCHAIN_URL: '${{ secrets.BB_WINDOWS_MEDIA_TOOLCHAIN_URL }}',
      BB_WINDOWS_MEDIA_TOOLCHAIN_SHA256: '${{ secrets.BB_WINDOWS_MEDIA_TOOLCHAIN_SHA256 }}',
    }))
    expect(preparation?.run).toContain('BB_RELEASE_UPLOAD_SSH_KEY_B64')
    expect(preparation?.run).toContain('GW_APP_CREDENTIALS')
    expect(preparation?.run).toContain('GW_LICENSE_PROVISIONING')
    expect(preparation?.run).toContain('BB_WINDOWS_MEDIA_TOOLCHAIN_URL')
    expect(preparation?.run).toContain('Get-FileHash -Algorithm SHA256')
    expect(preparation?.run).toContain('media-toolchain-source.json')
    expect(preparation?.run).toContain('product-secrets.json')
    expect(preparation?.run).toContain('BB_MEDIA_TOOLCHAIN_SOURCE_DIR')
  })

  test('always removes temporary secrets and media inputs', () => {
    const cleanup = steps().find(step => step.name === '清理临时凭据与媒体工具链')
    expect(cleanup?.if).toBe('always()')
    expect(cleanup?.run).toContain('product-secrets.json')
    expect(cleanup?.run).toContain('billiardbuddy-release-upload')
    expect(cleanup?.run).toContain('billiardbuddy-media-toolchain.zip')
    expect(cleanup?.run).toContain('billiardbuddy-media-toolchain')
    expect(cleanup?.run).toContain('billiardbuddy-published-0.4.9-installer')
  })

  test('releases unpacked audit files before launching the Windows installer', () => {
    const workflowSteps = steps()
    const unpack = workflowSteps.find(step => step.name === '解包并审计 Windows 成品')
    expect(unpack?.run).toContain('Remove-Item -LiteralPath $installerAuditDir, $appAuditDir')
    expect(unpack?.run).toContain('finally')
  })

  test('isolates NSIS temp files and reports Windows crash evidence', () => {
    const runner = readFileSync(installerRunnerPath, 'utf8')
    expect(runner).toContain("SetEnvironmentVariable('TEMP', $nsisTemp, 'Process')")
    expect(runner).toContain("SetEnvironmentVariable('TMP', $nsisTemp, 'Process')")
    expect(runner).toContain("ProviderName -in @('Application Error', 'Windows Error Reporting')")
    expect(runner).toContain("LogName = 'Microsoft-Windows-Windows Defender/Operational'")
    expect(runner).toContain("$arguments = @('/S') + $AdditionalArguments + @(\"/D=$InstallDir\")")

    for (const scriptName of [
      'accept-windows-package.ps1',
      'accept-windows-upgrade.ps1',
      'accept-windows-update-recovery.ps1',
    ]) {
      const script = readFileSync(path.resolve(import.meta.dir, '../desktop/scripts', scriptName), 'utf8')
      expect(script).toContain(". (Join-Path $PSScriptRoot 'windows-installer-runner.ps1')")
      expect(script).toContain('Invoke-BilliardBuddyWindowsInstaller')
    }
  })

  test('pins the builder template with the bounded Windows path copy', () => {
    const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, 'utf8')) as {
      build?: { nsis?: { customNsisBinary?: unknown } }
      devDependencies?: Record<string, string>
    }
    expect(desktopPackage.build?.nsis?.customNsisBinary).toBeUndefined()
    expect(desktopPackage.devDependencies?.['electron-builder']).toBe('26.15.7')
    expect(desktopPackage.devDependencies?.['electron-builder-squirrel-windows']).toBe('26.15.7')
    const multiUserTemplate = readFileSync(nsisMultiUserTemplatePath, 'utf8')
    expect(multiUserTemplate).toContain('KERNEL32::lstrcpynW')
    expect(multiUserTemplate).not.toContain("System::Call '*$2(&w${NSIS_MAX_STRLEN} .s)'")
  })

  test('proves the current installer before downloading the published upgrade baseline', () => {
    const workflowSteps = steps()
    const baselineIndex = workflowSteps.findIndex(step => step.name === '准备已发布的 Windows 升级基线包')
    const currentIndex = workflowSteps.findIndex(step => step.run?.includes('bun run electron:package'))
    const installIndex = workflowSteps.findIndex(step => step.name === '安装、启动并卸载 Windows 成品')
    const upgradeIndex = workflowSteps.findIndex(step => step.name === '从最老支持版本升级并回退 Windows 成品')
    expect(baselineIndex).toBeGreaterThanOrEqual(0)
    expect(workflowSteps[baselineIndex]?.run).toContain('prepare-published-windows-upgrade-baseline.ps1')
    expect(workflowSteps[baselineIndex]?.run).not.toContain('$LASTEXITCODE')
    expect(currentIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeGreaterThan(currentIndex)
    expect(baselineIndex).toBeGreaterThan(installIndex)
    expect(upgradeIndex).toBeGreaterThan(baselineIndex)
    expect(workflowSteps[upgradeIndex]?.run).toContain('accept-windows-upgrade.ps1')
    expect(workflowSteps[upgradeIndex]?.run).toContain('BB_OLD_WINDOWS_INSTALLER')
    const baselineScript = readFileSync(baselineScriptPath, 'utf8')
    expect(baselineScript).toContain('https://zzyppz.cn/desktop/BilliardBuddy-0.4.9-win-x64.exe')
    expect(baselineScript).toContain('$expectedSize = 239427245')
    expect(baselineScript).toContain('XJViXgG33Ps+pyjMT4xbLqDrhN9mTEdIqA3qNJ3JKqgqbxk2k23OjxLGUxC/bsK3GVDrwTbxZ17KuF3nazCIHw==')
    expect(baselineScript).toContain('BB_OLD_WINDOWS_INSTALLER=$installerPath')
  })

  test('waits for the upgraded Product Server before probing its renderer API', () => {
    const acceptance = readFileSync(upgradeAcceptancePath, 'utf8')
    const readyIndex = acceptance.indexOf('Wait-CurrentReady -SmokeLog $smokeLog -Process $script:appProcess')
    const probeIndex = acceptance.indexOf('$output = @(& bun @arguments)')
    expect(readyIndex).toBeGreaterThanOrEqual(0)
    expect(probeIndex).toBeGreaterThan(readyIndex)
    expect(acceptance.match(/Install-Package .* -AllUsers/g)).toHaveLength(3)
    expect(acceptance).toContain("BB_ELECTRON_WINDOW_SMOKE_INCLUDE_ERROR_DETAILS = '1'")
    expect(acceptance).toContain('$failure[0] | ConvertTo-Json -Compress -Depth 5')
  })

  test('proves Windows update download recovery after upgrade acceptance', () => {
    const workflowSteps = steps()
    const upgradeIndex = workflowSteps.findIndex(step => step.name === '从最老支持版本升级并回退 Windows 成品')
    const recoveryIndex = workflowSteps.findIndex(step => step.name === '模拟更新下载中断并验证 Windows 重启恢复')
    expect(upgradeIndex).toBeGreaterThanOrEqual(0)
    expect(recoveryIndex).toBeGreaterThan(upgradeIndex)
    expect(workflowSteps[recoveryIndex]?.run).toContain('accept-windows-update-recovery.ps1')
    const recoveryAcceptance = readFileSync(updateRecoveryAcceptancePath, 'utf8')
    expect(recoveryAcceptance).toContain("BB_ELECTRON_WINDOW_SMOKE_INCLUDE_ERROR_DETAILS = '1'")
    expect(recoveryAcceptance).toContain('$failure[0] | ConvertTo-Json -Compress -Depth 5')
  })

  test('proves macOS update download recovery after installed-package acceptance', () => {
    const workflowSteps = macSteps()
    const installIndex = workflowSteps.findIndex(step => step.run?.includes('accept-macos-package.ts'))
    const recoveryIndex = workflowSteps.findIndex(step => step.name === '模拟更新下载中断并验证重启恢复')
    expect(installIndex).toBeGreaterThanOrEqual(0)
    expect(recoveryIndex).toBeGreaterThan(installIndex)
    expect(workflowSteps[recoveryIndex]?.run).toContain('accept-macos-update-recovery.ts')
    expect(workflowSteps[recoveryIndex]?.run).toContain('--dmg')
    expect(workflowSteps[recoveryIndex]?.run).toContain('--zip')
  })

  test('ad-hoc signs the complete local macOS app without notarization', () => {
    const localMacBuild = readFileSync(localMacBuildPath, 'utf8')
    expect(localMacBuild).toContain('BUILDER_ARGS+=(-c.mac.identity=- -c.mac.notarize=false)')
    expect(localMacBuild).toContain('CSC_IDENTITY_AUTO_DISCOVERY=false')
  })

  test('verifies the public Windows update feed after publishing', () => {
    const workflowSteps = steps()
    const publishIndex = workflowSteps.findIndex(step => step.name === '发布 Windows 安装包与更新清单')
    const verifyIndex = workflowSteps.findIndex(step => step.name === '验证正式 Windows 更新源')
    expect(publishIndex).toBeGreaterThanOrEqual(0)
    expect(verifyIndex).toBeGreaterThan(publishIndex)
    expect(workflowSteps[verifyIndex]?.if).toBe(workflowSteps[publishIndex]?.if)
    expect(workflowSteps[verifyIndex]?.run).toContain('verify-published-update.ts')
    expect(workflowSteps[verifyIndex]?.run).toContain('https://zzyppz.cn/desktop')
  })
})
