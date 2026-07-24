import { expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { ProductTaskAuthorityRepository } from '../product/authorityRepository.js'
import { ProductTaskService } from '../product/taskService.js'

test('review comments are durable, idempotent, task-owned, and revision-scoped', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-review-comments-'))
  const storagePath = path.join(dir, 'product-tasks.json')
  const authorityPath = path.join(dir, 'product-task-authority.v1.json')
  await fs.writeFile(storagePath, JSON.stringify({ version: 4, projects: {}, directories: {}, tasks: {}, sideTasks: {} }))
  const authority = new ProductTaskAuthorityRepository(authorityPath)
  const now = '2026-07-24T00:00:00.000Z'
  await authority.mutateCapabilities((state) => {
    state.tasks.task = {
      task: { id: 'task', projectId: '', directoryId: '', workDir: '', title: 'task', lifecycle: 'active', kind: 'main', createdAt: now, updatedAt: now, worktreeState: 'not_requested', actions: [], revision: 7 },
      binding: { coreSessionId: 'core' },
    }
  })
  const service = new ProductTaskService({ storagePath, now: () => new Date(now) })
  const fileRef = {
    fileId: `file_${createHash('sha256').update('task\0src/main.ts').digest('hex').slice(0, 20)}`,
    path: 'src/main.ts',
    revision: `rev_${'a'.repeat(32)}`,
  }
  const input = {
    taskId: 'task',
    fileRef,
    side: 'new' as const,
    line: 4,
    body: '请补充边界测试',
    clientOperationId: 'review-comment-op',
  }

  const accepted = await service.createReviewComment(input)
  await authority.mutateCapabilities((state) => { state.task_scopes.unrelated = { kind: 'installation-default' } })
  const duplicate = await service.createReviewComment(input)
  expect(accepted.outcome).toBe('accepted')
  expect(duplicate).toEqual({ ...accepted, outcome: 'duplicate' })
  expect(accepted.comment.commentId).toMatch(/^comment_[a-f0-9]{20}$/)

  const restarted = new ProductTaskService({ storagePath })
  await expect(restarted.listReviewComments('task', fileRef)).resolves.toEqual([accepted.comment])
  await expect(restarted.listReviewComments('task', { ...fileRef, revision: `rev_${'b'.repeat(32)}` })).resolves.toEqual([])
  await expect(service.createReviewComment({ ...input, body: '不同输入' })).rejects.toMatchObject({ statusCode: 409 })

  const persisted = await authority.read()
  expect(persisted.authority_schema_revision).toBe(4)
  expect(Object.keys(persisted.review_comments)).toEqual([accepted.comment.commentId])
  expect((persisted.tasks.task as { task: { revision: number } }).task.revision).toBe(7)
  expect(Object.keys(persisted.receipts)).toContain('review-comment-op')
})
