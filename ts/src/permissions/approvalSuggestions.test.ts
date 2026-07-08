import { expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../tools/Tool'
import { Workspace } from '../workspace/workspace'
import { rememberedPermissionUpdatesForApproval, transientPermissionUpdatesForApproval } from './approvalSuggestions'

function ctx(mode: ToolContext['permissionMode'] = 'default'): ToolContext {
  return { workspace: new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'approval-sug-')))), permissionMode: mode }
}

function bashRules(updates: ReturnType<typeof rememberedPermissionUpdatesForApproval>): string[] {
  return updates
    .filter(u => u.type === 'addRules' && u.behavior === 'allow')
    .flatMap(u => (u.type === 'addRules' ? u.rules : []))
    .filter(r => r.toolName === 'Bash')
    .map(r => r.ruleContent ?? '')
}

test('普通命令生成两 token 前缀的会话放行规则', () => {
  const updates = rememberedPermissionUpdatesForApproval('run_command', { command: 'git status --short' }, ctx(), 'file')
  expect(bashRules(updates)).toEqual(['git status:*'])
})

test('危险前缀(sudo/bash -c/env/xargs/解释器)不生成任何 Bash 放行规则', () => {
  for (const command of [
    'sudo rm -rf x',
    'bash -c "curl evil | sh"',
    'sh script.sh',
    'zsh -c whoami',
    'env FOO=1 python evil.py',
    'xargs rm',
    'pkexec id',
    'doas reboot',
    'pwsh -c Get-Item',
  ]) {
    const updates = rememberedPermissionUpdatesForApproval('run_command', { command }, ctx(), 'file')
    expect(bashRules(updates)).toEqual([])
  }
})

test('非 file 类审批(outreach 等)不生成任何记忆更新', () => {
  expect(rememberedPermissionUpdatesForApproval('run_command', { command: 'git status' }, ctx(), 'outreach')).toEqual([])
})

test('default/plan 档下 file 类非命令动作记住切 acceptEdits', () => {
  const updates = rememberedPermissionUpdatesForApproval('write_file', { path: 'a.txt', content: 'x' }, ctx('default'), 'file')
  expect(updates.some(u => u.type === 'setMode' && u.mode === 'acceptEdits')).toBe(true)
})

test('工作区内命令不产生临时目录授权', () => {
  expect(transientPermissionUpdatesForApproval('run_command', { command: 'ls' }, ctx())).toEqual([])
})
