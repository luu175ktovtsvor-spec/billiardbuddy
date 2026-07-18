import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DesktopSidebar } from './DesktopSidebar'
import { PRODUCT_TASKS_TAB_ID, useTabStore } from '../../stores/tabStore'
import { useSessionStore } from '../../stores/sessionStore'

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => ({
    'sidebar.newSession': '新建任务',
    'sidebar.scheduled': '已安排',
    'sidebar.settings': '设置',
    'sidebar.collapse': '收起侧边栏',
    'session.untitled': '未命名任务',
  })[key] ?? key,
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({ isDesktop: false }),
}))

describe('DesktopSidebar', () => {
  beforeEach(() => {
    useTabStore.setState({ tabs: [], activeTabId: null })
    useSessionStore.setState({
      sessions: [],
      fetchSessions: vi.fn(async () => undefined),
    } as Partial<ReturnType<typeof useSessionStore.getState>>)
  })

  afterEach(() => {
    cleanup()
    useTabStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens the product task index through the desktop navigation', () => {
    render(<DesktopSidebar />)

    fireEvent.click(screen.getByRole('button', { name: '任务中心' }))

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
