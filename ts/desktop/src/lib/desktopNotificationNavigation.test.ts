import { beforeEach, describe, expect, it } from 'vitest'
import { openDesktopNotificationTarget } from './desktopNotificationNavigation'
import { PRODUCT_TASKS_TAB_ID, SCHEDULED_TAB_ID, useTabStore } from '../stores/tabStore'

const initialTabState = useTabStore.getInitialState()

describe('desktopNotificationNavigation', () => {
  beforeEach(() => {
    useTabStore.setState(initialTabState, true)
  })

  it('opens the product task index for a legacy session notification target', () => {
    openDesktopNotificationTarget({
      type: 'session',
      sessionId: 'session-1',
      title: 'Build fix',
    })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: PRODUCT_TASKS_TAB_ID, title: '任务中心', type: 'product-tasks', status: 'idle' },
    ])
    expect(useTabStore.getState().activeTabId).toBe(PRODUCT_TASKS_TAB_ID)
  })

  it('does not expose a Core session when the notification omits its title', () => {
    openDesktopNotificationTarget({ type: 'session', sessionId: 'session-2' })

    expect(useTabStore.getState().tabs[0]).toMatchObject({
      sessionId: PRODUCT_TASKS_TAB_ID,
      title: '任务中心',
      type: 'product-tasks',
    })
  })

  it('opens the scheduled tasks tab for scheduled notification targets', () => {
    openDesktopNotificationTarget({ type: 'scheduled' })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: SCHEDULED_TAB_ID, title: 'Scheduled Tasks', type: 'scheduled', status: 'idle' },
    ])
    expect(useTabStore.getState().activeTabId).toBe(SCHEDULED_TAB_ID)
  })
})
