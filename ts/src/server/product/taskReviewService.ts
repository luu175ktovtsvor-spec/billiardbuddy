import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewCommentMutation,
  ProductTaskReviewComments,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
  WorkspaceFileRef,
} from '../../../shared/product/taskReview.js'
import { parseProductTaskReviewDiff } from '../../../shared/product/taskReview.js'
import { ApiError } from '../middleware/errorHandler.js'
import {
  WorkspaceService,
  type WorkspaceDiffResult,
  type WorkspaceFileRevisionResult,
  type WorkspaceReadFileOptions,
  type WorkspaceReadFileResult,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../services/workspaceService.js'
import type { ProductTaskService } from './taskService.js'

const MAX_PRODUCT_TASK_REVIEW_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PRODUCT_TASK_REVIEW_VIDEO_BYTES = 16 * 1024 * 1024
const VCS_METADATA_PATH_SEGMENTS = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])

type TaskResolver = Pick<
  ProductTaskService,
  'requireWorkspaceCapability' | 'listReviewComments' | 'createReviewComment'
>
type TaskWorkDirResolver = (taskId: string) => Promise<string | undefined>
type TaskReviewWorkspace = Pick<WorkspaceService, 'getStatus' | 'readTree' | 'getDiff' | 'getFileRevision'> & {
  readFile(
    sessionId: string,
    filePath: string,
    options?: WorkspaceReadFileOptions,
  ): Promise<WorkspaceReadFileResult>
}

/**
 * A task-scoped adapter over the deterministic workspace reader. ProductTask
 * owns the capability and canonical root; no historical transcript or private
 * model-session store participates in the review path.
 */
export class ProductTaskReviewService {
  constructor(
    private readonly tasks: TaskResolver,
    private readonly workspace: TaskReviewWorkspace,
    private readonly getTaskWorkDir: TaskWorkDirResolver,
  ) {}

  async getStatus(taskId: string): Promise<ProductTaskReviewStatus> {
    const status = await this.withTaskWorkspace(taskId, (sessionId) => (
      this.workspace.getStatus(sessionId)
    ))
    return projectStatus(taskId, status)
  }

  async getTree(taskId: string, requestedPath = ''): Promise<ProductTaskReviewTree> {
    const treePath = normalizeReviewPath(requestedPath, { required: false })
    const tree = await this.withTaskWorkspace(taskId, (sessionId) => (
      this.workspace.readTree(sessionId, treePath)
    ))
    return projectTree(taskId, tree)
  }

  async getFile(taskId: string, requestedPath: string): Promise<ProductTaskReviewFile> {
    const filePath = normalizeReviewPath(requestedPath, { required: true })
    const result = await this.withTaskWorkspace(taskId, async (sessionId) => {
      const before = await this.workspace.getFileRevision(sessionId, filePath)
      const file = await this.workspace.readFile(sessionId, filePath, {
        maxImagePreviewBytes: MAX_PRODUCT_TASK_REVIEW_IMAGE_BYTES,
        maxVideoPreviewBytes: MAX_PRODUCT_TASK_REVIEW_VIDEO_BYTES,
      })
      const after = await this.workspace.getFileRevision(sessionId, filePath)
      return { before, file, after }
    })
    if (hasRevisionError(result.before, result.after)) {
      return unavailableFile(taskId, result.file.path)
    }
    if (!sameWorkspaceRevision(result.before, result.after)) {
      return staleFile(taskId, filePath, result.after)
    }
    return projectFile(taskId, result.file, createFileRef(taskId, filePath, result.after))
  }

  async getDiff(
    taskId: string,
    requestedPath: string,
    expectedRevision?: string,
  ): Promise<ProductTaskReviewDiff> {
    const filePath = normalizeReviewPath(requestedPath, { required: true })
    const revision = normalizeExpectedRevision(expectedRevision)
    const result = await this.withTaskWorkspace(taskId, async (sessionId) => {
      const before = await this.workspace.getFileRevision(sessionId, filePath)
      if (revision && before.state === 'ok' && before.revision !== revision) {
        return { before, after: before }
      }
      const diff = await this.workspace.getDiff(sessionId, filePath)
      const after = await this.workspace.getFileRevision(sessionId, filePath)
      return { before, diff, after }
    })
    if (!result.diff) {
      return staleDiff(taskId, filePath, result.after)
    }
    const diff = result.diff
    if (diff.state === 'error' && diff.error?.includes('outside workspace')) {
      throw new ApiError(403, '路径不在当前任务工作区内', 'FORBIDDEN')
    }
    if (hasRevisionError(result.before, result.after)) {
      return unavailableDiff(taskId, diff.path)
    }
    if (!sameWorkspaceRevision(result.before, result.after)) {
      return staleDiff(taskId, filePath, result.after)
    }

    const fileRef = createFileRef(taskId, filePath, result.after)
      ?? createDiffFileRef(taskId, filePath, diff)
    if (revision && fileRef?.revision !== revision) {
      return staleDiff(taskId, filePath, result.after, fileRef)
    }
    return projectDiff(taskId, diff, fileRef)
  }

  async getComments(
    taskId: string,
    requestedPath: string,
    expectedRevision: string | undefined,
  ): Promise<ProductTaskReviewComments> {
    const filePath = normalizeReviewPath(requestedPath, { required: true })
    const fileRef = expectedFileRef(taskId, filePath, expectedRevision)
    await this.requireCurrentDiff(taskId, fileRef)
    return {
      taskId,
      fileRef,
      comments: await this.tasks.listReviewComments(taskId, fileRef),
    }
  }

  async createComment(input: {
    taskId: string
    fileRef: WorkspaceFileRef
    side: 'old' | 'new'
    line: number
    body: string
    clientOperationId: string
  }): Promise<ProductTaskReviewCommentMutation> {
    const filePath = normalizeReviewPath(input.fileRef.path, { required: true })
    const fileRef = expectedFileRef(input.taskId, filePath, input.fileRef.revision)
    if (input.fileRef.fileId !== fileRef.fileId) throw ApiError.badRequest('审阅文件标识无效')
    if ((input.side !== 'old' && input.side !== 'new') || !Number.isSafeInteger(input.line) || input.line < 1) {
      throw ApiError.badRequest('批注行号无效')
    }
    const body = input.body.trim()
    if (!body || body.length > 4_000) throw ApiError.badRequest('批注内容无效')
    const diff = await this.requireCurrentDiff(input.taskId, fileRef)
    if (!diffContainsLine(diff, input.side, input.line)) {
      throw ApiError.badRequest('批注行号不在当前差异范围内')
    }
    return this.tasks.createReviewComment({
      taskId: input.taskId,
      fileRef,
      side: input.side,
      line: input.line,
      body,
      clientOperationId: input.clientOperationId,
    })
  }

  private async requireCurrentDiff(
    taskId: string,
    fileRef: WorkspaceFileRef,
  ): Promise<string> {
    const diff = await this.getDiff(taskId, fileRef.path, fileRef.revision)
    if (diff.state === 'stale') throw new ApiError(409, '文件版本已变化，请刷新后重试', 'AUTHORITY_CONFLICT')
    if (diff.state !== 'ok' || typeof diff.diff !== 'string' || diff.fileRef?.revision !== fileRef.revision) {
      throw new ApiError(409, '当前文件没有可批注的差异', 'AUTHORITY_CONFLICT')
    }
    return diff.diff
  }

  private async withTaskWorkspace<T>(
    taskId: string,
    operation: (taskId: string) => Promise<T>,
  ): Promise<T> {
    try {
      const workspace = await this.tasks.requireWorkspaceCapability(taskId, 'review')
      const cwd = await this.getTaskWorkDir(taskId)
      if (!cwd || path.resolve(cwd) !== path.resolve(workspace.canonical_root)) throw new ApiError(409, '任务工作区不可用', 'WORKSPACE_REQUIRED')
    } catch (error) {
      throw reviewApiError(error)
    }

    try {
      return await operation(taskId)
    } catch (error) {
      throw reviewApiError(error)
    }
  }
}

export function createProductTaskReviewService(tasks: TaskResolver): ProductTaskReviewService {
  const getTaskWorkDir = async (taskId: string) => (
    await tasks.requireWorkspaceCapability(taskId, 'review')
  ).canonical_root
  return new ProductTaskReviewService(
    tasks,
    new WorkspaceService(getTaskWorkDir),
    getTaskWorkDir,
  )
}

function projectStatus(taskId: string, status: WorkspaceStatusResult): ProductTaskReviewStatus {
  if (status.state !== 'ok') {
    return {
      taskId,
      state: 'unavailable',
      repository: null,
      changedFiles: [],
    }
  }

  return {
    taskId,
    state: 'ready',
    repository: {
      name: status.repoName ?? '当前项目',
      branch: status.branch,
      isGitRepository: status.isGitRepo,
    },
    changedFiles: status.changedFiles
      .filter((file) => !isVcsMetadataPath(file.path) && !isVcsMetadataPath(file.oldPath ?? ''))
      .map((file) => ({
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
  }
}

function projectTree(taskId: string, tree: WorkspaceTreeResult): ProductTaskReviewTree {
  if (tree.state === 'error') {
    return { taskId, state: 'unavailable', path: tree.path, entries: [] }
  }

  return {
    taskId,
    state: tree.state,
    path: tree.path,
    entries: tree.entries
      .filter((entry) => !isVcsMetadataPath(entry.path) && !isVcsMetadataPath(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
      })),
  }
}

function projectFile(
  taskId: string,
  file: WorkspaceReadFileResult,
  fileRef?: WorkspaceFileRef,
): ProductTaskReviewFile {
  if (file.state === 'error') {
    return {
      taskId,
      state: 'unavailable',
      path: file.path,
      ...(fileRef ? { fileRef } : {}),
      language: file.language,
      size: file.size,
    }
  }

  return {
    taskId,
    state: file.state,
    path: file.path,
    ...(fileRef ? { fileRef } : {}),
    ...(file.previewType ? { previewType: file.previewType } : {}),
    ...(typeof file.content === 'string' ? { content: file.content } : {}),
    ...(typeof file.dataUrl === 'string' ? { dataUrl: file.dataUrl } : {}),
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    language: file.language,
    size: file.size,
    ...(file.truncated === undefined ? {} : { truncated: file.truncated }),
    ...(file.readBytes === undefined ? {} : { readBytes: file.readBytes }),
  }
}

function projectDiff(
  taskId: string,
  diff: WorkspaceDiffResult,
  fileRef?: WorkspaceFileRef,
): ProductTaskReviewDiff {
  const state = diff.state === 'not_git_repo'
    ? 'not_versioned'
    : diff.state === 'error'
      ? 'unavailable'
      : diff.state

  return {
    taskId,
    state,
    path: diff.path,
    ...(fileRef ? { fileRef } : {}),
    ...(typeof diff.diff === 'string' ? { diff: diff.diff } : {}),
  }
}

function sameWorkspaceRevision(
  before: WorkspaceFileRevisionResult,
  after: WorkspaceFileRevisionResult,
): boolean {
  return (
    before.state === 'ok' &&
    after.state === 'ok' &&
    before.revision === after.revision
  ) || (before.state === 'missing' && after.state === 'missing')
}

function hasRevisionError(
  before: WorkspaceFileRevisionResult,
  after: WorkspaceFileRevisionResult,
): boolean {
  return before.state === 'error' || after.state === 'error'
}

function createFileRef(
  taskId: string,
  filePath: string,
  revision: WorkspaceFileRevisionResult,
): WorkspaceFileRef | undefined {
  if (revision.state !== 'ok' || !revision.revision) return undefined
  return {
    fileId: fileId(taskId, filePath),
    path: filePath,
    revision: revision.revision,
  }
}

function createDiffFileRef(
  taskId: string,
  filePath: string,
  diff: WorkspaceDiffResult,
): WorkspaceFileRef | undefined {
  if (diff.state !== 'ok' || typeof diff.diff !== 'string') return undefined
  const revision = `rev_${createHash('sha256')
    .update(`${filePath}\0${diff.diff}`)
    .digest('hex')
    .slice(0, 32)}`
  return { fileId: fileId(taskId, filePath), path: filePath, revision }
}

function fileId(taskId: string, filePath: string): string {
  return `file_${createHash('sha256')
    .update(`${taskId}\0${filePath}`)
    .digest('hex')
    .slice(0, 20)}`
}

function expectedFileRef(
  taskId: string,
  filePath: string,
  value: string | undefined,
): WorkspaceFileRef {
  const revision = normalizeExpectedRevision(value)
  if (!revision) throw ApiError.badRequest('审阅文件 revision 必填')
  return { fileId: fileId(taskId, filePath), path: filePath, revision }
}

function diffContainsLine(diff: string, side: 'old' | 'new', targetLine: number): boolean {
  return parseProductTaskReviewDiff(diff).some(line => (
    side === 'old' ? line.oldLine === targetLine : line.newLine === targetLine
  ))
}

function staleFile(
  taskId: string,
  filePath: string,
  revision: WorkspaceFileRevisionResult,
): ProductTaskReviewFile {
  const fileRef = createFileRef(taskId, filePath, revision)
  return {
    taskId,
    state: 'stale',
    path: filePath,
    ...(fileRef ? { fileRef } : {}),
    language: 'text',
    size: 0,
  }
}

function unavailableFile(taskId: string, filePath: string): ProductTaskReviewFile {
  return {
    taskId,
    state: 'unavailable',
    path: filePath,
    language: 'text',
    size: 0,
  }
}

function staleDiff(
  taskId: string,
  filePath: string,
  revision: WorkspaceFileRevisionResult,
  fallbackRef?: WorkspaceFileRef,
): ProductTaskReviewDiff {
  const fileRef = createFileRef(taskId, filePath, revision) ?? fallbackRef
  return {
    taskId,
    state: 'stale',
    path: filePath,
    ...(fileRef ? { fileRef } : {}),
  }
}

function unavailableDiff(taskId: string, filePath: string): ProductTaskReviewDiff {
  return { taskId, state: 'unavailable', path: filePath }
}

function normalizeExpectedRevision(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^rev_[a-f0-9]{32}$/.test(value)) {
    throw ApiError.badRequest('审阅文件 revision 无效')
  }
  return value
}

function normalizeReviewPath(
  value: string,
  options: { required: boolean },
): string {
  if (typeof value !== 'string') {
    throw ApiError.badRequest('审阅路径必须是字符串')
  }
  const trimmed = value.trim()
  if (!trimmed) {
    if (options.required) {
      throw ApiError.badRequest('审阅文件需要 path 参数')
    }
    return ''
  }
  if (trimmed.length > 4_096) {
    throw ApiError.badRequest('审阅路径过长')
  }

  const normalized = trimmed.replace(/\\/g, '/')
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    path.win32.isAbsolute(trimmed) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new ApiError(403, '路径不在当前任务工作区内', 'FORBIDDEN')
  }

  const relativePath = normalized
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')

  if (isVcsMetadataPath(relativePath)) {
    throw new ApiError(403, '审阅不支持访问版本控制内部文件', 'FORBIDDEN')
  }

  return relativePath
}

function isVcsMetadataPath(value: string): boolean {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => VCS_METADATA_PATH_SEGMENTS.has(segment.toLowerCase()))
}

function reviewApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    if (error.code === 'WORKSPACE_REQUIRED' || error.code === 'WORKSPACE_RELINK_REQUIRED') return error
    if (error.statusCode === 400 || error.statusCode === 403) return error
    if (error.statusCode === 404) return ApiError.notFound('任务或其工作区不存在')
  }

  if (error instanceof Error && error.message.includes('outside workspace')) {
    return new ApiError(403, '路径不在当前任务工作区内', 'FORBIDDEN')
  }
  if (error instanceof Error && error.message.startsWith('Session not found:')) {
    return ApiError.notFound('任务或其工作区不存在')
  }

  return new ApiError(503, '任务审阅暂不可用', 'PRODUCT_TASK_REVIEW_UNAVAILABLE')
}
