// Public task-index shape v2 adds persistent project-directory bindings and
// distinguishes a project root from a task's live execution directory.
export const PRODUCT_DOMAIN_VERSION = 2 as const

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
  /**
   * Stable project root owned by the product registry. This is not a task's
   * current execution directory: a task may run from a nested directory or
   * a materialized worktree while remaining in this project.
   */
  rootDir: string
  createdAt: string
  taskCount: number
  archivedTaskCount: number
  updatedAt: string
}

/**
 * A directory explicitly associated with a product project. Product tasks
 * bind to this identity, while their `workDir` continues to reflect the
 * actual directory currently used by the Agent Core.
 */
export type ProductProjectDirectory = {
  id: string
  projectId: string
  path: string
  label: string
  createdAt: string
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

export type ProductWorkspaceAvailability = 'available' | 'missing' | 'read_only' | 'identity_changed' | 'relink_required'
export type ProductWorkspaceRootIdentity = { platform: string; volume_id: string; file_id: string }
export type ProductTaskScope = { kind: 'installation-default' } | { kind: 'workspace'; workspace_id: string; generation: number }
/** Public, path-free workspace state used solely for renderer affordances. */
export type ProductTaskWorkspaceCapability = {
  scope: ProductTaskScope
  workspace_revision?: number
  availability?: ProductWorkspaceAvailability
  available: boolean
}
export type ProductWorkspace = {
  workspace_id: string
  installation_id: string
  /** Server-only: bind callers never supply or need this path. */
  canonical_root: string
  root_identity: ProductWorkspaceRootIdentity
  revision: number
  availability: ProductWorkspaceAvailability
  created_at: string
  updated_at: string
}

export type ProductTask = {
  id: string
  /** Entity CAS revision; never the repository authority revision. */
  revision?: number
  task_scope?: ProductTaskScope
  /** Public capability projection: never contains canonical roots or cwd. */
  workspace_capability?: ProductTaskWorkspaceCapability
  current_lineage_id?: string
  projectId: string
  directoryId: string
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
  directories: ProductProjectDirectory[]
  tasks: ProductTask[]
  total: number
}

export type ProductTaskMutationEnvelope = {
  /** CAS revision used by every metadata mutation. */
  expected_revision?: number
  /** Durable client idempotency key for this mutation. */
  client_operation_id?: string
}

export type CreateProductTaskInput = ProductTaskMutationEnvelope & {
  /**
   * A previously registered project/directory pair. Both values are required
   * together and the server resolves the actual path from its own registry.
   */
  projectId?: string
  directoryId?: string
  /**
   * Compatibility path for selecting a new directory. The server
   * canonicalizes it and registers or reuses a product project/directory
   * before creating the Agent Core session.
   */
  workDir?: string
  title?: string
  useWorktree?: boolean
  /**
   * The safe product-facing execution choice for this new task. Omitted
   * values keep the same per-request confirmation behavior as `ask`.
   */
  permissionMode?: ProductTaskPermissionMode
}

export type UpdateProductTaskInput = ProductTaskMutationEnvelope & {
  title?: string
  pinned?: boolean
}

export type ContinueProductTaskInput = ProductTaskMutationEnvelope & {
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

export type CreateProductSideTaskInput = ProductTaskMutationEnvelope & {
  /** A product-thread entry id; the server resolves the private Core turn. */
  sourceEntryId: string
  title?: string
}
