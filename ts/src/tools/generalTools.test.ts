import { test, expect } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildGeneralRegistry } from './generalTools'
import { Sandbox } from '../sandbox/sandbox'
import { Workspace } from '../workspace/workspace'

test('general registry contains the core tools', () => {
  const reg = buildGeneralRegistry()
  expect(reg.list().map(t => t.name).sort()).toEqual([
    'AskUserQuestion',
    'ExitPlanMode',
    'ask_user_question',
    'edit_file',
    'exit_plan',
    'file_history',
    'glob_files',
    'grep_files',
    'list_dir',
    'read_file',
    'restore_file',
    'run_command',
    'todo_write',
    'write_file',
  ])
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
