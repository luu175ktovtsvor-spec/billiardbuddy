import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskService } from '../product/taskService.js'

test('durable TaskRun identity carries its exact lineage checkpoint only to the private Core launch', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-session-memory-identity-'))
  try {
    const storagePath = path.join(root, 'product-tasks.json')
    const now = '2026-01-01T00:00:00.000Z'
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now } } }))
    const service = new ProductTaskService({ storagePath, now: () => new Date(now) })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath: path.join(root, 'product-task-authority.v1.json') })
    const parent = await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'parent' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'parent turn', attachment_ids: [] })
    const child = await service.createConversationLineage({ task_id: 'task', expected_task_revision: 2, parent_lineage_id: parent.lineage.lineage_id as string, fork_checkpoint_id: first.result!.entry_id, client_operation_id: 'child' })
    await service.setConversationLineageCurrent({ task_id: 'task', lineage_id: child.lineage.lineage_id as string, expected_task_revision: 2, expected_lineage_revision: 0, client_operation_id: 'select-child' })
    const second = await service.submitTaskRun('task', { expected_task_revision: 3, expected_lineage_revision: 0, client_operation_id: 'second', text: 'child turn', attachment_ids: [] })
    const identity = await service.readTaskRunDispatchIdentity(second.result!.run_id, 1)
    expect(identity).toMatchObject({
      task_id: 'task',
      lineage_id: child.lineage.lineage_id,
      session_memory: {
        storage_dir: path.join(root, 'product-session-memory'),
        entry_id: second.result!.entry_id,
        ancestors: [{ lineage_id: parent.lineage.lineage_id, inherit_through_entry_id: first.result!.entry_id }],
      },
    })
    expect(JSON.stringify(await service.getConversationLineage(child.lineage.lineage_id as string))).not.toContain(identity.resume_binding_id)
    expect(JSON.stringify(await service.listTaskEvents('task'))).not.toContain(identity.session_memory.storage_dir)

    const cleared = await service.createConversationLineage({ task_id: 'task', expected_task_revision: 4, client_operation_id: 'clear-root' })
    const third = await service.submitTaskRun('task', { expected_task_revision: 5, expected_lineage_revision: 0, client_operation_id: 'third', text: 'fresh root', attachment_ids: [] })
    expect(await service.readTaskRunDispatchIdentity(third.result!.run_id, 1)).toMatchObject({
      lineage_id: cleared.lineage.lineage_id,
      session_memory: { ancestors: [] },
    })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
