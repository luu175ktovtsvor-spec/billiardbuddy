import { describe, expect, test } from 'bun:test'
import { applyAgentPermissionPolicy } from './agentPermissionPolicy'

describe('Agent 请求权限策略', () => {
  test('传输层不能在用户未允许时提升到完全访问', () => {
    expect(applyAgentPermissionPolicy({
      permissionMode: 'bypassPermissions',
      full_disk_access: true,
    }, { allowBypassPermissionsMode: false, managedBypassDisabled: false })).toMatchObject({
      permissionMode: 'default',
      permission_mode: 'default',
      full_disk_access: false,
    })
  })

  test('用户允许且没有上级禁用时可选择完全访问', () => {
    expect(applyAgentPermissionPolicy({
      permission_mode: 'full',
    }, { allowBypassPermissionsMode: true, managedBypassDisabled: false })).toMatchObject({
      permissionMode: 'bypassPermissions',
      permission_mode: 'bypassPermissions',
      full_disk_access: true,
    })
  })

  test('上级禁用开关优先于用户设置', () => {
    expect(applyAgentPermissionPolicy({
      permissionMode: 'bypassPermissions',
    }, { allowBypassPermissionsMode: true, managedBypassDisabled: true })).toMatchObject({
      permissionMode: 'default',
      full_disk_access: false,
    })
  })

  test('旧字段兼容只发生在入站边界', () => {
    const result = applyAgentPermissionPolicy({ permission_mode: 'auto_files' }, {
      allowBypassPermissionsMode: false,
      managedBypassDisabled: false,
    })
    expect(result.permissionMode).toBe('acceptEdits')
    expect(result.permission_mode).toBe('acceptEdits')
  })
})
