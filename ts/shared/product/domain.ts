export const PRODUCT_DOMAIN_VERSION = 1 as const

export type ProductTaskLifecycle = 'active' | 'archived'
export type ProductTaskKind = 'main' | 'continuation'
export type ProductWorktreeState = 'not_requested' | 'planned' | 'materialized'
export type ProductSideTaskStatus = 'open' | 'closed'
export type ProductContinuationTarget = 'current_workspace' | 'new_worktree'

/**
 * Product-facing task start choices. These intentionally do not mirror the
 * Agent Core's permission-mode wire values, so the product contract can stay
 * stable and only offer modes that are appropriate for ordinary users.
 */
export const PRODUCT_TASK_PERMISSION_MODES = [
  'ask',
  'allow_edits',
  'plan_only',
] as const

export type ProductTaskPermissionMode =
  (typeof PRODUCT_TASK_PERMISSION_MODES)[number]

export type ProductProject = {
  id: string
  title: string
  workDir: string
  taskCount: number
  archivedTaskCount: number
  updatedAt: string
}

/**
 * A recent project for product-owned directory selection.
 *
 * `sessionCount` is retained for the existing picker contract, but its value
 * is derived from visible product tasks rather than exposing Agent Core
 * sessions or their identifiers.
 */
export type ProductRecentProject = {
  projectPath: string
  realPath: string
  projectName: string
  isGit: boolean
  repoName: string | null
  branch: string | null
  modifiedAt: string
  sessionCount: number
}

export type ProductRecentProjectList = {
  projects: ProductRecentProject[]
}

export type ProductTask = {
  id: string
  projectId: string
  workDir: string
  title: string
  lifecycle: ProductTaskLifecycle
  kind: ProductTaskKind
  pinnedAt?: string
  archivedAt?: string
  parentTaskId?: string
  createdAt: string
  updatedAt: string
  worktreeState: ProductWorktreeState
}

/**
 * A temporary, message-anchored fork of a product task.
 *
 * Side tasks deliberately do not use ProductTaskKind: their Core session is
 * isolated from the regular task index and remains available after closing.
 */
export type ProductSideTask = {
  id: string
  parentTaskId: string
  /** An opaque product task reference for the side task's safe stream. */
  taskId: string
  title: string
  status: ProductSideTaskStatus
  createdAt: string
  updatedAt: string
  closedAt?: string
}

export type ProductSideTaskList = {
  sideTasks: ProductSideTask[]
}

export type ProductTaskIndex = {
  schemaVersion: typeof PRODUCT_DOMAIN_VERSION
  projects: ProductProject[]
  tasks: ProductTask[]
  total: number
}

export type CreateProductTaskInput = {
  workDir: string
  title?: string
  useWorktree?: boolean
  /**
   * The safe product-facing execution choice for this new task. Omitted
   * values keep the same per-request confirmation behavior as `ask`.
   */
  permissionMode?: ProductTaskPermissionMode
}

export type UpdateProductTaskInput = {
  title?: string
  pinned?: boolean
}

export type ContinueProductTaskInput = {
  title?: string
  /**
   * Optional opaque product-thread entry anchor. When omitted, continuation
   * branches the complete task transcript. The server resolves this to the
   * private Core turn and never exposes that turn id to the renderer.
   */
  sourceEntryId?: string
  /**
   * Continue in the source task's workspace by default. A new worktree is
   * materialized before the branched transcript is created.
   */
  target?: ProductContinuationTarget
}

export type CreateProductSideTaskInput = {
  /** A product-thread entry id; the server resolves the private Core turn. */
  sourceEntryId: string
  title?: string
}
