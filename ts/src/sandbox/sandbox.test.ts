import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import { Sandbox } from './sandbox'

function ws() {
  return new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-sb-'))))
}

describe('Sandbox 分派', () => {
  test('默认 opt-in 关闭 → OS 沙箱不激活、wrapCommand 返回 null(明文跑)', async () => {
    const sb = new Sandbox({ workspace: ws(), platform: 'darwin' })
    expect(sb.isOsSandboxActive()).toBe(false)
    expect(await sb.wrapCommand('echo hi')).toBeNull()
  })
  test('darwin + enabled → OS 沙箱激活', () => {
    const sb = new Sandbox({ workspace: ws(), enabled: true, platform: 'darwin' })
    expect(sb.isOsSandboxActive()).toBe(true)
  })
  test('win32 + enabled → OS 层不激活(走 app 护栏),wrapCommand 返回 null', async () => {
    const sb = new Sandbox({ workspace: ws(), enabled: true, platform: 'win32' })
    expect(sb.isOsSandboxActive()).toBe(false)
    expect(await sb.wrapCommand('dir')).toBeNull()
  })
  test('describeForPrompt 随状态给大白话:激活提"工作区可写围栏",win 提 "Job Object 待启用"', () => {
    expect(new Sandbox({ workspace: ws(), enabled: true, platform: 'darwin' }).describeForPrompt()).toContain('工作区')
    expect(new Sandbox({ workspace: ws(), platform: 'win32' }).describeForPrompt()).toContain('Job Object')
  })
})
