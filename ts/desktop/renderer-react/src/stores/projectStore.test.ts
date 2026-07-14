import { expect, test } from 'bun:test'
import type { ProjectSummary } from '../types/chat'
import { mergeRememberedProjects } from './projectStore'

const serverProject: ProjectSummary = {
  workspaceRoot: '/workspace/existing',
  sessionCount: 2,
  lastUpdatedAt: '2026-07-15T00:00:00.000Z',
  lastSessionId: 'session-1',
  lastTitle: '已有任务',
  isDefault: false,
}

test('空项目目录与后端会话项目合并，重名目录不产生第二条记录', () => {
  expect(mergeRememberedProjects([serverProject], ['/workspace/empty', '/workspace/existing'])).toEqual([
    serverProject,
    {
      workspaceRoot: '/workspace/empty',
      sessionCount: 0,
      lastUpdatedAt: '',
      lastSessionId: '',
      lastTitle: '',
      isDefault: false,
    },
  ])
})
