import { afterEach, describe, expect, test } from 'bun:test'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PermissionExecutionEnvelope } from '../../../shared/product/permissionExecutionEnvelope.js'
import { runProductShell } from './productSandboxRunner.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
  await SandboxManager.reset().catch(() => undefined)
})

function envelope(sandbox_profile: PermissionExecutionEnvelope['sandbox_profile']): PermissionExecutionEnvelope {
  return {
    version: 1,
    mode: 'policy_bound',
    sandbox_profile,
    approval_policy: sandbox_profile === 'unrestricted' ? 'never' : 'user_reviewer',
    reviewer: sandbox_profile === 'unrestricted' ? 'none' : 'user',
    network_scope: sandbox_profile === 'unrestricted' ? 'unrestricted' : 'denied',
    digest: 'test-envelope',
  }
}

describe('Product shell sandbox', () => {
  test('runs a bounded command in the selected workspace', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-shell-'))
    roots.push(root)
    const result = await runProductShell({
      command: 'pwd && printf done',
      workDir: root,
      timeoutMs: 5_000,
      signal: new AbortController().signal,
      envelope: envelope('unrestricted'),
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(root)
    expect(result.stdout).toEndWith('done')
    expect(result.timedOut).toBe(false)
  })

  test('workspace profile prevents writes outside the task workspace', async () => {
    if (!SandboxManager.isSupportedPlatform()) return
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-shell-'))
    const outside = await fs.mkdtemp(path.join(os.homedir(), '.bb-product-shell-outside-'))
    roots.push(root, outside)
    const outsideFile = path.join(outside, 'forbidden.txt')
    const result = await runProductShell({
      command: `printf blocked > ${JSON.stringify(outsideFile)}`,
      workDir: root,
      timeoutMs: 10_000,
      signal: new AbortController().signal,
      envelope: envelope('workspace'),
    })
    expect(result.exitCode).not.toBe(0)
    await expect(fs.stat(outsideFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
