import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

type WorkflowStep = {
  name?: string
  if?: string
  run?: string
  env?: Record<string, string>
}

type Workflow = {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

const workflowPath = path.resolve(
  import.meta.dir,
  '../../.github/workflows/desktop-build-win.yml',
)

function steps(): WorkflowStep[] {
  const workflow = parse(readFileSync(workflowPath, 'utf8')) as Workflow
  return workflow.jobs?.['verify-and-build']?.steps ?? []
}

describe('Windows release workflow contract', () => {
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
  })
})
