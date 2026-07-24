import { afterEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ProductTaskService } from './taskService.js'
import { ProductTaskAuthorityRepository } from './authorityRepository.js'

let roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-07-attachment-'))
  roots.push(root)
  const storagePath = path.join(root, 'product-tasks.json')
  await fs.writeFile(storagePath, JSON.stringify({
    version: 4,
    tasks: {
      task: {
        coreSessionId: 'core',
        title: 'task',
        lifecycle: 'active',
        kind: 'main',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  }))
  const service = new ProductTaskService({ storagePath, installationId: 'install', now: () => new Date('2026-01-01T00:00:00.000Z') })
  await service.ensureAuthorityProjectionForLegacyTask('task', { authorityPath: path.join(root, 'product-task-authority.v1.json') })
  await service.createConversationLineage({ task_id: 'task', expected_task_revision: 0, client_operation_id: 'lineage' })
  const draft = await service.createComposerDraft({ target_task_id: 'task', ttl_ms: 60_000, client_operation_id: 'draft' })
  return { root, service, draftId: draft.draft.draft_id as string }
}

describe('ProductTask attachment ingest', () => {
  test('verifies, owns and persists a copy before a run can bind it', async () => {
    const { service, draftId } = await fixture()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const ingested = await service.ingestAttachment({
      owner: { kind: 'composer_draft', id: draftId },
      type: 'image',
      name: '../球台原图.exe',
      mime_type: 'image/png',
      data: `data:image/png;base64,${png.toString('base64')}`,
      client_operation_id: 'ingest',
    })

    expect(ingested).toMatchObject({ outcome: 'accepted', attachment_revision: 2 })
    const submitted = await service.submitTaskRun('task', {
      expected_task_revision: 1,
      expected_lineage_revision: 0,
      draft_id: draftId,
      expected_draft_revision: 0,
      client_operation_id: 'submit',
      text: '分析附件',
      attachment_ids: [ingested.attachment_id],
    })
    expect(submitted.outcome).toBe('accepted')

    const identity = await service.readTaskRunDispatchIdentity(submitted.result!.run_id, 1)
    expect(identity.initial_attachments).toHaveLength(1)
    expect(path.basename(identity.initial_attachments![0]!)).toBe('球台原图.png')
    expect(await fs.readFile(identity.initial_attachments![0]!)).toEqual(png)
  })

  test('rejects spoofed media before creating an attachment identity', async () => {
    const { root, service, draftId } = await fixture()
    await expect(service.ingestAttachment({
      owner: { kind: 'composer_draft', id: draftId },
      type: 'image',
      name: '伪装.png',
      mime_type: 'image/png',
      data: `data:image/png;base64,${Buffer.from('not-a-png').toString('base64')}`,
      client_operation_id: 'spoofed',
    })).rejects.toMatchObject({ code: 'ATTACHMENT_REJECTED' })

    const authority = await new ProductTaskAuthorityRepository(path.join(root, 'product-task-authority.v1.json')).read()
    expect(authority.task_attachments).toEqual({})
  })
})
