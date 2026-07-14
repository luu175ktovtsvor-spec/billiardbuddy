import { test, expect } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGeneralRegistry } from './generalTools'
import { Sandbox } from '../sandbox/sandbox'
import { Workspace } from '../workspace/workspace'
import { createWebSearchTool } from './webSearchTool'

test('general registry contains the core tools', () => {
  const reg = buildGeneralRegistry()
  expect(reg.list().map(t => t.name).sort()).toEqual([
    'AskUserQuestion',
    'Brief',
    'EnterPlanMode',
    'EnterWorktree',
    'ExitPlanMode',
    'ExitWorktree',
    'LSP',
    'NotebookEdit',
    'PowerShell',
    'REPL',
    'SendUserMessage',
    'VerifyPlanExecution',
    'WebFetch',
    'ask_user_question',
    'code_outline',
    'edit_excel',
    'edit_file',
    'enter_plan',
    'exit_plan',
    'file_history',
    'git_history',
    'git_status',
    'glob_files',
    'grep_files',
    'list_dir',
    'list_project_instructions',
    'multi_edit_file',
    'patch_file',
    'patch_files',
    'project_diagnostics',
    'read_file',
    'read_many_files',
    'read_stored_tool_result',
    'restore_file',
    'run_command',
    'save_memory',
    'todo_write',
    'tool_search',
    'verify_plan_execution',
    'write_file',
  ])
})

test('general registry exposes WebSearch only when capability was explicitly enabled', () => {
  expect(buildGeneralRegistry().get('WebSearch')).toBeUndefined()
  const webSearch = createWebSearchTool({ QF_GATEWAY_URL: 'https://gateway.example', QF_GATEWAY_TOKEN: 'app-token' })
  expect(buildGeneralRegistry({ webSearch }).get('WebSearch')).toBe(webSearch)
})

test('general registry specs are model-facing (have parameters)', () => {
  const specs = buildGeneralRegistry().specs()
  for (const s of specs) expect(s.parameters.type).toBe('object')
})

test('传 sandbox 时 run_command 描述带上沙箱说明', () => {
  const ws = new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'w3-gr-'))))
  const reg = buildGeneralRegistry({ sandbox: new Sandbox({ workspace: ws, enabled: true, platform: 'darwin' }) })
  const spec = reg.specs().find(s => s.name === 'run_command')!
  expect(spec.description).toContain('工作区')
})
