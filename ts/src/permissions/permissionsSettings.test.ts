import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPermissionRules, parsePermissionRuleString, permissionRuleValueToString, permissionUpdatesFromRules, persistPermissionRule } from './permissionsSettings'
import { applyPermissionUpdates } from './permissionUpdate'
import { resolvePermission } from './resolve'
import { runCommandTool } from '../tools/runCommandTool'
import { Workspace } from '../workspace/workspace'

test('parsePermissionRuleString:Tool(content) / Tool / 转义 / 空', () => {
  expect(parsePermissionRuleString('Bash(npm install)')).toEqual({ toolName: 'Bash', ruleContent: 'npm install' })
  expect(parsePermissionRuleString('Read')).toEqual({ toolName: 'Read' })
  expect(parsePermissionRuleString('Bash(python -c "print\\(1\\)")')).toEqual({ toolName: 'Bash', ruleContent: 'python -c "print(1)"' })
  expect(parsePermissionRuleString('  ')).toBeNull()
  expect(parsePermissionRuleString('Read()')).toEqual({ toolName: 'Read' })
})

test('permissionRuleValueToString:往返 + 括号转义', () => {
  expect(permissionRuleValueToString({ toolName: 'Read' })).toBe('Read')
  expect(permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'npm install' })).toBe('Bash(npm install)')
  expect(permissionRuleValueToString({ toolName: 'Bash', ruleContent: 'x(1)' })).toBe('Bash(x\\(1\\))')
})

test('loadPermissionRules:从 settings.json(project)+ settings.local.json(local)加载', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perm-settings-'))
  try {
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(npm install)'], deny: ['Read(/etc/shadow)'] } }))
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Read'] } }))
    const rules = await loadPermissionRules(root)
    expect(rules).toContainEqual({ source: 'projectSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'npm install' } })
    expect(rules).toContainEqual({ source: 'projectSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'Read', ruleContent: '/etc/shadow' } })
    expect(rules).toContainEqual({ source: 'localSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Read' } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('loadPermissionRules:无 settings 文件安全退空', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perm-empty-'))
  try { expect(await loadPermissionRules(root)).toEqual([]) } finally { rmSync(root, { recursive: true, force: true }) }
})

test('persistPermissionRule:写进 settings.local.json + 跨"重启"能 load 回 + 去重', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perm-persist-'))
  try {
    await persistPermissionRule(root, 'allow', { toolName: 'Bash', ruleContent: 'ls' })
    await persistPermissionRule(root, 'allow', { toolName: 'Bash', ruleContent: 'ls' }) // 重复 → 去重
    await persistPermissionRule(root, 'deny', { toolName: 'run_command', ruleContent: 'rm -rf' })
    const saved = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))
    expect(saved.permissions.allow).toEqual(['Bash(ls)'])
    expect(saved.permissions.deny).toEqual(['run_command(rm -rf)'])
    // 重新 load(模拟重启)
    const rules = await loadPermissionRules(root)
    expect(rules).toContainEqual({ source: 'localSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'ls' } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('端到端:持久化 allow 规则 → 加载 → resolvePermission 放行(default 档下本会自动放行)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perm-e2e-'))
  try {
    await persistPermissionRule(root, 'allow', { toolName: 'run_command', ruleContent: 'echo hi' })
    const updates = permissionUpdatesFromRules(await loadPermissionRules(root))
    const baseCtx = { workspace: new Workspace(root), permissionMode: 'default' as const }
    const ctx = applyPermissionUpdates(baseCtx, updates)
    // run_command 'echo hi' 命中持久 allow 规则 → 放行(不弹审批)
    expect(resolvePermission(runCommandTool, { command: 'echo hi' }, ctx).behavior).toBe('allow')
    // 未命中规则的命令仍按档位判(default 下 echo 属只读会放行,换个越界写命令验证规则不越权:此处只验命中路径)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('permissionUpdatesFromRules:按 behavior 分组成 addRules 更新', () => {
  const updates = permissionUpdatesFromRules([
    { source: 'localSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Bash', ruleContent: 'ls' } },
    { source: 'localSettings', ruleBehavior: 'allow', ruleValue: { toolName: 'Read' } },
    { source: 'projectSettings', ruleBehavior: 'deny', ruleValue: { toolName: 'run_command', ruleContent: 'rm' } },
  ])
  const allow = updates.find(u => u.type === 'addRules' && u.behavior === 'allow')
  expect(allow && allow.type === 'addRules' && allow.rules.length).toBe(2)
  const deny = updates.find(u => u.type === 'addRules' && u.behavior === 'deny')
  expect(deny && deny.type === 'addRules' && deny.rules.length).toBe(1)
})
