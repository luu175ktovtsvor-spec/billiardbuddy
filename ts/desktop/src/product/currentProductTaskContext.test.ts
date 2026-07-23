import { describe, expect, it } from 'vitest'
import type { Tab } from '../stores/tabStore'
import type { ProductTaskRecord } from './domain/types'
import {
  resolveCurrentProductTaskContext,
  resolveCurrentProductTaskId,
} from './currentProductTaskContext'

function task(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: 'task-current',
    projectId: 'project-current',
    workDir: '/workspace/current',
    title: '当前任务',
    lifecycle: 'active',
    kind: 'main',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    worktreeState: 'not_requested',
    actions: ['rename'],
    workspace_capability: { scope: { kind: 'workspace', workspace_id: 'workspace-current', generation: 1 }, workspace_revision: 1, availability: 'available', available: true },
    ...overrides,
    directoryId: overrides.directoryId ?? 'directory-current',
  }
}

function productTaskTab(taskId = 'task-current'): Tab {
  return {
    sessionId: `__product_task__${taskId}`,
    title: '当前任务',
    type: 'product-task',
    taskId,
  }
}

describe('current product task context', () => {
  it('uses the active product task tab and indexed public work directory', () => {
    const tab = productTaskTab()

    expect(resolveCurrentProductTaskContext([tab], tab.sessionId, [task()])).toEqual({
      taskId: 'task-current',
      workDir: '/workspace/current',
    })
  })

  it('prefers the active task over a different recorded product task', () => {
    const activeTaskTab = productTaskTab('task-active')
    const previousTaskTab = productTaskTab('task-previous')

    expect(resolveCurrentProductTaskContext(
      [previousTaskTab, activeTaskTab],
      activeTaskTab.sessionId,
      [
        task({ id: 'task-active', workDir: '/workspace/active' }),
        task({ id: 'task-previous', workDir: '/workspace/previous' }),
      ],
      'task-previous',
    )).toEqual({
      taskId: 'task-active',
      workDir: '/workspace/active',
    })
  })

  it('keeps the explicit last product task context while a settings tab is active', () => {
    const olderTaskTab = productTaskTab('task-settings')
    const laterTaskTab = productTaskTab('task-later')
    const settingsTab: Tab = {
      sessionId: '__settings__',
      title: '设置',
      type: 'settings',
    }

    expect(resolveCurrentProductTaskContext(
      [olderTaskTab, laterTaskTab, settingsTab],
      settingsTab.sessionId,
      [task({ id: 'task-settings', workDir: '/workspace/settings' })],
      'task-settings',
    )).toEqual({
      taskId: 'task-settings',
      workDir: '/workspace/settings',
    })
  })

  it('does not expose cwd when the server capability is absent or unavailable', () => {
    const tab = productTaskTab()
    expect(resolveCurrentProductTaskContext([tab], tab.sessionId, [task({ workspace_capability: undefined })])).toEqual({ taskId: 'task-current' })
    expect(resolveCurrentProductTaskContext([tab], tab.sessionId, [task({ workspace_capability: { scope: { kind: 'installation-default' }, available: false } })])).toEqual({ taskId: 'task-current' })
  })

  it('does not infer a task from tab order when product navigation has no public context', () => {
    const taskTab = productTaskTab('task-stale')
    const settingsTab: Tab = {
      sessionId: '__settings__',
      title: '设置',
      type: 'settings',
    }

    expect(resolveCurrentProductTaskContext(
      [taskTab, settingsTab],
      settingsTab.sessionId,
      [task({ id: 'task-stale' })],
    )).toEqual({})
  })

  it('rejects a recorded id once its product tab is no longer open', () => {
    const settingsTab: Tab = {
      sessionId: '__settings__',
      title: '设置',
      type: 'settings',
    }

    expect(resolveCurrentProductTaskContext(
      [settingsTab, productTaskTab('task-open')],
      settingsTab.sessionId,
      [task({ id: 'task-open', workDir: '/workspace/open' })],
      'task-closed',
    )).toEqual({})
  })

  it('never treats an unknown tab as a product task context', () => {
    const legacyTab = {
      sessionId: '__unknown__',
      title: '未知页面',
      type: 'unknown',
    } as unknown as Tab

    expect(resolveCurrentProductTaskId([legacyTab], legacyTab.sessionId)).toBeUndefined()
    expect(resolveCurrentProductTaskContext([legacyTab], legacyTab.sessionId, [task()])).toEqual({})
  })

  it('keeps the public task id when the local task index has not loaded yet', () => {
    const tab = productTaskTab('task-unloaded')

    expect(resolveCurrentProductTaskContext([tab], tab.sessionId, [])).toEqual({
      taskId: 'task-unloaded',
    })
  })
})
