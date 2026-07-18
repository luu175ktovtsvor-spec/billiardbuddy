import { api } from './client'
import type { AgentTaskNotification } from '../types/chat'
import type { SessionListItem, MessageEntry } from '../types/session'
import type { PermissionMode } from '../types/settings'

type SessionsResponse = { sessions: SessionListItem[]; total: number }
type MessagesResponse = {
  messages: MessageEntry[]
  taskNotifications?: AgentTaskNotification[]
}
type CreateSessionResponse = { sessionId: string; workDir?: string }
export type BatchDeleteSessionsResponse = {
  ok: boolean
  successes: string[]
  failures: Array<{
    sessionId: string
    message: string
    code?: string
  }>
}
export type SessionGitWorktreeInfo = {
  enabled: boolean
  path: string | null
  plannedPath: string | null
  sourceWorkDir: string | null
  slug: string | null
  branch: string | null
}
export type SessionGitInfo = {
  branch: string | null
  repoName: string | null
  workDir: string
  changedFiles: number
  worktree: SessionGitWorktreeInfo | null
}
export type CreateSessionRepositoryOptions = {
  branch?: string | null
  worktree?: boolean
}
export type CreateSessionRequest = {
  workDir?: string
  repository?: CreateSessionRepositoryOptions
  permissionMode?: PermissionMode
}
export type RepositoryBranchInfo = {
  name: string
  current: boolean
  local: boolean
  remote: boolean
  remoteRef?: string
  checkedOut: boolean
  worktreePath?: string
}
export type RepositoryWorktreeInfo = {
  path: string
  branch: string | null
  current: boolean
}
export type RepositoryContextResult = {
  state: 'ok' | 'not_git_repo' | 'missing_workdir' | 'error'
  workDir: string
  repoRoot: string | null
  repoName: string | null
  currentBranch: string | null
  defaultBranch: string | null
  dirty: boolean
  branches: RepositoryBranchInfo[]
  worktrees: RepositoryWorktreeInfo[]
  error?: string
}
export type SessionRewindResponse = {
  target: {
    targetUserMessageId: string
    userMessageIndex: number
    userMessageCount: number
  }
  conversation: {
    messagesRemoved: number
    removedMessageIds?: string[]
  }
  code: {
    available: boolean
    reason?: string
    filesChanged: string[]
    insertions: number
    deletions: number
  }
}

export type RecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

export type WorkspaceFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'copied'
  | 'type_changed'
  | 'unknown'

export type WorkspaceChangedFile = {
  path: string
  oldPath?: string
  status: WorkspaceFileStatus
  additions: number
  deletions: number
}

export type WorkspaceStatusResult = {
  state: 'ok' | 'not_git_repo' | 'missing_workdir' | 'error'
  workDir: string
  repoName: string | null
  branch: string | null
  isGitRepo: boolean
  changedFiles: WorkspaceChangedFile[]
  error?: string
}

export type WorkspaceReadFileResult = {
  state: 'ok' | 'binary' | 'too_large' | 'missing' | 'error'
  path: string
  previewType?: 'text' | 'image'
  content?: string
  dataUrl?: string
  mimeType?: string
  language: string
  size: number
  truncated?: boolean
  readBytes?: number
  error?: string
}

export type WorkspaceTreeEntry = {
  name: string
  path: string
  isDirectory: boolean
}

export type WorkspaceTreeResult = {
  state: 'ok' | 'missing' | 'error'
  path: string
  entries: WorkspaceTreeEntry[]
  error?: string
}

export type WorkspaceDiffResult = {
  state: 'ok' | 'missing' | 'not_git_repo' | 'error'
  path: string
  diff?: string
  error?: string
}

export type SessionTurnCheckpoint = {
  target: SessionRewindResponse['target']
  conversation?: SessionRewindResponse['conversation']
  code: SessionRewindResponse['code']
  workDir?: string
}

export type SessionTurnCheckpointsResponse = {
  checkpoints: SessionTurnCheckpoint[]
}

export type TurnCheckpointDiffResult = WorkspaceDiffResult & {
  target?: SessionRewindResponse['target']
  workDir?: string
}

function buildWorkspacePath(
  sessionId: string,
  resource: 'status' | 'tree' | 'file' | 'diff',
  workspacePath?: string,
) {
  const query = new URLSearchParams()
  if (typeof workspacePath === 'string' && workspacePath.length > 0) {
    query.set('path', workspacePath)
  }

  const qs = query.toString()
  return `/api/sessions/${sessionId}/workspace/${resource}${qs ? `?${qs}` : ''}`
}

export const sessionsApi = {
  list(params?: { project?: string; limit?: number; offset?: number }) {
    const query = new URLSearchParams()
    if (params?.project) query.set('project', params.project)
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    const qs = query.toString()
    return api.get<SessionsResponse>(`/api/sessions${qs ? `?${qs}` : ''}`)
  },

  getMessages(sessionId: string) {
    return api.get<MessagesResponse>(`/api/sessions/${sessionId}/messages`)
  },

  create(input?: string | CreateSessionRequest) {
    const body = typeof input === 'string'
      ? (input ? { workDir: input } : {})
      : (input ?? {})
    return api.post<CreateSessionResponse>('/api/sessions', body)
  },

  delete(sessionId: string) {
    return api.delete<{ ok: true }>(`/api/sessions/${sessionId}`)
  },

  batchDelete(sessionIds: string[]) {
    return api.post<BatchDeleteSessionsResponse>('/api/sessions/batch-delete', { sessionIds })
  },

  rename(sessionId: string, title: string) {
    return api.patch<{ ok: true }>(`/api/sessions/${sessionId}`, { title })
  },

  getRecentProjects(limit?: number) {
    const query = typeof limit === 'number' ? `?limit=${limit}` : ''
    return api.get<{ projects: RecentProject[] }>(`/api/sessions/recent-projects${query}`)
  },

  getRepositoryContext(workDir: string) {
    const query = new URLSearchParams({ workDir })
    return api.get<RepositoryContextResult>(`/api/sessions/repository-context?${query.toString()}`)
  },

  getGitInfo(sessionId: string) {
    return api.get<SessionGitInfo>(`/api/sessions/${sessionId}/git-info`)
  },

  getSlashCommands(sessionId: string) {
    return api.get<{ commands: Array<{ name: string; description: string; argumentHint?: string }> }>(`/api/sessions/${sessionId}/slash-commands`)
  },

  getWorkspaceStatus(sessionId: string) {
    return api.get<WorkspaceStatusResult>(buildWorkspacePath(sessionId, 'status'))
  },

  getWorkspaceTree(sessionId: string, workspacePath = '') {
    return api.get<WorkspaceTreeResult>(buildWorkspacePath(sessionId, 'tree', workspacePath))
  },

  getWorkspaceFile(sessionId: string, workspacePath: string) {
    return api.get<WorkspaceReadFileResult>(buildWorkspacePath(sessionId, 'file', workspacePath))
  },

  getWorkspaceDiff(sessionId: string, workspacePath: string) {
    return api.get<WorkspaceDiffResult>(buildWorkspacePath(sessionId, 'diff', workspacePath))
  },

  getTurnCheckpoints(sessionId: string) {
    return api.get<SessionTurnCheckpointsResponse>(`/api/sessions/${sessionId}/turn-checkpoints`)
  },

  getTurnCheckpointDiff(
    sessionId: string,
    targetUserMessageId: string,
    workspacePath: string,
    userMessageIndex?: number,
  ) {
    const query = new URLSearchParams()
    query.set('targetUserMessageId', targetUserMessageId)
    if (Number.isInteger(userMessageIndex)) {
      query.set('userMessageIndex', String(userMessageIndex))
    }
    query.set('path', workspacePath)
    return api.get<TurnCheckpointDiffResult>(
      `/api/sessions/${sessionId}/turn-checkpoints/diff?${query.toString()}`,
    )
  },

  rewind(sessionId: string, body: {
    targetUserMessageId?: string
    userMessageIndex?: number
    expectedContent?: string
    dryRun?: boolean
  }) {
    return api.post<SessionRewindResponse>(`/api/sessions/${sessionId}/rewind`, body, {
      timeout: 60_000,
    })
  },
}
