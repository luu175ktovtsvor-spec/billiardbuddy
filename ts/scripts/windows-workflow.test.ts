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
  '../desktop/scripts/build-windows-upgrade-baseline.ps1',
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
    expect(cleanup?.run).toContain('git worktree remove --force')
    expect(cleanup?.run).toContain('billiardbuddy-old-0.4.9-media')
    expect(cleanup?.run).toContain('billiardbuddy-old-0.4.9-installer')
  })

  test('releases unpacked audit files before launching the Windows installer', () => {
    const workflowSteps = steps()
    const unpack = workflowSteps.find(step => step.name === '解包并审计 Windows 成品')
    expect(unpack?.run).toContain('Remove-Item -LiteralPath $installerAuditDir, $appAuditDir')
    expect(unpack?.run).toContain('finally')
  })

  test('builds the oldest supported installer before proving upgrade and rollback', () => {
    const workflowSteps = steps()
    const checkout = workflowSteps.find(step => step.uses === 'actions/checkout@v5')
    const baselineIndex = workflowSteps.findIndex(step => step.name === '构建最老支持 Windows 升级基线包')
    const currentIndex = workflowSteps.findIndex(step => step.run?.includes('bun run electron:package'))
    const installIndex = workflowSteps.findIndex(step => step.name === '安装、启动并卸载 Windows 成品')
    const upgradeIndex = workflowSteps.findIndex(step => step.name === '从最老支持版本升级并回退 Windows 成品')
    expect(baselineIndex).toBeGreaterThanOrEqual(0)
    expect(checkout?.with?.['fetch-depth']).toBe(0)
    expect(currentIndex).toBeGreaterThan(baselineIndex)
    expect(upgradeIndex).toBeGreaterThan(installIndex)
    expect(workflowSteps[upgradeIndex]?.run).toContain('accept-windows-upgrade.ps1')
    expect(workflowSteps[upgradeIndex]?.run).toContain('BB_OLD_WINDOWS_INSTALLER')
    const baselineScript = readFileSync(baselineScriptPath, 'utf8')
    expect(baselineScript).toContain('billiardbuddy-old-0.4.9-installer')
    expect(baselineScript).toContain('git worktree remove --force')
    expect(baselineScript).toContain('BB_OLD_WINDOWS_INSTALLER=$persistedInstaller')
  })

  test('proves Windows update download recovery after upgrade acceptance', () => {
    const workflowSteps = steps()
    const upgradeIndex = workflowSteps.findIndex(step => step.name === '从最老支持版本升级并回退 Windows 成品')
    const recoveryIndex = workflowSteps.findIndex(step => step.name === '模拟更新下载中断并验证 Windows 重启恢复')
    expect(upgradeIndex).toBeGreaterThanOrEqual(0)
    expect(recoveryIndex).toBeGreaterThan(upgradeIndex)
    expect(workflowSteps[recoveryIndex]?.run).toContain('accept-windows-update-recovery.ps1')
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
