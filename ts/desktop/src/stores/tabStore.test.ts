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
    useTabStore.setState({ tabs: [], activeTabId: null })
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

    unsafeOpenTab('session-1', '旧会话', 'session')
    unsafeOpenTab('__workbench__session-1', 'Workbench', 'workbench')

    expect(useTabStore.getState().tabs).toEqual([{
      sessionId: PRODUCT_TASKS_TAB_ID,
      title: '任务中心',
      type: 'product-tasks',
      status: 'idle',
    }])
    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
  })

  it('does not persist raw Core session tabs', () => {
    useTabStore.setState({
      tabs: [
        { sessionId: 'session-1', title: '旧会话', type: 'session', status: 'idle' },
        { sessionId: SETTINGS_TAB_ID, title: '设置', type: 'settings', status: 'idle' },
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
          title: '整理开球训练',
          type: 'product-task',
          status: 'idle',
          taskId: 'task-1',
        },
      ],
      activeTabId: 'session-1',
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

  it('stores a promoted terminal runtime id on new terminal tabs', () => {
    const tabId = useTabStore.getState().openTerminalTab('/tmp/project', '__session_terminal__session-1')

    expect(useTabStore.getState().tabs).toEqual([
      {
        sessionId: tabId,
        title: 'Terminal 1',
        type: 'terminal',
        status: 'idle',
        terminalCwd: '/tmp/project',
        terminalRuntimeId: '__session_terminal__session-1',
      },
    ])
    expect(useTabStore.getState().activeTabId).toBe(tabId)
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
      status: 'idle',
      taskId: 'task-1',
    }])
    expect(useTabStore.getState().activeTabId).toBe(tabId)
    expect(JSON.parse(localStorage.getItem('billiardbuddy-open-tabs') || '{}')).toEqual({
      openTabs: [{
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        title: '整理开球训练',
        type: 'product-task',
        taskId: 'task-1',
      }],
      activeTabId: tabId,
    })
  })

  it('updates only product task tabs when a restricted task stream supplies a new title', () => {
    useTabStore.setState({
      tabs: [
        {
          sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
          title: '旧任务标题',
          type: 'product-task',
          status: 'idle',
          taskId: 'task-1',
        },
        {
          sessionId: 'task-1',
          title: '旧会话标题',
          type: 'session',
          status: 'idle',
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
        sessionId: 'task-1',
        type: 'session',
        title: '旧会话标题',
      }),
    ])
  })

  it('drops legacy session tabs during restore without calling the Core session API', async () => {
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
        status: 'idle',
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
        status: 'idle',
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
      tabs: [{
        sessionId: `${PRODUCT_TASK_TAB_PREFIX}task-1`,
        title: '整理开球训练',
        type: 'product-task',
        taskId: 'task-1',
      }],
    })
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
