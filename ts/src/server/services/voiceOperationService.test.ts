import { describe, expect, test } from 'bun:test'
import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VoiceOperationError, VoiceOperationService } from './voiceOperationService.js'

async function root(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'bb-voice-operation-'))
}

const consent = 'a'.repeat(64)

describe('VoiceOperationService', () => {
  test('materializes VoiceOperation, raw Transcript and an immutable edit revision', async () => {
    const service = new VoiceOperationService({ root: await root() })
    const started = await service.begin(
      new File(['audio'], 'voice.webm', { type: 'audio/webm' }),
      consent,
    )
    const completed = await service.complete(started.operation.id, ' 原始转写 ')
    const raw = completed.transcript.revisions[0]!

    expect(completed.operation).not.toHaveProperty('consent_receipt_id')
    expect(completed.operation).toMatchObject({ status: 'succeeded', raw_revision_id: raw.id })
    expect(raw).toMatchObject({ kind: 'raw', text: '原始转写' })

    const edited = await service.revise(completed.transcript.id, {
      parent_revision_id: raw.id,
      text: '人工校正后的转写',
    })
    expect(edited.revisions).toHaveLength(2)
    expect(edited.revisions[0]).toEqual(raw)
    expect(edited.revisions[1]).toMatchObject({
      kind: 'edit',
      parent_revision_id: raw.id,
      text: '人工校正后的转写',
    })
    expect(edited.current_revision_id).toBe(edited.revisions[1]!.id)

    await expect(service.revise(completed.transcript.id, {
      parent_revision_id: raw.id,
      text: '覆盖并发编辑',
    })).rejects.toMatchObject({ code: 'TRANSCRIPT_REVISION_CONFLICT' })
  })

  test('cancels the owned signal and discards a late provider result', async () => {
    const service = new VoiceOperationService({ root: await root() })
    const started = await service.begin(new File(['audio'], 'voice.webm'), consent)
    await service.cancel(started.operation.id)

    expect(started.signal.aborted).toBe(true)
    await expect(service.complete(started.operation.id, '迟到结果')).rejects.toBeInstanceOf(VoiceOperationError)
    expect(await service.getOperation(started.operation.id)).toMatchObject({ status: 'cancelled' })
  })

  test('binds an exact revision to Composer and video Evidence idempotently', async () => {
    const service = new VoiceOperationService({ root: await root() })
    const started = await service.begin(new File(['audio'], 'voice.webm'), consent)
    const { transcript } = await service.complete(started.operation.id, '比赛画面说明')
    const rawRevisionId = transcript.raw_revision_id

    const composer = await service.bind(transcript.id, {
      revision_id: rawRevisionId,
      consumer: { kind: 'composer', id: 'task_0123456789abcdef' },
    })
    const duplicate = await service.bind(transcript.id, {
      revision_id: rawRevisionId,
      consumer: { kind: 'composer', id: 'task_0123456789abcdef' },
    })
    const video = await service.bind(transcript.id, {
      revision_id: rawRevisionId,
      consumer: { kind: 'video_evidence', id: 'video_0123456789abcdef0123456789' },
    })

    expect(composer.bindings).toHaveLength(1)
    expect(duplicate.bindings).toHaveLength(1)
    expect(video.bindings).toHaveLength(2)
    expect(video.bindings.map(binding => binding.consumer.kind)).toEqual(['composer', 'video_evidence'])
  })

  test('garbage-collects expired unbound records but retains consumer evidence', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z')
    const storage = await root()
    const service = new VoiceOperationService({ root: storage, now: () => now, retentionDays: 1 })

    const unboundOperation = await service.begin(new File(['one'], 'one.webm'), consent)
    await service.complete(unboundOperation.operation.id, '无绑定')
    const boundOperation = await service.begin(new File(['two'], 'two.webm'), consent)
    const bound = await service.complete(boundOperation.operation.id, '有绑定')
    await service.bind(bound.transcript.id, {
      revision_id: bound.transcript.raw_revision_id,
      consumer: { kind: 'video_evidence', id: 'video_0123456789abcdef0123456789' },
    })

    now = new Date('2026-01-03T00:00:00.000Z')
    expect(await service.purgeExpired()).toEqual({ operations: 1, transcripts: 1 })
    expect(await service.getOperation(boundOperation.operation.id)).toMatchObject({ status: 'succeeded' })
    expect(await readdir(join(storage, 'operations'))).toHaveLength(1)
    expect(await readdir(join(storage, 'transcripts'))).toHaveLength(1)
  })
})
