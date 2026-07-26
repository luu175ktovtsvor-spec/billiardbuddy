import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskService } from '../product/taskService.js'

test('durable TaskRun identity reconstructs its exact authoritative lineage checkpoint for Core', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-session-memory-identity-'))
  try {
    const storagePath = path.join(root, 'product-tasks.json')
    const now = '2026-01-01T00:00:00.000Z'
    await fs.writeFile(storagePath, JSON.stringify({ version: 4, tasks: { task: { coreSessionId: 'core', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now } } }))
    const service = new ProductTaskService({ storagePath, now: () => new Date(now), autoMemoryEnabled: async () => false })
    await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath: path.join(root, 'product-task-authority.v1.json') })
    const parent = await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'parent' })
    const first = await service.submitTaskRun('task', { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: 'parent turn', attachment_ids: [] })
    await service.recordTaskRunTerminalProjection(first.result!.run_id, 1, 'completed', 'parent answer')
    const child = await service.createConversationLineage({ task_id: 'task', expected_task_revision: 2, parent_lineage_id: parent.lineage.lineage_id as string, fork_checkpoint_id: first.result!.entry_id, client_operation_id: 'child' })
    await service.setConversationLineageCurrent({ task_id: 'task', lineage_id: child.lineage.lineage_id as string, expected_task_revision: 2, expected_lineage_revision: 0, client_operation_id: 'select-child' })
    const second = await service.submitTaskRun('task', { expected_task_revision: 3, expected_lineage_revision: 0, client_operation_id: 'second', text: 'child turn', attachment_ids: [] })
    const identity = await service.readTaskRunDispatchIdentity(second.result!.run_id, 1)
    expect(identity).toMatchObject({
      task_id: 'task',
      lineage_id: child.lineage.lineage_id,
      initial_input: 'child turn',
      auto_memory: {
        storage_dir: path.join(root, 'product-auto-memory'),
        enabled: false,
        entry_id: second.result!.entry_id,
      },
      session_context: {
        compact_generation: 0,
      },
    })
    expect(identity.session_context.text).toContain('parent turn')
    expect(identity.session_context.text).toContain('parent answer')
    expect(identity.session_context.text).not.toContain('child turn')
    expect(JSON.stringify(await service.getConversationLineage(child.lineage.lineage_id as string))).not.toContain(identity.resume_binding_id)
    expect(JSON.stringify(await service.listTaskEvents('task'))).not.toContain(identity.auto_memory.storage_dir)

    expect(await service.claimTaskRunDispatch(second.result!.run_id, 1)).toMatchObject({ outcome: 'claimed' })
    const compactStarted = await service.recordTaskRunContextCompaction(second.result!.run_id, 1, { type: 'event', event: 'context_compaction', phase: 'started', source: 'automatic', generation: 1, input_tokens: identity.session_context.estimated_tokens })
    const compactCompleted = await service.recordTaskRunContextCompaction(second.result!.run_id, 1, { type: 'event', event: 'context_compaction', phase: 'completed', source: 'automatic', generation: 1, input_tokens: identity.session_context.estimated_tokens, output_tokens: 5, summary: '父谱系压缩摘要', compacted_through_event_sequence: identity.session_context.event_sequence })
    expect(compactStarted.event.item.phase).toBe('started')
    expect(compactCompleted.event.item.phase).toBe('completed')
    expect(JSON.stringify(await service.listTaskEvents('task'))).not.toContain('父谱系压缩摘要')
    expect(await service.getConversationLineage(child.lineage.lineage_id as string)).toMatchObject({ compact_generation: 1 })
    await service.recordTaskRunTerminalProjection(second.result!.run_id, 1, 'completed', 'child answer')
    const afterCompact = await service.submitTaskRun('task', { expected_task_revision: 4, expected_lineage_revision: 2, client_operation_id: 'after-compact', text: 'next child', attachment_ids: [] })
    const resumedContext = (await service.readTaskRunDispatchIdentity(afterCompact.result!.run_id, 1)).session_context.text
    expect(resumedContext).toContain('父谱系压缩摘要')
    expect(resumedContext).toContain('child turn')
    expect(resumedContext).toContain('child answer')
    expect(resumedContext).not.toContain('parent turn')
    await service.recordTaskRunTerminalProjection(afterCompact.result!.run_id, 1, 'completed', 'next answer')
    const cleared = await service.createConversationLineage({ task_id: 'task', expected_task_revision: 5, client_operation_id: 'clear-root' })
    const third = await service.submitTaskRun('task', { expected_task_revision: 6, expected_lineage_revision: 0, client_operation_id: 'third', text: 'fresh root', attachment_ids: [] })
    expect(await service.readTaskRunDispatchIdentity(third.result!.run_id, 1)).toMatchObject({
      lineage_id: cleared.lineage.lineage_id,
      session_context: { text: '', compact_generation: 0 },
    })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
