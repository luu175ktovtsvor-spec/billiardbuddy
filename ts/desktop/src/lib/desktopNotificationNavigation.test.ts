import { beforeEach, describe, expect, it } from 'vitest'
import { openDesktopNotificationTarget } from './desktopNotificationNavigation'
import { SCHEDULED_TAB_ID, useTabStore } from '../stores/tabStore'

const initialTabState = useTabStore.getInitialState()

describe('desktopNotificationNavigation', () => {
  beforeEach(() => {
    useTabStore.setState(initialTabState, true)
  })

  it('opens the scheduled tasks tab for scheduled notification targets', () => {
    openDesktopNotificationTarget({ type: 'scheduled' })

    expect(useTabStore.getState().tabs).toEqual([
      { sessionId: SCHEDULED_TAB_ID, title: 'Scheduled Tasks', type: 'scheduled' },
    ])
    expect(useTabStore.getState().activeTabId).toBe(SCHEDULED_TAB_ID)
  })
})
