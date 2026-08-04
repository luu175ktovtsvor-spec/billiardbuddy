import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoWorkbenchRepository, type VideoOperation } from '../src/server/services/videoWorkbenchRepository.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { VideoMediaRelayClient, VideoMediaRelayClientError } from '../src/server/video/infrastructure/providers/videoMediaRelayClient.js'
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
  let acknowledgeAvailable = false
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
      if (url.pathname.endsWith('/ack')) return acknowledgeAvailable
        ? new Response(null, { status: 204 })
        : Response.json({ error: 'temporary_ack_unavailable' }, { status: 503 })
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
  await service.repository.saveOperation({
    schema_version: 1,
    id: 'task_00000001',
    project_id: created.id,
    kind: 'video.analyze',
    status: 'running',
    progress: 10,
    stage: '正在提取素材证据',
    result: { user_goal: 'ASR 证据' },
    created_at: at,
    updated_at: at,
  })
  const invoke = service as unknown as {
    remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<{ evidence: Array<{ in_ms: number; out_ms: number }>; acknowledgements: VideoStudioProject['pending_relay_acknowledgements'] } | null>
    flushPendingRelayAcknowledgements: (projectId: string) => Promise<void>
  }
  const transcript = await invoke.remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, analysisDirectory, 'task_00000001', new AbortController().signal)
  expect(transcript?.evidence).toMatchObject([{ in_ms: 100, out_ms: 900, kind: 'transcript' }])
  expect(transcript?.acknowledgements).toMatchObject([{ operation_id: `task_00000001_asr_${sourceFact.id}`, relay_operation_id: 'operation_00000001', receipt_id: 'receipt_00000001' }])
  expect(requests.map(item => `${item.method} ${item.url}`)).toEqual(expect.arrayContaining(['POST /v1/video-media/object-leases', 'PUT /put', 'POST /v1/video-media/operations']))
  expect(requests.map(item => `${item.method} ${item.url}`)).not.toContain('POST /v1/video-media/operations/operation_00000001/ack')
  expect(reservationsBeforeAsrCall).toBe(1)
  expect(reservedAsrMicros).toBeGreaterThan(0)
  expect(await service.repository.listFacts('transcript', created.id)).toMatchObject([{ source_offset: { ticks: '-4500' }, segments: [{ text: '原始 PTS 转写', start: { ticks: '4500' } }] }])
  const settledProject = await service.getProject(created.id)
  const settledBudget = settledProject.remote_analysis_budgets[0]
  expect(settledBudget?.settlements).toMatchObject([{ operation_id: `task_00000001_asr_${sourceFact.id}`, capability: 'speech_transcription', asr_seconds: 0.8 }])
  expect(settledBudget?.reservations).toHaveLength(0)
  expect(settledBudget?.settlements[0]?.estimated_amount_micros).toBe(0)
  expect((await service.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{
    local_operation_id: `task_00000001_asr_${sourceFact.id}`,
    relay_operation_id: 'operation_00000001',
    state: 'succeeded',
  }])
  // After the transcript Fact is durable, recovery reuses it without another
  // object upload, provider POST or result download. It only reconstructs the
  // pending ACK record for the caller's project commit.
  const requestCountBeforeRecovery = requests.length
  const reused = await invoke.remoteTranscriptEvidence(settledProject, settledProject.sources[0]!, sourceFact, analysisDirectory, 'task_00000001', new AbortController().signal)
  expect(reused?.acknowledgements).toMatchObject([{ relay_operation_id: 'operation_00000001' }])
  expect(requests).toHaveLength(requestCountBeforeRecovery)
  // Crash injection: the immutable Transcript Fact exists but the Project
  // evidence/outbox write was never reached. Restart rebuilds the durable ACK
  // entry from Fact metadata, then retries only ACK (never ASR or download).
  await service.recoverInterruptedOperations()
  expect(requests.map(item => `${item.method} ${item.url}`)).toContain('POST /v1/video-media/operations/operation_00000001/ack')
  expect((await service.getProject(created.id)).pending_relay_acknowledgements).toHaveLength(1)
  acknowledgeAvailable = true
  await service.recoverInterruptedOperations()
  expect((await service.getProject(created.id)).pending_relay_acknowledgements).toHaveLength(0)
  const acknowledgementsAfterSuccess = requests.filter(item => `${item.method} ${item.url}` === 'POST /v1/video-media/operations/operation_00000001/ack').length
  await service.recoverInterruptedOperations()
  expect(requests.filter(item => `${item.method} ${item.url}` === 'POST /v1/video-media/operations/operation_00000001/ack')).toHaveLength(acknowledgementsAfterSuccess)
  service.repository.close()
})

test('ASR 本地预算预留失败时不写远端提交栅栏或 outcome_unknown', async () => {
  const root = await testRoot('asr-reserve-failure')
  const sourcePath = join(root, 'source.mp4'); await writeFile(sourcePath, 'source bytes')
  let relayRequests = 0
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    runProcess: async command => { if (command.includes('-f') && command.includes('wav')) await writeFile(command.at(-1)!, new Uint8Array(128)); return { exitCode: 0, stdout: '', stderr: '' } },
    fetchImpl: async () => { relayRequests += 1; throw new Error('budget rejection must precede every Relay request') },
  })
  const created = await service.createProject({ title: 'ASR 预算拒绝' })
  const sourceFact = { ...source(created.id), path: sourcePath }
  await service.repository.saveFact(sourceFact)
  const saved = await service.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourcePath, name: 'source.mp4', duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['asr'], data_kinds: ['audio_extract'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 0, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0, settlements: [], created_at: at, updated_at: at }],
  })
  await service.repository.saveOperation({ schema_version: 1, id: 'task_00000001', project_id: created.id, kind: 'video.analyze', status: 'running', progress: 10, stage: 'ASR', result: { user_goal: '预算拒绝' }, created_at: at, updated_at: at })
  const invoke = service as unknown as { remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<unknown> }
  await expect(invoke.remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toMatchObject({ code: 'VIDEO_REMOTE_OPERATION_UNAVAILABLE' })
  expect(relayRequests).toBe(0)
  expect((await service.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'uploading' }])
  expect((await service.repository.getOperation('task_00000001')).result?.asr_checkpoints?.[0]).not.toHaveProperty('remote_submission_started_at')
  service.repository.close()
})

test('ASR 预算预留成功后上传失败不写提交栅栏并可安全恢复同一操作', async () => {
  const root = await testRoot('asr-upload-failure-before-fence')
  const sourcePath = join(root, 'source.mp4'); await writeFile(sourcePath, 'source bytes')
  let relayRequests = 0
  let fenceSeenDuringUpload = false
  let service!: VideoWorkbenchService
  service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    runProcess: async command => { if (command.includes('-f') && command.includes('wav')) await writeFile(command.at(-1)!, new Uint8Array(128)); return { exitCode: 0, stdout: '', stderr: '' } },
    fetchImpl: async input => {
      relayRequests += 1
      expect(String(input)).toEndWith('/v1/video-media/object-leases')
      const checkpoint = (await service.repository.getOperation('task_00000001')).result?.asr_checkpoints?.[0]
      fenceSeenDuringUpload ||= Boolean(checkpoint && typeof checkpoint === 'object' && 'remote_submission_started_at' in checkpoint)
      throw new Error('upload transport failed before provider submission')
    },
  })
  const created = await service.createProject({ title: 'ASR 上传失败恢复' })
  const sourceFact = { ...source(created.id), path: sourcePath }
  await service.repository.saveFact(sourceFact)
  const saved = await service.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourcePath, name: 'source.mp4', duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['asr'], data_kinds: ['audio_extract'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 1, total_tokens: 0, input_bytes: 128, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 3_600, settlements: [], created_at: at, updated_at: at }],
  })
  await service.repository.saveOperation({ schema_version: 1, id: 'task_00000001', project_id: created.id, kind: 'video.analyze', status: 'running', progress: 10, stage: 'ASR', result: { user_goal: '上传失败恢复' }, created_at: at, updated_at: at })
  const invoke = service as unknown as { remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<unknown> }

  await expect(invoke.remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toMatchObject({ code: 'relay_control_unavailable' })
  expect(fenceSeenDuringUpload).toBeFalse()
  const checkpoint = (await service.repository.getOperation('task_00000001')).result?.asr_checkpoints?.[0]
  expect(checkpoint).toMatchObject({ state: 'uploading' })
  expect(checkpoint).not.toHaveProperty('remote_submission_started_at')
  expect((await service.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{
    operation_id: `task_00000001_asr_${sourceFact.id}`,
    state: 'released',
    safe_error_code: 'relay_upload_failed_before_submission',
  }])

  // The same parent/local Operation revives only its released allocation and
  // reaches the same deterministic upload again; it is not blocked as an
  // outcome-unknown provider submission and does not add a second reservation.
  await expect(invoke.remoteTranscriptEvidence(await service.getProject(created.id), saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toMatchObject({ code: 'relay_control_unavailable' })
  expect(relayRequests).toBe(2)
  expect((await service.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toHaveLength(1)
  expect((await service.repository.getOperation('task_00000001')).result?.asr_checkpoints?.[0]).not.toHaveProperty('remote_submission_started_at')
  service.repository.close()
})

test('ASR fence 后 499 保留 outcome_unknown，并经 local_operation_id 权威查询恢复死区', async () => {
  const root = await testRoot('asr-fenced-submission-recovery')
  const sourcePath = join(root, 'source.mp4'); await writeFile(sourcePath, 'source bytes')
  const first = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    runProcess: async command => { if (command.includes('-f') && command.includes('wav')) await writeFile(command.at(-1)!, new Uint8Array(128)); return { exitCode: 0, stdout: '', stderr: '' } },
    fetchImpl: async input => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/object-leases')) return Response.json({ lease_id: 'lease_00000001', state: 'ready', object_ref: 'object_00000001', expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.pathname.endsWith('/operations')) {
        return Response.json({ error: 'relay_control_cancelled' }, { status: 499 })
      }
      throw new Error(`unexpected request ${url}`)
    },
  })
  const created = await first.createProject({ title: 'ASR fence 死区恢复' })
  const sourceFact = { ...source(created.id), path: sourcePath }
  await first.repository.saveFact(sourceFact)
  const saved = await first.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourcePath, name: 'source.mp4', duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['asr'], data_kinds: ['audio_extract'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 1, total_tokens: 0, input_bytes: 128, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 3_600, settlements: [], created_at: at, updated_at: at }],
  })
  await first.repository.saveOperation({ schema_version: 1, id: 'task_00000001', project_id: created.id, kind: 'video.analyze', status: 'running', progress: 10, stage: 'ASR', result: { user_goal: 'fence 死区' }, created_at: at, updated_at: at })
  const invoke = (service: VideoWorkbenchService) => service as unknown as { remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<unknown> }
  await expect(invoke(first).remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toMatchObject({ status: 499, code: 'relay_control_cancelled' })
  const fenced = (await first.repository.getOperation('task_00000001')).result?.asr_checkpoints?.[0]
  expect(fenced).toMatchObject({ state: 'outcome_unknown', object_ref: 'object_00000001' })
  expect(fenced).toHaveProperty('remote_submission_started_at')
  expect(fenced).not.toHaveProperty('relay_operation_id')
  expect((await first.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{ state: 'outcome_unknown', safe_error_code: 'relay_control_cancelled' }])
  first.repository.close()

  const unavailablePaths: string[] = []
  const unavailable = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async input => {
      unavailablePaths.push(new URL(String(input)).pathname)
      return Response.json({ error: 'temporary_unavailable' }, { status: 503 })
    },
  })
  const unavailableProject = await unavailable.getProject(created.id)
  await expect(invoke(unavailable).remoteTranscriptEvidence(unavailableProject, unavailableProject.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toMatchObject({ status: 503 })
  expect(unavailablePaths).toEqual([`/v1/video-media/operations/by-local-operation/task_00000001_asr_${sourceFact.id}`])
  expect((await unavailable.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{ state: 'outcome_unknown' }])
  unavailable.repository.close()

  const recoveryPaths: string[] = []
  const recovered = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    runProcess: async command => { if (command.includes('-f') && command.includes('wav')) await writeFile(command.at(-1)!, new Uint8Array(128)); return { exitCode: 0, stdout: '', stderr: '' } },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); recoveryPaths.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname.includes('/by-local-operation/')) return Response.json({ error: 'operation_not_found' }, { status: 404 })
      if (url.pathname.endsWith('/operations')) return Response.json({ id: 'operation_00000001', state: 'expired', account_quota_reservation_id: 'quota_00000001', created_at: at, updated_at: at })
      throw new Error(`unexpected recovery request ${url}`)
    },
  })
  const recoveredProject = await recovered.getProject(created.id)
  await expect(invoke(recovered).remoteTranscriptEvidence(recoveredProject, recoveredProject.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toThrow('ASR 结果保留期已过期')
  expect(recoveryPaths).toEqual([
    `GET /v1/video-media/operations/by-local-operation/task_00000001_asr_${sourceFact.id}`,
    'POST /v1/video-media/operations',
  ])
  expect((await recovered.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'expired', relay_operation_id: 'operation_00000001' }])
  expect((await recovered.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toHaveLength(1)
  recovered.repository.close()
})

test('ASR submission fence 后 HTTP 409 保留预算并只恢复已有 Relay Operation', async () => {
  const root = await testRoot('asr-fenced-conflict-recovery')
  const sourcePath = join(root, 'source.mp4'); await writeFile(sourcePath, 'source bytes')
  const firstRequests: string[] = []
  const seed = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    runProcess: async command => { if (command.includes('-f') && command.includes('wav')) await writeFile(command.at(-1)!, new Uint8Array(128)); return { exitCode: 0, stdout: '', stderr: '' } },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); firstRequests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname.endsWith('/object-leases')) return Response.json({ lease_id: 'lease_00000001', state: 'ready', object_ref: 'object_00000001', expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.pathname.endsWith('/operations')) return Response.json({ error: 'local_operation_conflict' }, { status: 409 })
      throw new Error(`unexpected submission request ${url}`)
    },
  })
  const created = await seed.createProject({ title: 'ASR 409 恢复' })
  const sourceFact = { ...source(created.id), path: sourcePath }
  await seed.repository.saveFact(sourceFact)
  const localOperationId = `task_00000001_asr_${sourceFact.id}`
  const saved = await seed.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourcePath, name: sourceFact.name, duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['asr'], data_kinds: ['audio_extract'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 1, total_tokens: 0, input_bytes: 128, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 3_600, settlements: [], created_at: at, updated_at: at }],
  })
  await seed.repository.saveOperation({ schema_version: 1, id: 'task_00000001', project_id: created.id, kind: 'video.analyze', status: 'running', progress: 20, stage: 'ASR submission', result: { user_goal: '409 恢复' }, created_at: at, updated_at: at })
  const firstInvoke = seed as unknown as { remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<unknown> }
  await expect(firstInvoke.remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toMatchObject({ status: 409, code: 'local_operation_conflict' })
  expect(firstRequests).toEqual([
    'POST /v1/video-media/object-leases',
    'POST /v1/video-media/operations',
    `GET /v1/video-media/operations/by-local-operation/${localOperationId}`,
  ])
  expect((await seed.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'outcome_unknown', object_ref: 'object_00000001', remote_submission_started_at: at }])
  expect((await seed.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{ state: 'outcome_unknown', safe_error_code: 'local_operation_conflict' }])
  seed.repository.close()

  const requests: string[] = []
  const recovered = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      return Response.json({ id: 'operation_00000009', state: 'expired', account_quota_reservation_id: 'quota_00000009', created_at: at, updated_at: at })
    },
  })
  const invoke = recovered as unknown as { remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<unknown> }
  const recoveredProject = await recovered.getProject(created.id)
  await expect(invoke.remoteTranscriptEvidence(recoveredProject, recoveredProject.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toThrow('ASR 结果保留期已过期')
  expect(requests).toEqual([`GET /v1/video-media/operations/by-local-operation/${localOperationId}`])
  expect((await recovered.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'expired', relay_operation_id: 'operation_00000009' }])
  expect((await recovered.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{ state: 'outcome_unknown' }])
  recovered.repository.close()
})

test('长 ASR 重启后仅轮询已持久化 Relay 任务，超过两分钟轮次也不重新提交', async () => {
  const root = await testRoot('asr-poll-recovery')
  const seed = new VideoWorkbenchService({ root, now: () => new Date(at) })
  const created = await seed.createProject({ title: 'ASR 恢复' })
  const sourceFact = source(created.id)
  await seed.repository.saveFact(sourceFact)
  const localOperationId = `task_00000001_asr_${sourceFact.id}`
  const saved = await seed.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourceFact.path, name: sourceFact.name, duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['asr'], data_kinds: ['audio_extract'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 1, total_tokens: 100, input_bytes: 10_000, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 10_000, reservations: [{ operation_id: localOperationId, capability: 'speech_transcription', state: 'reserved', requests: 1, total_tokens: 0, input_bytes: 128, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 3_600, reserved_at: at }], settlements: [], created_at: at, updated_at: at }],
  })
  await seed.repository.saveOperation({
    schema_version: 1,
    id: 'task_00000001',
    project_id: created.id,
    kind: 'video.analyze',
    status: 'running',
    progress: 20,
    stage: '正在等待 ASR',
    result: { user_goal: '恢复长 ASR', asr_checkpoints: [{ source_id: sourceFact.id, local_operation_id: localOperationId, state: 'running', object_ref: 'object_00000001', relay_operation_id: 'operation_00000001', provider_task_id: 'provider_00000001', remote_submission_started_at: at, next_poll_at: at, updated_at: at }] },
    created_at: at,
    updated_at: at,
  })
  seed.repository.close()

  const invokeRecovery = (service: VideoWorkbenchService) => service as unknown as {
    remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<{ evidence: Array<{ text: string }> } | null>
  }
  const resetCheckpoint = async (service: VideoWorkbenchService) => {
    const operation = await service.repository.getOperation('task_00000001')
    await service.repository.saveOperation({
      ...operation,
      result: {
        ...operation.result,
        asr_checkpoints: (operation.result?.asr_checkpoints as Array<Record<string, unknown>>).map(item => ({ ...item, state: 'running', next_poll_at: at })),
      },
    })
  }
  const resetBudget = async (service: VideoWorkbenchService) => {
    const latest = await service.getProject(created.id)
    await service.repository.saveProject({ ...latest, remote_analysis_budgets: saved.remote_analysis_budgets })
  }
  const failed = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async () => Response.json({
      id: 'operation_00000001', state: 'failed', account_quota_reservation_id: 'quota_00000001',
      provider_receipt: { id: 'receipt_failed_asr', capability: 'speech_transcription', model_snapshot: 'fun-asr', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('d'), usage: { requests: 1, total_tokens: 0, input_bytes: 128, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 3_600 }, cache_hit: false, created_at: at },
      created_at: at, updated_at: at,
    }),
  })
  await expect(invokeRecovery(failed).remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toMatchObject({ code: 'relay_operation_not_succeeded' })
  expect((await failed.getProject(created.id)).remote_analysis_budgets[0]).toMatchObject({ reservations: [], settlements: [{ operation_id: localOperationId, receipt_id: 'receipt_failed_asr' }] })
  await resetCheckpoint(failed)
  await resetBudget(failed)
  failed.repository.close()

  const expired = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async () => Response.json({ id: 'operation_00000001', state: 'expired', account_quota_reservation_id: 'quota_00000001', created_at: at, updated_at: at }),
  })
  await expect(invokeRecovery(expired).remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)).rejects.toThrow('ASR 结果保留期已过期')
  expect((await expired.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'expired', relay_operation_id: 'operation_00000001' }])
  expect((await expired.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{ state: 'outcome_unknown', safe_error_code: 'provider_expired_receipt_missing' }])
  await resetCheckpoint(expired)
  expired.repository.close()

  const cancellation = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/cancel')) {
        expect(init?.signal?.aborted).toBeFalse()
        return Response.json({ id: 'operation_00000001', state: 'cancelled', provider_task_id: 'provider_00000001', account_quota_reservation_id: 'quota_00000001', created_at: at, updated_at: at })
      }
      return Response.json({ id: 'operation_00000001', state: 'running', provider_task_id: 'provider_00000001', retry_after_ms: 60_000, account_quota_reservation_id: 'quota_00000001', created_at: at, updated_at: at })
    },
  })
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 5)
  await expect(invokeRecovery(cancellation).remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', abort.signal)).rejects.toThrow('视频分析已取消')
  expect((await cancellation.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'cancelled', relay_operation_id: 'operation_00000001' }])
  expect((await cancellation.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{ state: 'released', safe_error_code: 'provider_cancelled_before_start' }])
  await resetCheckpoint(cancellation)
  await resetBudget(cancellation)
  cancellation.repository.close()

  const payload = new TextEncoder().encode(JSON.stringify({ kind: 'asr', sentences: [{ text: '恢复后的长任务', begin_time: 0, end_time: 1000, words: [] }] }))
  const payloadHash = `sha256:${createHash('sha256').update(payload).digest('hex')}`
  let polls = 0
  const requests: string[] = []
  const resumed = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.hostname === 'result.example.test') return new Response(payload, { status: 200 })
      if (url.pathname === '/v1/video-media/operations/operation_00000001') {
        polls += 1
        const running = polls <= 121
        return Response.json(running ? {
          id: 'operation_00000001', state: 'running', provider_task_id: 'provider_00000001', retry_after_ms: 1, account_quota_reservation_id: 'quota_00000001', created_at: at, updated_at: at,
        } : {
          id: 'operation_00000001', state: 'succeeded', provider_task_id: 'provider_00000001', account_quota_reservation_id: 'quota_00000001', result_object_refs: ['result_00000001'], result_objects: [{ object_ref: 'result_00000001', content_hash: payloadHash, byte_size: payload.byteLength, content_type: 'application/json', get_url: 'https://result.example.test/asr.json', expires_at: '2026-08-03T01:00:00.000Z' }], provider_receipt: { id: 'receipt_00000001', capability: 'speech_transcription', model_snapshot: 'fun-asr', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('d'), usage: { requests: 1, total_tokens: 0, input_bytes: 1, visual_frames: 0, proxy_seconds: 0, asr_seconds: 1, estimated_amount_micros: 0 }, cache_hit: false, created_at: at }, created_at: at, updated_at: at,
        })
      }
      throw new Error(`unexpected Relay request ${url}`)
    },
  })
  const transcript = await invokeRecovery(resumed).remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', new AbortController().signal)
  expect(transcript?.evidence).toMatchObject([{ text: '恢复后的长任务' }])
  expect(polls).toBeGreaterThan(120)
  expect(requests.every(item => item.startsWith('GET /v1/video-media/operations/') || item === 'GET /asr.json')).toBe(true)
  expect((await resumed.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'succeeded', relay_operation_id: 'operation_00000001' }])
  resumed.repository.close()
}, 15_000)

test('ASR GET 中取消后使用未绑定 client，在 Provider 不支持 cancel 时持续有界轮询并丢弃晚到结果', async () => {
  const root = await testRoot('asr-cancel-during-get')
  const seed = new VideoWorkbenchService({ root, now: () => new Date(at) })
  const created = await seed.createProject({ title: 'ASR GET 取消恢复' })
  const sourceFact = source(created.id)
  await seed.repository.saveFact(sourceFact)
  const localOperationId = `task_00000001_asr_${sourceFact.id}`
  const saved = await seed.repository.saveProject({
    ...created,
    task_id: 'task_00000001',
    sources: [{ id: sourceFact.id, path: sourceFact.path, name: sourceFact.name, duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['asr'], data_kinds: ['audio_extract'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 1, total_tokens: 100, input_bytes: 10_000, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 10_000, reservations: [{ operation_id: localOperationId, capability: 'speech_transcription', state: 'reserved', requests: 1, total_tokens: 0, input_bytes: 128, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 3_600, reserved_at: at }], settlements: [], created_at: at, updated_at: at }],
  })
  await seed.repository.saveOperation({
    schema_version: 1, id: 'task_00000001', project_id: created.id, kind: 'video.analyze', status: 'running', progress: 20, stage: '正在等待 ASR',
    result: { user_goal: '取消长 ASR', asr_checkpoints: [{ source_id: sourceFact.id, local_operation_id: localOperationId, state: 'running', object_ref: 'object_00000001', relay_operation_id: 'operation_00000001', provider_task_id: 'provider_00000001', remote_submission_started_at: at, next_poll_at: at, updated_at: at }] },
    created_at: at, updated_at: at,
  })
  seed.repository.close()

  let beganGet!: () => void
  const getStarted = new Promise<void>(resolve => { beganGet = resolve })
  const cancelSignals: boolean[] = []
  const requests: string[] = []
  let operationGets = 0
  const interrupted = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input)); requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
      if (url.pathname.endsWith('/cancel')) {
        cancelSignals.push(Boolean(init?.signal?.aborted))
        return Response.json({ error: 'operation_cancel_unconfirmed' }, { status: 409 })
      }
      operationGets += 1
      if (operationGets === 1) {
        beganGet()
        return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('GET aborted')), { once: true }))
      }
      if (operationGets === 2) return Response.json({ id: 'operation_00000001', state: 'running', provider_task_id: 'provider_00000001', retry_after_ms: 1, account_quota_reservation_id: 'quota_00000001', created_at: at, updated_at: at })
      return Response.json({
        id: 'operation_00000001', state: 'succeeded', provider_task_id: 'provider_00000001', account_quota_reservation_id: 'quota_00000001',
        provider_receipt: { id: 'receipt_cancel_late', capability: 'speech_transcription', model_snapshot: 'fun-asr', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('d'), usage: { requests: 1, total_tokens: 0, input_bytes: 128, visual_frames: 0, proxy_seconds: 0, asr_seconds: 30, estimated_amount_micros: 3_600 }, cache_hit: false, created_at: at },
        created_at: at, updated_at: at,
      })
    },
  })
  const invoke = (service: VideoWorkbenchService) => service as unknown as { remoteTranscriptEvidence: (project: VideoStudioProject, source: VideoStudioProject['sources'][number], fact: VideoFactSource, directory: string, operationId: string, signal: AbortSignal) => Promise<unknown> }
  const controller = new AbortController()
  const pending = invoke(interrupted).remoteTranscriptEvidence(saved, saved.sources[0]!, sourceFact, root, 'task_00000001', controller.signal)
  await getStarted
  controller.abort()
  await expect(pending).rejects.toThrow('视频分析已取消')
  expect(cancelSignals).toEqual([false])
  expect(requests).toEqual([
    'GET /v1/video-media/operations/operation_00000001',
    'GET /v1/video-media/operations/operation_00000001',
    'POST /v1/video-media/operations/operation_00000001/cancel',
    'GET /v1/video-media/operations/operation_00000001',
  ])
  expect((await interrupted.repository.getOperation('task_00000001')).result?.asr_checkpoints).toMatchObject([{ state: 'cancelled', relay_operation_id: 'operation_00000001' }])
  expect((await interrupted.getProject(created.id)).remote_analysis_budgets[0]).toMatchObject({ reservations: [], settlements: [{ operation_id: localOperationId, receipt_id: 'receipt_cancel_late' }] })
  interrupted.repository.close()
})

test('Relay ACK 已确认结果对象过期时只在本地 Fact 可验证后退役，5xx 仍保留重试', async () => {
  const root = await testRoot('relay-ack-retirement')
  let status = 503
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async () => Response.json({ error: status === 410 ? 'result_delivery_expired' : 'temporary_unavailable' }, { status }),
  })
  const created = await service.createProject({ title: 'ACK 退役' })
  const sourceFact = source(created.id)
  await service.repository.saveFact(sourceFact)
  await service.repository.saveFact({
    id: 'transcript_00000001', project_id: created.id, source_id: sourceFact.id, source_fingerprint: sourceFact.fingerprint,
    model_receipt_id: 'receipt_00000001', relay_operation_id: 'operation_00000001', relay_result_hashes: [hash('c')], source_offset: sourceFact.primary_video_stream.start_time,
    language: 'zh', segments: [{ id: 'segment_00000001', source_id: sourceFact.id, start: rationalTime('0', { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }), text: '本地已持久化结果', words: [] }], created_at: at,
  })
  await service.repository.saveProject({
    ...created,
    pending_relay_acknowledgements: [{ operation_id: 'task_00000001', relay_operation_id: 'operation_00000001', receipt_id: 'receipt_00000001', result_hashes: [hash('c')], created_at: at }],
  })
  const invoke = service as unknown as { flushPendingRelayAcknowledgements: (projectId: string) => Promise<void> }
  await invoke.flushPendingRelayAcknowledgements(created.id)
  expect((await service.getProject(created.id)).pending_relay_acknowledgements).toHaveLength(1)
  status = 410
  await invoke.flushPendingRelayAcknowledgements(created.id)
  expect(await service.getProject(created.id)).toMatchObject({ pending_relay_acknowledgements: [], retired_relay_operations: ['operation_00000001'] })
  service.repository.close()
})

test('启动 ACK 恢复逐项目有界执行，不并发压满 Relay', async () => {
  const root = await testRoot('bounded-ack-recovery')
  let active = 0; let peak = 0
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async () => await new Promise<Response>(resolve => {
      active += 1; peak = Math.max(peak, active)
      setTimeout(() => { active -= 1; resolve(new Response(null, { status: 204 })) }, 5)
    }),
  })
  for (const index of [1, 2, 3]) {
    const project = await service.createProject({ title: `恢复 ${index}` })
    await service.repository.saveProject({
      ...project,
      pending_relay_acknowledgements: [{ operation_id: `task_0000000${index}`, relay_operation_id: `operation_0000000${index}`, receipt_id: `receipt_0000000${index}`, result_hashes: [hash(String(index))], created_at: at }],
    })
  }
  await service.recoverInterruptedOperations()
  expect(peak).toBe(1)
  expect((await service.repository.listProjects()).every(project => project.pending_relay_acknowledgements.length === 0)).toBe(true)
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
    finalizeRemoteBudgetFailure: (projectId: string, budgetId: string, operationId: string, error: unknown, options?: { submissionFenced?: boolean }) => Promise<void>
  }
  const usage = { requests: 1, total_tokens: 1, input_bytes: 1, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 1 }
  const capabilities = ['visual_evidence', 'media_reasoning', 'speech_transcription', 'semantic_embedding'] as const
  for (const [index, capability] of capabilities.entries()) {
    const settledOperationId = `task_settled_${index}`
    await invoke.reserveRemoteBudget(created.id, 'budget_00000001', settledOperationId, capability, usage)
    await invoke.settleRemoteBudget(created.id, 'budget_00000001', settledOperationId, { id: `receipt_settled_${index}`, capability, usage })
    await invoke.reserveRemoteBudget(created.id, 'budget_00000001', `task_known_release_${index}`, capability, usage)
    await invoke.finalizeRemoteBudgetFailure(created.id, 'budget_00000001', `task_known_release_${index}`, new VideoMediaRelayClientError(422, 'provider_rejected'), { submissionFenced: true })
    await invoke.reserveRemoteBudget(created.id, 'budget_00000001', `task_unknown_fenced_${index}`, capability, usage)
    await invoke.finalizeRemoteBudgetFailure(created.id, 'budget_00000001', `task_unknown_fenced_${index}`, new Error('transport_lost'), { submissionFenced: true })
  }
  await invoke.reserveRemoteBudget(created.id, 'budget_00000001', 'task_provider_not_started', 'semantic_embedding', usage)
  await invoke.finalizeRemoteBudgetFailure(created.id, 'budget_00000001', 'task_provider_not_started', new VideoMediaRelayClientError(503, 'provider_not_started'), { submissionFenced: true })
  await invoke.reserveRemoteBudget(created.id, 'budget_00000001', 'task_provider_not_started_wrong_status', 'semantic_embedding', usage)
  await invoke.finalizeRemoteBudgetFailure(created.id, 'budget_00000001', 'task_provider_not_started_wrong_status', new VideoMediaRelayClientError(500, 'provider_not_started'), { submissionFenced: true })
  const budget = (await service.getProject(created.id)).remote_analysis_budgets[0]!
  expect(budget.state).toBe('reserved')
  expect(budget.settlements).toHaveLength(4)
  expect(budget.reservations.filter(item => item.state === 'released')).toHaveLength(5)
  expect(budget.reservations.filter(item => item.state === 'outcome_unknown')).toHaveLength(5)
  expect(budget.reservations.find(item => item.operation_id === 'task_provider_not_started')).toMatchObject({ state: 'released', safe_error_code: 'provider_not_started' })
  expect(budget.reservations.find(item => item.operation_id === 'task_provider_not_started_wrong_status')).toMatchObject({ state: 'outcome_unknown', safe_error_code: 'provider_not_started' })
  expect(budget.reservations.every(item => item.finalized_at && item.safe_error_code)).toBe(true)
  service.repository.close()
})

test('视觉、规划与 Embedding 在 fenced 499 后严格重放同一 Relay Operation 并结算', async () => {
  const root = await testRoot('remote-operation-strict-recovery')
  type Request = Parameters<VideoMediaRelayClient['createOperation']>[0]
  type Projection = Awaited<ReturnType<VideoMediaRelayClient['createOperation']>>
  const records = new Map<string, { body: string; projection: Projection; lostResponses: number; idempotencyKey: string }>()
  let providerCalls = 0
  let operationPosts = 0
  let lookups = 0
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      const lookup = /^\/v1\/video-media\/operations\/by-local-operation\/(.+)$/.exec(url.pathname)
      if (lookup) {
        lookups += 1
        const record = records.get(decodeURIComponent(lookup[1]!))
        return record ? Response.json(record.projection) : Response.json({ error: 'operation_not_found' }, { status: 404 })
      }
      if (url.pathname !== '/v1/video-media/operations' || init?.method !== 'POST') throw new Error(`unexpected Relay request ${init?.method} ${url}`)
      operationPosts += 1
      const body = String(init.body)
      const request = JSON.parse(body) as Request
      const existing = records.get(request.local_operation_id)
      if (existing) {
        if (existing.body !== body || existing.idempotencyKey !== new Headers(init.headers).get('Idempotency-Key')) {
          return Response.json({ error: 'local_operation_conflict' }, { status: 409 })
        }
        if (existing.lostResponses > 0) {
          existing.lostResponses -= 1
          return Response.json({ error: 'relay_control_cancelled' }, { status: 499 })
        }
        return Response.json(existing.projection)
      }
      providerCalls += 1
      const usage = request.capability === 'visual_evidence'
        ? { requests: 1, total_tokens: 0, input_bytes: 100, visual_frames: 1, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 10 }
        : { requests: 1, total_tokens: 10, input_bytes: 100, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 10 }
      const suffix = String(providerCalls).padStart(8, '0')
      const projection: Projection = {
        id: `operation_${suffix}`,
        state: 'succeeded',
        account_quota_reservation_id: `quota_${suffix}`,
        provider_receipt: {
          id: `receipt_${suffix}`,
          capability: request.capability,
          model_snapshot: 'test-model-v1',
          region: 'cn-beijing',
          request_schema_version: 1,
          prompt_version: 'v1',
          input_basis_hash: request.request_hash,
          usage,
          cache_hit: false,
          created_at: at,
        },
        created_at: at,
        updated_at: at,
      }
      records.set(request.local_operation_id, {
        body,
        projection,
        // The conflict case loses both its initial response and the one
        // bounded recovery response so a later changed fingerprint can be
        // verified against a durable outcome_unknown reservation.
        lostResponses: request.local_operation_id === 'task_conflict_00000001' ? 1 : 0,
        idempotencyKey: new Headers(init.headers).get('Idempotency-Key')!,
      })
      if (request.local_operation_id === 'task_local_consume_0001') return Response.json(projection)
      return Response.json({ error: 'relay_control_cancelled' }, { status: 499 })
    },
  })
  const created = await service.createProject({ title: '全能力严格恢复' })
  await service.repository.saveProject({
    ...created,
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('a'), state: 'reserved', requests: 10, total_tokens: 100, input_bytes: 1_000, visual_frames: 2, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 100, reservations: [], settlements: [], created_at: at, updated_at: at }],
  })
  const invoke = service as unknown as {
    videoMediaRelay: () => VideoMediaRelayClient | null
    reserveAndRunRemote: <T>(projectId: string, budgetId: string, capability: Request['capability'], usage: { requests: number; total_tokens: number; input_bytes: number; visual_frames: number; proxy_seconds: number; asr_seconds: number; estimated_amount_micros: number }, relay: VideoMediaRelayClient, request: Request, consume: (client: VideoMediaRelayClient, operation: Projection) => Promise<T>) => Promise<T>
    settleRemoteBudget: (projectId: string, budgetId: string, operationId: string, receipt: NonNullable<Projection['provider_receipt']>) => Promise<void>
  }
  const relay = invoke.videoMediaRelay()!
  const requests: Request[] = [
    { local_operation_id: 'task_visual_00000001', consent_revision_id: 'consent_00000001', consent_scope_hash: hash('a'), local_budget_reservation_id: 'budget_00000001', request_hash: hash('b'), capability: 'visual_evidence', application_role: 'shot_evidence', input: { object_refs: ['object_00000001'], evidence_window_id: 'window_00000001', facts_basis_hash: hash('c'), language: 'zh', output_schema_version: 1 } },
    { local_operation_id: 'task_planning_00000001', consent_revision_id: 'consent_00000001', consent_scope_hash: hash('a'), local_budget_reservation_id: 'budget_00000001', request_hash: hash('c'), capability: 'media_reasoning', application_role: 'planning', input: { object_refs: [], facts_basis_hash: hash('d'), evidence: [], language: 'zh', output_schema_version: 1 } },
    { local_operation_id: 'task_embedding_00000001', consent_revision_id: 'consent_00000001', consent_scope_hash: hash('a'), local_budget_reservation_id: 'budget_00000001', request_hash: hash('d'), capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'query', items: [{ id: 'embed_00000001', text: '开球' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'video-facts-v1' } },
  ]
  const usageFor = (request: Request) => request.capability === 'visual_evidence'
    ? { requests: 1, total_tokens: 0, input_bytes: 100, visual_frames: 1, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 10 }
    : { requests: 1, total_tokens: 10, input_bytes: 100, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 10 }
  for (const request of requests) {
    const settled = await invoke.reserveAndRunRemote(created.id, 'budget_00000001', request.capability, usageFor(request), relay, request, async (_activeRelay, operation) => {
      expect(operation.provider_receipt).toBeDefined()
      await invoke.settleRemoteBudget(created.id, 'budget_00000001', request.local_operation_id, operation.provider_receipt!)
      return operation
    })
    expect(settled.state).toBe('succeeded')
  }
  expect(providerCalls).toBe(3)
  expect(operationPosts).toBe(6)
  expect(lookups).toBe(3)
  expect((await service.getProject(created.id)).remote_analysis_budgets[0]).toMatchObject({ reservations: [], settlements: [{ capability: 'visual_evidence' }, { capability: 'media_reasoning' }, { capability: 'semantic_embedding' }] })

  const conflictRequest: Request = { ...requests[2]!, local_operation_id: 'task_conflict_00000001', request_hash: hash('e') }
  await expect(invoke.reserveAndRunRemote(created.id, 'budget_00000001', conflictRequest.capability, usageFor(conflictRequest), relay, conflictRequest, async () => { throw new Error('consume must not run') })).rejects.toMatchObject({ status: 499 })
  expect((await service.getProject(created.id)).remote_analysis_budgets[0]?.reservations).toMatchObject([{ operation_id: conflictRequest.local_operation_id, state: 'outcome_unknown' }])
  const providerCallsBeforeConflict = providerCalls
  const changedFingerprint: Request = { ...conflictRequest, request_hash: hash('f') }
  await expect(invoke.reserveAndRunRemote(created.id, 'budget_00000001', changedFingerprint.capability, usageFor(changedFingerprint), relay, changedFingerprint, async () => { throw new Error('consume must not run') })).rejects.toMatchObject({ status: 409, code: 'local_operation_conflict' })
  expect(providerCalls).toBe(providerCallsBeforeConflict)
  const postsBeforeAllocationConflict = operationPosts
  await expect(invoke.reserveAndRunRemote(created.id, 'budget_00000001', conflictRequest.capability, { ...usageFor(conflictRequest), input_bytes: 101 }, relay, conflictRequest, async () => { throw new Error('consume must not run') })).rejects.toMatchObject({ status: 409, code: 'VIDEO_REMOTE_OPERATION_UNAVAILABLE' })
  expect(operationPosts).toBe(postsBeforeAllocationConflict)
  const localConsumeRequest: Request = { ...requests[1]!, local_operation_id: 'task_local_consume_0001', request_hash: hash('1') }
  const callsBeforeLocalFailure = { providerCalls, operationPosts, lookups }
  let consumeCalls = 0
  await expect(invoke.reserveAndRunRemote(created.id, 'budget_00000001', localConsumeRequest.capability, usageFor(localConsumeRequest), relay, localConsumeRequest, async (_activeRelay, operation) => {
    consumeCalls += 1
    await invoke.settleRemoteBudget(created.id, 'budget_00000001', localConsumeRequest.local_operation_id, operation.provider_receipt!)
    throw new Error('local projection write failed after receipt settlement')
  })).rejects.toThrow('local projection write failed after receipt settlement')
  expect(consumeCalls).toBe(1)
  expect({ providerCalls, operationPosts, lookups }).toEqual({ providerCalls: callsBeforeLocalFailure.providerCalls + 1, operationPosts: callsBeforeLocalFailure.operationPosts + 1, lookups: callsBeforeLocalFailure.lookups })
  service.repository.close()
})

test('远程规划 consume 后先以 staged Operation 原子替换 fence，重启只投影与 ACK 不再调用 Provider', async () => {
  const root = await testRoot('planning-staged-crash-recovery')
  let providerPosts = 0
  let acknowledgements = 0
  const usage = { requests: 1, total_tokens: 10, input_bytes: 100, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 10 }
  const projection = {
    id: 'operation_planning_0001', state: 'succeeded' as const, account_quota_reservation_id: 'quota_planning_0001',
    provider_receipt: { id: 'receipt_planning_0001', capability: 'media_reasoning' as const, model_snapshot: 'qwen-planning-test', region: 'cn-beijing' as const, request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('b'), usage, cache_hit: false, created_at: at },
    created_at: at, updated_at: at,
  }
  const fetchImpl = async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/video-media/operations') { providerPosts += 1; return Response.json(projection) }
    if (url.pathname.endsWith('/ack')) { acknowledgements += 1; return new Response(null, { status: 204 }) }
    throw new Error(`unexpected Relay request ${url}`)
  }
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' }, fetchImpl })
  const created = await service.createProject({ title: '规划 staged 恢复' })
  const sourceFact = source(created.id)
  await service.repository.saveFact(sourceFact)
  const evidence = { id: 'evidence_00000001', kind: 'visual' as const, source_id: sourceFact.id, source_fingerprint: sourceFact.fingerprint, in_ms: 0, out_ms: 1_000, text: '真实击球片段', confidence: 0.9, warnings: [], created_at: at }
  const saved = await service.repository.saveProject({
    ...created,
    sources: [{ id: sourceFact.id, path: sourceFact.path, name: sourceFact.name, duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }],
    evidence: [evidence],
    evidence_revision: hash('a'),
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['planning'], data_kinds: ['transcript'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', ...usage, settlements: [], created_at: at, updated_at: at }],
  })
  const planTask = await service.repository.saveOperation({
    schema_version: 1, id: 'task_planning_parent', project_id: created.id, kind: 'video.plan', status: 'running', progress: 60, stage: '远程规划',
    result: { base_revision: saved.revision, base_timeline_version_id: saved.current_timeline_version_id, evidence_revision: saved.evidence_revision, user_goal: '保留真实击球', analysis_gaps: [] }, created_at: at, updated_at: at,
  })
  await service.repository.saveProject({ ...saved, task_id: planTask.id })
  const rawPlan = {
    brief: { content_type: '视频短片', output_channel: '本地', must_preserve_text: [], recommended_direction: '按真实证据剪辑', rationale: ['仅使用本地事实'], gaps: [] },
    scenes: [{ source_id: sourceFact.id, in_ms: 0, out_ms: 1_000, story_role: 'hook', evidence_ids: [evidence.id], rationale: '真实击球开场', needs_review: false }],
    alternatives: [],
  }
  type RelayRequest = Parameters<VideoMediaRelayClient['createOperation']>[0]
  type RelayProjection = Awaited<ReturnType<VideoMediaRelayClient['createOperation']>>
  const request: RelayRequest = { local_operation_id: planTask.id, consent_revision_id: 'consent_00000001', consent_scope_hash: hash('c'), local_budget_reservation_id: 'budget_00000001', request_hash: hash('b'), capability: 'media_reasoning', application_role: 'planning', input: { object_refs: [], facts_basis_hash: saved.evidence_revision!, evidence: [{ id: evidence.id, kind: 'visual_fact', text: evidence.text, confidence: evidence.confidence }], language: 'zh', output_schema_version: 1 } }
  const invoke = service as unknown as {
    videoMediaRelay: () => VideoMediaRelayClient | null
    reserveAndRunRemote: <T>(projectId: string, budgetId: string, capability: 'media_reasoning', allocation: typeof usage, relay: VideoMediaRelayClient, request: RelayRequest, consume: (client: VideoMediaRelayClient, operation: RelayProjection) => Promise<T>, options: { parentOperationId: string }) => Promise<T>
    settleRemoteBudget: (projectId: string, budgetId: string, operationId: string, receipt: NonNullable<RelayProjection['provider_receipt']>) => Promise<void>
    stageRemotePlanningResult: (task: VideoOperation, input: { userGoal: string; analysisGaps: string[] }, raw: unknown, acknowledgement: VideoStudioProject['pending_relay_acknowledgements'][number]) => Promise<VideoOperation>
  }
  await expect(invoke.reserveAndRunRemote(created.id, 'budget_00000001', 'media_reasoning', usage, invoke.videoMediaRelay()!, request, async (_relay, remote) => {
    await invoke.settleRemoteBudget(created.id, 'budget_00000001', planTask.id, remote.provider_receipt!)
    await invoke.stageRemotePlanningResult(planTask, { userGoal: '保留真实击球', analysisGaps: [] }, rawPlan, { operation_id: planTask.id, relay_operation_id: remote.id, receipt_id: remote.provider_receipt!.id, result_hashes: [hash('d')], created_at: at })
    throw new Error('simulated crash after durable stage')
  }, { parentOperationId: planTask.id })).rejects.toThrow('simulated crash after durable stage')
  const staged = await service.repository.getOperation(planTask.id)
  expect(staged).toMatchObject({ status: 'committing', result: { raw_plan: rawPlan, relay_acknowledgement: { relay_operation_id: projection.id } } })
  expect(staged.result).not.toHaveProperty('remote_recovery')
  service.repository.close()

  const recovered = new VideoWorkbenchService({ root, now: () => new Date(at), env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' }, fetchImpl })
  await recovered.recoverInterruptedOperations()
  expect(await recovered.repository.getOperation(planTask.id)).toMatchObject({ status: 'succeeded', result: { timeline_draft_id: expect.any(String) } })
  expect((await recovered.getProject(created.id)).timeline_drafts).toHaveLength(1)
  expect({ providerPosts, acknowledgements }).toEqual({ providerPosts: 1, acknowledgements: 1 })
  recovered.repository.close()
})

test('正式视觉证据路径在 POST 响应丢失后查询旧任务，不产生第二次 Provider 调用', async () => {
  const root = await testRoot('visual-operation-recovery')
  const result = new TextEncoder().encode(JSON.stringify({ kind: 'visual_evidence', evidence: { summary: '恢复后的击球画面', confidence: 0.9, warnings: [] } }))
  const resultHash: `sha256:${string}` = `sha256:${createHash('sha256').update(result).digest('hex')}`
  let providerCalls = 0
  let operationPosts = 0
  let lookups = 0
  let acceptedBody = ''
  const projection = {
    id: 'operation_00000001', state: 'succeeded' as const, account_quota_reservation_id: 'quota_00000001',
    result_object_refs: ['result_00000001'], result_objects: [{ object_ref: 'result_00000001', content_hash: resultHash, byte_size: result.byteLength, content_type: 'application/json', get_url: 'https://result.example.test/visual.json', expires_at: '2026-08-03T01:00:00.000Z' }],
    provider_receipt: { id: 'receipt_00000001', capability: 'visual_evidence' as const, model_snapshot: 'qwen-vl-test', region: 'cn-beijing' as const, request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('a'), usage: { requests: 1, total_tokens: 0, input_bytes: 3, visual_frames: 1, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: at }, created_at: at, updated_at: at,
  }
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === 'result.example.test') return new Response(result)
      if (url.pathname.endsWith('/object-leases')) return Response.json({ lease_id: 'lease_00000001', state: 'ready', object_ref: 'object_00000001', expires_at: '2026-08-03T01:00:00.000Z' })
      if (url.pathname.includes('/by-local-operation/')) { lookups += 1; return Response.json(projection) }
      if (url.pathname === '/v1/video-media/operations') {
        operationPosts += 1
        const body = String(init?.body)
        if (!acceptedBody) {
          acceptedBody = body
          providerCalls += 1
          return Response.json({ error: 'relay_control_cancelled' }, { status: 499 })
        }
        if (body !== acceptedBody) return Response.json({ error: 'local_operation_conflict' }, { status: 409 })
        return Response.json(projection)
      }
      throw new Error(`unexpected Relay request ${init?.method} ${url}`)
    },
  })
  const created = await service.createProject({ title: '视觉恢复' })
  const sourceFact = source(created.id)
  const videoSource = { id: sourceFact.id, path: sourceFact.path, name: sourceFact.name, duration_ms: 30_000, width: 1920, height: 1080, fps: 30, has_audio: true, fingerprint: sourceFact.fingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }
  const saved = await service.repository.saveProject({
    ...created,
    sources: [videoSource],
    remote_analysis_consents: [{ id: 'consent_00000001', project_id: created.id, revision: 1, state: 'active', provider: 'aliyun_bailian', region: 'cn-beijing', purposes: ['visual_evidence'], data_kinds: ['keyframes'], coverage: [{ source_id: sourceFact.id, ranges: [{ start: sourceFact.primary_video_stream.start_time, duration: sourceFact.primary_video_stream.duration! }] }], acknowledged_estimate_hash: hash('e'), granted_by_actor_id: 'local', granted_at: at }],
    remote_analysis_budgets: [{ id: 'budget_00000001', estimate_hash: hash('e'), state: 'reserved', requests: 1, total_tokens: 0, input_bytes: 3, visual_frames: 1, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 250, settlements: [], created_at: at, updated_at: at }],
  })
  const window = {
    id: 'window_00000001', project_id: created.id, source_id: sourceFact.id, source_fingerprint: sourceFact.fingerprint,
    range: sourceTimeRange(sourceFact.primary_video_stream.start_time, rationalTime('90000', sourceFact.primary_video_stream.start_time.tick_rate)),
    sample_strategy: 'representative_frame' as const, keyframe_derivative_ids: [], transcript_segment_ids: [], evidence_ids: [], analysis_depth: 'summary' as const, sampling_receipt_id: 'receipt_sampling_0001',
    coverage: { generation: 1, request_budget: { max_windows: 1, max_visual_requests: 1, max_frames: 1, max_proxy_seconds: 0, max_input_tokens: 100, max_covered_ticks: '90000' }, request_usage: { windows: 1, visual_requests: 1, frames: 1, proxy_seconds: 0, estimated_input_tokens: 1, covered_ticks: '90000' }, uncovered: [] }, created_at: at,
  }
  await service.repository.saveOperation({ schema_version: 1, id: 'task_visual_parent', project_id: created.id, kind: 'video.analyze', status: 'running', progress: 45, stage: '视觉恢复', result: { user_goal: '恢复视觉证据' }, created_at: at, updated_at: at })
  const invoke = service as unknown as {
    remoteVisualEvidence: (project: VideoStudioProject, operationId: string, extracted: { frames: Array<{ source_id: string; in_ms: number; range_end_ms: number; evidence_window_id: string; data_url: string }>; transcripts: []; relay_acknowledgements: []; gaps: []; source_facts: Map<string, VideoFactSource>; evidence_windows: Map<string, typeof window> }, signal: AbortSignal) => Promise<{ evidence: Array<{ text: string }>; acknowledgements: VideoStudioProject['pending_relay_acknowledgements'] } | null>
  }
  const recovered = await invoke.remoteVisualEvidence(saved, 'task_visual_parent', {
    frames: [{ source_id: sourceFact.id, in_ms: 0, range_end_ms: 1000, evidence_window_id: window.id, data_url: `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}` }],
    transcripts: [], relay_acknowledgements: [], gaps: [], source_facts: new Map([[sourceFact.id, sourceFact]]), evidence_windows: new Map([[window.id, window]]),
  }, new AbortController().signal)
  expect(recovered?.evidence).toMatchObject([{ text: '恢复后的击球画面' }])
  expect(recovered?.acknowledgements).toMatchObject([{ relay_operation_id: 'operation_00000001', receipt_id: 'receipt_00000001' }])
  expect({ providerCalls, operationPosts, lookups }).toEqual({ providerCalls: 1, operationPosts: 2, lookups: 1 })
  expect((await service.getProject(created.id)).remote_analysis_budgets[0]).toMatchObject({ reservations: [], settlements: [{ operation_id: 'task_visual_parent_frame_0', capability: 'visual_evidence' }] })
  expect((await service.repository.getOperation('task_visual_parent')).result).not.toHaveProperty('remote_recovery')
  expect(await service.repository.listFacts('evidence', created.id, sourceFact.id)).toHaveLength(1)
  service.repository.close()
})

test('正式混合检索在零词法命中时仍索引完整授权 Transcript 语料并返回语义结果', async () => {
  const root = await testRoot('relay-hybrid')
  const resultPayloads = new Map<string, Uint8Array>()
  const relayOperations = new Map<string, { requestBody: string; projection: Record<string, unknown> }>()
  let operation = 0
  let lookups = 0
  let operationPosts = 0
  let resultDownloads = 0
  let acknowledgements = 0
  let documentAcknowledgementsAvailable = false
  const reservationsBeforeSearchCalls: number[] = []
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    env: { BB_VIDEO_MEDIA_RELAY_URL: 'https://relay.example.test', BB_GATEWAY_TOKEN: 'relay-test-token-1234' },
    fetchImpl: async (input, init) => {
      const url = new URL(String(input))
      if (url.hostname === 'result.example.test') {
        resultDownloads += 1
        const payload = resultPayloads.get(url.pathname)
        return payload ? new Response(payload, { status: 200 }) : Response.json({ error: 'result_delivery_expired' }, { status: 410 })
      }
      if (url.pathname.endsWith('/ack')) {
        acknowledgements += 1
        const relayId = url.pathname.split('/').at(-2)
        const record = [...relayOperations.values()].find(item => (item.projection as { id?: string }).id === relayId)
        const embeddingRole = record ? (JSON.parse(record.requestBody) as { input: { embedding_role: 'document' | 'query' } }).input.embedding_role : undefined
        if (embeddingRole === 'document' && !documentAcknowledgementsAvailable) {
          return Response.json({ error: 'temporary_ack_unavailable' }, { status: 503 })
        }
        const getUrl = (record?.projection as { result_objects?: Array<{ get_url: string }> } | undefined)?.result_objects?.[0]?.get_url
        if (getUrl) resultPayloads.delete(new URL(getUrl).pathname)
        return new Response(null, { status: 204 })
      }
      const lookup = /^\/v1\/video-media\/operations\/by-local-operation\/(.+)$/.exec(url.pathname)
      if (lookup) {
        lookups += 1
        const record = relayOperations.get(decodeURIComponent(lookup[1]!))
        return record ? Response.json(record.projection) : Response.json({ error: 'operation_not_found' }, { status: 404 })
      }
      if (!url.pathname.endsWith('/operations')) throw new Error(`unexpected relay request ${url}`)
      operationPosts += 1
      reservationsBeforeSearchCalls.push((await service.getProject(created.id)).remote_analysis_budgets[0]?.reservations.length ?? 0)
      const requestBody = String(init?.body)
      const request = JSON.parse(requestBody) as { local_operation_id: string; input: { embedding_role: 'document' | 'query'; items: Array<{ id: string; text: string }> } }
      const existing = relayOperations.get(request.local_operation_id)
      if (existing) return existing.requestBody === requestBody
        ? Response.json(existing.projection)
        : Response.json({ error: 'local_operation_conflict' }, { status: 409 })
      const vectors = request.input.embedding_role === 'query'
        ? [{ id: request.input.items[0]!.id, vector: Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0) }]
        : request.input.items.map(item => ({ id: item.id, vector: Array.from({ length: 768 }, (_, index) => index === (item.text.includes('反弹') ? 0 : 1) ? 1 : 0) }))
      const payload = new TextEncoder().encode(JSON.stringify({ kind: 'embedding', vectors }))
      const path = `/embedding-${operation}.json`; const receiptId = `receipt_0000000${operation + 1}`; const operationId = `operation_0000000${operation + 1}`; operation += 1
      resultPayloads.set(path, payload)
      const projection = {
        id: operationId, state: 'succeeded', account_quota_reservation_id: `quota_0000000${operation}`,
        result_object_refs: [`result_0000000${operation}`], result_objects: [{ object_ref: `result_0000000${operation}`, content_hash: `sha256:${createHash('sha256').update(payload).digest('hex')}`, byte_size: payload.byteLength, content_type: 'application/json', get_url: `https://result.example.test${path}`, expires_at: '2026-08-03T01:00:00.000Z' }],
        provider_receipt: { id: receiptId, capability: 'semantic_embedding', model_snapshot: 'text-embedding-v4', region: 'cn-beijing', request_schema_version: 1, prompt_version: 'v1', input_basis_hash: hash('a'), usage: { requests: 1, total_tokens: 0, input_bytes: 0, visual_frames: 0, proxy_seconds: 0, asr_seconds: 0, estimated_amount_micros: 0 }, cache_hit: false, created_at: at }, created_at: at, updated_at: at,
      }
      relayOperations.set(request.local_operation_id, { requestBody, projection })
      // Simulate Relay accepting each paid call while the first Sidecar
      // response is lost. Recovery must look it up and strictly replay the
      // identical request rather than create another Provider invocation.
      return Response.json({ error: 'relay_control_cancelled' }, { status: 499 })
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
  expect(operation).toBe(2)
  expect(operationPosts).toBe(4)
  expect(lookups).toBe(2)
  expect(reservationsBeforeSearchCalls).toEqual([1, 1, 1, 1])
  expect((await service.getProject(created.id)).remote_analysis_budgets[0]?.settlements).toHaveLength(2)
  expect({ resultDownloads, acknowledgements }).toEqual({ resultDownloads: 2, acknowledgements: 3 })
  expect(await service.repository.listPendingFactEmbeddingRelayAcknowledgements(created.id)).toMatchObject([{
    local_operation_id: expect.stringContaining('d00'),
    relay_operation_id: 'operation_00000001',
    receipt_id: 'receipt_00000001',
  }])
  documentAcknowledgementsAvailable = true
  const replayedPage = await service.searchMediaFacts(created.id, '完全不同的查询词', { limit: 10 })
  expect(replayedPage.items[0]).toMatchObject({ id: 'transcript_00000002', text: '反弹角度的控制技巧' })
  expect({ operation, operationPosts, lookups, resultDownloads, acknowledgements }).toEqual({ operation: 2, operationPosts: 4, lookups: 2, resultDownloads: 2, acknowledgements: 4 })
  expect(await service.repository.listPendingFactEmbeddingRelayAcknowledgements(created.id)).toEqual([])
  service.repository.close()
})
