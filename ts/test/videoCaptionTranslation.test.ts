import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { fastVideoIdentity, videoFingerprint } from '../src/server/services/videoExecution.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { type TimedTranscript } from '../src/server/video/domain/mediaFacts/model.js'
import { mediaTimeBase, rationalTime, sourceTimeRange, tickRateForTimeBase } from '../src/server/video/domain/mediaFacts/time.js'
import { MEDIA_UI_CAPABILITY_HEADER } from '../shared/contracts/media.js'

const roots: string[] = []
const at = '2026-08-05T00:00:00.000Z'
const capability = 'capability_0123456789abcdef0123456789'

async function testRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `billiardbuddy-caption-translation-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

function requestSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part)
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

type RelayRecord = {
  bytes: Uint8Array
  projection: Record<string, unknown>
}

function translationRelay(mode: () => 'valid' | 'invalid') {
  const records = new Map<string, RelayRecord>()
  const requests: Array<Record<string, unknown>> = []
  let acknowledgements = 0
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (url.hostname === 'result.example.test') {
      const record = records.get(url.pathname)
      if (!record) return Response.json({ error: 'result_not_found' }, { status: 404 })
      return new Response(record.bytes, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(record.bytes.byteLength),
        },
      })
    }
    if (url.pathname.endsWith('/ack') && init?.method === 'POST') {
      acknowledgements += 1
      return new Response(null, { status: 204 })
    }
    if (url.pathname === '/v1/video-media/operations' && init?.method === 'POST') {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push(request)
      const localOperationId = String(request.local_operation_id)
      const evidence = (request.input as { evidence?: Array<{ id: string }> }).evidence ?? []
      const result = mode() === 'valid'
        ? { kind: 'caption_translation', translations: evidence.map(item => ({ cue_id: item.id, text: `English: ${item.id}` })) }
        : { kind: 'caption_translation', translations: [{ cue_id: 'caption_cue_wrong_00000001', text: 'wrong revision' }] }
      const bytes = new TextEncoder().encode(JSON.stringify(result))
      const suffix = String(requests.length).padStart(8, '0')
      const resultPath = `/caption-${suffix}.json`
      const projection = {
        id: `operation_caption_${suffix}`,
        state: 'succeeded',
        result_object_refs: [`result_caption_${suffix}`],
        result_objects: [{
          object_ref: `result_caption_${suffix}`,
          content_hash: sha256(bytes),
          byte_size: bytes.byteLength,
          content_type: 'application/json',
          get_url: `https://result.example.test${resultPath}`,
          expires_at: '2026-08-05T01:00:00.000Z',
        }],
        provider_receipt: {
          id: `receipt_caption_${suffix}`,
          capability: 'media_reasoning',
          model_snapshot: 'qwen-caption-translation-test',
          region: 'cn-beijing',
          request_schema_version: 1,
          prompt_version: 'caption-translation-v1',
          input_basis_hash: request.request_hash,
          usage: {
            requests: 1,
            total_tokens: 32,
            input_bytes: bytes.byteLength,
            visual_frames: 0,
            proxy_seconds: 0,
            asr_seconds: 0,
            estimated_amount_micros: 320,
          },
          cache_hit: false,
          created_at: at,
        },
        account_quota_reservation_id: `quota_caption_${suffix}`,
        created_at: at,
        updated_at: at,
      }
      records.set(resultPath, { bytes, projection })
      return Response.json(projection)
    }
    if (url.pathname.includes('/by-local-operation/')) return Response.json({ error: 'operation_not_found' }, { status: 404 })
    throw new Error(`unexpected Relay request ${init?.method ?? 'GET'} ${url}`)
  }
  return {
    fetchImpl,
    requests,
    acknowledgements: () => acknowledgements,
  }
}

async function seededService(root: string, relay: ReturnType<typeof translationRelay>) {
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'caption translation source bytes')
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    env: {
      BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test',
      BB_GATEWAY_TOKEN: 'relay-test-token-1234',
    },
    fetchImpl: relay.fetchImpl,
  })
  const created = await service.createProject({ title: '远程字幕翻译 API 回归' })
  const fingerprint = await videoFingerprint(sourcePath)
  const identity = await fastVideoIdentity(sourcePath)
  const timeBase = mediaTimeBase(1, 1_000)
  const tickRate = tickRateForTimeBase(timeBase)
  const sourceId = 'src_caption_00000001'
  await service.repository.saveFact({
    id: sourceId,
    project_id: created.id,
    path: sourcePath,
    name: 'source.mp4',
    fast_identity: identity,
    fingerprint,
    fingerprint_state: 'ready',
    primary_video_stream: {
      stream_index: 0,
      time_base: timeBase,
      start_time: rationalTime('0', tickRate),
      duration: rationalTime('10000', tickRate),
      codec: 'h264',
      width: 1920,
      height: 1080,
      rotation: 0,
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('15000', tickRate),
    audio_tracks: [],
    state: 'ready',
    created_at: at,
    updated_at: at,
  })
  await service.repository.saveProject({
    ...created,
    state: 'ready',
    revision: 1,
    sources: [{
      id: sourceId,
      path: sourcePath,
      name: 'source.mp4',
      duration_ms: 15_000,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: false,
      fingerprint,
      rotation: 0,
      video_stream_count: 1,
      audio_stream_count: 0,
      missing: false,
      content_changed: false,
    }],
    timeline: [{ id: 'clip_caption_00000001', source_id: sourceId, in_ms: 0, out_ms: 10_000 }],
  })
  // Materialize the one v2 editorial baseline from the legacy projection.
  await expect(service.getEditorialTimeline(created.id, 'timeline_caption_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  const current = await service.getProject(created.id)
  const transcript: TimedTranscript = {
    id: 'transcript_caption_00000001',
    project_id: created.id,
    source_id: sourceId,
    source_fingerprint: fingerprint,
    model_receipt_id: 'receipt_transcript_00000001',
    source_offset: rationalTime('0', tickRate),
    language: 'zh',
    segments: [{
      id: 'segment_caption_00000001',
      source_id: sourceId,
      start: rationalTime('1000', tickRate),
      duration: rationalTime('2000', tickRate),
      text: '第一句需要翻译',
      words: [{ id: 'word_caption_00000001', start: rationalTime('1000', tickRate), duration: rationalTime('2000', tickRate), text: '第一句需要翻译' }],
    }, {
      id: 'segment_caption_00000002',
      source_id: sourceId,
      start: rationalTime('5000', tickRate),
      duration: rationalTime('1500', tickRate),
      text: '第二句需要翻译',
      words: [],
    }],
    created_at: at,
  }
  await service.repository.saveFact(transcript)
  return { service, created, sourceId, transcript, timelineId: current.current_editorial_timeline_version_id! }
}

test('正式字幕翻译 API 以已确认预算调用 Relay，生成不切头的候选 Revision 并拒绝错版结果', async () => {
  let mode: 'valid' | 'invalid' = 'valid'
  const relay = translationRelay(() => mode)
  const root = await testRoot('api')
  const { service, created, sourceId, transcript, timelineId } = await seededService(root, relay)
  try {
    const handler = createVideoWorkbenchDomainApiHandler(service, capability)
    const request = async (url: URL, init: RequestInit = {}) => await handler(new Request(url, init), url, requestSegments(url))
    const headers = (idempotencyKey?: string) => ({
      'Content-Type': 'application/json',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    })
    const draftUrl = new URL(`http://localhost/api/videos/projects/${created.id}/captions/drafts`)
    const draftResponse = await request(draftUrl, {
      method: 'POST',
      headers: headers('caption-draft-translation-0001'),
      body: JSON.stringify({ editorial_timeline_version_id: timelineId, transcript_id: transcript.id, language: 'zh' }),
    })
    expect(draftResponse.status).toBe(201)
    const draft = await draftResponse.json() as {
      document: { id: string; current_revision_id: string }
      revision: { id: string; cues: Array<{ id: string; source_anchor: unknown; timeline_range: unknown }> }
    }
    const translationUrl = new URL(`http://localhost/api/videos/projects/${created.id}/captions/${draft.document.id}/translations`)
    const translationInput = {
      base_revision_id: draft.revision.id,
      editorial_timeline_version_id: timelineId,
      language: 'en',
    }
    const denied = await request(translationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caption-translation-denied-0001' },
      body: JSON.stringify(translationInput),
    })
    expect(denied.status).toBe(403)
    expect(relay.requests).toHaveLength(0)

    const foreignProject = await service.createProject({ title: '字幕翻译跨项目边界' })
    const foreignUrl = new URL(`http://localhost/api/videos/projects/${foreignProject.id}/captions/${draft.document.id}/translations`)
    const foreign = await request(foreignUrl, {
      method: 'POST',
      headers: headers('caption-translation-cross-project-0001'),
      body: JSON.stringify(translationInput),
    })
    expect(foreign.status).toBe(404)
    expect(relay.requests).toHaveLength(0)

    const estimateUrl = new URL(`http://localhost/api/videos/projects/${created.id}/analysis-estimates`)
    const estimateResponse = await request(estimateUrl, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ purposes: ['caption_translation'], source_ids: [sourceId] }),
    })
    expect(estimateResponse.status).toBe(201)
    const estimate = await estimateResponse.json() as { estimate: { estimate_hash: string; total_tokens: number; estimated_amount_micros: number } }
    expect(estimate.estimate.total_tokens).toBeGreaterThan(0)
    expect(estimate.estimate.estimated_amount_micros).toBeGreaterThan(0)
    const consentUrl = new URL(`http://localhost/api/videos/projects/${created.id}/remote-analysis-consent`)
    const consentResponse = await request(consentUrl, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        purposes: ['caption_translation'],
        data_kinds: ['transcript'],
        coverage: [{ source_id: sourceId, ranges: [sourceTimeRange(rationalTime('0', { num: 1_000, den: 1 }), rationalTime('10000', { num: 1_000, den: 1 }))] }],
        acknowledged_estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(consentResponse.status).toBe(201)

    const translated = await request(translationUrl, {
      method: 'POST',
      headers: headers('caption-translation-api-0001'),
      body: JSON.stringify(translationInput),
    })
    expect(translated.status).toBe(201)
    const body = await translated.json() as {
      project: { caption_documents: Array<{ id: string; current_revision_id: string }> }
      revision: { id: string; parent_revision_id: string; cues: Array<{ text: string; translation_of_cue_id?: string; source_anchor: unknown; timeline_range: unknown }> }
      task: { id: string; kind: string; status: string }
    }
    expect(body.task).toMatchObject({ kind: 'video.caption_translation', status: 'succeeded' })
    expect(body.revision.parent_revision_id).toBe(draft.revision.id)
    expect(body.project.caption_documents.find(document => document.id === draft.document.id)?.current_revision_id).toBe(draft.revision.id)
    expect(body.revision.cues).toHaveLength(draft.revision.cues.length)
    for (const [index, cue] of body.revision.cues.entries()) {
      expect(cue.translation_of_cue_id).toBe(draft.revision.cues[index]?.id)
      expect(cue.source_anchor).toEqual(draft.revision.cues[index]?.source_anchor)
      expect(cue.timeline_range).toEqual(draft.revision.cues[index]?.timeline_range)
      expect(cue.text).toBe(`English: ${draft.revision.cues[index]?.id}`)
    }
    expect(relay.requests).toHaveLength(1)
    expect(relay.requests[0]).toMatchObject({ capability: 'media_reasoning', application_role: 'caption_translation' })
    expect(relay.acknowledgements()).toBe(1)
    const projected = await service.getProject(created.id)
    const budget = projected.remote_analysis_budgets[0]!
    expect(budget.reservations).toHaveLength(0)
    expect(budget.settlements).toEqual([expect.objectContaining({ operation_id: body.task.id, capability: 'media_reasoning' })])
    expect(projected.finishing_receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'caption_translation', resource_ids: [body.revision.id] }),
    ]))

    const replay = await request(translationUrl, {
      method: 'POST',
      headers: headers('caption-translation-api-0001'),
      body: JSON.stringify(translationInput),
    })
    expect(replay.status).toBe(201)
    expect(await replay.json()).toMatchObject({ revision: { id: body.revision.id }, task: { id: body.task.id } })
    expect(relay.requests).toHaveLength(1)

    // Receipt reconciliation must restore the candidate's real document ID,
    // not infer a draft-style [document, revision] resource tuple.
    const completedTask = await service.repository.getOperation(body.task.id)
    await service.repository.saveOperation({
      ...completedTask,
      status: 'running',
      progress: 80,
      stage: '模拟重启前的已投影任务',
      result: { request_hash: completedTask.result?.request_hash },
    })
    await service.recoverInterruptedOperations()
    expect(await service.getOperation(body.task.id)).toMatchObject({
      status: 'succeeded',
      result: {
        caption_document_id: draft.document.id,
        caption_revision_id: body.revision.id,
      },
    })
    expect(relay.requests).toHaveLength(1)

    // A second provider attempt needs a fresh explicit estimate/consent. This
    // makes the invalid-result assertion cover a paid response, rather than a
    // correct pre-admission budget rejection.
    const invalidEstimateResponse = await request(estimateUrl, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ purposes: ['caption_translation', 'planning'], source_ids: [sourceId] }),
    })
    expect(invalidEstimateResponse.status).toBe(201)
    const invalidEstimate = await invalidEstimateResponse.json() as { estimate: { estimate_hash: string } }
    const invalidConsentResponse = await request(consentUrl, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        purposes: ['caption_translation', 'planning'],
        data_kinds: ['transcript'],
        coverage: [{ source_id: sourceId, ranges: [sourceTimeRange(rationalTime('0', { num: 1_000, den: 1 }), rationalTime('10000', { num: 1_000, den: 1 }))] }],
        acknowledged_estimate_hash: invalidEstimate.estimate.estimate_hash,
      }),
    })
    expect(invalidConsentResponse.status).toBe(201)
    mode = 'invalid'
    const invalid = await request(translationUrl, {
      method: 'POST',
      headers: headers('caption-translation-invalid-0001'),
      body: JSON.stringify(translationInput),
    })
    expect(invalid.status).toBe(502)
    expect(relay.requests).toHaveLength(2)
    const afterInvalid = await service.getProject(created.id)
    expect(afterInvalid.caption_document_revisions.filter(revision => revision.document_id === draft.document.id)).toHaveLength(2)
    const invalidTask = (await service.repository.listOperations(created.id)).find(operation => operation.idempotency_key === 'caption-translation-invalid-0001')
    expect(invalidTask).toMatchObject({ kind: 'video.caption_translation', status: 'failed', error_code: 'MEDIA_VIDEO_FINISHING_UNAVAILABLE' })

    // A receipt is not itself enough proof for recovery. Losing its immutable
    // candidate must fail closed instead of returning a fake successful task.
    await service.repository.saveProject({
      ...afterInvalid,
      caption_document_revisions: afterInvalid.caption_document_revisions.filter(revision => revision.id !== body.revision.id),
    })
    const receiptTask = await service.repository.getOperation(body.task.id)
    await service.repository.saveOperation({
      ...receiptTask,
      status: 'running',
      progress: 80,
      stage: '模拟候选丢失后的重启',
      result: { request_hash: receiptTask.result?.request_hash },
    })
    await service.recoverInterruptedOperations()
    expect(await service.getOperation(body.task.id)).toMatchObject({
      status: 'failed',
      error_code: 'MEDIA_VIDEO_FINISHING_UNAVAILABLE',
    })
  } finally {
    service.repository.close()
  }
})

test('字幕翻译在候选已暂存但项目投影中断后，仅按原 receipt 恢复并 ACK', async () => {
  const relay = translationRelay(() => 'valid')
  const root = await testRoot('staged-recovery')
  const { service, created, sourceId, transcript, timelineId } = await seededService(root, relay)
  try {
    const draft = await service.createCaptionDraft(created.id, {
      editorial_timeline_version_id: timelineId,
      transcript_id: transcript.id,
      language: 'zh',
    }, 'caption-draft-staged-recovery-0001')
    const estimate = await service.estimateRemoteAnalysis(created.id, {
      purposes: ['caption_translation'],
      source_ids: [sourceId],
    })
    await service.grantRemoteAnalysisConsent(created.id, {
      purposes: ['caption_translation'],
      data_kinds: ['transcript'],
      coverage: [{ source_id: sourceId, ranges: [sourceTimeRange(rationalTime('0', { num: 1_000, den: 1 }), rationalTime('10000', { num: 1_000, den: 1 }))] }],
      acknowledged_estimate_hash: estimate.estimate_hash,
    })
    const originalSaveProject = service.repository.saveProject.bind(service.repository)
    let failProjection = true
    service.repository.saveProject = async project => {
      if (failProjection && project.caption_document_revisions.some(revision => revision.parent_revision_id === draft.revision.id)) {
        failProjection = false
        throw new Error('simulated crash after staged caption translation')
      }
      return await originalSaveProject(project)
    }
    await expect(service.createCaptionTranslation(created.id, draft.document.id, {
      base_revision_id: draft.revision.id,
      editorial_timeline_version_id: timelineId,
      language: 'en',
    }, 'caption-translation-staged-recovery-0001')).rejects.toThrow('simulated crash after staged caption translation')
    service.repository.saveProject = originalSaveProject

    const interrupted = (await service.repository.listOperations(created.id)).find(operation => operation.idempotency_key === 'caption-translation-staged-recovery-0001')
    expect(interrupted).toMatchObject({
      kind: 'video.caption_translation',
      status: 'committing',
      result: { caption_translation_revision: { parent_revision_id: draft.revision.id } },
    })
    expect((await service.getProject(created.id)).caption_document_revisions.filter(revision => revision.document_id === draft.document.id)).toHaveLength(1)
    await service.recoverInterruptedOperations()
    const recovered = await service.getOperation(interrupted!.id)
    expect(recovered).toMatchObject({
      status: 'succeeded',
      result: {
        caption_document_id: draft.document.id,
        caption_revision_id: expect.any(String),
      },
    })
    const project = await service.getProject(created.id)
    expect(project.caption_documents.find(document => document.id === draft.document.id)?.current_revision_id).toBe(draft.revision.id)
    expect(project.caption_document_revisions.filter(revision => revision.document_id === draft.document.id)).toHaveLength(2)
    expect(relay.requests).toHaveLength(1)
    expect(relay.acknowledgements()).toBe(1)
  } finally {
    service.repository.close()
  }
})
