import { beforeEach, describe, expect, it } from 'vitest'
import {
  NEW_PRODUCT_TASK_TAB_ID,
  PRODUCT_TASKS_TAB_ID,
  PRODUCT_TASK_TAB_PREFIX,
  SETTINGS_TAB_ID,
  useTabStore,
} from './tabStore'

describe('tabStore', () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null, lastActiveProductTaskId: null })
    localStorage.clear()
  })

  it('refreshes an existing fixed product surface title when opened again', () => {
    useTabStore.getState().openTab(PRODUCT_TASKS_TAB_ID, '```json {"title":', 'product-tasks')
    useTabStore.getState().openTab(PRODUCT_TASKS_TAB_ID, '任务中心', 'product-tasks')

    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      sessionId: PRODUCT_TASKS_TAB_ID,
      title: '任务中心',
      type: 'product-tasks',
    })
    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
  })

  it('fails closed to the product task index when JavaScript bypasses the public tab type', () => {
    const unsafeOpenTab = useTabStore.getState().openTab as unknown as (
      sessionId: string,
      title: string,
      type: string,
    ) => void

    unsafeOpenTab('__unknown__', 'Unsupported', 'unknown')
    unsafeOpenTab('__terminal__manual', 'Manual terminal', 'terminal')

    expect(useTabStore.getState().tabs).toEqual([{
      sessionId: PRODUCT_TASKS_TAB_ID,
      title: '任务中心',
      type: 'product-tasks',
    }])
    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
  })

  it('does not persist ephemeral tab surfaces', () => {
    useTabStore.setState({
      tabs: [
        { sessionId: NEW_PRODUCT_TASK_TAB_ID, title: '新建任务', type: 'new-product-task' },
        { sessionId: SETTINGS_TAB_ID, title: '设置', type: 'settings' },
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
          title: '整理开球训练',
          type: 'product-task',
          taskId: 'task-1',
        },
      ],
      activeTabId: NEW_PRODUCT_TASK_TAB_ID,
      lastActiveProductTaskId: null,
    })

    useTabStore.getState().saveTabs()

    expect(JSON.parse(localStorage.getItem('billiardbuddy-open-tabs') || '{}')).toEqual({
      openTabs: [
        { sessionId: SETTINGS_TAB_ID, title: '设置', type: 'settings' },
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
          title: '整理开球训练',
          type: 'product-task',
          taskId: 'task-1',
        },
      ],
      activeTabId: SETTINGS_TAB_ID,
    })
  })

  it('opens one ephemeral dedicated new-task tab and refreshes its work-directory request', () => {
    useTabStore.getState().openNewProductTask('  /workspace/billiard  ')

    const first = useTabStore.getState().tabs[0]
    expect(first).toMatchObject({
      sessionId: NEW_PRODUCT_TASK_TAB_ID,
      title: '新建任务',
      type: 'new-product-task',
      newTaskWorkDir: '/workspace/billiard',
    })
    expect(first?.newTaskRequestId).toEqual(expect.any(Number))
    expect(useTabStore.getState().activeTabId).toBe(NEW_PRODUCT_TASK_TAB_ID)
    expect(localStorage.getItem('billiardbuddy-open-tabs')).toBe(JSON.stringify({
      openTabs: [],
      activeTabId: null,
    }))

    useTabStore.getState().openNewProductTask()

    expect(useTabStore.getState().tabs).toHaveLength(1)
    expect(useTabStore.getState().tabs[0]).toMatchObject({
      sessionId: NEW_PRODUCT_TASK_TAB_ID,
      type: 'new-product-task',
    })
    expect(useTabStore.getState().tabs[0]?.newTaskWorkDir).toBeUndefined()
    expect(useTabStore.getState().tabs[0]?.newTaskRequestId).not.toBe(first?.newTaskRequestId)
  })

  it('opens a stable product task tab without treating its task id as a Core session tab', () => {
    const tabId = useTabStore.getState().openProductTaskTab('task-1', '整理开球训练')

    expect(tabId).toBe(`${PRODUCT_TASK_TAB_PREFIX}task-1`)
    expect(useTabStore.getState().tabs).toEqual([{
      sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
      title: '整理开球训练',
      type: 'product-task',
      taskId: 'task-1',
    }])
    expect(useTabStore.getState().activeTabId).toBe(tabId)
    expect(useTabStore.getState().lastActiveProductTaskId).toBe('task-1')
    expect(JSON.parse(localStorage.getItem('billiardbuddy-open-tabs') || '{}')).toEqual({
      openTabs: [{
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        title: '整理开球训练',
        type: 'product-task',
        taskId: 'task-1',
      }],
      activeTabId: tabId,
      lastActiveProductTaskId: 'task-1',
    })
  })

  it('tracks the explicitly activated product task while a fixed product surface is active', () => {
    const taskAId = useTabStore.getState().openProductTaskTab('task-a', '任务 A')
    const taskBId = useTabStore.getState().openProductTaskTab('task-b', '任务 B')

    expect(useTabStore.getState().lastActiveProductTaskId).toBe('task-b')

    useTabStore.getState().setActiveTab(taskAId)
    expect(useTabStore.getState().lastActiveProductTaskId).toBe('task-a')

    useTabStore.getState().openTab(SETTINGS_TAB_ID, '设置', 'settings')
    expect(useTabStore.getState()).toMatchObject({
      activeTabId: SETTINGS_TAB_ID,
      lastActiveProductTaskId: 'task-a',
    })
    expect(useTabStore.getState().tabs.find((tab) => tab.sessionId === taskBId)?.taskId).toBe('task-b')
  })

  it('selects the active product task as a safe close fallback and clears a closed remembered task', () => {
    const taskAId = useTabStore.getState().openProductTaskTab('task-a', '任务 A')
    const taskBId = useTabStore.getState().openProductTaskTab('task-b', '任务 B')

    useTabStore.getState().closeTab(taskBId)
    expect(useTabStore.getState()).toMatchObject({
      activeTabId: taskAId,
      lastActiveProductTaskId: 'task-a',
    })

    const reopenedTaskBId = useTabStore.getState().openProductTaskTab('task-b', '任务 B')
    useTabStore.getState().openTab(SETTINGS_TAB_ID, '设置', 'settings')
    useTabStore.getState().closeTab(reopenedTaskBId)

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: SETTINGS_TAB_ID,
      lastActiveProductTaskId: null,
    })
  })

  it('updates only product task tabs when a restricted task stream supplies a new title', () => {
    useTabStore.setState({
      tabs: [
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
          title: '旧任务标题',
          type: 'product-task',
          taskId: 'task-1',
        },
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-2`,
          title: '另一个任务标题',
          type: 'product-task',
          taskId: 'task-2',
        },
      ],
      activeTabId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
    })

    useTabStore.getState().updateProductTaskTitle('task-1', '  实时任务标题  ')

    expect(useTabStore.getState().tabs).toEqual([
      expect.objectContaining({
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        type: 'product-task',
        title: '实时任务标题',
      }),
      expect.objectContaining({
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-2`,
        type: 'product-task',
        title: '另一个任务标题',
      }),
    ])
  })

  it('drops unsupported persisted tabs during restore', async () => {
    localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: 'session-1', title: 'Old Session', type: 'session' },
        { sessionId: PRODUCT_TASKS_TAB_ID, title: '任务中心', type: 'product-tasks' },
      ],
      activeTabId: 'session-1',
    }))

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: PRODUCT_TASKS_TAB_ID,
        title: '任务中心',
        type: 'product-tasks',
      },
    ])
  })

  it('restores the product task index as a special tab without a core session', async () => {
    localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: PRODUCT_TASKS_TAB_ID, title: '任务中心', type: 'product-tasks' }],
      activeTabId: PRODUCT_TASKS_TAB_ID,
    }))

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: PRODUCT_TASKS_TAB_ID,
      tabs: [{
        sessionId: PRODUCT_TASKS_TAB_ID,
        title: '任务中心',
        type: 'product-tasks',
      }],
    })
  })

  it('restores a product task tab through its persisted product task identity', async () => {
    localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [{
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        title: '整理开球训练',
        type: 'product-task',
        taskId: 'task-1',
      }],
      activeTabId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
    }))

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
      lastActiveProductTaskId: 'task-1',
      tabs: [{
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        title: '整理开球训练',
        type: 'product-task',
        taskId: 'task-1',
      }],
    })
  })

  it('persists and restores a recorded product task while Settings is active', async () => {
    localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-a`,
          title: '任务 A',
          type: 'product-task',
          taskId: 'task-a',
        },
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-b`,
          title: '任务 B',
          type: 'product-task',
          taskId: 'task-b',
        },
        { sessionId: SETTINGS_TAB_ID, title: '设置', type: 'settings' },
      ],
      activeTabId: SETTINGS_TAB_ID,
      lastActiveProductTaskId: 'task-a',
    }))

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: SETTINGS_TAB_ID,
      lastActiveProductTaskId: 'task-a',
    })
    expect(JSON.parse(localStorage.getItem('billiardbuddy-open-tabs') || '{}')).toMatchObject({
      activeTabId: SETTINGS_TAB_ID,
      lastActiveProductTaskId: 'task-a',
    })
  })

  it('drops a persisted last task id that is not an open product task', async () => {
    localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [{ sessionId: SETTINGS_TAB_ID, title: '设置', type: 'settings' }],
      activeTabId: SETTINGS_TAB_ID,
      lastActiveProductTaskId: 'core-session-1',
    }))

    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState().lastActiveProductTaskId).toBeNull()
    expect(JSON.parse(localStorage.getItem('billiardbuddy-open-tabs') || '{}')).not.toHaveProperty(
      'lastActiveProductTaskId',
    )
  })

  it('discards retired trace tabs and raw sessions during restore', async () => {
    localStorage.setItem('billiardbuddy-open-tabs', JSON.stringify({
      openTabs: [
        { sessionId: '__traces__', title: 'Trace list', type: 'traces' },
        { sessionId: '__trace__session-1', title: 'Trace', type: 'trace' },
        { sessionId: 'session-1', title: 'Current task', type: 'session' },
      ],
      activeTabId: '__trace__session-1',
    }))
    await useTabStore.getState().restoreTabs()

    expect(useTabStore.getState()).toMatchObject({
      activeTabId: null,
      tabs: [],
    })
    expect(localStorage.getItem('billiardbuddy-open-tabs')).toBeNull()
  })
})
