import * as os from 'node:os'
import * as path from 'node:path'
import type {
  ContinueProductTaskInput,
  CreateProductTaskInput,
  CreateProductSideTaskInput,
  ProductRecentProject,
  ProductRecentProjectList,
  UpdateProductTaskInput,
} from '../../../shared/product/domain.js'
import { PRODUCT_TASK_PERMISSION_MODES } from '../../../shared/product/domain.js'
import { errorResponse, ApiError } from '../middleware/errorHandler.js'
import {
  productTaskReviewService,
  type ProductTaskReviewService,
} from '../product/taskReviewService.js'
import { assertAuthorityMapKey, assertOperationEnvelope } from '../../../shared/product/authority.js'
import { CoreOperationBridge, SessionCoreOperationBackend } from '../product/coreOperationBridge.js'
import { productTaskService, type ProductTaskService } from '../product/taskService.js'
import {
  ProductTaskMediaService,
  type ProductTaskMediaApi,
} from '../product/taskMediaService.js'
import { handleProductScheduledTasksApi } from './productScheduledTasks.js'
import {
  productScheduledTaskService,
  type ProductScheduledTaskService,
} from '../product/scheduledTaskService.js'
import { handleProductSettingsApi } from './productSettings.js'
import { handleProductTaskCommandsApi } from './productTaskCommands.js'
import { handleProductVoiceApi } from './productVoice.js'
import { handleProductDataEgressConsentApi } from './productDataEgressConsent.js'

type ProductTaskReviewApi = Pick<
  ProductTaskReviewService,
  'getStatus' | 'getTree' | 'getFile' | 'getDiff'
>

function authorityPath(): string {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'billiardbuddy', 'product-task-authority.v1.json')
}

const authorityBridge = new CoreOperationBridge(new SessionCoreOperationBackend())

function authoritativeEnvelope(value: unknown): { expected_revision: number; client_operation_id: string } {
  try {
    assertOperationEnvelope(value)
    assertAuthorityMapKey((value as { client_operation_id: unknown }).client_operation_id)
    return value as { expected_revision: number; client_operation_id: string }
  } catch {
    throw ApiError.badRequest('expected_revision 和 client_operation_id 必填且格式正确')
  }
}

function submitReceiptStatus(receipt: { outcome: string; error?: string }): number {
  if (receipt.outcome === 'accepted') return 201
  if (receipt.outcome === 'duplicate') return 200
  if (receipt.outcome === 'conflict' || receipt.error === 'AUTHORITY_CONFLICT' || receipt.error === 'OPERATION_INPUT_CONFLICT') return 409
  return receipt.error?.endsWith('_UNAVAILABLE') ? 503 : 422
}

export async function handleProductApi(
  req: Request,
  url: URL,
  segments: string[],
  tasks: Pick<
    ProductTaskService,
    | 'listTasks'
    | 'listRecentProjects'
    | 'createTask'
    | 'updateTask'
    | 'setPinned'
    | 'setArchived'
    | 'continueTask'
    | 'getTask'
    | 'getTaskThread'
    | 'listSideTasks'
    | 'createSideTask'
    | 'closeSideTask'
    | 'createTaskAuthoritatively'
    | 'continueTaskAuthoritatively'
    | 'createSideTaskAuthoritatively'
    | 'closeSideTaskAuthoritatively'
    | 'renameTaskAuthoritatively'
    | 'reconcileRenameAuthoritatively'
    | 'mutateTaskAuthoritatively'
    | 'mutateTaskDeletion'
    | 'getAuthorityOperation'
    | 'getConversationLineage'
    | 'getConversationLineageRoot'
    | 'getConversationLineageCurrent'
    | 'createConversationLineage'
    | 'setConversationLineageCurrent'
    | 'registerWorkspaceOperation'
    | 'relocateWorkspaceOperation'
    | 'relinkWorkspaceOperation'
    | 'mutateConversationLineage'
    | 'registerAttachmentIdentity'
    | 'ingestAttachment'
    | 'transitionAttachment'
    | 'bindAttachment'
    | 'submitTaskRun'
    | 'recoverTaskRun'
    | 'createAndSubmitTask'
    | 'listTaskEvents'
    | 'claimTaskRunDispatch'
    | 'createNewTaskComposerDraft'
    | 'createComposerDraft'
    | 'getComposerDraft'
    | 'mutateComposerDraft'
    | 'inspectWorkspace'
    | 'listTasksAuthoritatively'
    | 'listSideTasksAuthoritatively'
    | 'bindTaskWorkspace'
  > = productTaskService,
  review: ProductTaskReviewApi = productTaskReviewService,
  media: ProductTaskMediaApi = new ProductTaskMediaService(tasks),
  scheduledTasks: ProductScheduledTaskService = productScheduledTaskService,
): Promise<Response> {
  try {
    if (segments[2] === 'data-egress-consent') {
      return await handleProductDataEgressConsentApi(req, segments)
    }

    if (segments[2] === 'voice') {
      return await handleProductVoiceApi(req, segments)
    }

    if (segments[2] === 'task-commands') {
      return await handleProductTaskCommandsApi(req, url, segments)
    }

    if (segments[2] === 'settings') {
      return await handleProductSettingsApi(req, url, segments)
    }

    if (segments[2] === 'scheduled-tasks') {
      return await handleProductScheduledTasksApi(req, url, segments, scheduledTasks)
    }

    if (segments[2] === 'projects') {
      if (segments[3] !== 'recent' || segments[4]) {
        throw ApiError.notFound('未知产品项目资源')
      }
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json(
        publicRecentProjectList(await tasks.listRecentProjects(recentProjectLimit(url))),
      )
    }

    if (segments[2] === 'lineages') {
      const lineageId = segments[3]
      const action = segments[4]
      if (!lineageId) {
        if (req.method !== 'POST' || segments[3]) throw ApiError.notFound('未知会话谱系资源')
        const input = await readJson<{ task_id?: unknown; expected_task_revision?: unknown; parent_lineage_id?: unknown; fork_checkpoint_id?: unknown; client_operation_id?: unknown }>(req)
        if (!exactKeys(input, ['task_id', 'expected_task_revision', 'parent_lineage_id', 'fork_checkpoint_id', 'client_operation_id']) || typeof input.task_id !== 'string' || !Number.isSafeInteger(input.expected_task_revision) || (input.expected_task_revision as number) < 0 || typeof input.client_operation_id !== 'string' || input.parent_lineage_id !== null || input.fork_checkpoint_id !== null) throw ApiError.badRequest('lineage create 参数无效')
        const result = await tasks.createConversationLineage({ task_id: input.task_id, expected_task_revision: input.expected_task_revision, client_operation_id: input.client_operation_id })
        return Response.json({ lineage: publicLineage(result.lineage), receipt: { outcome: result.outcome, revision: result.authority_revision } }, { status: result.outcome === 'accepted' ? 201 : 200 })
      }
      if (!action && req.method === 'GET') {
        return Response.json({ lineage: publicLineage(await tasks.getConversationLineage(lineageId)) })
      }
      if (action === 'root' && !segments[5] && req.method === 'GET') {
        return Response.json({ lineage: publicLineage(await tasks.getConversationLineageRoot(lineageId)) })
      }
      // Child lineage construction is intentionally not an HTTP capability.
      // These mutations only advance an already-public opaque lineage id.
      if (!action || segments[5] || req.method !== 'POST' || !['advance', 'park', 'recovery', 'compact'].includes(action)) {
        throw ApiError.notFound('未知会话谱系资源')
      }
      const input = await readJson<{ expected_lineage_revision?: unknown; client_operation_id?: unknown; head_entry_id?: unknown }>(req)
      if (!assertPlainExactObject(input, ['expected_lineage_revision', 'client_operation_id'], ['head_entry_id']) || !Number.isSafeInteger(input.expected_lineage_revision) || (input.expected_lineage_revision as number) < 0 || typeof input.client_operation_id !== 'string' || (action === 'advance' && typeof input.head_entry_id !== 'string')) {
        throw ApiError.badRequest('lineage revision 和 operation 必填')
      }
      const receipt = await tasks.mutateConversationLineage({ lineage_id: lineageId, expected_revision: input.expected_lineage_revision, client_operation_id: input.client_operation_id, action: action as 'advance' | 'park' | 'recovery' | 'compact', ...(typeof input.head_entry_id === 'string' ? { head_entry_id: input.head_entry_id } : {}) })
      return Response.json({ receipt })
    }

    if (segments[2] === 'composer-drafts') {
      const draftId = segments[3]
      if (draftId === 'new-task') {
        if (req.method !== 'POST' || segments[4]) return methodNotAllowed(req.method)
        const input = await readJson<Record<string, unknown>>(req)
        if (!assertPlainExactObject(input, ['ttl_ms', 'client_operation_id']) || !Number.isSafeInteger(input.ttl_ms) || (input.ttl_ms as number) < 1 || typeof input.client_operation_id !== 'string' || !input.client_operation_id) throw ApiError.badRequest('new task draft 参数无效')
        try { assertAuthorityMapKey(input.client_operation_id) } catch { throw ApiError.badRequest('new task draft 参数无效') }
        const created = await tasks.createNewTaskComposerDraft({ ttl_ms: input.ttl_ms as number, client_operation_id: input.client_operation_id })
        return Response.json({ ...created, draft: publicDraft(created.draft) }, { status: created.outcome === 'accepted' ? 201 : 200 })
      }
      if (!draftId) {
        if (req.method !== 'POST') return methodNotAllowed(req.method)
        const input = await readJson<{ target_task_id?: unknown; workspace_id?: unknown; ttl_ms?: unknown; client_operation_id?: unknown }>(req)
        if (!assertPlainExactObject(input, ['target_task_id', 'ttl_ms', 'client_operation_id'], ['workspace_id']) || typeof input.target_task_id !== 'string' || (input.workspace_id !== undefined && typeof input.workspace_id !== 'string') || !Number.isSafeInteger(input.ttl_ms) || (input.ttl_ms as number) < 1 || typeof input.client_operation_id !== 'string') throw ApiError.badRequest('draft 参数无效')
        const created = await tasks.createComposerDraft({ target_task_id: input.target_task_id, ...(typeof input.workspace_id === 'string' ? { workspace_id: input.workspace_id } : {}), ttl_ms: input.ttl_ms, client_operation_id: input.client_operation_id })
        return Response.json({ ...created, draft: publicDraft(created.draft) }, { status: 201 })
      }
      if (draftId && !segments[4] && req.method === 'GET') return Response.json({ draft: await tasks.getComposerDraft(draftId) })
      if (req.method !== 'POST' || !segments[4]) return methodNotAllowed(req.method)
      const action = segments[4]
      if (action === 'attachments' && !segments[5]) {
        const input = await readJson<Record<string, unknown>>(req)
        if (!assertPlainExactObject(input, ['type', 'name', 'mime_type', 'data', 'client_operation_id']) || (input.type !== 'file' && input.type !== 'image') || typeof input.name !== 'string' || typeof input.mime_type !== 'string' || typeof input.data !== 'string' || typeof input.client_operation_id !== 'string') throw ApiError.badRequest('附件摄取参数无效')
        try { assertAuthorityMapKey(input.client_operation_id) } catch { throw ApiError.badRequest('附件摄取参数无效') }
        const attachment = await tasks.ingestAttachment({ owner: { kind: 'composer_draft', id: draftId }, type: input.type, name: input.name, mime_type: input.mime_type, data: input.data, client_operation_id: input.client_operation_id })
        return Response.json({ attachment }, { status: attachment.outcome === 'accepted' ? 201 : 200 })
      }
      if (!['update', 'consume', 'expire'].includes(action)) throw ApiError.notFound('未知草稿操作')
      const input = await readJson<{ expected_draft_revision?: unknown; client_operation_id?: unknown }>(req)
      if (!assertPlainExactObject(input, ['expected_draft_revision', 'client_operation_id']) || !Number.isSafeInteger(input.expected_draft_revision) || typeof input.client_operation_id !== 'string') throw ApiError.badRequest('draft revision 和 operation 必填')
      return Response.json({ receipt: await tasks.mutateComposerDraft({ draft_id: draftId, expected_revision: input.expected_draft_revision, client_operation_id: input.client_operation_id, action: action as 'update' | 'consume' | 'expire' }) })
    }

    if (segments[2] === 'attachments') {
      const attachmentId = segments[3]
      if (!attachmentId) {
        // Attachment verification and registration are an internal Module-07
        // verifier capability. Renderer input can never assert verified hashes.
        throw new ApiError(409, '附件登记当前不可用', 'OUT_OF_SCOPE_DISABLED')
      }
      const action = segments[4]
      if (req.method !== 'POST' || !action || segments[5] || !['transition', 'bind'].includes(action)) return methodNotAllowed(req.method)
      if (action === 'transition') {
        const input = await readJson<{ expected_revision?: unknown; target_state?: unknown; client_operation_id?: unknown; error?: unknown }>(req)
        if (!assertPlainExactObject(input, ['expected_revision', 'target_state', 'client_operation_id'], ['error']) || !Number.isSafeInteger(input.expected_revision) || !['inspecting', 'ready', 'failed', 'cancelled', 'discarded'].includes(input.target_state as string) || typeof input.client_operation_id !== 'string' || (input.error !== undefined && typeof input.error !== 'string')) throw ApiError.badRequest('attachment transition 参数无效')
        if (input.target_state === 'inspecting' || input.target_state === 'ready') throw new ApiError(409, '附件验证状态当前不可用', 'OUT_OF_SCOPE_DISABLED')
        return Response.json(await tasks.transitionAttachment({ attachment_id: attachmentId, expected_revision: input.expected_revision, target_state: input.target_state as 'inspecting' | 'ready' | 'failed' | 'cancelled' | 'discarded', client_operation_id: input.client_operation_id, ...(typeof input.error === 'string' ? { error: input.error } : {}) }))
      }
      const input = await readJson<{ expected_revision?: unknown; owner?: unknown; client_operation_id?: unknown }>(req)
      const owner = input.owner as Record<string, unknown> | undefined
      if (!exactKeys(input, ['expected_revision', 'owner', 'client_operation_id']) || !Number.isSafeInteger(input.expected_revision) || !owner || !exactKeys(owner, ['kind', 'id']) || (owner.kind !== 'composer_draft' && owner.kind !== 'product_task') || typeof owner.id !== 'string' || typeof input.client_operation_id !== 'string') throw ApiError.badRequest('attachment bind 参数无效')
      return Response.json(await tasks.bindAttachment(attachmentId, input.expected_revision, { kind: owner.kind, id: owner.id }, input.client_operation_id))
    }

    if (segments[2] === 'workspaces') {
      const workspaceId = segments[3]
      if (!workspaceId) {
        if (req.method !== 'POST') return methodNotAllowed(req.method)
        const input = await readJson<{ root?: unknown; expected_revision?: unknown; client_operation_id?: unknown }>(req)
        if (!exactKeys(input, ['root', 'expected_revision', 'client_operation_id']) || typeof input.root !== 'string' || !input.root.trim() || !Number.isSafeInteger(input.expected_revision) || (input.expected_revision as number) < 0 || typeof input.client_operation_id !== 'string' || !input.client_operation_id) throw ApiError.badRequest('workspace operation 参数无效')
        const result = await tasks.registerWorkspaceOperation({ root: input.root, expected_revision: input.expected_revision, client_operation_id: input.client_operation_id })
        return Response.json({ workspace: publicWorkspace(result.workspace), receipt: result.receipt }, { status: result.receipt.outcome === 'accepted' ? 201 : 200 })
      }
      if (segments[4] === 'inspect' && req.method === 'POST') return Response.json({ workspace: publicWorkspace(await tasks.inspectWorkspace(workspaceId)) })
      if (segments[4] === 'relocate' && req.method === 'POST') {
        const input = await readJson<{ root?: unknown; expected_workspace_revision?: unknown; client_operation_id?: unknown }>(req)
        if (!exactKeys(input, ['root', 'expected_workspace_revision', 'client_operation_id']) || typeof input.root !== 'string' || !input.root.trim() || !Number.isSafeInteger(input.expected_workspace_revision) || (input.expected_workspace_revision as number) < 0 || typeof input.client_operation_id !== 'string' || !input.client_operation_id) throw ApiError.badRequest('workspace relocate 参数无效')
        const result = await tasks.relocateWorkspaceOperation({ workspace_id: workspaceId, root: input.root, expected_workspace_revision: input.expected_workspace_revision, client_operation_id: input.client_operation_id })
        return Response.json({ workspace: publicWorkspace(result.workspace), receipt: result.receipt })
      }
      if (segments[4] === 'relink' && req.method === 'POST') {
        const input = await readJson<{ root?: unknown; expected_workspace_revision?: unknown; client_operation_id?: unknown }>(req)
        if (!exactKeys(input, ['root', 'expected_workspace_revision', 'client_operation_id']) || typeof input.root !== 'string' || !input.root.trim() || !Number.isSafeInteger(input.expected_workspace_revision) || (input.expected_workspace_revision as number) < 0 || typeof input.client_operation_id !== 'string' || !input.client_operation_id) throw ApiError.badRequest('workspace relink 参数无效')
        const result = await tasks.relinkWorkspaceOperation({ workspace_id: workspaceId, root: input.root, expected_workspace_revision: input.expected_workspace_revision, client_operation_id: input.client_operation_id })
        return Response.json({ workspace: publicWorkspace(result.workspace), receipt: result.receipt })
      }
      throw ApiError.notFound('未知工作区资源')
    }

    if (segments[2] !== 'tasks') {
      throw ApiError.notFound('未知产品资源')
    }

    const taskId = segments[3]
    const action = segments[4]

    if (!taskId) {
      if (req.method === 'GET') return Response.json(publicTaskIndex(await tasks.listTasksAuthoritatively()))
      if (req.method === 'POST') {
        const input = await readJson<Record<string, unknown>>(req)
        if (containsRawAttachment(input)) throw new ApiError(409, '附件导入当前不可用', 'ATTACHMENT_INGEST_UNAVAILABLE')
        if (!assertPlainExactObject(input, ['draft_id', 'expected_draft_revision', 'client_operation_id', 'text', 'attachment_ids', 'permission_mode']) || typeof input.draft_id !== 'string' || !Number.isSafeInteger(input.expected_draft_revision) || (input.expected_draft_revision as number) < 0 || typeof input.client_operation_id !== 'string' || !input.client_operation_id || typeof input.text !== 'string' || !Array.isArray(input.attachment_ids) || input.attachment_ids.some(id => typeof id !== 'string') || !(PRODUCT_TASK_PERMISSION_MODES as readonly unknown[]).includes(input.permission_mode)) throw ApiError.badRequest('首页 submit 参数无效')
        try { assertAuthorityMapKey(input.client_operation_id) } catch { throw ApiError.badRequest('首页 submit 参数无效') }
        const receipt = await tasks.createAndSubmitTask(input as import('../../../shared/product/domain.js').CreateAndSubmitTaskInput)
        return Response.json({ receipt }, { status: submitReceiptStatus(receipt) })
      }
      return methodNotAllowed(req.method)
    }

    if (action === 'runs' && !segments[5]) {
      if (req.method !== 'POST') return methodNotAllowed(req.method)
      const input = await readJson<Record<string, unknown>>(req)
      if (containsRawAttachment(input)) throw new ApiError(409, '附件导入当前不可用', 'ATTACHMENT_INGEST_UNAVAILABLE')
      if (!assertPlainExactObject(input, ['client_operation_id', 'expected_task_revision', 'expected_lineage_revision', 'text', 'attachment_ids', 'reference_entry_ids'], ['draft_id', 'expected_draft_revision'])
        || typeof input.client_operation_id !== 'string' || !Number.isSafeInteger(input.expected_task_revision) || (input.expected_task_revision as number) < 0 || !Number.isSafeInteger(input.expected_lineage_revision) || (input.expected_lineage_revision as number) < 0
        || typeof input.text !== 'string' || !Array.isArray(input.attachment_ids) || input.attachment_ids.some(id => typeof id !== 'string')
        || !Array.isArray(input.reference_entry_ids) || input.reference_entry_ids.length > 8 || new Set(input.reference_entry_ids).size !== input.reference_entry_ids.length || input.reference_entry_ids.some(id => typeof id !== 'string' || !/^thread_[a-f0-9]{20}$/.test(id))
        || ((input.draft_id === undefined) !== (input.expected_draft_revision === undefined))
        || (input.draft_id !== undefined && typeof input.draft_id !== 'string') || (input.expected_draft_revision !== undefined && (!Number.isSafeInteger(input.expected_draft_revision) || (input.expected_draft_revision as number) < 0))) throw ApiError.badRequest('submit 参数无效')
      try { assertAuthorityMapKey(input.client_operation_id) } catch { throw ApiError.badRequest('submit 参数无效') }
      const receipt = await tasks.submitTaskRun(taskId, input as import('../../../shared/product/domain.js').SubmitTaskRunInput)
      return Response.json({ receipt }, { status: submitReceiptStatus(receipt) })
    }

    if (action === 'events' && !segments[5]) {
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      const after = url.searchParams.get('after') ?? '0'
      if (!/^(0|[1-9][0-9]*)$/.test(after)) throw ApiError.badRequest('事件游标无效')
      return Response.json(await tasks.listTaskEvents(taskId, Number(after)))
    }

    if (action === 'delete' && !segments[5]) {
      if (req.method !== 'POST') return methodNotAllowed(req.method)
      const input = await readJson<Record<string, unknown>>(req)
      if (!assertPlainExactObject(input, ['phase', 'expected_revision', 'client_operation_id'])
        || !['begin', 'cancel', 'commit_purge', 'retry'].includes(input.phase as string)
        || !Number.isSafeInteger(input.expected_revision) || (input.expected_revision as number) < 0
        || typeof input.client_operation_id !== 'string') throw ApiError.badRequest('删除阶段、revision 和 operation 必填')
      const result = await tasks.mutateTaskDeletion(taskId, {
        action: input.phase as 'begin' | 'cancel' | 'commit_purge' | 'retry',
        expected_revision: input.expected_revision,
        client_operation_id: input.client_operation_id,
      })
      return Response.json({ task: publicTask(result.task), receipt: { outcome: result.outcome }, blockers: result.blockers }, { status: result.outcome === 'conflict' ? 409 : result.outcome === 'rejected' ? 422 : 200 })
    }

    if (action === 'operations') {
      const operationId = segments[5]
      if (req.method !== 'GET' || !operationId || segments[6]) return methodNotAllowed(req.method)
      return Response.json(await tasks.getAuthorityOperation(taskId, operationId, { authorityPath: authorityPath() }))
    }

    if (action === 'thread') {
      if (req.method !== 'GET') return methodNotAllowed(req.method)
      return Response.json(await tasks.getTaskThread(taskId))
    }

    if (action === 'lineage' && segments[5] === 'current' && !segments[6]) {
      if (req.method === 'GET') {
        const lineage = await tasks.getConversationLineageCurrent(taskId)
        return Response.json({ lineage: lineage ? publicLineage(lineage) : null })
      }
      if (req.method === 'POST') {
        const input = await readJson<{ lineage_id?: unknown; expected_task_revision?: unknown; expected_lineage_revision?: unknown; client_operation_id?: unknown }>(req)
        if (!exactKeys(input, ['lineage_id', 'expected_task_revision', 'expected_lineage_revision', 'client_operation_id']) || typeof input.lineage_id !== 'string' || !Number.isSafeInteger(input.expected_task_revision) || (input.expected_task_revision as number) < 0 || !Number.isSafeInteger(input.expected_lineage_revision) || (input.expected_lineage_revision as number) < 0 || typeof input.client_operation_id !== 'string') throw ApiError.badRequest('lineage current 参数无效')
        return Response.json({ receipt: await tasks.setConversationLineageCurrent({ task_id: taskId, lineage_id: input.lineage_id, expected_task_revision: input.expected_task_revision, expected_lineage_revision: input.expected_lineage_revision, client_operation_id: input.client_operation_id }) })
      }
      return methodNotAllowed(req.method)
    }

    if (action === 'review') {
      return await handleTaskReviewRoute(review, req, url, taskId, segments[5])
    }

    if (action === 'media') {
      const resource = segments[5]
      if (!resource) {
        if (req.method !== 'GET') return methodNotAllowed(req.method)
        return Response.json(await media.listForTask(taskId))
      }
      if (resource === 'attachable-projects' && !segments[6]) {
        if (req.method !== 'GET') return methodNotAllowed(req.method)
        return Response.json(await media.listAttachableForTask(taskId))
      }
      if (
        resource === 'projects'
        && segments[6]
      ) {
        const projectId = segments[6]
        if (segments[7] === 'assets' && segments[8] && !segments[9]) {
          if (req.method !== 'GET') return methodNotAllowed(req.method)
          return await media.assetResponse(taskId, projectId, segments[8], req)
        }
        if (segments[7] === 'attach' && !segments[8]) {
          if (req.method !== 'POST') return methodNotAllowed(req.method)
          return Response.json({ project: await media.attachProject(taskId, projectId) })
        }
      }
      throw ApiError.notFound('未知任务媒体资源')
    }

    if (action === 'side-tasks') {
      const sideTaskId = segments[5]
      const sideTaskAction = segments[6]

      if (!sideTaskId) {
        if (req.method === 'GET') {
          return Response.json({ sideTasks: (await tasks.listSideTasksAuthoritatively(taskId)).map(publicTask) })
        }
        if (req.method === 'POST') {
          const input = await readJson<CreateProductSideTaskInput & { sideTaskId?: string }>(req)
          const envelope = authoritativeEnvelope(input)
          if (!input.sideTaskId) throw ApiError.badRequest('sideTaskId 必填')
          const result = await tasks.createSideTaskAuthoritatively({ taskId, sideTaskId: input.sideTaskId, ...envelope, canonical_input: JSON.stringify(input) }, { authorityPath: authorityPath(), bridge: authorityBridge })
          const operation = await tasks.getAuthorityOperation(taskId, envelope.client_operation_id, { authorityPath: authorityPath() })
          return Response.json({ receipt: operation.receipt, authority: publicAuthority(operation.authority), sideTask: operation.authority.side_tasks?.find((sideTask) => sideTask.id === input.sideTaskId) }, { status: 201 })
        }
        return methodNotAllowed(req.method)
      }

      if (sideTaskAction === 'close') {
        if (req.method !== 'POST') return methodNotAllowed(req.method)
        const input = await readJson<Record<string, unknown>>(req)
        const envelope = authoritativeEnvelope(input)
        const result = await tasks.closeSideTaskAuthoritatively({ taskId, sideTaskId, ...envelope, canonical_input: JSON.stringify(input) }, { authorityPath: authorityPath() })
        const operation = await tasks.getAuthorityOperation(taskId, envelope.client_operation_id, { authorityPath: authorityPath() })
        return Response.json({ receipt: operation.receipt, authority: publicAuthority(operation.authority), sideTask: operation.authority.side_tasks?.find((sideTask) => sideTask.id === sideTaskId) })
      }

      throw ApiError.notFound(
        sideTaskAction
          ? `未知侧边任务操作：${sideTaskAction}`
          : `未知侧边任务资源：${sideTaskId}`,
      )
    }

    if (action === 'bind_workspace') {
      if (req.method !== 'POST') return methodNotAllowed(req.method)
      const input = await readJson<{ workspace_id?: unknown; expected_task_revision?: unknown; expected_workspace_revision?: unknown; client_operation_id?: unknown }>(req)
      if (!assertPlainExactObject(input, ['workspace_id', 'expected_task_revision', 'expected_workspace_revision', 'client_operation_id']) || typeof input.workspace_id !== 'string' || !Number.isSafeInteger(input.expected_task_revision) || !Number.isSafeInteger(input.expected_workspace_revision) || typeof input.client_operation_id !== 'string') throw ApiError.badRequest('workspace_id、双 revision 和 client_operation_id 必填')
      return Response.json({ receipt: await tasks.bindTaskWorkspace({ task_id: taskId, workspace_id: input.workspace_id, expected_task_revision: input.expected_task_revision, expected_workspace_revision: input.expected_workspace_revision, client_operation_id: input.client_operation_id }) })
    }

    if (!action) {
      if (req.method !== 'PATCH') return methodNotAllowed(req.method)
      const input = await readJson<UpdateProductTaskInput>(req)
      const envelope = authoritativeEnvelope(input)
      if (input.title !== undefined) {
        const result = await tasks.renameTaskAuthoritatively({ taskId, title: input.title, ...envelope }, { authorityPath: authorityPath(), bridge: authorityBridge })
        let mirror = result.mirror
        try {
          mirror = await tasks.reconcileRenameAuthoritatively(envelope.client_operation_id, { authorityPath: authorityPath(), bridge: authorityBridge })
        } catch {
          mirror = { state: 'failed', error: 'OPERATION_REJECTED' }
        }
        return Response.json({ receipt: result.receipt, authority: publicAuthority(result.snapshot), mirror, task: publicTask(result.task) })
      }
      const result = await tasks.mutateTaskAuthoritatively({ taskId, patch: { pinned: input.pinned }, ...envelope }, { authorityPath: authorityPath() })
      return Response.json({ receipt: result.receipt, authority: result.snapshot, task: publicTask(result.task) })
    }

    if (req.method !== 'POST') return methodNotAllowed(req.method)
    const input = await readJson<Record<string, unknown>>(req)
    const envelope = authoritativeEnvelope(input)
    switch (action) {
      case 'pin':
      case 'unpin':
      case 'archive':
      case 'restore': {
        const patch = action === 'pin' ? { pinned: true } : action === 'unpin' ? { pinned: false } : { archived: action === 'archive' }
        const result = await tasks.mutateTaskAuthoritatively({ taskId, patch, ...envelope }, { authorityPath: authorityPath() })
        return Response.json({ receipt: result.receipt, authority: result.snapshot, task: publicTask(result.task) })
      }
      case 'continue': {
        const body = input as ContinueProductTaskInput
        const result = await tasks.continueTaskAuthoritatively({ taskId, ...envelope, canonical_input: JSON.stringify(body) }, { authorityPath: authorityPath(), bridge: authorityBridge })
        const operation = await tasks.getAuthorityOperation(taskId, envelope.client_operation_id, { authorityPath: authorityPath() })
        return Response.json({ receipt: { outcome: result.outcome, revision: result.revision }, authority: publicAuthority(operation.authority) }, { status: 201 })
      }
      case 'recover': {
        if (!assertPlainExactObject(input, ['expected_revision', 'client_operation_id'])) throw ApiError.badRequest('recover 参数无效')
        const result = await tasks.recoverTaskRun(taskId, envelope)
        return Response.json(
          { receipt: result.receipt, authority: publicAuthority(result.snapshot), task: publicTask(result.task) },
          { status: result.receipt.outcome === 'accepted' ? 201 : result.receipt.outcome === 'duplicate' ? 200 : 409 },
        )
      }
      default:
        throw ApiError.notFound(`未知任务操作：${action}`)
    }
  } catch (error) {
    return errorResponse(error)
  }
}

function recentProjectLimit(url: URL): number {
  const raw = url.searchParams.get('limit')
  if (raw === null || !raw.trim()) return 10
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : 10
}

async function handleTaskReviewRoute(
  review: ProductTaskReviewApi,
  req: Request,
  url: URL,
  taskId: string,
  resource?: string,
): Promise<Response> {
  if (req.method !== 'GET') return methodNotAllowed(req.method)

  switch (resource) {
    case 'status':
      return Response.json(await review.getStatus(taskId))
    case 'tree':
      return Response.json(await review.getTree(taskId, url.searchParams.get('path') ?? ''))
    case 'file':
      return Response.json(await review.getFile(taskId, requireReviewPath(url)))
    case 'diff':
      return Response.json(await review.getDiff(taskId, requireReviewPath(url)))
    default:
      throw ApiError.notFound('未知任务审阅资源')
  }
}

function requireReviewPath(url: URL): string {
  const filePath = url.searchParams.get('path')
  if (!filePath?.trim()) {
    throw ApiError.badRequest('审阅文件需要 path 参数')
  }
  return filePath
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function isPlainValue(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
function hasDangerousKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasDangerousKey)
  if (!value || typeof value !== 'object') return false
  if (!isPlainValue(value)) return true
  for (const key of Object.keys(value)) if (DANGEROUS_KEYS.has(key) || hasDangerousKey(value[key])) return true
  return false
}
/** Exact plain-object contract gate for all BB-02B public mutations. */
function assertPlainExactObject(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> {
  if (!isPlainValue(value) || hasDangerousKey(value)) return false
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => required.includes(key) || optional.includes(key))
}
function containsRawAttachment(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsRawAttachment)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => ['data', 'mimeType', 'name'].includes(key) || containsRawAttachment(child))
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return assertPlainExactObject(value, keys)
}

async function readJson<T>(req: Request): Promise<T> {
  try {
    return await req.json() as T
  } catch {
    throw ApiError.badRequest('请求必须是 JSON')
  }
}

function methodNotAllowed(method: string): Response {
  return Response.json(
    { error: 'METHOD_NOT_ALLOWED', message: `不支持 ${method} 请求` },
    { status: 405 },
  )
}

function publicDraft(draft: Record<string, unknown>): PublicDraft {
  return { draft_id: String(draft.draft_id), ...(typeof draft.workspace_id === 'string' ? { workspace_id: draft.workspace_id } : {}), target_task_id: String(draft.target_task_id), revision: Number(draft.revision), last_activity: String(draft.last_activity), state: String(draft.state), created_at: String(draft.created_at), expires_at: String(draft.expires_at) }
}

function publicLineage(lineage: Record<string, unknown>): PublicLineage {
  const { lineage_id, product_task_id, parent_lineage_id, fork_checkpoint_id, head_entry_id, revision, compact_generation, state, created_at, updated_at } = lineage
  return { ...(typeof lineage_id === 'string' ? { lineage_id } : {}), ...(typeof product_task_id === 'string' ? { product_task_id } : {}), ...(typeof parent_lineage_id === 'string' ? { parent_lineage_id } : {}), ...(typeof fork_checkpoint_id === 'string' ? { fork_checkpoint_id } : {}), ...(typeof head_entry_id === 'string' ? { head_entry_id } : {}), ...(typeof revision === 'number' ? { revision } : {}), ...(typeof compact_generation === 'number' ? { compact_generation } : {}), ...(typeof state === 'string' ? { state } : {}), ...(typeof created_at === 'string' ? { created_at } : {}), ...(typeof updated_at === 'string' ? { updated_at } : {}) }
}

function publicWorkspace(workspace: Record<string, unknown>): PublicWorkspace {
  const { workspace_id, revision, availability, created_at, updated_at } = workspace
  return { workspace_id: String(workspace_id), revision: Number(revision), availability: String(availability), created_at: String(created_at), updated_at: String(updated_at) }
}

type PublicProductTask = {
  id?: string
  revision?: number
  task_scope?: unknown
  workspace_capability?: unknown
  current_lineage_id?: string
  projectId?: string
  directoryId?: string
  title?: string
  lifecycle?: string
  kind?: string
  pinnedAt?: string
  archivedAt?: string
  parentTaskId?: string
  createdAt?: string
  updatedAt?: string
  worktreeState?: string
  actions?: unknown
}
type PublicWorkspace = { workspace_id: string; revision: number; availability: string; created_at: string; updated_at: string }
type PublicDraft = { draft_id: string; workspace_id?: string; target_task_id: string; revision: number; last_activity: string; state: string; created_at: string; expires_at: string }
type PublicLineage = { lineage_id?: string; product_task_id?: string; parent_lineage_id?: string; fork_checkpoint_id?: string; head_entry_id?: string; revision?: number; compact_generation?: number; state?: string; created_at?: string; updated_at?: string }
type PublicReceipt = { client_operation_id?: string; expected_revision?: number; outcome: string; revision: number; error?: string }
type PublicOperationResponse = { receipt: PublicReceipt }
type PublicAuthoritySnapshot = { revision: number; event_sequence?: number; tasks: PublicProductTask[]; side_tasks?: PublicProductTask[] }

function publicTask(task: Record<string, unknown>): PublicProductTask {
  const {
    coreSessionId: _legacyCoreSessionId,
    sourceTurnId: _privateCoreSourceTurnId,
    parentThreadId: _legacyCoreParentThreadId,
    workDir: _workDir,
    binding: _binding,
    resume_binding_id: _resumeBindingId,
    ...publicTask
  } = task
  return publicTask
}

function publicAuthority(authority: { revision: number; event_sequence?: number; tasks: Record<string, unknown>[]; side_tasks?: Record<string, unknown>[] }): PublicAuthoritySnapshot {
  return { ...authority, tasks: authority.tasks.map(publicTask), ...(authority.side_tasks ? { side_tasks: authority.side_tasks.map(publicTask) } : {}) }
}

function publicTaskIndex(index: { tasks: Record<string, unknown>[] } & Record<string, unknown>): Record<string, unknown> {
  return {
    ...index,
    tasks: index.tasks.map(publicTask),
  }
}

/**
 * The task service returns this public shape already, but retain a narrow
 * projection at the HTTP boundary so future private task metadata cannot be
 * serialized into the ordinary project picker by accident.
 */
function publicRecentProjectList(
  result: ProductRecentProjectList,
): ProductRecentProjectList {
  return {
    projects: result.projects.map(publicRecentProject),
  }
}

function publicRecentProject(project: ProductRecentProject): ProductRecentProject {
  return {
    projectPath: project.projectPath,
    realPath: project.realPath,
    projectName: project.projectName,
    isGit: project.isGit,
    repoName: project.repoName,
    branch: project.branch,
    modifiedAt: project.modifiedAt,
    sessionCount: project.sessionCount,
  }
}
