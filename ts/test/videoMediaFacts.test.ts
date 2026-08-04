import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoWorkbenchRepository } from '../src/server/services/videoWorkbenchRepository.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { VideoMediaRelayClientError } from '../src/server/video/infrastructure/providers/videoMediaRelayClient.js'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { PayloadCommitProtocol } from '../src/server/media/kernel/storage/payloadCommitProtocol.js'
import { SqliteUnitOfWork } from '../src/server/media/kernel/storage/sqliteUnitOfWork.js'
import { fixedIntervalContentSegments, planEvidenceWindows } from '../src/server/video/domain/mediaFacts/analysis.js'
import type { VideoStudioProject } from '../shared/contracts/media.js'
import { createHostedEvidence, type TimedTranscript, type VideoDerivative, type VideoFactSource } from '../src/server/video/domain/mediaFacts/model.js'
import {
  compareRationalTime,
  editorialTimeRange,
  frameRate,
  mediaTimeBase,
  rationalTime,
  rescaleRationalTime,
  sourceRangeToEditorial,
  sourceTimeRange,
  tickRateForTimeBase,
} from '../src/server/video/domain/mediaFacts/time.js'
import { materializeTranscriptRevision, transcriptRevisionFingerprint } from '../src/server/video/domain/mediaFacts/transcript.js'

const roots: string[] = []
const at = '2026-08-03T00:00:00.000Z'
const hash = (character: string): `sha256:${string}` => `sha256:${character.repeat(64)}`

async function testRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `billiardbuddy-facts-${label}-`))
  roots.push(root)
  return root
}

function project(id = 'vid_00000001'): VideoStudioProject {
  return {
    schema_version: 1,
    id,
    kind: 'video',
    title: 'Media Facts',
    owner: { kind: 'standalone', owner_id: 'local_workbench' },
    writer_fence: `fence_${'0'.repeat(32)}`,
    assets: [],
    versions: [],
    revision: 0,
    created_at: at,
    updated_at: at,
    state: 'draft',
    sources: [],
    timeline: [],
    evidence: [],
    timeline_versions: [],
    alternatives: [],
    output: { width: 1080, height: 1920, fps: 30 },
  }
}

function source(projectId = 'vid_00000001'): VideoFactSource & { fingerprint: `sha256:${string}` } {
  const timeBase = mediaTimeBase(1, 90_000)
  const rate = tickRateForTimeBase(timeBase)
  return {
    id: 'src_00000001',
    project_id: projectId,
    path: '/media/source.mp4',
    name: 'source.mp4',
    fast_identity: { byte_size: 1234, mtime_ms: 1_000, file_id: '1:2', head_tail_hash: hash('a') },
    fingerprint: hash('b'),
    fingerprint_state: 'ready',
    primary_video_stream: {
      stream_index: 0,
      time_base: timeBase,
      start_time: rationalTime('-4500', rate),
      duration: rationalTime('2700000', rate),
      codec: 'h264',
      width: 1920,
      height: 1080,
      rotation: 0,
      average_frame_rate: frameRate(30000, 1001),
      nominal_frame_rate: frameRate(30000, 1001),
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('2700000', rate),
    audio_tracks: [{
      stream_index: 1,
      time_base: mediaTimeBase(1, 48_000),
      start_time: rationalTime('-2400', { num: 48_000, den: 1 }),
      duration: rationalTime('1440000', { num: 48_000, den: 1 }),
      codec: 'aac',
      sample_rate: 48_000,
      channels: 2,
      disposition_default: true,
    }],
    state: 'ready',
    created_at: at,
    updated_at: at,
  }
}

function mediaProcessRunner(command: string[]) {
  if (command.includes('-show_format') && command.includes('-show_streams')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        format: { duration: '20.000', start_time: '-0.050' },
        streams: [
          { index: 0, codec_type: 'video', codec_name: 'h264', width: 640, height: 360, time_base: '1/90000', start_pts: '-4500', duration_ts: '1800000', avg_frame_rate: '24000/1001', r_frame_rate: '30000/1001' },
          { index: 1, codec_type: 'audio', codec_name: 'aac', time_base: '1/48000', start_pts: '-2400', duration_ts: '960000', sample_rate: '48000', channels: 2, disposition: { default: 1 } },
        ],
      }),
      stderr: '',
    })
  }
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
}

async function waitForTerminalOperation(service: VideoWorkbenchService, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await service.getOperation(operationId)
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return operation
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`operation ${operationId} did not settle`)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

test('精确时间保留负 PTS、30000/1001，并要求显式舍入和跨域 receipt', () => {
  const sourceRate = { num: 90_000, den: 1 } as const
  const sourceRange = sourceTimeRange(rationalTime('-4500', sourceRate), rationalTime('2700000', sourceRate))
  const display = rescaleRationalTime(sourceRange.start, { num: 1000, den: 1 }, 'floor')
  expect(display.ticks).toBe('-50')
  expect(rescaleRationalTime(rationalTime('1', { num: 30000, den: 1001 }), { num: 1000, den: 1 }, 'floor').ticks).toBe('33')
  expect(rescaleRationalTime(rationalTime('1', { num: 30000, den: 1001 }), { num: 1000, den: 1 }, 'ceil').ticks).toBe('34')
  const converted = sourceRangeToEditorial(sourceRange, { num: 30_000, den: 1001 }, 'nearest', 'preview display')
  expect(converted.receipt.rounding).toBe('nearest')
  expect(converted.range.__time_domain).toBeUndefined()
  expect(compareRationalTime(converted.range.start, editorialTimeRange(converted.range.start, converted.range.duration).start)).toBe(0)
  expect(() => sourceTimeRange(rationalTime('0', { num: 1, den: 1 }), rationalTime('1', { num: 2, den: 1 }))).toThrow()
})

test('Media Facts 保持不可变 payload、全文检索、转录修订和派生状态', async () => {
  const root = await testRoot('repository')
  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  const created = await repository.saveProject(project())
  const videoSource = source(created.id)
  await repository.saveFact(videoSource)

  const derivative: VideoDerivative = {
    id: 'derivative_00000001',
    project_id: created.id,
    source_id: videoSource.id,
    source_fingerprint: videoSource.fingerprint,
    kind: 'proxy',
    source_range: sourceTimeRange(videoSource.primary_video_stream.start_time, videoSource.presentation_duration),
    asset: {
      id: 'asset_00000001',
      role: 'source',
      version_id: 'version_00000001',
      storage: { kind: 'managed', locator: 'facts/proxy.mp4' },
      mime_type: 'video/mp4',
      content_hash: hash('c'),
      byte_size: 12,
      created_at: at,
    },
    content_hash: hash('c'),
    byte_size: 12,
    generator_name: 'ffmpeg',
    generator_version: '7.0',
    parameters_hash: hash('d'),
    created_by_operation_id: 'op_00000001',
    created_at: at,
    state: 'ready',
  }
  await repository.saveFact(derivative)

  const transcript: TimedTranscript = {
    id: 'transcript_00000001',
    project_id: created.id,
    source_id: videoSource.id,
    source_fingerprint: videoSource.fingerprint,
    model_receipt_id: 'receipt_00000001',
    source_offset: videoSource.primary_video_stream.start_time,
    language: 'zh',
    segments: [{
      id: 'segment_00000001',
      source_id: videoSource.id,
      start: rationalTime('0', { num: 90_000, den: 1 }),
      duration: rationalTime('180000', { num: 90_000, den: 1 }),
      text: '开球之后是一记精彩进球',
      words: [
        { id: 'word_00000001', start: rationalTime('0', { num: 90_000, den: 1 }), duration: rationalTime('45000', { num: 90_000, den: 1 }), text: '开球' },
        { id: 'word_00000002', start: rationalTime('45000', { num: 90_000, den: 1 }), duration: rationalTime('45000', { num: 90_000, den: 1 }), text: '之后' },
        { id: 'word_00000003', start: rationalTime('90000', { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }), text: '精彩进球' },
      ],
    }],
    created_at: at,
  }
  await repository.saveFact(transcript)
  await expect(repository.saveFact({ ...transcript, language: 'en' })).rejects.toMatchObject({ code: 'VIDEO_FACTS_INVALID' })
  const revision = {
    id: 'revision_00000001',
    project_id: created.id,
    transcript_id: transcript.id,
    base_transcript_fingerprint: transcriptRevisionFingerprint(transcript),
    edits: [{ kind: 'replace_text' as const, segment_id: 'segment_00000001', text: '开球后打进关键一球' }],
    created_at: at,
  }
  await repository.saveFact(revision)
  expect(materializeTranscriptRevision(transcript, revision).segments[0]?.text).toBe('开球后打进关键一球')
  expect(await repository.activeTranscriptRevision(transcript.id)).toMatchObject({ id: revision.id })
  const otherProject = await repository.saveProject(project('vid_00000002'))
  await expect(repository.saveFact({ ...revision, id: 'revision_00000002', project_id: otherProject.id })).rejects.toMatchObject({ code: 'VIDEO_FACTS_INVALID' })
  await expect(repository.saveFact({
    ...revision,
    edits: [{ kind: 'replace_text' as const, segment_id: 'segment_00000001', text: '试图覆盖已提交修订' }],
  })).rejects.toMatchObject({ code: 'VIDEO_FACTS_INVALID' })
  expect(await repository.searchFacts(created.id, '精彩')).toEqual([])
  expect(await repository.searchFacts(created.id, '关键')).toMatchObject([{ id: transcript.id, kind: 'transcript' }])

  await repository.selectTranscriptRevision(created.id, transcript.id, revision.id)
  expect(await repository.searchFacts(created.id, '一球')).toMatchObject([{ id: transcript.id, kind: 'transcript' }])

  const segments = fixedIntervalContentSegments({ source: videoSource, intervalSeconds: 10, createdAt: at })
  expect(segments).toHaveLength(3)
  await Promise.all(segments.map(async segment => await repository.saveFact(segment)))
  const planned = planEvidenceWindows({
    source: videoSource,
    segments,
    transcript,
    keyframeDerivativeIds: [derivative.id],
    analysisDepth: 'standard',
    samplingReceiptId: 'receipt_00000002',
    createdAt: at,
    budget: {
      maxWindows: 3,
      maxVisualRequests: 1,
      maxFrames: 9,
      maxProxySeconds: 0,
      maxInputTokens: 4_950,
      maxCoveredTicks: 2_700_000n,
      maxFramesPerVisualRequest: 8,
    },
  })
  expect(planned.windows).toHaveLength(2)
  expect(planned.uncovered).toHaveLength(1)
  expect(planned.coverage.request_usage).toMatchObject({ windows: 2, visual_requests: 1, frames: 6, estimated_input_tokens: 3_300 })
  expect(planned.uncovered[0]?.reason).toBe('max_visual_requests')
  await Promise.all(planned.windows.map(async window => await repository.saveFact(window)))
  const firstWindows = await repository.pageFacts('evidence_window', created.id, { sourceId: videoSource.id, limit: 1 })
  expect(firstWindows.items[0]?.id).toEqual(expect.any(String))
  expect(typeof firstWindows.next_cursor).toBe('string')
  const secondWindows = await repository.pageFacts('evidence_window', created.id, { sourceId: videoSource.id, cursor: firstWindows.next_cursor, limit: 1 })
  expect(secondWindows.items[0]?.id).not.toBe(firstWindows.items[0]?.id)
  const evidence = createHostedEvidence({
    kind: 'visual',
    projectId: created.id,
    source: videoSource,
    range: planned.windows[0]!.range,
    evidenceWindowId: planned.windows[0]!.id,
    derivativeIds: [derivative.id],
    promptVersion: 'media-facts-v1',
    createdAt: at,
    payload: { summary: '球手俯身击球', subjects: ['球手', '球桌'], warnings: [] },
  })
  await repository.saveFact(evidence)
  expect((await repository.listFacts('evidence_window', created.id, videoSource.id)).length).toBe(2)
  expect((await repository.listFacts('evidence', created.id, videoSource.id))[0]).toMatchObject({ basis_hash: expect.stringMatching(/^sha256:/) })
  const firstSearch = await repository.searchFactsPage(created.id, '球', { limit: 1 })
  expect(firstSearch.generation).toBeGreaterThan(0)
  expect(firstSearch.items[0]).toMatchObject({ source_id: videoSource.id, range: { start: { ticks: expect.any(String) } } })
  expect(typeof firstSearch.next_cursor).toBe('string')
  const secondSearch = await repository.searchFactsPage(created.id, '球', { cursor: firstSearch.next_cursor, limit: 1 })
  expect(secondSearch.generation).toBe(firstSearch.generation)
  expect(secondSearch.items[0]?.id).not.toBe(firstSearch.items[0]?.id)
  const { fingerprint: _fingerprint, ...changedSource } = videoSource
  await repository.saveFact({ ...changedSource, fingerprint_state: 'failed', state: 'changed', updated_at: '2026-08-03T00:01:00.000Z' })
  await expect(repository.searchFactsPage(created.id, '球', { cursor: firstSearch.next_cursor, limit: 1 })).rejects.toMatchObject({ code: 'VIDEO_FACTS_INVALID' })
  expect((await repository.searchFactsPage(created.id, '球', { limit: 10 })).items).toEqual([])
  expect((await repository.pageCurrentFacts('evidence', created.id)).items).toEqual([])
  expect((await repository.pageCurrentFacts('source', created.id)).items[0]).toMatchObject({ state: 'changed', fingerprint_state: 'failed' })
  expect(await repository.reclaimLeastRecentlyUsedDerivatives(created.id, 1)).toEqual([derivative.id])
  expect(await repository.getFact('derivative', derivative.id)).toMatchObject({ state: 'missing' })
  repository.close()
})

test('完整指纹独立恢复，素材改变会阻止正式路径并使派生失效', async () => {
  const root = await testRoot('fingerprint')
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'initial simulated video bytes')
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    runProcess: mediaProcessRunner,
    platform: 'linux',
  })
  const created = await service.createProject({ title: '指纹路径' })
  const imported = await service.addVideoSource(created.id, { path: sourcePath })
  const fingerprintTask = (await service.repository.listOperations(created.id)).find(task => task.kind === 'video.fingerprint')
  expect(fingerprintTask).toBeDefined()
  expect((await waitForTerminalOperation(service, fingerprintTask!.id)).status).toBe('succeeded')
  const current = await service.getProject(created.id)
  const sourceFact = await service.repository.getFact('source', current.sources[0]!.id) as VideoFactSource & { fingerprint: `sha256:${string}` }
  expect(sourceFact.primary_video_stream).toMatchObject({
    time_base: { num: 1, den: 90_000 },
    start_time: { ticks: '-4500' },
    duration: { ticks: '1800000' },
    variable_frame_rate: true,
  })
  expect(sourceFact.audio_tracks[0]).toMatchObject({ start_time: { ticks: '-2400' }, duration: { ticks: '960000' } })
  await service.repository.saveFact({
    id: 'derivative_00000002',
    project_id: created.id,
    source_id: sourceFact.id,
    source_fingerprint: sourceFact.fingerprint,
    kind: 'thumbnail',
    asset: { id: 'asset_00000002', role: 'source', version_id: 'version_00000002', storage: { kind: 'managed', locator: 'facts/thumb.jpg' }, content_hash: hash('e'), byte_size: 10, created_at: at },
    content_hash: hash('e'),
    byte_size: 10,
    generator_name: 'ffmpeg',
    generator_version: '7.0',
    parameters_hash: hash('f'),
    created_by_operation_id: 'op_00000002',
    created_at: at,
    state: 'ready',
  })
  await writeFile(sourcePath, 'changed simulated video bytes with a different length')
  const handler = createVideoWorkbenchDomainApiHandler(service)
  const previewUrl = new URL(`http://localhost/api/videos/projects/${created.id}/preview`)
  const previewInput = {
    base_revision: current.revision,
    timeline_version_id: current.current_timeline_version_id!,
  }
  const requestPreview = async () => await handler(
    new Request(previewUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(previewInput) }),
    previewUrl,
    previewUrl.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part),
  )
  const changed = await requestPreview()
  expect(changed.status).toBe(409)
  expect(await changed.json()).toMatchObject({ error: 'MEDIA_VIDEO_SOURCE_CHANGED' })
  expect(await service.repository.getFact('source', sourceFact.id)).toMatchObject({ state: 'changed', fingerprint_state: 'failed' })
  expect(await service.repository.getFact('derivative', 'derivative_00000002')).toMatchObject({ state: 'stale' })
  const repeated = await requestPreview()
  expect(repeated.status).toBe(409)
  expect(await repeated.json()).toMatchObject({ error: 'MEDIA_VIDEO_SOURCE_CHANGED' })
  service.repository.close()
})

test('完整指纹生产链路生成可追溯 Derivative、真实 Camera Shot 与持久覆盖预算', async () => {
  const root = await testRoot('local-media-facts')
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'local-media-facts-source')
  const runProcess = async (command: string[]) => {
    if (command.includes('-show_format') && command.includes('-show_streams')) return await mediaProcessRunner(command)
    if (command.includes('-frames:v') && command.at(-1)?.startsWith('/')) {
      await writeFile(command.at(-1)!, 'thumbnail-bytes')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    if (command.some(item => item.includes("select='gt(scene,0.35)'"))) {
      return { exitCode: 0, stdout: 'frame:42 pts_time:9.950000', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), runProcess, platform: 'linux' })
  const created = await service.createProject({ title: '本地媒体事实' })
  await service.addVideoSource(created.id, { path: sourcePath })
  const fingerprintTask = (await service.repository.listOperations(created.id)).find(task => task.kind === 'video.fingerprint')!
  const complete = await waitForTerminalOperation(service, fingerprintTask.id)
  expect(complete.status).toBe('succeeded')
  expect(complete.result?.media_facts).toMatchObject({
    derivative_ids: expect.any(Array),
    camera_shot_ids: expect.any(Array),
    coverage: { request_budget: { max_visual_requests: 12 }, request_usage: { visual_requests: 1 } },
  })
  const derivatives = await service.repository.listFacts('derivative', created.id) as VideoDerivative[]
  expect(derivatives.map(item => item.kind).sort()).toEqual(['scene_map', 'thumbnail'])
  expect(derivatives.every(item => item.asset.storage.kind === 'managed' && item.state === 'ready')).toBeTrue()
  expect((await readdir(join(root, 'assets', created.id, 'derivatives'))).some(file => file.endsWith('.null'))).toBeFalse()
  const shots = await service.repository.listFacts('camera_shot', created.id) as Array<{ boundary_source: string; range: { duration: { ticks: string } } }>
  expect(shots).toHaveLength(2)
  expect(shots.every(item => item.boundary_source === 'scene_detect' && Number(item.range.duration.ticks) > 0)).toBeTrue()
  const segments = await service.repository.listFacts('content_segment', created.id) as Array<{ camera_shot_ids: string[] }>
  expect(segments).toHaveLength(2)
  expect(segments.every(item => item.camera_shot_ids.length === 1)).toBeTrue()
  const windows = await service.repository.listFacts('evidence_window', created.id) as Array<{ coverage: { uncovered: unknown[]; request_usage: { frames: number } } }>
  expect(windows).toHaveLength(2)
  expect(windows[0]?.coverage).toMatchObject({ uncovered: [], request_usage: { frames: 6 } })
  service.repository.close()
})

test('Media Facts payload 在发布后崩溃会由统一恢复器提交，而不会暴露 prepared 索引', async () => {
  const root = await testRoot('payload-recovery')
  const firstRepository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  const created = await firstRepository.saveProject(project())
  firstRepository.close()

  const unitOfWork = new SqliteUnitOfWork(root)
  const payloads = new PayloadCommitProtocol(root, unitOfWork, () => new Date(at))
  const fact = source(created.id)
  const intent = await payloads.stage({
    entityKind: 'video_fact_source',
    aggregateId: fact.id,
    projectId: fact.project_id,
    finalLocator: `projects/${fact.project_id}/payloads/facts/source/${fact.id}.json`,
    schema: 'video-media-fact-source-v1',
    version: 1,
    value: fact,
  })
  const prepared = payloads.prepare(intent.id, candidate => {
    unitOfWork.database.query(`INSERT INTO video_fact_payloads(
      intent_id,fact_kind,fact_id,project_id,source_id,source_fingerprint,payload_hash,payload_locator,payload_schema,payload_version,state
    ) VALUES(?,?,?,?,?,?,?,?,?,?, 'prepared')`).run(
      candidate.id, 'source', fact.id, fact.project_id, fact.id, fact.fingerprint,
      candidate.expected_hash, candidate.final_locator, candidate.payload_schema, candidate.payload_version,
    )
    unitOfWork.database.query(`INSERT INTO media_payload_blobs(
      locator,content_hash,byte_size,schema_name,schema_version,ref_count,created_at
    ) VALUES(?,?,?,?,?,?,?)`).run(
      candidate.final_locator, candidate.expected_hash, candidate.expected_bytes,
      candidate.payload_schema, candidate.payload_version, 1, at,
    )
  })
  await payloads.publish(prepared)
  unitOfWork.close()

  const recovered = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  expect(await recovered.getFact('source', fact.id)).toMatchObject({ fingerprint_state: 'ready', fingerprint: fact.fingerprint })
  recovered.close()
})

test('Media Facts 正式 API 返回带来源、范围、generation 与 cursor 的安全检索投影', async () => {
  const root = await testRoot('facts-api')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), runProcess: mediaProcessRunner, platform: 'linux' })
  const created = await service.createProject({ title: '事实检索 API' })
  const videoSource = source(created.id)
  await service.repository.saveFact(videoSource)
  await service.repository.saveFact(createHostedEvidence({
    kind: 'visual', projectId: created.id, source: videoSource,
    range: sourceTimeRange(videoSource.primary_video_stream.start_time, rationalTime('90000', videoSource.primary_video_stream.start_time.tick_rate)),
    promptVersion: 'facts-api-v1', createdAt: at,
    payload: { summary: '球手准备开球', subjects: ['球手'], warnings: [] },
  }))
  await service.repository.saveFact(createHostedEvidence({
    kind: 'visual', projectId: created.id, source: videoSource,
    range: sourceTimeRange(rationalTime('90000', videoSource.primary_video_stream.start_time.tick_rate), rationalTime('90000', videoSource.primary_video_stream.start_time.tick_rate)),
    promptVersion: 'facts-api-v1', createdAt: at,
    payload: { summary: '球桌上的关键一击', subjects: ['球桌'], warnings: [] },
  }))
  const handler = createVideoWorkbenchDomainApiHandler(service)
  const searchUrl = new URL(`http://localhost/api/videos/projects/${created.id}/search?q=%E7%90%83&limit=1`)
  const search = await handler(new Request(searchUrl), searchUrl, searchUrl.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part))
  expect(search.status).toBe(200)
  const firstPage = await search.json() as { schema_version: number; generation: number; items: Array<{ source_id: string; range: { start: { ticks: string } } }>; next_cursor?: string }
  expect(firstPage).toMatchObject({ schema_version: 1, generation: expect.any(Number), items: [{ source_id: videoSource.id, range: { start: { ticks: expect.any(String) } } }] })
  expect(typeof firstPage.next_cursor).toBe('string')
  const nextUrl = new URL(searchUrl)
  nextUrl.searchParams.set('cursor', firstPage.next_cursor!)
  const next = await handler(new Request(nextUrl), nextUrl, nextUrl.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part))
  expect((await next.json() as { generation: number; items: unknown[] }).items).toHaveLength(1)
  const factsUrl = new URL(`http://localhost/api/videos/projects/${created.id}/facts/source?limit=1`)
  const facts = await handler(new Request(factsUrl), factsUrl, factsUrl.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part))
  const factPage = await facts.json() as { schema_version: number; items: Array<Record<string, unknown>> }
  expect(factPage).toMatchObject({ schema_version: 1, items: [{ id: videoSource.id, fingerprint_state: 'ready' }] })
  expect(factPage.items[0]?.path).toBeUndefined()
  for (const invalidUrl of [
    new URL(`http://localhost/api/videos/projects/${created.id}/facts/source?cursor=not-a-valid-cursor`),
    new URL(`http://localhost/api/videos/projects/${created.id}/search?q=%E7%90%83&cursor=not-a-valid-cursor`),
  ]) {
    const invalid = await handler(new Request(invalidUrl), invalidUrl, invalidUrl.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part))
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
  }
  service.repository.close()
})

test('768 维文本 embedding 与 FTS 同代持久化，并融合非词法命中的语义候选', async () => {
  const root = await testRoot('hybrid-search')
  const repository = new VideoWorkbenchRepository({ root, now: () => new Date(at) })
  const created = await repository.saveProject(project())
  const videoSource = source(created.id)
  await repository.saveFact(videoSource)
  const first = await repository.saveFact(createHostedEvidence({ kind: 'visual', projectId: created.id, source: videoSource, range: sourceTimeRange(videoSource.primary_video_stream.start_time, rationalTime('90000', videoSource.primary_video_stream.start_time.tick_rate)), promptVersion: 'embedding-v1', createdAt: at, payload: { summary: '精彩进球', subjects: ['球'], warnings: [] } }))
  const second = await repository.saveFact(createHostedEvidence({ kind: 'visual', projectId: created.id, source: videoSource, range: sourceTimeRange(rationalTime('90000', videoSource.primary_video_stream.start_time.tick_rate), rationalTime('90000', videoSource.primary_video_stream.start_time.tick_rate)), promptVersion: 'embedding-v1', createdAt: at, payload: { summary: '精彩开球', subjects: ['球'], warnings: [] } }))
  const semanticOnly = await repository.saveFact(createHostedEvidence({ kind: 'visual', projectId: created.id, source: videoSource, range: sourceTimeRange(rationalTime('180000', videoSource.primary_video_stream.start_time.tick_rate), rationalTime('90000', videoSource.primary_video_stream.start_time.tick_rate)), promptVersion: 'embedding-v1', createdAt: at, payload: { summary: '反弹角度控制', subjects: ['球'], warnings: [] } }))
  const vector = (index: number) => Array.from({ length: 768 }, (_, value) => value === index ? 1 : 0)
  const semanticOnlyVector = Array.from({ length: 768 }, (_, index) => index === 0 ? 0.5 : index === 2 ? Math.sqrt(0.75) : 0)
  const contentHash = (index: number) => `sha256:${createHash('sha256').update(JSON.stringify(vector(index))).digest('hex')}` as `sha256:${string}`
  const generation = await repository.saveFactEmbeddings(created.id, [
    { entry_id: first.id, vector: vector(1), model_snapshot: 'text-embedding-v4', instruction_version: 'v1', content_hash: contentHash(1) },
    { entry_id: second.id, vector: vector(0), model_snapshot: 'text-embedding-v4', instruction_version: 'v1', content_hash: contentHash(0) },
    { entry_id: semanticOnly.id, vector: semanticOnlyVector, model_snapshot: 'text-embedding-v4', instruction_version: 'v1', content_hash: `sha256:${createHash('sha256').update(JSON.stringify(semanticOnlyVector)).digest('hex')}` },
  ])
  const page = await repository.hybridSearchFactsPage(created.id, '精彩', vector(0), { limit: 2 })
  expect(page.generation).toBe(generation)
  expect(page.items.map(item => item.id)).toEqual([second.id, first.id])
  expect(page.next_cursor).toBeDefined()
  const secondPage = await repository.hybridSearchFactsPage(created.id, '精彩', vector(0), { limit: 2, cursor: page.next_cursor })
  expect(secondPage.items.map(item => item.id)).toEqual([semanticOnly.id])
  repository.close()
})

test('未确认远程分析时，新视频只抽取本地 Evidence Window，不把画面发送到旧 Gateway', async () => {
  const root = await testRoot('windowed-analysis')
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'windowed-analysis-source')
  const commands: string[][] = []
  const runProcess = async (command: string[]) => {
    commands.push(command)
    if (command.includes('-show_format') && command.includes('-show_streams')) return await mediaProcessRunner(command)
    if (command.includes('-frames:v') && command.at(-1)?.startsWith('/')) {
      await writeFile(command.at(-1)!, 'simulated-frame')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    runProcess,
    platform: 'linux',
    fetchImpl: async (input, init) => {
      const url = String(input)
      if (url.endsWith('/v1/visual/evidence')) {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: unknown[] }> }
        const count = body.messages[0]!.content.length
        return Response.json({
          schema: 'bb.visual-evidence-batch.v1',
          evidence: Array.from({ length: count }, () => ({
            schema: 'bb.visual-evidence.v1', ocr: '比分牌', objects: ['球桌'], layout: '', ui: [], alerts: [], observations: ['开球准备'],
          })),
        })
      }
      // Planning is intentionally allowed to choose the existing deterministic
      // fallback; this test isolates the visual Evidence Window boundary.
      return Response.json({ choices: [{ message: { content: '{}' } }] })
    },
    env: { BB_GATEWAY_URL: 'https://gateway.example.test', BB_GATEWAY_TOKEN: 'gateway-test-token' },
  })
  const created = await service.createProject({ title: '窗口分析' })
  const imported = await service.addVideoSource(created.id, { path: sourcePath })
  const fingerprintTask = (await service.repository.listOperations(created.id)).find(task => task.kind === 'video.fingerprint')
  expect((await waitForTerminalOperation(service, fingerprintTask!.id)).status).toBe('succeeded')
  const ready = await service.getProject(created.id)
  const windows = await service.repository.listFacts('evidence_window', created.id, ready.sources[0]!.id) as Array<{ id: string; sample_strategy: string; range: { start: { ticks: string } } }>
  expect(windows).toHaveLength(1)
  expect(windows[0]?.sample_strategy).toBe('start_middle_end')
  const task = await service.analyzeVideoProject(created.id, {
    base_revision: ready.revision,
    user_goal: '只分析窗口内画面',
  })
  expect((await waitForTerminalOperation(service, task.id)).status).toBe('succeeded')
  const planTask = (await service.repository.listOperations(created.id)).find(candidate => candidate.kind === 'video.plan')
  expect(planTask).toBeDefined()
  expect((await waitForTerminalOperation(service, planTask!.id)).status).toBe('succeeded')
  const analyzed = await service.getProject(created.id)
  expect(analyzed.current_editorial_timeline_version_id).toBe(ready.current_editorial_timeline_version_id)
  expect(analyzed.timeline_drafts).toMatchObject([{ status: 'proposed', base_timeline_version_id: ready.current_editorial_timeline_version_id }])
  const frameCommands = commands.filter(command => command.includes('-frames:v') && command.at(-1)?.includes('/analysis/'))
  expect(frameCommands).toHaveLength(3)
  expect(frameCommands.map(command => command[command.indexOf('-ss') + 1])).toEqual(['0.000', '10.000', '19.999'])
  const evidence = await service.repository.listFacts('evidence', created.id, ready.sources[0]!.id) as Array<{ evidence_window_id?: string }>
  expect(evidence).toHaveLength(0)
  const refreshedWindow = await service.repository.getFact('evidence_window', windows[0]!.id) as { evidence_ids: string[] }
  expect(refreshedWindow.evidence_ids).toHaveLength(0)
  service.repository.close()
})

test('正式 ASR 只在完整授权范围内流式上传，并持久化原始 PTS Transcript 与预算回执', async () => {
  const root = await testRoot('relay-asr')
  const sourcePath = join(root, 'source.mp4')
  const analysisDirectory = join(root, 'analysis')
  await writeFile(sourcePath, 'source bytes')
  await mkdir(analysisDirectory, { recursive: true })
  const payload = new TextEncoder().encode(JSON.stringify({ kind: 'asr', sentences: [{ text: '原始 PTS 转写', begin_time: 100, end_time: 900, words: [{ text: '原始', begin_time: 100, end_time: 400 }] }] }))
  const payloadHash = `sha256:${createHash('sha256').update(payload).digest('hex')}`
  const requests: Array<{ url: string; method: string }> = []
  let reservationsBeforeAsrCall = 0
  let reservedAsrMicros = 0
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    runProcess: async command => {
      if (command.includes('-f') && command.includes('wav')) await writeFile(command.at(-1)!, new Uint8Array(128))
      return { exitCode: 0, stdout: '', stderr: '' }
    },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); const method = init?.method ?? 'GET'
      requests.push({ url: url.pathname, method })
      if (url.hostname === 'oss.example.test') return new Response(null, { status: 200, headers: { etag: 'etag-asr' } })
      if (url.hostname === 'result.example.test') return new Response(payload, { status: 200 })
      if (url.pathname.endsWith('/object-leases')) return Response.json({ lease_id: 'lease_00000001', state: 'awaiting_upload', put_url: 'https://oss.example.test/put', required_headers: {}, expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.pathname.endsWith('/complete')) return Response.json({ lease_id: 'lease_00000001', state: 'ready', object_ref: 'object_00000001', expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.pathname.endsWith('/operations')) {
        const budgetAtCall = (await service.getProject(created.id)).remote_analysis_budgets[0]
        reservationsBeforeAsrCall = budgetAtCall?.reservations.length ?? 0
        reservedAsrMicros = budgetAtCall?.reservations[0]?.estimated_amount_micros ?? 0
        return Response.json({
        id: 'operation_00000001', state: 'succeeded', account_quota_reservation_id: 'quota_00000001',
        result_object_refs: ['result_00000001'], result_objects: [{ object_ref: 'result_00000001', content_hash: payloadHash, byte_size: payload.byteLength, content_type: 'application/json', get_url: 'https://result.example.test/asr.json', expires_at: '2026-08-03T01:00:00.000Z' }],
        provider_receipt: { id: 'receipt_00000001', capability: 'speech_transcription', model_snapshot: 'fun-asr', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('d'), usage: { requests: 1, total_tokens: 0, input_bytes: 1, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0.8, estimated_amount_micros: 0 }, cache_hit: false, created_at: at }, created_at: at, updated_at: at,
        })
      }
      if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 })
      throw new Error(`unexpected relay request ${method} ${url}`)
    },
  })
  const created = await service.createProject({ title: 'ASR' })
  const sourceFact = { ...source(created.id), path: sourcePath }
  await service.repository.saveFact(sourceFact)
  const saved = await service.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourcePath, name: 'source.mp4', duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['asr'], data_kinds: ['audio_extract'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 1, total_tokens: 100, input_bytes: 10_000, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 10_000, settlements: [], created_at: at, updated_at: at }],
  })
  const invoke = service as unknown as { remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<Array<{ in_ms: number; out_ms: number }> | null> }
  const evidence = await invoke.remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, analysisDirectory, 'task_00000001', new AbortController().signal)
  expect(evidence).toMatchObject([{ in_ms: 100, out_ms: 900, kind: 'transcript' }])
  expect(requests.map(item => `${item.method} ${item.url}`)).toEqual(expect.arrayContaining(['POST /v1/video-media/object-leases', 'PUT /put', 'POST /v1/video-media/operations', 'POST /v1/video-media/operations/operation_00000001/ack']))
  expect(reservationsBeforeAsrCall).toBe(1)
  expect(reservedAsrMicros).toBeGreaterThan(0)
  expect(await service.repository.listFacts('transcript', created.id)).toMatchObject([{ source_offset: { ticks: '-4500' }, segments: [{ text: '原始 PTS 转写', start: { ticks: '4500' } }] }])
  const settledBudget = (await service.getProject(created.id)).remote_analysis_budgets[0]
  expect(settledBudget?.settlements).toMatchObject([{ operation_id: `task_00000001_asr_${sourceFact.id}`, capability: 'speech_transcription', asr_seconds: 0.8 }])
  expect(settledBudget?.reservations).toHaveLength(0)
  expect(settledBudget?.settlements[0]?.estimated_amount_micros).toBe(0)
  service.repository.close()
})

test('四类远程能力按 Operation 结算、释放或围栏，而不改变整个项目预算状态', async () => {
  const root = await testRoot('operation-budget-finalization')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at) })
  const created = await service.createProject({ title: '逐操作预算' })
  await service.repository.saveProject({
    ...created,
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('a'), state: 'reserved', requests: 20, total_tokens: 20_000, input_bytes: 20_000_000, visual_frames: 20, proxy_seconds: 20, asr_seconds: 20, estimated_amount_micros: 20_000, reservations: [], settlements: [], created_at: at, updated_at: at }],
  })
  const invoke = service as unknown as {
    reserveRemoteBudget: (projectId: string, budgetId: string, operationId: string, capability: 'visual_evidence' | 'media_reasoning' | 'speech_transcription' | 'semantic_embedding', usage: { requests: number; total_tokens: number; input_bytes: number; visual_frames: number; proxy_seconds: number; asr_seconds: number; estimated_amount_micros: number }) => Promise<void>
    settleRemoteBudget: (projectId: string, budgetId: string, operationId: string, receipt: { id: string; capability: 'visual_evidence' | 'media_reasoning' | 'speech_transcription' | 'semantic_embedding'; usage: { requests: number; total_tokens: number; input_bytes: number; visual_frames: number; proxy_seconds: number; asr_seconds: number; estimated_amount_micros: number } }) => Promise<void>
    reserveAndRunRemote: (projectId: string, budgetId: string, operationId: string, capability: 'visual_evidence' | 'media_reasoning' | 'speech_transcription' | 'semantic_embedding', usage: { requests: number; total_tokens: number; input_bytes: number; visual_frames: number; proxy_seconds: number; asr_seconds: number; estimated_amount_micros: number }, action: () => Promise<never>) => Promise<never>
  }
  const usage = { requests: 1, total_tokens: 1, input_bytes: 1, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1 }
  const capabilities = ['visual_evidence', 'media_reasoning', 'speech_transcription', 'semantic_embedding'] as const
  for (const [index, capability] of capabilities.entries()) {
    const settledOperationId = `task_settled_${index}`
    await invoke.reserveRemoteBudget(created.id, 'budget_00000001', settledOperationId, capability, usage)
    await invoke.settleRemoteBudget(created.id, 'budget_00000001', settledOperationId, { id: `receipt_settled_${index}`, capability, usage })
    await expect(invoke.reserveAndRunRemote(created.id, 'budget_00000001', `task_known_release_${index}`, capability, usage, async () => { throw new VideoMediaRelayClientError(422, 'provider_rejected') })).rejects.toThrow('provider_rejected')
    await expect(invoke.reserveAndRunRemote(created.id, 'budget_00000001', `task_unknown_fenced_${index}`, capability, usage, async () => { throw new Error('transport_lost') })).rejects.toThrow('transport_lost')
  }
  const budget = (await service.getProject(created.id)).remote_analysis_budgets[0]!
  expect(budget.state).toBe('reserved')
  expect(budget.settlements).toHaveLength(4)
  expect(budget.reservations.filter(item => item.state === 'released')).toHaveLength(4)
  expect(budget.reservations.filter(item => item.state === 'outcome_unknown')).toHaveLength(4)
  expect(budget.reservations.every(item => item.finalized_at && item.safe_error_code)).toBe(true)
  service.repository.close()
})

test('正式混合检索在零词法命中时仍索引完整授权 Transcript 语料并返回语义结果', async () => {
  const root = await testRoot('relay-hybrid')
  const resultPayloads = new Map<string, Uint8Array>()
  let operation = 0
  const reservationsBeforeSearchCalls: number[] = []
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === 'result.example.test') return new Response(resultPayloads.get(url.pathname)!, { status: 200 })
      if (url.pathname.endsWith('/ack')) return new Response(null, { status: 204 })
      if (!url.pathname.endsWith('/operations')) throw new Error(`unexpected relay request ${url}`)
      reservationsBeforeSearchCalls.push((await service.getProject(created.id)).remote_analysis_budgets[0]?.reservations.length ?? 0)
      const request = JSON.parse(String(init?.body)) as { input: { embedding_role: 'document' | 'query'; items: Array<{ id: string; text: string }> } }
      const vectors = request.input.embedding_role === 'query'
        ? [{ id: request.input.items[0]!.id, vector: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) }]
        : request.input.items.map(item => ({ id: item.id, vector: Array.from({ length: 768 }, (_, index) => index === (item.text.includes('反弹') ? 0 : 1) ? 1 : 0) }))
      const payload = new TextEncoder().encode(JSON.stringify({ kind: 'embedding', vectors }))
      const path = `/embedding-${operation}.json`; const receiptId = `receipt_0000000${operation + 1}`; const operationId = `operation_0000000${operation + 1}`; operation += 1
      resultPayloads.set(path, payload)
      return Response.json({
        id: operationId, state: 'succeeded', account_quota_reservation_id: `quota_0000000${operation}`,
        result_object_refs: [`result_0000000${operation}`], result_objects: [{ object_ref: `result_0000000${operation}`, content_hash: `sha256:${createHash('sha256').update(payload).digest('hex')}`, byte_size: payload.byteLength, content_type: 'application/json', get_url: `https://result.example.test${path}`, expires_at: '2026-08-03T01:00:00.000Z' }],
        provider_receipt: { id: receiptId, capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('a'), usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: at }, created_at: at, updated_at: at,
      })
    },
  })
  const created = await service.createProject({ title: '语义检索' })
  const sourceFact = source(created.id)
  await service.repository.saveFact(sourceFact)
  for (const [id, text, start] of [['transcript_00000001', '普通开球描述', '0'], ['transcript_00000002', '反弹角度的控制技巧', '90000']] as const) {
    await service.repository.saveFact({ id, project_id: created.id, source_id: sourceFact.id, source_fingerprint: sourceFact.fingerprint, model_receipt_id: 'receipt_00000001', source_offset: sourceFact.primary_video_stream.start_time, language: 'zh', segments: [{ id: `segment_${id.slice(-8)}`, source_id: sourceFact.id, start: rationalTime(start, { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }), text, words: [] }], created_at: at })
  }
  await service.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourceFact.path, name: sourceFact.name, duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['semantic_search'], data_kinds: ['transcript'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 6, total_tokens: 100, input_bytes: 10_000, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1_000, settlements: [], created_at: at, updated_at: at }],
  })
  const page = await service.searchMediaFacts(created.id, '完全不同的查询词', { limit: 10 })
  expect(page.items[0]).toMatchObject({ id: 'transcript_00000002', text: '反弹角度的控制技巧' })
  expect(reservationsBeforeSearchCalls).toEqual([1, 1])
  expect((await service.getProject(created.id)).remote_analysis_budgets[0]?.settlements).toHaveLength(2)
  service.repository.close()
})
