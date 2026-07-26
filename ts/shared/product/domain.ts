// Public task-index shape v2 adds persistent project-directory bindings and
// distinguishes a project root from a task's live execution directory.
export const PRODUCT_DOMAIN_VERSION = 2 as const

export type ProductTaskLifecycle =
  | 'active'
  | 'archived'
  | 'deleting'
  | 'delete_failed_pre_purge'
  | 'purge_committed'
  | 'delete_failed_post_purge'
  | 'deleted'
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
  'ask_for_approval',
  'approve_for_me',
  'full_access',
] as const

export type ProductTaskPermissionMode =
  (typeof PRODUCT_TASK_PERMISSION_MODES)[number]

export type ProductPermissionSnapshot = {
  version: 1
  mode: ProductTaskPermissionMode
  sandbox: 'workspace-write' | 'danger-full-access'
  approval: 'on-request' | 'never'
  reviewer: 'user' | 'automatic' | 'none'
}

export const PRODUCT_PERMISSION_PROFILES: Record<
  ProductTaskPermissionMode,
  ProductPermissionSnapshot
> = {
  ask_for_approval: {
    version: 1,
    mode: 'ask_for_approval',
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: 'user',
  },
  approve_for_me: {
    version: 1,
    mode: 'approve_for_me',
    sandbox: 'workspace-write',
    approval: 'on-request',
    reviewer: 'automatic',
  },
  full_access: {
    version: 1,
    mode: 'full_access',
    sandbox: 'danger-full-access',
    approval: 'never',
    reviewer: 'none',
  },
}

export function productPermissionSnapshot(
  mode: ProductTaskPermissionMode,
): ProductPermissionSnapshot {
  return { ...PRODUCT_PERMISSION_PROFILES[mode] }
}

export function isProductPermissionSnapshot(
  value: unknown,
): value is ProductPermissionSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const snapshot = value as Record<string, unknown>
  if (Object.keys(snapshot).sort().join(',') !== 'approval,mode,reviewer,sandbox,version') return false
  const profile = typeof snapshot.mode === 'string'
    ? PRODUCT_PERMISSION_PROFILES[snapshot.mode as ProductTaskPermissionMode]
    : undefined
  return Boolean(profile)
    && snapshot.version === profile!.version
    && snapshot.sandbox === profile!.sandbox
    && snapshot.approval === profile!.approval
    && snapshot.reviewer === profile!.reviewer
}

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
  /** Default for future runs. Every accepted run stores its own immutable copy. */
  permission_snapshot?: ProductPermissionSnapshot
  projectId: string
  directoryId: string
  workDir: string
  title: string
  lifecycle: ProductTaskLifecycle
  kind: ProductTaskKind
  pinnedAt?: string
  archivedAt?: string
  deletion?: {
    phase: Exclude<ProductTaskLifecycle, 'active' | 'archived'>
    fencing_token: string
    cleanup_plan_hash: string
    started_at: string
    failed_items?: string[]
    tombstone_expires_at?: string
  }
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
   * values keep the same per-request confirmation behavior as
   * `ask_for_approval`.
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
   * A fork always materializes an independent worktree. The legacy
   * current_workspace value remains a type-level read compatibility shim and
   * is rejected by the authoritative mutation route.
   */
  target?: ProductContinuationTarget
}

export type CreateProductSideTaskInput = ProductTaskMutationEnvelope & {
  /** A product-thread entry id; the server resolves the private Core turn. */
  sourceEntryId: string
  title?: string
}

/** Strict public submit input. Attachment bytes are never accepted here. */
export type SubmitTaskRunInput = {
  client_operation_id: string
  expected_task_revision: number
  expected_lineage_revision: number
  text: string
  attachment_ids: string[]
  /** Opaque persisted task-thread entries explicitly quoted by this turn. */
  reference_entry_ids?: string[]
  draft_id?: string
  expected_draft_revision?: number
}

export type CreateAndSubmitTaskInput = {
  draft_id: string
  expected_draft_revision: number
  client_operation_id: string
  text: string
  attachment_ids: string[]
  permission_mode: ProductTaskPermissionMode
}

export type SubmitTaskRunReceipt = {
  client_operation_id: string
  outcome: 'accepted' | 'duplicate' | 'conflict' | 'rejected'
  authority_revision: number
  entity_revisions: Record<string, number>
  result?:
    | { task_id: string; run_id: string; entry_id: string; dispatch_generation: number; delivery?: 'turn' }
    | { task_id: string; queue_item_id: string; entry_id: string; delivery: 'queued' }
  error?: string
}
