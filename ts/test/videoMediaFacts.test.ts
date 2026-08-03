import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { VideoWorkbenchRepository } from '../src/server/services/videoWorkbenchRepository.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
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
  await expect(service.previewVideo(created.id, {
    base_revision: current.revision,
    timeline_version_id: current.current_timeline_version_id!,
  })).rejects.toMatchObject({ code: 'VIDEO_SOURCE_CHANGED' })
  expect(await service.repository.getFact('source', sourceFact.id)).toMatchObject({ state: 'changed', fingerprint_state: 'failed' })
  expect(await service.repository.getFact('derivative', 'derivative_00000002')).toMatchObject({ state: 'stale' })
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
  service.repository.close()
})

test('新视频分析只从 Evidence Window 抽帧，并把视觉结果写回窗口绑定的 typed Evidence', async () => {
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
  const frameCommands = commands.filter(command => command.includes('-frames:v') && command.at(-1)?.includes('/analysis/'))
  expect(frameCommands).toHaveLength(3)
  expect(frameCommands.map(command => command[command.indexOf('-ss') + 1])).toEqual(['0.000', '10.000', '19.999'])
  const evidence = await service.repository.listFacts('evidence', created.id, ready.sources[0]!.id) as Array<{ evidence_window_id?: string }>
  expect(evidence).toHaveLength(3)
  expect(evidence.every(item => item.evidence_window_id === windows[0]!.id)).toBeTrue()
  const refreshedWindow = await service.repository.getFact('evidence_window', windows[0]!.id) as { evidence_ids: string[] }
  expect(refreshedWindow.evidence_ids).toHaveLength(3)
  service.repository.close()
})
