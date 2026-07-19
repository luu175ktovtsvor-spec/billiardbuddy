import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PRODUCT_TASKS_TAB_ID, useTabStore } from './tabStore'
import { useTeamStore } from './teamStore'

function resetStores() {
  useTeamStore.getState().stopMemberPolling()
  useTeamStore.setState({
    teams: [],
    activeTeam: null,
    memberColors: new Map(),
    error: null,
  })
  useTabStore.setState({ tabs: [], activeTabId: null })
}

beforeEach(resetStores)
afterEach(resetStores)

describe('teamStore member navigation', () => {
  it('returns team member interactions to the product task index without creating a raw session tab', () => {
    useTeamStore.getState().openMemberSession({
      agentId: 'reviewer-1',
      role: '审阅助手',
      status: 'running',
      sessionId: 'core-session-1',
    })

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
})
