import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../workspace/workspace'
import type { ToolContext } from '../tools/Tool'
import { applyPermissionUpdate, applyPermissionUpdates } from './permissionUpdate'

function ctx(): ToolContext {
  return { workspace: new Workspace(realpathSync(mkdtempSync(join(tmpdir(), 'perm-update-')))) }
}

describe('permission updates', () => {
  test('add/replace/remove rules keep source, behavior and rule value', () => {
    const base = ctx()
    const added = applyPermissionUpdate(base, {
      type: 'addRules',
      destination: 'localSettings',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git:*' }],
    })
    expect(added.permissionRules).toEqual([
      {
        source: 'localSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'git:*' },
      },
    ])

    const deduped = applyPermissionUpdate(added, {
      type: 'addRules',
      destination: 'localSettings',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'git:*' }],
    })
    expect(deduped.permissionRules).toHaveLength(1)

    const replaced = applyPermissionUpdate(deduped, {
      type: 'replaceRules',
      destination: 'localSettings',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    })
    expect(replaced.permissionRules).toEqual([
      {
        source: 'localSettings',
        ruleBehavior: 'allow',
        ruleValue: { toolName: 'Bash', ruleContent: 'npm test:*' },
      },
    ])

    const removed = applyPermissionUpdate(replaced, {
      type: 'removeRules',
      destination: 'localSettings',
      behavior: 'allow',
      rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }],
    })
    expect(removed.permissionRules).toEqual([])
  })

  test('setMode and directory updates mirror cc in-memory context updates', () => {
    const updated = applyPermissionUpdates(ctx(), [
      { type: 'setMode', destination: 'session', mode: 'dontAsk' },
      { type: 'addDirectories', destination: 'session', directories: ['/tmp/a', '/tmp/b'] },
      { type: 'removeDirectories', destination: 'session', directories: ['/tmp/a'] },
    ])
    expect(updated.permissionMode).toBe('dontAsk')
    const directories = updated.additionalWorkingDirectories ? [...updated.additionalWorkingDirectories.values()] : []
    expect(directories).toEqual([
      { path: '/tmp/b', source: 'session' },
    ])
  })
})
