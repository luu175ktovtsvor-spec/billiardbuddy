import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { link, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { buildExecutionPlanRenderCommand, fastVideoIdentity, selectDeliveryVideoEncoder, verifyDeliveryVideoOutput, videoFingerprint, writeExecutionPlanCaption, type VideoProcessRunner } from '../src/server/services/videoExecution.js'
import { VideoWorkbenchService, type LocalPcmDecoder } from '../src/server/services/videoWorkbenchService.js'
import { VideoWorkbenchRuntime } from '../src/server/services/videoWorkbenchRuntime.js'
import { detectBeatGrid, detectBeatGridFromPcmChunks } from '../src/server/video/domain/finishingDelivery/beatDetector.js'
import { FinishingDeliveryApplication } from '../src/server/video/domain/finishingDelivery/finishingDeliveryApplication.js'
import { EditorialApplication } from '../src/server/video/domain/editorial/editorialApplication.js'
import { createHostedEvidence, type TimedTranscript, type VideoFactSource } from '../src/server/video/domain/mediaFacts/model.js'
import { mediaTimeBase, rationalTime, sourceTimeRange, tickRateForTimeBase } from '../src/server/video/domain/mediaFacts/time.js'
import {
  MEDIA_UI_CAPABILITY_HEADER,
  videoAudioFinishingPlanSchema,
  videoCompositionPlanSchema,
  type VideoCaptionCue,
  type VideoCaptionDocument,
  type VideoCaptionDocumentRevision,
  type VideoCaptionStyle,
  type VideoExecutionPlan,
  type VideoQualityAcknowledgement,
  type VideoQualityReport,
  type VideoStudioProject,
} from '../shared/contracts/media.js'

const roots: string[] = []
const at = '2026-08-05T00:00:00.000Z'
const capability = 'capability_0123456789abcdef0123456789'

/** Public delivery journeys stay on the compatibility facade. Low-level
 * FFmpeg and publication fault injection targets the internal delivery
 * runtime, keeping those executor methods out of the API surface. */
function deliveryRuntime(service: VideoWorkbenchService): VideoWorkbenchRuntime {
  return (service as unknown as { root: { runtime: VideoWorkbenchRuntime } }).root.runtime
}

async function testRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `billiardbuddy-finishing-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

function requestSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part)
}

async function waitForTerminalOperation(service: VideoWorkbenchService, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await service.getOperation(operationId)
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) return operation
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`operation ${operationId} did not settle`)
}

async function waitForQualityConfirmation(service: VideoWorkbenchService, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const operation = await service.getOperation(operationId)
    if (operation.status === 'committing' && operation.result?.awaiting_quality_confirmation === true) {
      const reportId = typeof operation.result.post_render_report_id === 'string' ? operation.result.post_render_report_id : undefined
      const project = await service.getProject(operation.project_id)
      if (reportId && project.quality_reports.some(report => report.id === reportId)) return operation
    }
    if (['succeeded', 'failed', 'cancelled'].includes(operation.status)) {
      throw new Error(`operation ${operationId} settled before entering quality confirmation`)
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`operation ${operationId} did not await quality confirmation`)
}

function outputProbe(options: {
  audioStreams?: number
  majorBrand?: string
  videoCodec?: 'h264' | 'prores'
  proresProfile?: string
  audioCodec?: 'aac' | 'pcm_s16le'
  pixelFormat?: 'yuv420p' | 'yuv422p10le'
  colorRange?: string
  sampleRate?: number
  channels?: number
  sampleAspectRatio?: string
  displayAspectRatio?: string
  rotation?: number
  durationSeconds?: number
  omitVideoDuration?: boolean
  omitAudioDuration?: boolean
} = {}) {
  const audioStreams = options.audioStreams ?? 1
  const duration = (options.durationSeconds ?? 10).toFixed(3)
  return JSON.stringify({
    format: { duration, format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: options.majorBrand ?? 'isom' } },
    streams: [
      {
        codec_type: 'video', codec_name: options.videoCodec ?? 'h264', width: 1080, height: 1920,
        ...(options.proresProfile ? { profile: options.proresProfile } : {}),
        avg_frame_rate: '30/1',
        ...(options.omitVideoDuration ? {} : { duration }),
        pix_fmt: options.pixelFormat ?? 'yuv420p',
        color_space: 'bt709', color_transfer: 'bt709', color_primaries: 'bt709', color_range: options.colorRange ?? 'tv',
        sample_aspect_ratio: options.sampleAspectRatio ?? '1:1', display_aspect_ratio: options.displayAspectRatio ?? '9:16',
        ...(options.rotation === undefined ? {} : { side_data_list: [{ rotation: options.rotation }] }),
      },
      ...Array.from({ length: audioStreams }, () => ({
        codec_type: 'audio', codec_name: options.audioCodec ?? 'aac',
        ...(options.omitAudioDuration ? {} : { duration }),
        sample_rate: String(options.sampleRate ?? 48_000),
        channels: options.channels ?? 2, channel_layout: (options.channels ?? 2) === 1 ? 'mono' : 'stereo',
      })),
    ],
  })
}

/** Mirrors FFmpeg's named-filter-output resolution at the only boundary the
 * fixture simulates. A command with `-map [vout]` must actually produce that
 * label; otherwise real FFmpeg rejects it before it can write an output. */
function mappedFilterOutputsExist(command: readonly string[]): boolean {
  const filterIndex = command.indexOf('-filter_complex')
  if (filterIndex < 0) return true
  const graph = command[filterIndex + 1]
  if (!graph) return false
  const outputs = new Set(graph.split(';').flatMap(filter => {
    const labels = [...filter.matchAll(/\[([^\]]+)\]/g)].map(match => match[1])
    const last = labels.at(-1)
    return last ? [last] : []
  }))
  for (let index = 1; index < command.length; index += 1) {
    if (command[index - 1] !== '-map') continue
    const mapped = command[index]
    const label = mapped?.match(/^\[([^\]]+)\]$/)?.[1]
    if (label && !outputs.has(label)) return false
  }
  return true
}

function finishingRunner(commands: string[][]) {
  return async (command: string[]) => {
    commands.push(command)
    if (command.includes('-version')) return { exitCode: 0, stdout: 'ffmpeg fake', stderr: '' }
    if (command.includes('-encoders')) return { exitCode: 0, stdout: ' libx264 ', stderr: '' }
    if (command.includes('-filters')) return { exitCode: 0, stdout: ' TSC afftdn A->A\n T.. subtitles V->V\n T.. zscale V->V\n T.. tonemap V->V ', stderr: '' }
    if (command.includes('-show_format') && command.includes('-show_streams')) return { exitCode: 0, stdout: outputProbe(), stderr: '' }
    if (command.includes('-show_packets')) {
      return { exitCode: 0, stdout: JSON.stringify({ packets: [
        { stream_index: 0, dts: '0' }, { stream_index: 0, dts: '3000' },
        { stream_index: 1, dts: '0' }, { stream_index: 1, dts: '1024' },
      ] }), stderr: '' }
    }
    if (command.some(part => part.includes('ebur128'))) return { exitCode: 0, stdout: '', stderr: 'I: -24.0 LUFS\nTrue peak: -3.0' }
    if (command.some(part => part.includes('blackdetect'))) return { exitCode: 0, stdout: '', stderr: '' }
    if (command.some(part => part.includes('silencedetect')) && command.includes('0:a:0')) return { exitCode: 0, stdout: '', stderr: 'silence_duration: 0.1' }
    if (command.some(part => part.includes('silencedetect'))) {
      // Source analysis deliberately reports a three-second quiet interval;
      // the post-render whole-file scan is a distinct receipt and is clean.
      return { exitCode: 0, stdout: '', stderr: command.includes('-ss') ? 'silence_start: 3.0\nsilence_end: 6.0 | silence_duration: 3.0' : '' }
    }
    if (command.includes('-f') && command.includes('null')) return { exitCode: 0, stdout: '', stderr: '' }
    if (!mappedFilterOutputsExist(command)) return { exitCode: 1, stdout: '', stderr: "Output with label 'vout' does not exist" }
    const output = command.at(-1)
    if (output?.startsWith('/')) {
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, 'formal-video-output')
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
}

async function seededService(root: string, options: {
  pcmDecoder?: LocalPcmDecoder
  offsetAudio?: boolean
  primaryVideoStreamIndex?: number
  primaryVideoDurationMs?: number
  presentationDurationMs?: number
  runProcess?: VideoProcessRunner
  env?: Record<string, string | undefined>
} = {}) {
  const commands: string[][] = []
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'source-bytes-for-finishing')
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: options.runProcess ?? finishingRunner(commands),
    ...(options.env ? { env: options.env } : {}),
    ...(options.pcmDecoder ? { pcmDecoder: options.pcmDecoder } : {}),
  })
  const created = await service.createProject({ title: '完成层合同测试' })
  const fingerprint = await videoFingerprint(sourcePath)
  const identity = await fastVideoIdentity(sourcePath)
  const timeBase = mediaTimeBase(1, 1_000)
  const tickRate = tickRateForTimeBase(timeBase)
  const sourceId = 'src_00000001'
  const primaryVideoDurationMs = options.primaryVideoDurationMs ?? 10_000
  const presentationDurationMs = options.presentationDurationMs ?? primaryVideoDurationMs
  const primaryStart = options.offsetAudio ? rationalTime('1000', tickRate) : rationalTime('0', tickRate)
  const audioTracks = options.offsetAudio
    ? [{
        stream_index: 1,
        time_base: mediaTimeBase(1, 48_000),
        start_time: rationalTime('0', { num: 48_000, den: 1 }),
        duration: rationalTime('528000', { num: 48_000, den: 1 }),
        codec: 'aac', sample_rate: 48_000, channels: 2, disposition_default: false,
      }, {
        stream_index: 2,
        time_base: mediaTimeBase(1, 48_000),
        start_time: rationalTime('24000', { num: 48_000, den: 1 }),
        duration: rationalTime('504000', { num: 48_000, den: 1 }),
        codec: 'aac', sample_rate: 48_000, channels: 2, disposition_default: true,
      }]
    : [{
        stream_index: 1,
        time_base: mediaTimeBase(1, 48_000),
        start_time: rationalTime('0', { num: 48_000, den: 1 }),
        duration: rationalTime('480000', { num: 48_000, den: 1 }),
        codec: 'aac', sample_rate: 48_000, channels: 2, disposition_default: true,
      }]
  await service.repository.saveFact({
    id: sourceId,
    project_id: created.id,
    path: sourcePath,
    name: 'source.mp4',
    fast_identity: identity,
    fingerprint,
    fingerprint_state: 'ready',
    primary_video_stream: {
      stream_index: options.primaryVideoStreamIndex ?? 0,
      time_base: timeBase,
      start_time: primaryStart,
      duration: rationalTime(String(primaryVideoDurationMs), tickRate),
      codec: 'h264',
      width: 1920,
      height: 1080,
      rotation: 0,
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      color_range: 'tv',
      pixel_format: 'yuv420p',
      hdr_kind: 'sdr',
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime(String(presentationDurationMs), tickRate),
    audio_tracks: audioTracks,
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
      duration_ms: primaryVideoDurationMs,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      fingerprint,
      rotation: 0,
      video_stream_count: 1,
      audio_stream_count: audioTracks.length,
      missing: false,
      content_changed: false,
    }],
    timeline: [{ id: 'clip_00000001', source_id: sourceId, in_ms: 0, out_ms: primaryVideoDurationMs }],
  })
  // This read creates the one allowed v2 baseline from the legacy projection.
  await expect(service.getEditorialTimeline(created.id, 'timeline_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  return { service, created, commands }
}

async function stagedFormalSidecarPublicationCrash(
  root: string,
  label: string,
  conflictingSidecar = false,
) {
  const first = await seededService(root)
  const initial = await first.service.getProject(first.created.id)
  const variant = await first.service.createDeliveryVariant(first.created.id, {
    name: `${label} 恢复交付`,
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, `${label}-variant-key-0001`)
  const preflight = await first.service.preflightDeliveryVariant(first.created.id, variant.variant.id, {
    base_revision: variant.project.revision,
    base_variant_version_id: variant.version.id,
  }, `${label}-preflight-key-0001`)
  const output = join(root, `${label}.mp4`)
  const render = await first.service.renderDeliveryVariant(first.created.id, variant.variant.id, {
    base_revision: preflight.project.revision,
    base_variant_version_id: variant.version.id,
    output_path: output,
  }, `${label}-render-key-0001`)
  const terminal = await waitForTerminalOperation(first.service, render.id)
  if (terminal.status !== 'succeeded' || !terminal.result?.output_content_hash || !terminal.result.output_verification) {
    throw new Error('fixture formal render did not produce a verified output')
  }

  const temporaryOutput = join(root, `${label}.partial.mp4`)
  const temporarySidecar = join(root, `${label}.partial.srt`)
  const sidecarPath = join(root, `${label}.srt`)
  const originalOutput = await readFile(output)
  const sidecar = '1\n00:00:00,000 --> 00:00:01,000\n恢复字幕\n'
  await rm(output, { force: true })
  await writeFile(temporaryOutput, originalOutput)
  // Precise crash point: the first file is already linked, while the source
  // remains until the sidecar can be linked as part of the same group.
  await link(temporaryOutput, output)
  await writeFile(temporarySidecar, sidecar)
  if (conflictingSidecar) await writeFile(sidecarPath, 'user-sidecar-must-survive')
  const sidecarHash = await videoFingerprint(temporarySidecar)
  const completedProject = await first.service.getProject(first.created.id)
  await first.service.repository.saveProject({
    ...completedProject,
    state: 'rendering',
    task_id: render.id,
  })
  await first.service.repository.saveOperation({
    ...terminal,
    status: 'committing',
    progress: 95,
    stage: '模拟主文件已发布但字幕尚未发布',
    result: {
      ...terminal.result,
      temporary_output: temporaryOutput,
      temporary_sidecar_path: temporarySidecar,
      sidecar_caption_path: sidecarPath,
      output_verification: {
        ...terminal.result.output_verification,
        sidecar_caption: {
          format: 'srt',
          byte_size: new TextEncoder().encode(sidecar).byteLength,
          content_hash: sidecarHash,
          caption_basis_hash: `sha256:${'e'.repeat(64)}`,
        },
      },
    },
    error: undefined,
    error_code: undefined,
  })
  first.service.repository.close()
  return { created: first.created, output, render, sidecar, sidecarPath, temporaryOutput, temporarySidecar }
}

function clickTrack(bpm: number, seconds = 8, sampleRate = 8_000): Float32Array {
  const pcm = new Float32Array(seconds * sampleRate)
  const interval = 60 / bpm
  for (let atSeconds = 0.5; atSeconds < seconds - 0.1; atSeconds += interval) {
    const start = Math.round(atSeconds * sampleRate)
    for (let offset = 0; offset < Math.min(16, pcm.length - start); offset += 1) pcm[start + offset] = 1
  }
  return pcm
}

async function* oddChunks(bytes: Uint8Array): AsyncGenerator<Uint8Array<ArrayBufferLike>> {
  for (let offset = 0, size = 3; offset < bytes.length; offset += size, size = size === 11 ? 3 : size + 2) {
    yield bytes.subarray(offset, Math.min(bytes.length, offset + size))
  }
}

test('本地 BeatGrid 对 60/90/120/140 BPM 保持流式结果，低置信度明确降级', async () => {
  const sourceStart = rationalTime('100', { num: 1_000, den: 1 })
  for (const bpm of [60, 90, 120, 140]) {
    const pcm = clickTrack(bpm)
    const direct = detectBeatGrid(pcm, 8_000, sourceStart)
    const bytes = new Uint8Array(pcm.buffer.slice(0))
    const streamed = await detectBeatGridFromPcmChunks(oddChunks(bytes), 8_000, sourceStart)
    expect(direct.confidence).toBeGreaterThanOrEqual(0.65)
    expect(streamed.confidence).toBeGreaterThanOrEqual(0.65)
    expect(streamed.bpm).toBeCloseTo(bpm, 0)
    expect(streamed.beat_times.map(value => value.ticks)).toEqual(direct.beat_times.map(value => value.ticks))
  }
  const quiet = detectBeatGrid(new Float32Array(8_000), 8_000, sourceStart)
  expect(quiet).toMatchObject({ confidence: 0, beat_times: [] })
})

test('Caption Document/Revision 仅接受源锚点，服务端重投影时间线、判定 ready 并保留翻译锚点', async () => {
  const root = await testRoot('captions')
  const { service, created } = await seededService(root)
  const project = await service.getProject(created.id)
  const timelineId = project.current_editorial_timeline_version_id!
  const source = project.sources[0]!
  const transcript: TimedTranscript = {
    id: 'transcript_00000001',
    project_id: created.id,
    source_id: source.id,
    source_fingerprint: source.fingerprint!,
    model_receipt_id: 'receipt_00000001',
    source_offset: rationalTime('0', { num: 1_000, den: 1 }),
    language: 'zh',
    segments: [{
      id: 'segment_00000001',
      source_id: source.id,
      start: rationalTime('1000', { num: 1_000, den: 1 }),
      duration: rationalTime('2000', { num: 1_000, den: 1 }),
      text: '第一句字幕',
      words: [
        { id: 'word_00000001', start: rationalTime('1000', { num: 1_000, den: 1 }), duration: rationalTime('1000', { num: 1_000, den: 1 }), text: '第一句' },
        { id: 'word_00000002', start: rationalTime('2000', { num: 1_000, den: 1 }), duration: rationalTime('1000', { num: 1_000, den: 1 }), text: '字幕' },
      ],
    }, {
      id: 'segment_00000002',
      source_id: source.id,
      start: rationalTime('4000', { num: 1_000, den: 1 }),
      duration: rationalTime('1000', { num: 1_000, den: 1 }),
      text: '只有句级时间码',
      words: [],
    }],
    created_at: at,
  }
  await service.repository.saveFact(transcript)
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => await handler(new Request(url, init), url, requestSegments(url))
  const draftUrl = new URL(`http://localhost/api/videos/projects/${created.id}/captions/drafts`)
  const draftBody = { editorial_timeline_version_id: timelineId, transcript_id: transcript.id, language: 'zh' }
  const draft = await request(draftUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caption-draft-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify(draftBody),
  })
  expect(draft.status).toBe(201)
  const createdDraft = await draft.json() as { document: { id: string; current_revision_id: string }; revision: { id: string; cues: Array<{ id: string; source_anchor: { transcript_id: string; segment_ids: string[]; word_ids: string[] }; timeline_range: { start: { ticks: string }; duration: { ticks: string } }; alignment_state: string; alignment_confidence: number }> }; task: { id: string; kind: string; status: string } }
  const firstCue = createdDraft.revision.cues[0]
  expect(firstCue?.source_anchor).toEqual({
    transcript_id: transcript.id,
    segment_ids: ['segment_00000001'],
    word_ids: ['word_00000001', 'word_00000002'],
  })
  expect(firstCue?.alignment_state).toBe('ready')
  expect(firstCue?.timeline_range).toMatchObject({ start: { ticks: '90000' }, duration: { ticks: '180000' } })
  expect(createdDraft.revision.cues.map(cue => cue.alignment_state)).toEqual(['ready', 'needs_calibration'])
  expect(createdDraft.task.kind).toBe('video.caption_draft')
  expect(createdDraft.task.status).toBe('succeeded')
  const replay = await request(draftUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caption-draft-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify(draftBody),
  })
  expect(await replay.json()).toMatchObject({ document: { id: createdDraft.document.id }, revision: { id: createdDraft.revision.id }, task: { id: createdDraft.task.id } })
  const revisionUrl = new URL(`http://localhost/api/videos/projects/${created.id}/captions/${createdDraft.document.id}/revisions`)
  const next = await request(revisionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caption-revision-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({
      base_revision_id: createdDraft.revision.id,
      editorial_timeline_version_id: timelineId,
      cues: createdDraft.revision.cues.map(cue => ({
        source_anchor: cue.source_anchor,
        // A caller can send this shape for compatibility, but neither the
        // position nor ready state is authoritative on the client.
        timeline_range: { start: rationalTime('0', { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }) },
        text: '修订后的字幕',
        alignment_confidence: 0,
        alignment_state: 'ready',
      })),
    }),
  })
  expect(next.status).toBe(201)
  const nextBody = await next.json() as { revision: { id: string; parent_revision_id: string; cues: Array<{ id: string; text: string; source_anchor: { transcript_id: string; segment_ids: string[]; word_ids: string[] }; timeline_range: { start: { ticks: string }; duration: { ticks: string } }; alignment_state: string; alignment_confidence: number }> }; task: { status: string } }
  expect(nextBody.revision.parent_revision_id).toBe(createdDraft.revision.id)
  expect(nextBody.revision.cues.map(cue => cue.text)).toEqual(['修订后的字幕', '修订后的字幕'])
  expect(nextBody.task.status).toBe('succeeded')
  expect(nextBody.revision.cues[0]).toMatchObject({
    timeline_range: { start: { ticks: '90000' }, duration: { ticks: '180000' } },
    alignment_confidence: 0.95,
    alignment_state: 'ready',
  })
  expect(nextBody.revision.cues[1]).toMatchObject({
    timeline_range: { start: { ticks: '360000' }, duration: { ticks: '90000' } },
    alignment_confidence: 0.72,
    alignment_state: 'needs_calibration',
  })
  const overlapping = await request(revisionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caption-overlap-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({
      base_revision_id: nextBody.revision.id,
      editorial_timeline_version_id: timelineId,
      cues: [nextBody.revision.cues[0], nextBody.revision.cues[0]].map(cue => ({
        source_anchor: cue.source_anchor,
        timeline_range: { start: rationalTime('0', { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }) },
        text: cue.text,
        alignment_confidence: 1,
        alignment_state: 'ready',
      })),
    }),
  })
  expect(overlapping.status).toBe(400)
  expect(await overlapping.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
  const forgedAnchor = await request(revisionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caption-forged-anchor-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({
      base_revision_id: nextBody.revision.id,
      editorial_timeline_version_id: timelineId,
      cues: [{
        source_anchor: { transcript_id: transcript.id, segment_ids: ['segment_00009999'], word_ids: [] },
        timeline_range: { start: rationalTime('0', { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }) },
        text: '伪造锚点', alignment_confidence: 1, alignment_state: 'ready',
      }],
    }),
  })
  expect(forgedAnchor.status).toBe(400)
  const translation = await request(revisionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'caption-translation-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({
      base_revision_id: nextBody.revision.id,
      editorial_timeline_version_id: timelineId,
      cues: [{
        source_anchor: nextBody.revision.cues[0]!.source_anchor,
        timeline_range: { start: rationalTime('0', { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }) },
        text: 'Translated subtitle',
        translation_of_cue_id: nextBody.revision.cues[0]!.id,
        alignment_confidence: 0,
        alignment_state: 'needs_calibration',
      }],
    }),
  })
  expect(translation.status).toBe(201)
  const translationBody = await translation.json() as { revision: { cues: Array<{ source_anchor: unknown; timeline_range: unknown; translation_of_cue_id?: string; alignment_state: string; alignment_confidence: number }> } }
  expect(translationBody.revision.cues[0]).toMatchObject({
    source_anchor: nextBody.revision.cues[0]!.source_anchor,
    timeline_range: nextBody.revision.cues[0]!.timeline_range,
    translation_of_cue_id: nextBody.revision.cues[0]!.id,
    alignment_state: 'ready',
    alignment_confidence: 0.95,
  })
  const saved = await service.getProject(created.id)
  expect(saved.caption_document_revisions.find(item => item.id === createdDraft.revision.id)?.cues[0]?.text).toBe('第一句字幕')
  service.repository.close()
})

test('正式 ProRes 输出必须匹配冻结的 Standard/HQ profile，而非只匹配编码名', async () => {
  const root = await testRoot('output-prores-profile-contract')
  const { service, created } = await seededService(root)
  const project = await service.getProject(created.id)
  const baseProfile = project.export_profile_revisions[0]!
  const profile = {
    ...baseProfile,
    encoding: {
      container: 'mov' as const,
      video: { codec: 'prores_422' as const, quality: { mode: 'prores_profile' as const, profile: 'hq' as const } },
      audio: { codec: 'pcm_s16le' as const, sample_rate: 48_000 as const, channels: 2 as const },
      output_color: { range: 'sdr_bt709' as const, pixel_format: 'yuv422p10le' as const },
    },
  } as typeof baseProfile
  const output = join(root, 'prores-profile-contract.mov')
  await writeFile(output, 'output-contract-fixture')
  const runFor = (proresProfile: string) => async (command: string[]) => {
    if (command.includes('-show_format')) {
      return {
        exitCode: 0,
        stdout: outputProbe({
          majorBrand: 'qt',
          videoCodec: 'prores',
          proresProfile,
          audioCodec: 'pcm_s16le',
          pixelFormat: 'yuv422p10le',
        }),
        stderr: '',
      }
    }
    if (command.includes('-show_packets')) {
      return { exitCode: 0, stdout: JSON.stringify({ packets: [
        { stream_index: 0, dts: '0' }, { stream_index: 0, dts: '9000' }, { stream_index: 1, dts: '0' }, { stream_index: 1, dts: '9000' },
      ] }), stderr: '' }
    }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const inputFor = (proresProfile: string) => ({
    path: output,
    expected_duration_ms: 10_000,
    expected_profile: profile,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    runProcess: runFor(proresProfile),
  })
  await expect(verifyDeliveryVideoOutput(inputFor('Standard'))).rejects.toThrow('ProRes profile')
  await expect(verifyDeliveryVideoOutput(inputFor('HQ'))).resolves.toMatchObject({ prores_profile: 'hq' })
  service.repository.close()
})

test('字幕预检和执行编译失败关闭字体/安全区，sidecar 与 burn-in 均遵守 max_width', async () => {
  const root = await testRoot('caption-layout')
  const { service, created } = await seededService(root)
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '字幕交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'caption-layout-variant-key-0001')
  const compiled = await service.compileDeliveryVariant(created.id, variant.variant.id)
  const project = await service.getProject(created.id)
  const timeline = project.editorial_timeline_versions.find(item => item.id === variant.version.editorial_timeline_version_id)!
  const profile = project.export_profile_revisions.find(item => item.id === variant.version.export_profile_revision_id)!
  const style: VideoCaptionStyle = {
    id: 'caption_style_00000002', name: '窄幅字幕', font_family: 'Noto Sans CJK SC', font_size: 48,
    fill: '#FFFFFF', outline_fill: '#000000', outline_width: 2, bottom_safe_area: 0.08, max_width: 0.25, created_at: at,
  }
  const cue: VideoCaptionCue = {
    id: 'caption_cue_00000003',
    source_anchor: { transcript_id: 'transcript_00000002', segment_ids: ['segment_00000003'], word_ids: ['word_00000003'] },
    timeline_range: compiled.plan.timeline_items[0]!.timeline_range,
    text: '这是一段需要自动换行的很长字幕文本用于验证最大宽度约束',
    alignment_confidence: 0.95,
    alignment_state: 'ready' as const,
  }
  const document: VideoCaptionDocument = { id: 'caption_document_00000002', project_id: created.id, current_revision_id: 'caption_revision_00000002', created_at: at }
  const revision: VideoCaptionDocumentRevision = {
    id: 'caption_revision_00000002', document_id: document.id, project_id: created.id,
    editorial_timeline_version_id: timeline.id, transcript_id: cue.source_anchor.transcript_id,
    language: 'zh', style_id: style.id, cues: [cue], basis_hash: `sha256:${'b'.repeat(64)}`, created_at: at,
  }
  const captionProject: VideoStudioProject = {
    ...project,
    caption_styles: [...project.caption_styles, style],
    caption_documents: [...project.caption_documents, document],
    caption_document_revisions: [...project.caption_document_revisions, revision],
  }
  const captionVersion = { ...variant.version, caption_revision_id: revision.id }
  const captionProfile = { ...profile, caption_mode: 'burn_in' as const }
  const finishing = new FinishingDeliveryApplication(() => new Date(at))
  const report = finishing.createPreflightReport({
    project: captionProject,
    version: captionVersion,
    timeline,
    profile: captionProfile,
  })
  expect(report.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'caption_alignment', state: 'passed' }),
  ]))
  expect(report.checks.some(check => check.code === 'caption_font' || check.code === 'caption_safe_area')).toBeFalse()
  const plan = { ...compiled.plan, caption: {
    document_id: document.id, revision_id: revision.id, basis_hash: revision.basis_hash,
    mode: 'burn_in' as const, language: 'zh', style, cues: [cue],
  } } as VideoExecutionPlan
  const sidecar = join(root, 'captions.srt')
  await writeExecutionPlanCaption(plan, sidecar)
  const sidecarText = await readFile(sidecar, 'utf8')
  const subtitleLines = sidecarText.split('\n').filter(line => line && !/^\d+$/.test(line) && !line.includes('-->'))
  expect(subtitleLines.length).toBeGreaterThan(1)
  const command = buildExecutionPlanRenderCommand('ffmpeg', captionProject, plan, join(root, 'captioned.mp4'), undefined, {
    burnInCaptionPath: sidecar,
    burnInCaptionFontDirectory: '/app/runtime-assets/fonts',
  })
  expect(command.join(' ')).toContain('MarginL=')
  expect(command.join(' ')).toContain('MarginR=')
  expect(command.join(' ')).toContain('WrapStyle=0')
  expect(command.join(' ')).toContain("fontsdir='/app/runtime-assets/fonts'")
  expect(command.join(' ')).toContain('[vcaption]null[vout]')
  expect(mappedFilterOutputsExist(command)).toBeTrue()
  const unsupportedGlyphReport = finishing.createPreflightReport({
    project: {
      ...captionProject,
      caption_document_revisions: [{ ...revision, cues: [{ ...cue, text: '当前字体未声明覆盖的 emoji 😀' }] }],
    },
    version: captionVersion,
    timeline,
    profile: captionProfile,
  })
  expect(unsupportedGlyphReport.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'caption_glyph', state: 'blocked' }),
  ]))
  const unsafeStyle = { ...style, font_family: 'Uninstalled Display Font', max_width: 1, bottom_safe_area: 0 }
  const unsafeProject = { ...captionProject, caption_styles: [unsafeStyle] }
  const unsafeReport = finishing.createPreflightReport({
    project: unsafeProject,
    version: captionVersion,
    timeline,
    profile: captionProfile,
  })
  expect(unsafeReport.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'caption_font', state: 'blocked' }),
    expect.objectContaining({ code: 'caption_safe_area', state: 'blocked' }),
  ]))
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', unsafeProject, {
    ...plan,
    caption: { ...plan.caption!, style: unsafeStyle },
  }, join(root, 'unsafe.mp4'), undefined, {
    burnInCaptionPath: sidecar,
    burnInCaptionFontDirectory: '/app/runtime-assets/fonts',
  })).toThrow('受控字体清单')
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', captionProject, plan, join(root, 'missing-font-dir.mp4'), undefined, {
    burnInCaptionPath: sidecar,
  })).toThrow('受控字体目录')
  service.repository.close()
})

test('正式 ExecutionPlan 在烧录字幕时预检 subtitles 过滤器，缺失即失败关闭', async () => {
  const root = await testRoot('caption-filter-unavailable')
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  let filterListed = false
  const { service, created } = await seededService(root, {
    runProcess: async command => {
      if (command.includes('-filters')) {
        filterListed = true
        return { exitCode: 0, stdout: ' TSC afftdn A->A\n T.. zscale V->V\n T.. tonemap V->V ', stderr: '' }
      }
      return await runner(command)
    },
  })
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const compiled = await service.compileDeliveryVariant(created.id, variant.id)
  const plan = {
    ...compiled.plan,
    caption: {
      document_id: 'caption_document_00000003',
      revision_id: 'caption_revision_00000003',
      basis_hash: `sha256:${'c'.repeat(64)}` as const,
      mode: 'burn_in' as const,
      language: 'zh',
      style: {
        id: 'caption_style_00000003', name: '测试字幕', font_family: 'Noto Sans CJK SC', font_size: 40,
        fill: '#FFFFFF', outline_fill: '#000000', outline_width: 2, bottom_safe_area: 0.08, max_width: 0.8, created_at: at,
      },
      cues: [],
    },
  } as VideoExecutionPlan
  const filterPreflight = deliveryRuntime(service) as unknown as { assertExecutionPlanFiltersSupported(value: VideoExecutionPlan): Promise<void> }
  await expect(filterPreflight.assertExecutionPlanFiltersSupported(plan)).rejects.toMatchObject({ code: 'VIDEO_FINISHING_UNAVAILABLE' })
  expect(filterListed).toBeTrue()
  service.repository.close()
})

test('正式字幕预检在实际执行 Sidecar 验证受控字体目录、字体族和一帧烧录', async () => {
  const root = await testRoot('caption-runtime-preflight')
  const fontDirectory = join(root, 'controlled-fonts')
  const fontFile = join(fontDirectory, 'NotoSansCJKSC-Regular.ttc')
  await mkdir(fontDirectory, { recursive: true })
  await writeFile(fontFile, 'reviewed-font-fixture')
  const commands: string[][] = []
  let scannedFamily = 'Noto Sans CJK SC'
  let filters = ' T.. subtitles V->V '
  let renderExitCode = 0
  const { service, created } = await seededService(root, {
    env: { VIDEO_MEDIA_SUBTITLE_FONT_DIR: fontDirectory },
    runProcess: async command => {
      commands.push(command)
      if (command[0] === 'fc-scan') return { exitCode: 0, stdout: `${scannedFamily}\n`, stderr: '' }
      if (command.includes('-filters')) return { exitCode: 0, stdout: filters, stderr: '' }
      if (command.includes('-vf')) return { exitCode: renderExitCode, stdout: '', stderr: renderExitCode ? 'libass render unavailable' : '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  const project = await service.getProject(created.id)
  const compiled = await service.compileDeliveryVariant(created.id, project.delivery_variants[0]!.id)
  const plan = {
    ...compiled.plan,
    caption: {
      document_id: 'caption_document_runtime_0001',
      revision_id: 'caption_revision_runtime_0001',
      basis_hash: `sha256:${'d'.repeat(64)}` as const,
      mode: 'burn_in' as const,
      language: 'zh',
      style: {
        id: 'caption_style_runtime_0001', name: '运行时字幕', font_family: 'Noto Sans CJK SC', font_size: 40,
        fill: '#FFFFFF', outline_fill: '#000000', outline_width: 2, bottom_safe_area: 0.08, max_width: 0.8, created_at: at,
      },
      cues: [],
    },
  } as VideoExecutionPlan
  const preflight = deliveryRuntime(service) as unknown as { assertExecutionPlanFiltersSupported(value: VideoExecutionPlan): Promise<void> }

  await expect(preflight.assertExecutionPlanFiltersSupported(plan)).resolves.toBeUndefined()
  const probeCommand = commands.find(command => command.includes('-vf'))
  expect(probeCommand).toBeDefined()
  expect(probeCommand?.join(' ')).toContain(`fontsdir='${fontDirectory}'`)
  const filter = probeCommand?.[probeCommand.indexOf('-vf') + 1] ?? ''
  const probePath = /filename='([^']+)'/.exec(filter)?.[1]
  if (!probePath) throw new Error('caption runtime probe did not include a subtitle path')
  await expect(stat(probePath)).rejects.toMatchObject({ code: 'ENOENT' })

  await rm(fontDirectory, { recursive: true, force: true })
  await expect(preflight.assertExecutionPlanFiltersSupported(plan)).rejects.toMatchObject({ code: 'VIDEO_FINISHING_UNAVAILABLE' })

  await mkdir(fontDirectory, { recursive: true })
  await writeFile(fontFile, 'wrong-font-fixture')
  scannedFamily = 'Unreviewed Fallback Font'
  await expect(preflight.assertExecutionPlanFiltersSupported(plan)).rejects.toMatchObject({ code: 'VIDEO_FINISHING_UNAVAILABLE' })

  scannedFamily = 'Noto Sans CJK SC'
  renderExitCode = 1
  await expect(preflight.assertExecutionPlanFiltersSupported(plan)).rejects.toMatchObject({ code: 'VIDEO_FINISHING_UNAVAILABLE' })

  renderExitCode = 0
  filters = ' T.. zscale V->V '
  const beforeMissingFilter = commands.length
  await expect(preflight.assertExecutionPlanFiltersSupported(plan)).rejects.toMatchObject({ code: 'VIDEO_FINISHING_UNAVAILABLE' })
  expect(commands.slice(beforeMissingFilter).some(command => command[0] === 'fc-scan')).toBeFalse()
  service.repository.close()
})

test('正式预检、预览和导出只消费冻结 Variant/ExecutionPlan，并发布后渲染质量报告', async () => {
  const root = await testRoot('formal-api')
  const { service, created, commands } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '竖版正式交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'formal-variant-key-0001')
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => await handler(new Request(url, init), url, requestSegments(url))
  const preflightUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/preflight`)
  const preflightBody = { base_revision: variant.project.revision, base_variant_version_id: variant.version.id }
  const rejected = await request(preflightUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'formal-preflight-key-0001' },
    body: JSON.stringify(preflightBody),
  })
  expect(rejected.status).toBe(403)
  const preflight = await request(preflightUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'formal-preflight-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify(preflightBody),
  })
  expect(preflight.status).toBe(201)
  const preflightResult = await preflight.json() as { plan: { id: string; delivery_variant_version_id: string }; report: { id: string; state: string }; task: { id: string; kind: string; status: string } }
  expect(preflightResult).toMatchObject({
    plan: { delivery_variant_version_id: variant.version.id },
    report: { state: 'passed' },
    task: { kind: 'video.quality_preflight', status: 'succeeded' },
  })
  const preflightReplay = await request(preflightUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'formal-preflight-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify(preflightBody),
  })
  expect(await preflightReplay.json()).toMatchObject({ plan: { id: preflightResult.plan.id }, report: { id: preflightResult.report.id }, task: { id: preflightResult.task.id } })

  const afterPreflight = await service.getProject(created.id)
  const previewUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/preview`)
  const preview = await request(previewUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'formal-preview-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ base_revision: afterPreflight.revision, base_variant_version_id: variant.version.id }),
  })
  expect(preview.status).toBe(202)
  const previewTask = await preview.json() as { task: { id: string; result: Record<string, unknown> } }
  expect(previewTask.task.result).toMatchObject({ delivery_variant_version_id: variant.version.id, execution_plan_id: preflightResult.plan.id })
  expect(previewTask.task.result).not.toHaveProperty('output_path')
  expect((await waitForTerminalOperation(service, previewTask.task.id)).status).toBe('succeeded')

  const afterPreview = await service.getProject(created.id)
  expect(afterPreview.preview_task_id).toBeUndefined()
  const outputPath = join(root, 'formal-delivery.mp4')
  const renderUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/render`)
  const render = await request(renderUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'formal-render-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ base_revision: afterPreview.revision, base_variant_version_id: variant.version.id, output_path: outputPath }),
  })
  expect(render.status).toBe(202)
  const renderTask = await render.json() as { task: { id: string; result: Record<string, unknown> } }
  expect(renderTask.task.result).toMatchObject({ delivery_variant_version_id: variant.version.id, execution_plan_id: preflightResult.plan.id })
  expect(renderTask.task.result).not.toHaveProperty('output_path')
  const terminal = await waitForTerminalOperation(service, renderTask.task.id)
  expect(terminal.status).toBe('succeeded')
  const previewStagingPath = join(service.repository.paths().exports, 'execution-plans', `${preflightResult.plan.id}.mp4.partial-${previewTask.task.id}.mp4`)
  const renderStagingPath = join(service.repository.paths().exports, 'execution-plans', `${preflightResult.plan.id}.mp4.partial-${renderTask.task.id}.mp4`)
  // The user-selected target is publication-only. Both encoder invocations
  // must consume the frozen plan and write to its managed staging location.
  expect(commands.some(command => command.at(-1) === previewStagingPath)).toBeTrue()
  expect(commands.some(command => command.at(-1) === renderStagingPath)).toBeTrue()
  expect(commands.some(command => command.at(-1) === outputPath)).toBeFalse()
  const completed = await service.getProject(created.id)
  expect(completed).toMatchObject({
    state: 'complete',
    output_path: outputPath,
    output_verification: { execution_plan_id: preflightResult.plan.id, decoded: true, packet_timestamps_monotonic: true },
  })
  expect(completed.task_id).toBeUndefined()
  expect(completed.quality_reports.at(-1)).toMatchObject({ kind: 'post_render', state: 'passed', execution_plan_id: preflightResult.plan.id })
  expect(await readFile(outputPath, 'utf8')).toBe('formal-video-output')
  expect(commands.some(command => command.includes('-filter_complex') && command.join(' ').includes('concat=n=1:v=1:a=0'))).toBeTrue()
  expect(commands.some(command => command.includes('-show_packets'))).toBeTrue()
  service.repository.close()
})

test('正式预览失败后清除 Project 的活动预览投影', async () => {
  const root = await testRoot('formal-preview-terminal-state')
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  const { service, created } = await seededService(root, {
    runProcess: async command => command.includes('-filter_complex')
      ? { exitCode: 1, stdout: '', stderr: 'fixture preview encoder failure' }
      : await runner(command),
  })
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '失败预览交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'preview-terminal-variant-key-0001')
  const preflight = await service.preflightDeliveryVariant(created.id, variant.variant.id, {
    base_revision: variant.project.revision,
    base_variant_version_id: variant.version.id,
  }, 'preview-terminal-preflight-key-0001')
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/preview`)
  const response = await handler(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'preview-terminal-api-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ base_revision: preflight.project.revision, base_variant_version_id: variant.version.id }),
  }), url, requestSegments(url))
  expect(response.status).toBe(202)
  const body = await response.json() as { task: { id: string } }
  expect(await waitForTerminalOperation(service, body.task.id)).toMatchObject({ status: 'failed' })
  expect((await service.getProject(created.id)).preview_task_id).toBeUndefined()
  service.repository.close()
})

test('正式导出失败后清除 Project 的活动导出投影，API 可立即重试', async () => {
  const root = await testRoot('formal-render-terminal-state')
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  let rejectEncoder = true
  const { service, created } = await seededService(root, {
    runProcess: async command => command.includes('-filter_complex') && rejectEncoder
      ? { exitCode: 1, stdout: '', stderr: 'fixture render encoder failure' }
      : await runner(command),
  })
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '失败导出交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'render-terminal-variant-key-0001')
  const preflight = await service.preflightDeliveryVariant(created.id, variant.variant.id, {
    base_revision: variant.project.revision,
    base_variant_version_id: variant.version.id,
  }, 'render-terminal-preflight-key-0001')
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/render`)
  const body = JSON.stringify({
    base_revision: preflight.project.revision,
    base_variant_version_id: variant.version.id,
    output_path: join(root, 'failed-formal-render.mp4'),
  })
  const failed = await handler(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'render-terminal-api-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body,
  }), url, requestSegments(url))
  expect(failed.status).toBe(202)
  const firstTask = await failed.json() as { task: { id: string } }
  expect(await waitForTerminalOperation(service, firstTask.task.id)).toMatchObject({ status: 'failed' })
  const afterFailure = await service.getProject(created.id)
  expect(afterFailure.state).toBe('failed')
  expect(afterFailure.task_id).toBeUndefined()

  rejectEncoder = false
  const retried = await handler(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'render-terminal-api-key-0002',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({
      base_revision: preflight.project.revision,
      base_variant_version_id: variant.version.id,
      output_path: join(root, 'retried-formal-render.mp4'),
    }),
  }), url, requestSegments(url))
  expect(retried.status).toBe(202)
  const retryTask = await retried.json() as { task: { id: string } }
  expect(await waitForTerminalOperation(service, retryTask.task.id)).toMatchObject({ status: 'succeeded' })
  expect((await service.getProject(created.id)).task_id).toBeUndefined()
  service.repository.close()
})

test('正式导出取消 API 在返回终态前清除 Project 的活动导出投影', async () => {
  const root = await testRoot('formal-render-cancel-terminal-state')
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  let started!: () => void
  const startedEncoder = new Promise<void>(resolve => { started = resolve })
  const { service, created } = await seededService(root, {
    runProcess: async (command, options) => {
      if (!command.includes('-filter_complex')) return await runner(command)
      started()
      await new Promise<void>(resolve => {
        if (options?.signal?.aborted) return resolve()
        options?.signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      return { exitCode: 1, stdout: '', stderr: 'fixture render cancelled' }
    },
  })
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '取消导出交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'render-cancel-variant-key-0001')
  const preflight = await service.preflightDeliveryVariant(created.id, variant.variant.id, {
    base_revision: variant.project.revision,
    base_variant_version_id: variant.version.id,
  }, 'render-cancel-preflight-key-0001')
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const renderUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/render`)
  const render = await handler(new Request(renderUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'render-cancel-api-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({
      base_revision: preflight.project.revision,
      base_variant_version_id: variant.version.id,
      output_path: join(root, 'cancelled-formal-render.mp4'),
    }),
  }), renderUrl, requestSegments(renderUrl))
  expect(render.status).toBe(202)
  const createdTask = await render.json() as { task: { id: string } }
  await startedEncoder

  const cancelUrl = new URL(`http://localhost/api/videos/operations/${createdTask.task.id}/cancel`)
  const cancelled = await handler(new Request(cancelUrl, {
    method: 'POST',
    headers: { [MEDIA_UI_CAPABILITY_HEADER]: capability },
  }), cancelUrl, requestSegments(cancelUrl))
  expect(cancelled.status).toBe(200)
  expect(await cancelled.json()).toMatchObject({ task: { id: createdTask.task.id, status: 'cancelled' } })
  const afterCancellation = await service.getProject(created.id)
  expect(afterCancellation.state).toBe('ready')
  expect(afterCancellation.task_id).toBeUndefined()
  service.repository.close()
})

test('正式预检从主视频事实冻结绝对流索引，并以原始视频流时长编译', async () => {
  const root = await testRoot('primary-stream-freeze')
  const { service, created } = await seededService(root, {
    primaryVideoStreamIndex: 2,
    primaryVideoDurationMs: 3_000,
    presentationDurationMs: 10_000,
  })
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '主视频绝对流索引交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'primary-stream-variant-key-0001')
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/preflight`)
  const response = await handler(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'primary-stream-preflight-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ base_revision: variant.project.revision, base_variant_version_id: variant.version.id }),
  }), url, requestSegments(url))
  expect(response.status).toBe(201)
  const result = await response.json() as { plan: VideoExecutionPlan }
  expect(result.plan.inputs).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'source',
      video_stream_index: 2,
      source_range: expect.objectContaining({ duration: expect.objectContaining({ ticks: '3000' }) }),
    }),
  ]))

  const project = await service.getProject(created.id)
  const command = buildExecutionPlanRenderCommand('ffmpeg', project, result.plan, join(root, 'primary-stream.mp4'))
  const filter = command[command.indexOf('-filter_complex') + 1] ?? ''
  expect(filter).toContain('[0:2]')
  expect(filter).not.toMatch(/\[\d+:v\]/)

  const missingStream = structuredClone(result.plan) as VideoExecutionPlan
  missingStream.inputs = missingStream.inputs.map(input => input.kind === 'source'
    ? { ...input, video_stream_index: undefined }
    : input)
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', project, missingStream, join(root, 'missing-primary-stream.mp4')))
    .toThrow('源视频缺少冻结的绝对视频流索引')
  service.repository.close()
})

test('应用旧备选后，正式预览和导出只执行新 CommandSet 生成的 Version', async () => {
  const root = await testRoot('alternative-formal-execution')
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  const { service, created } = await seededService(root, {
    runProcess: async command => command.includes('-show_format') && command.includes('-show_streams')
      ? { exitCode: 0, stdout: outputProbe({ durationSeconds: 3 }), stderr: '' }
      : await runner(command),
  })
  const initial = await service.getProject(created.id)
  const source = initial.sources[0]
  const baseTimelineId = initial.current_timeline_version_id ?? initial.current_editorial_timeline_version_id
  if (!source || !baseTimelineId || !initial.current_editorial_timeline_version_id) throw new Error('fixture must have an editorial baseline')
  await service.repository.saveProject({
    ...initial,
    alternatives: [{
      id: 'alternative_00000001',
      base_timeline_version_id: baseTimelineId,
      label: '从第二秒开始的正式备选',
      tradeoff: '缩短开场，保留三秒主镜头',
      scenes: [{
        id: 'scene_00000001',
        source_id: source.id,
        in_ms: 2_000,
        out_ms: 5_000,
        story_role: 'hook',
        evidence_ids: [],
        rationale: '备选镜头范围',
        needs_review: false,
      }],
    }],
  })
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }

  const applied = await request(new URL(`http://localhost/api/videos/projects/${created.id}/alternatives/alternative_00000001/apply`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: initial.revision }),
  })
  expect(applied.status).toBe(200)
  const afterAlternative = await service.getProject(created.id)
  const alternativeTimelineId = afterAlternative.current_editorial_timeline_version_id
  expect(alternativeTimelineId).not.toBe(initial.current_editorial_timeline_version_id)
  const alternativeTimeline = afterAlternative.editorial_timeline_versions.find(version => version.id === alternativeTimelineId)
  expect(alternativeTimeline?.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'video',
      binding: expect.objectContaining({
        kind: 'source',
        source_range: expect.objectContaining({
          start: expect.objectContaining({ ticks: '2000' }),
          duration: expect.objectContaining({ ticks: '3000' }),
        }),
      }),
    }),
  ]))
  expect(afterAlternative.editorial_command_receipts.at(-1)).toMatchObject({
    target_kind: 'editorial',
    created_version_id: alternativeTimelineId,
  })

  const variantResponse = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'alternative-formal-variant-key-0001' },
    body: JSON.stringify({ name: '备选正式交付', editorial_timeline_version_id: alternativeTimelineId }),
  })
  expect(variantResponse.status).toBe(201)
  const variant = await variantResponse.json() as {
    project: { revision: number }
    variant: { id: string }
    version: { id: string }
  }
  const preflightResponse = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/preflight`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'alternative-formal-preflight-key-0001' },
    body: JSON.stringify({ base_revision: variant.project.revision, base_variant_version_id: variant.version.id }),
  })
  expect(preflightResponse.status).toBe(201)
  const preflight = await preflightResponse.json() as {
    project: { revision: number }
    plan: {
      id: string
      editorial_timeline_version_id: string
      timeline_items: Array<{
        kind: string
        binding: {
          kind: string
          source_range?: { start: { ticks: string }; duration: { ticks: string } }
        }
      }>
    }
  }
  expect(preflight.plan.editorial_timeline_version_id).toBe(alternativeTimelineId)
  expect(preflight.plan.timeline_items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'video',
      binding: expect.objectContaining({
        kind: 'source',
        source_range: expect.objectContaining({
          start: expect.objectContaining({ ticks: '2000' }),
          duration: expect.objectContaining({ ticks: '3000' }),
        }),
      }),
    }),
  ]))
  const previewResponse = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'alternative-formal-preview-key-0001' },
    body: JSON.stringify({ base_revision: preflight.project.revision, base_variant_version_id: variant.version.id }),
  })
  expect(previewResponse.status).toBe(202)
  const preview = await previewResponse.json() as { task: { id: string; result: { execution_plan_id: string } } }
  expect(preview.task.result.execution_plan_id).toBe(preflight.plan.id)
  expect((await waitForTerminalOperation(service, preview.task.id)).status).toBe('succeeded')

  const beforeRender = await service.getProject(created.id)
  const outputPath = join(root, 'alternative-formal-delivery.mp4')
  const renderResponse = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/render`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'alternative-formal-render-key-0001' },
    body: JSON.stringify({ base_revision: beforeRender.revision, base_variant_version_id: variant.version.id, output_path: outputPath }),
  })
  expect(renderResponse.status).toBe(202)
  const render = await renderResponse.json() as { task: { id: string; result: { execution_plan_id: string } } }
  expect(render.task.result.execution_plan_id).toBe(preflight.plan.id)
  expect((await waitForTerminalOperation(service, render.task.id)).status).toBe('succeeded')

  const executions = commands.filter(command => command.includes('-filter_complex') && (
    command.at(-1) === join(service.repository.paths().exports, 'execution-plans', `${preflight.plan.id}.mp4.partial-${preview.task.id}.mp4`)
    || command.at(-1) === join(service.repository.paths().exports, 'execution-plans', `${preflight.plan.id}.mp4.partial-${render.task.id}.mp4`)
  ))
  expect(executions).toHaveLength(2)
  for (const command of executions) {
    expect(command).toEqual(expect.arrayContaining(['-ss', '2.000000', '-t', '3.000000', '-i', source.path]))
  }
  service.repository.close()
})

test('sidecar 字幕预览通过受控资源交付，并与正式导出复用同一冻结执行计划字节', async () => {
  const root = await testRoot('sidecar-preview-api')
  const { service, created } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = initial.delivery_variants[0]!
  const version = initial.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const profile = initial.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)!
  const timeline = initial.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)!
  const videoItem = timeline.items.find(item => item.kind === 'video')!
  const {
    content_hash: _ignored,
    audio_policy,
    created_at,
    ...profileBeforeAudioPolicy
  } = profile
  // Profile hashes cover JSON key order. Keep the optional sidecar format at
  // its canonical schema position, before audio_policy, as production does.
  const withoutHash = {
    ...profileBeforeAudioPolicy,
    caption_mode: 'sidecar' as const,
    sidecar_caption_format: 'vtt' as const,
    audio_policy,
    created_at,
  }
  const sidecarProfile = {
    ...withoutHash,
    content_hash: `sha256:${createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex')}` as const,
  }
  const style: VideoCaptionStyle = {
    id: 'caption_style_sidecar_0001',
    name: 'Sidecar 字幕',
    font_family: 'Noto Sans CJK SC',
    font_size: 48,
    fill: '#FFFFFF',
    outline_fill: '#000000',
    outline_width: 2,
    bottom_safe_area: 0.08,
    max_width: 0.8,
    created_at: at,
  }
  const document: VideoCaptionDocument = {
    id: 'caption_document_sidecar_0001',
    project_id: created.id,
    current_revision_id: 'caption_revision_sidecar_0001',
    created_at: at,
  }
  const revision: VideoCaptionDocumentRevision = {
    id: document.current_revision_id,
    document_id: document.id,
    project_id: created.id,
    editorial_timeline_version_id: timeline.id,
    transcript_id: 'transcript_sidecar_0001',
    language: 'zh',
    style_id: style.id,
    cues: [{
      id: 'caption_cue_sidecar_0001',
      source_anchor: { transcript_id: 'transcript_sidecar_0001', segment_ids: ['segment_sidecar_0001'], word_ids: [] },
      timeline_range: structuredClone(videoItem.timeline_range),
      text: '预览和导出必须使用同一份字幕。',
      alignment_confidence: 0.95,
      alignment_state: 'ready',
    }],
    basis_hash: `sha256:${'f'.repeat(64)}`,
    created_at: at,
  }
  await service.repository.saveProject({
    ...initial,
    export_profile_revisions: initial.export_profile_revisions.map(candidate => candidate.id === profile.id ? sidecarProfile : candidate),
    delivery_variant_versions: initial.delivery_variant_versions.map(candidate => candidate.id === version.id
      ? { ...candidate, export_profile_hash: sidecarProfile.content_hash }
      : candidate),
    caption_styles: [...initial.caption_styles, style],
    caption_documents: [...initial.caption_documents, document],
    caption_document_revisions: [...initial.caption_document_revisions, revision],
    revision: initial.revision + 1,
    updated_at: at,
  })
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const commandsUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/commands`)
  const applied = await request(commandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sidecar-caption-command-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: version.id,
      commands: [{ kind: 'set_caption_revision', caption_document_id: document.id, caption_revision_id: revision.id }],
    }),
  })
  expect(applied.status).toBe(200)
  const appliedBody = await applied.json() as { project: { revision: number }; version: { id: string } }
  await expect(service.compileDeliveryVariant(created.id, variant.id)).resolves.toMatchObject({ plan: { delivery_variant_version_id: appliedBody.version.id } })
  const preflightUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/preflight`)
  const preflight = await request(preflightUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sidecar-caption-preflight-key-0001' },
    body: JSON.stringify({ base_revision: appliedBody.project.revision, base_variant_version_id: appliedBody.version.id }),
  })
  const preflightBody = await preflight.json() as { plan?: { id: string }; error?: string; message?: string }
  expect(preflight.status, JSON.stringify(preflightBody)).toBe(201)
  if (!preflightBody.plan) throw new Error('fixture preflight did not produce an execution plan')
  const afterPreflight = await service.getProject(created.id)
  const previewUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/preview`)
  const preview = await request(previewUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sidecar-caption-preview-key-0001' },
    body: JSON.stringify({ base_revision: afterPreflight.revision, base_variant_version_id: appliedBody.version.id }),
  })
  expect(preview.status).toBe(202)
  const previewTask = await preview.json() as { task: { id: string; result: { execution_plan_id: string } } }
  expect(previewTask.task.result.execution_plan_id).toBe(preflightBody.plan.id)
  expect((await waitForTerminalOperation(service, previewTask.task.id)).status).toBe('succeeded')
  const previewProject = await service.getProject(created.id)
  const previewArtifact = previewProject.preview?.sidecar_caption
  if (!previewProject.preview || !previewArtifact) throw new Error('fixture preview did not publish a sidecar caption')
  expect(previewArtifact).toMatchObject({ format: 'vtt', asset_path: `/api/videos/projects/${created.id}/previews/${previewProject.preview.asset_id}/sidecar` })
  const sidecarResponse = await request(new URL(`http://localhost${previewArtifact.asset_path}`))
  expect(sidecarResponse.status).toBe(200)
  expect(sidecarResponse.headers.get('content-type')).toContain('text/vtt')
  const previewSidecarText = await sidecarResponse.text()
  expect(previewSidecarText).toContain('WEBVTT')
  const previewSidecarPath = join(service.repository.paths().assets, created.id, `${previewProject.preview.asset_id}.vtt`)
  expect(await videoFingerprint(previewSidecarPath)).toBe(previewArtifact.content_hash)

  const outputPath = join(root, 'sidecar-preview-contract.mp4')
  const renderUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/render`)
  const render = await request(renderUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'sidecar-caption-render-key-0001' },
    body: JSON.stringify({ base_revision: previewProject.revision, base_variant_version_id: appliedBody.version.id, output_path: outputPath }),
  })
  expect(render.status).toBe(202)
  const renderTask = await render.json() as { task: { id: string; result: { execution_plan_id: string } } }
  expect(renderTask.task.result.execution_plan_id).toBe(preflightBody.plan.id)
  expect((await waitForTerminalOperation(service, renderTask.task.id)).status).toBe('succeeded')
  const formalSidecarPath = join(root, 'sidecar-preview-contract.vtt')
  expect(await readFile(formalSidecarPath, 'utf8')).toBe(previewSidecarText)
  expect(await videoFingerprint(formalSidecarPath)).toBe(previewArtifact.content_hash)
  service.repository.close()
})

test('预览任务中断后同时清理视频与 sidecar 临时文件', async () => {
  const root = await testRoot('sidecar-preview-recovery')
  const { service, created } = await seededService(root)
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const version = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const temporaryOutput = join(root, 'preview-recovery.partial.mp4')
  const temporarySidecar = join(root, 'preview-recovery.partial.srt')
  await Promise.all([writeFile(temporaryOutput, 'preview-bytes'), writeFile(temporarySidecar, 'sidecar-bytes')])
  const operation = await service.repository.saveOperation({
    schema_version: 1,
    id: 'task_preview_recovery_0001',
    project_id: created.id,
    kind: 'video.preview',
    status: 'running',
    progress: 50,
    stage: '模拟预览在字幕发布前中断',
    result: {
      preview_revision: project.revision,
      timeline_version_id: version.editorial_timeline_version_id,
      delivery_variant_version_id: version.id,
      execution_plan_id: 'execution_plan_preview_0001',
      asset_id: 'preview_recovery_0001',
      asset_path: `/api/videos/projects/${created.id}/previews/preview_recovery_0001/content`,
      temporary_output: temporaryOutput,
      temporary_sidecar_path: temporarySidecar,
    },
    created_at: at,
    updated_at: at,
  })
  await service.repository.saveProject({ ...project, preview_task_id: operation.id })
  await service.recoverInterruptedOperations()
  expect(await service.getOperation(operation.id)).toMatchObject({ status: 'failed' })
  expect((await service.getProject(created.id)).preview_task_id).toBeUndefined()
  expect(await Bun.file(temporaryOutput).exists()).toBeFalse()
  expect(await Bun.file(temporarySidecar).exists()).toBeFalse()
  service.repository.close()
})

test('音频条目拒绝构图 CommandSet，旧载荷在预检前也会失败关闭', async () => {
  const root = await testRoot('audio-transform-boundary')
  const { service, created } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = initial.delivery_variants[0]!
  const version = initial.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const timeline = initial.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)!
  const audioItem = timeline.items.find(item => item.kind === 'audio')!
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const commandsUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/commands`)
  const rejected = await request(commandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'audio-transform-command-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: version.id,
      commands: [{
        kind: 'set_transform_keyframes',
        item_id: audioItem.id,
        keyframes: [{ at: audioItem.timeline_range.start, value: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, interpolation: 'linear' }],
      }],
    }),
  })
  expect(rejected.status).toBe(400)
  expect(await rejected.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
  const afterRejected = await service.getProject(created.id)
  expect(afterRejected.delivery_variant_versions).toHaveLength(initial.delivery_variant_versions.length)
  expect(afterRejected.delivery_variants.find(candidate => candidate.id === variant.id)?.current_version_id).toBe(version.id)

  await service.repository.saveProject({
    ...afterRejected,
    delivery_variant_versions: afterRejected.delivery_variant_versions.map(candidate => candidate.id === version.id
      ? {
          ...candidate,
          item_overrides: [{
            item_id: audioItem.id,
            transform_keyframes: [{ at: audioItem.timeline_range.start, value: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, interpolation: 'linear' }],
          }],
        }
      : candidate),
    revision: afterRejected.revision + 1,
    updated_at: at,
  })
  const corrupted = await service.getProject(created.id)
  const preflight = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/preflight`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'audio-transform-preflight-key-0001' },
    body: JSON.stringify({ base_revision: corrupted.revision, base_variant_version_id: version.id }),
  })
  expect(preflight.status).toBe(400)
  expect(await preflight.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
  service.repository.close()
})

test('未显式选择音轨时，节拍 API 与正式 A/V 链使用同一条默认音轨', async () => {
  const root = await testRoot('beat-default-audio')
  const pcm = clickTrack(120, 8, 22_050)
  const decoded: Array<{ audioStreamIndex: number; startSeconds: number; durationSeconds: number }> = []
  const pcmDecoder: LocalPcmDecoder = input => {
    decoded.push({
      audioStreamIndex: input.audioStreamIndex,
      startSeconds: input.startSeconds,
      durationSeconds: input.durationSeconds,
    })
    return {
      chunks: oddChunks(new Uint8Array(pcm.buffer.slice(0))),
      completion: Promise.resolve({ exitCode: 0, stderr: '' }),
    }
  }
  const { service, created } = await seededService(root, { offsetAudio: true, pcmDecoder })
  const project = await service.getProject(created.id)
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/beat-analysis`)
  const response = await handler(new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'beat-default-audio-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ source_id: project.sources[0]!.id }),
  }), url, requestSegments(url))
  expect(response.status).toBe(202)
  const body = await response.json() as { task: { id: string } }
  const terminal = await waitForTerminalOperation(service, body.task.id)
  expect(terminal).toMatchObject({ status: 'succeeded', result: { audio_stream_index: 2 } })
  expect(decoded).toEqual([expect.objectContaining({ audioStreamIndex: 2, startSeconds: 0.5, durationSeconds: 10 })])
  service.repository.close()
})

test('同画幅也必须报告缺失主体证据，应用构图计划后预检要求人工决策', async () => {
  const root = await testRoot('composition-same-aspect-evidence')
  const { service, created } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = initial.delivery_variants[0]!
  const version = initial.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const profile = initial.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)!
  const timeline = initial.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)!
  const videoItem = timeline.items.find(item => item.kind === 'video')!
  const { content_hash: _ignored, ...withoutHash } = {
    ...profile,
    target: 'horizontal_video' as const,
    width: 1920,
    height: 1080,
  }
  const horizontalProfile = {
    ...withoutHash,
    content_hash: `sha256:${createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex')}` as const,
  }
  await service.repository.saveProject({
    ...initial,
    export_profile_revisions: initial.export_profile_revisions.map(candidate => candidate.id === profile.id ? horizontalProfile : candidate),
    delivery_variant_versions: initial.delivery_variant_versions.map(candidate => candidate.id === version.id
      ? { ...candidate, export_profile_hash: horizontalProfile.content_hash }
      : candidate),
    revision: initial.revision + 1,
    updated_at: at,
  })
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const composition = await request(new URL(`http://localhost/api/videos/projects/${created.id}/composition-plans`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-aspect-composition-key-0001' },
    body: JSON.stringify({ variant_id: variant.id, base_variant_version_id: version.id }),
  })
  expect(composition.status).toBe(201)
  const compositionBody = await composition.json() as { plan: { id: string; unresolved_ranges: Array<{ item_id: string; reason: string }> } }
  expect(compositionBody.plan.unresolved_ranges).toEqual(expect.arrayContaining([
    expect.objectContaining({ item_id: videoItem.id, reason: expect.stringContaining('缺少可信主体证据') }),
  ]))
  const applied = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/commands`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-aspect-apply-key-0001' },
    body: JSON.stringify({ base_variant_version_id: version.id, commands: [{ kind: 'set_composition_plan', composition_plan_id: compositionBody.plan.id }] }),
  })
  expect(applied.status).toBe(200)
  const appliedBody = await applied.json() as { project: { revision: number }; version: { id: string } }
  const preflight = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/preflight`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'same-aspect-preflight-key-0001' },
    body: JSON.stringify({ base_revision: appliedBody.project.revision, base_variant_version_id: appliedBody.version.id }),
  })
  expect(preflight.status).toBe(201)
  expect(await preflight.json()).toMatchObject({ report: { state: 'needs_user_decision' } })
  service.repository.close()
})

test('受管项目资产按哈希和许可进入多轨 ExecutionPlan，非法后渲染结果失败关闭', async () => {
  const root = await testRoot('assets-and-quality')
  const { service, created } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '资产混音交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'asset-variant-key-0001')
  const compiled = await service.compileDeliveryVariant(created.id, variant.variant.id)
  const project = await service.getProject(created.id)
  const musicId = 'asset_music_00000001'
  const brollId = 'asset_broll_00000001'
  const logoId = 'asset_logo_00000001'
  const musicPath = join(service.repository.paths().assets, created.id, 'music.mp3')
  const brollPath = join(service.repository.paths().assets, created.id, 'broll.mp4')
  const logoPath = join(service.repository.paths().assets, created.id, 'logo.png')
  await mkdir(dirname(musicPath), { recursive: true })
  await Promise.all([
    writeFile(musicPath, 'music'),
    writeFile(brollPath, 'broll'),
    writeFile(logoPath, 'logo'),
  ])
  const [musicHash, brollHash, logoHash] = await Promise.all([videoFingerprint(musicPath), videoFingerprint(brollPath), videoFingerprint(logoPath)])
  const base = structuredClone(compiled.plan) as VideoExecutionPlan
  const range = base.timeline_items[0]!.timeline_range
  const brollColor = {
    hdr_kind: 'sdr' as const,
    color_space: 'bt709',
    color_transfer: 'bt709',
    color_primaries: 'bt709',
    color_range: 'tv',
    pixel_format: 'yuv420p',
  }
  const enriched = await service.repository.saveProject({
    ...project,
    assets: [...project.assets,
      { id: musicId, role: 'source', version_id: 'version_music_00000001', storage: { kind: 'managed', locator: join(created.id, 'music.mp3') }, mime_type: 'audio/mpeg', content_hash: musicHash, byte_size: 5, created_at: at },
      { id: brollId, role: 'source', version_id: 'version_broll_00000001', storage: { kind: 'managed', locator: join(created.id, 'broll.mp4') }, mime_type: 'video/mp4', content_hash: brollHash, byte_size: 5, created_at: at },
      { id: logoId, role: 'source', version_id: 'version_logo_00000001', storage: { kind: 'managed', locator: join(created.id, 'logo.png') }, mime_type: 'image/png', content_hash: logoHash, byte_size: 4, created_at: at },
    ],
    video_asset_attestations: [
      {
        asset_id: musicId,
        provenance: 'licensed_library',
        license_attestation: 'test license',
        audio_stream: { stream_index: 0, start: range.start, duration: range.duration, sample_rate: 48_000, channels: 2 },
        approved_at: at,
      },
      {
        asset_id: brollId,
        provenance: 'licensed_library',
        license_attestation: 'test license',
        video_color: brollColor,
        video_stream: { stream_index: 2, start: range.start, duration: range.duration },
        approved_at: at,
      },
      { asset_id: logoId, provenance: 'brand_owned', license_attestation: 'test license', approved_at: at },
    ],
  })
  const plan = {
    ...base,
    timeline_items: [...base.timeline_items,
      { order: 20, item_id: 'item_music_00000001', track_id: 'track_music_00000001', track_kind: 'music', kind: 'audio', timeline_range: range, binding: { kind: 'project_asset', asset_id: musicId, asset_content_hash: musicHash } },
      { order: 21, item_id: 'item_broll_00000001', track_id: 'track_broll_00000001', track_kind: 'b_roll', kind: 'video', timeline_range: range, binding: { kind: 'project_asset', asset_id: brollId, asset_content_hash: brollHash } },
      { order: 22, item_id: 'item_logo_00000001', track_id: 'track_overlay_00000001', track_kind: 'overlay', kind: 'overlay', timeline_range: range, binding: { kind: 'project_asset', asset_id: logoId, asset_content_hash: logoHash } },
    ],
    inputs: [...base.inputs,
      {
        kind: 'project_asset',
        asset_id: musicId,
        asset_content_hash: musicHash,
        source_range: range,
        audio_stream_index: 0,
        audio_start: range.start,
        audio_duration: range.duration,
        audio_sample_rate: 48_000,
        audio_channels: 2,
      },
      {
        kind: 'project_asset',
        asset_id: brollId,
        asset_content_hash: brollHash,
        source_range: range,
        video_color: brollColor,
        video_stream_index: 2,
        video_start: range.start,
        video_duration: range.duration,
      },
      { kind: 'project_asset', asset_id: logoId, asset_content_hash: logoHash },
    ],
    audio_pipeline: { ...base.audio_pipeline, policy: 'music_with_source' as const },
    maps: [
      ...base.maps,
      { track_id: 'track_music_00000001', output: 'audio' as const },
      { track_id: 'track_broll_00000001', output: 'video' as const },
      { track_id: 'track_overlay_00000001', output: 'video' as const },
    ],
  } as VideoExecutionPlan
  const command = buildExecutionPlanRenderCommand('ffmpeg', enriched, plan, join(root, 'out.mp4'), undefined, {
    projectAssets: new Map([
      [musicId, { path: musicPath, content_hash: musicHash, mime_type: 'audio/mpeg' }],
      [brollId, { path: brollPath, content_hash: brollHash, mime_type: 'video/mp4' }],
      [logoId, { path: logoPath, content_hash: logoHash, mime_type: 'image/png' }],
    ]),
  })
  expect(command.join(' ')).toContain('amix=inputs=2')
  expect(command.join(' ')).toContain('overlay=')
  expect(command.join(' ')).toContain('[1:2]')
  expect(command).toEqual(expect.arrayContaining(['-loop', '1', logoPath]))
  const projectAssets = new Map([
    [musicId, { path: musicPath, content_hash: musicHash, mime_type: 'audio/mpeg' }],
    [brollId, { path: brollPath, content_hash: brollHash, mime_type: 'video/mp4' }],
    [logoId, { path: logoPath, content_hash: logoHash, mime_type: 'image/png' }],
  ])
  const unknownBroll = structuredClone(plan) as VideoExecutionPlan
  unknownBroll.inputs = unknownBroll.inputs.map(input => input.kind === 'project_asset' && input.asset_id === brollId
    ? { ...input, video_color: { hdr_kind: 'unknown' as const } }
    : input)
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', enriched, unknownBroll, join(root, 'unknown-broll.mp4'), undefined, { projectAssets }))
    .toThrow('颜色特征')
  const outOfBoundsBroll = structuredClone(plan) as VideoExecutionPlan
  outOfBoundsBroll.inputs = outOfBoundsBroll.inputs.map(input => input.kind === 'project_asset' && input.asset_id === brollId
    ? { ...input, video_duration: { ...range.duration, ticks: (BigInt(range.duration.ticks) - 1n).toString() } }
    : input)
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', enriched, outOfBoundsBroll, join(root, 'out-of-bounds-broll.mp4'), undefined, { projectAssets }))
    .toThrow('超出冻结的视频流边界')
  const editor = new FinishingDeliveryApplication(() => new Date(at))
  const timeline = enriched.editorial_timeline_versions.find(item => item.id === variant.version.editorial_timeline_version_id)!
  const profile = enriched.export_profile_revisions.find(item => item.id === variant.version.export_profile_revision_id)!
  const blocked = editor.createPostRenderReport({
    project: enriched,
    version: variant.version,
    timeline,
    profile,
    executionPlanId: plan.id,
    output: {
      timeline_version_id: timeline.id,
      delivery_variant_version_id: variant.version.id,
      execution_plan_id: plan.id,
      byte_size: 1,
      duration_ms: 10_000,
      video_stream_count: 1,
      audio_stream_count: 1,
      width: profile.width,
      height: profile.height,
      container: profile.encoding.container,
      video_codec: profile.encoding.video.codec,
      audio_codec: profile.encoding.audio.codec,
      pixel_format: profile.encoding.output_color.pixel_format,
      color_range: profile.encoding.output_color.range,
      decoded: false,
      packet_timestamps_monotonic: false,
      expected_duration_ms: 10_000,
      duration_delta_ms: 500,
      audio_video_duration_delta_ms: 500,
      content_hash: `sha256:${'f'.repeat(64)}`,
      verified_at: at,
    },
  })
  expect(blocked).toMatchObject({ state: 'blocked' })
  expect(blocked.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'decode_scan', state: 'blocked' }),
    expect.objectContaining({ code: 'packet_timestamps', state: 'blocked' }),
  ]))
  const wrongFps = editor.createPostRenderReport({
    project: enriched,
    version: variant.version,
    timeline,
    profile,
    executionPlanId: plan.id,
    output: {
      timeline_version_id: timeline.id,
      delivery_variant_version_id: variant.version.id,
      execution_plan_id: plan.id,
      byte_size: 1,
      duration_ms: 10_000,
      video_stream_count: 1,
      audio_stream_count: 1,
      width: profile.width,
      height: profile.height,
      fps: 24,
      container: profile.encoding.container,
      video_codec: profile.encoding.video.codec,
      audio_codec: profile.encoding.audio.codec,
      pixel_format: profile.encoding.output_color.pixel_format,
      color_range: profile.encoding.output_color.range,
      decoded: true,
      packet_timestamps_monotonic: true,
      expected_duration_ms: 10_000,
      duration_delta_ms: 0,
      audio_video_duration_delta_ms: 0,
      content_hash: `sha256:${'e'.repeat(64)}`,
      verified_at: at,
    },
  })
  expect(wrongFps.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'profile_integrity', state: 'blocked' }),
  ]))
  service.repository.close()
})

test('主体轨迹、BeatGrid、构图和音频计划经 API 落入同一冻结 Variant ExecutionPlan', async () => {
  const root = await testRoot('finishing-api-chain')
  const pcm = clickTrack(120, 8, 22_050)
  const pcmDecoder: LocalPcmDecoder = () => ({
    chunks: oddChunks(new Uint8Array(pcm.buffer.slice(0))),
    completion: Promise.resolve({ exitCode: 0, stderr: '' }),
  })
  const { service, created, commands } = await seededService(root, { pcmDecoder })
  const before = await service.getProject(created.id)
  const source = before.sources[0]!
  const sourceFact = await service.repository.getFact('source', source.id) as VideoFactSource & { fingerprint: `sha256:${string}` }
  await service.repository.saveFact({
    id: 'transcript_00000003',
    project_id: created.id,
    source_id: source.id,
    source_fingerprint: source.fingerprint!,
    model_receipt_id: 'receipt_00000003',
    source_offset: rationalTime('0', { num: 1_000, den: 1 }),
    language: 'zh',
    segments: [{
      id: 'segment_00000003',
      source_id: source.id,
      start: rationalTime('3000', { num: 1_000, den: 1 }),
      duration: rationalTime('3000', { num: 1_000, den: 1 }),
      text: '嗯',
      words: [],
    }],
    created_at: at,
  })
  const subjectId = 'subject_00000001'
  for (const [index, start, box] of [
    [1, 0, [0.12, 0.20, 0.42, 0.80]],
    [2, 300, [0.24, 0.20, 0.54, 0.80]],
    [3, 600, [0.36, 0.20, 0.66, 0.80]],
  ] as const) {
    await service.repository.saveFact(createHostedEvidence({
      id: `evidence_object_${String(index).padStart(8, '0')}`,
      kind: 'object',
      projectId: created.id,
      source: sourceFact,
      range: sourceTimeRange(rationalTime(String(start), { num: 1_000, den: 1 }), rationalTime('100', { num: 1_000, den: 1 })),
      payload: { label: '主持人', subject_id: subjectId, normalized_box: box },
      promptVersion: 'fixture-object-v1',
      createdAt: at,
      confidence: 0.92,
    }))
  }
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const subjectUrl = new URL(`http://localhost/api/videos/projects/${created.id}/subject-tracks`)
  const tracked = await request(subjectUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'subject-track-api-key-0001' },
    body: JSON.stringify({ source_id: source.id, subject_id: subjectId }),
  })
  expect(tracked.status).toBe(201)
  const trackedBody = await tracked.json() as { evidence: { id: string }; task: { kind: string; status: string } }
  expect(trackedBody.task).toMatchObject({ kind: 'video.subject_track', status: 'succeeded' })
  const subjectTrack = (await service.repository.getFact('evidence', trackedBody.evidence.id)) as Extract<import('../src/server/video/domain/mediaFacts/model.js').VideoFactEvidence, { kind: 'subject_track' }>
  expect(subjectTrack.payload.points.filter(point => point.source === 'local_track')).toHaveLength(2)
  expect(subjectTrack.payload.unresolved_ranges.some(range => range.reason === 'left_frame')).toBeTrue()
  const outOfBounds = await request(subjectUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'subject-track-api-key-0002' },
    body: JSON.stringify({
      source_id: source.id,
      subject_id: subjectId,
      source_range: { start: { ticks: '9999', tick_rate: { num: 1_000, den: 1 } }, duration: { ticks: '2', tick_rate: { num: 1_000, den: 1 } } },
    }),
  })
  expect(outOfBounds.status).toBe(422)

  const beatUrl = new URL(`http://localhost/api/videos/projects/${created.id}/beat-analysis`)
  const beat = await request(beatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'beat-analysis-api-key-0001' },
    body: JSON.stringify({ source_id: source.id }),
  })
  expect(beat.status).toBe(202)
  const beatBody = await beat.json() as { task: { id: string } }
  const beatTerminal = await waitForTerminalOperation(service, beatBody.task.id)
  expect(beatTerminal).toMatchObject({ status: 'succeeded', result: { confidence: expect.any(Number) } })
  const beatEvidenceId = String(beatTerminal.result?.evidence_id)
  const grid = (await service.repository.getFact('evidence', beatEvidenceId)) as Extract<import('../src/server/video/domain/mediaFacts/model.js').VideoFactEvidence, { kind: 'beat_grid' }>
  expect(grid.payload).toMatchObject({ analyzer_version: 'local-energy-v2', sample_rate: 22_050, created_by_operation_id: beatBody.task.id })
  expect(grid.payload.coverage[0]?.duration.ticks).toBe(String(8_000))
  const cachedBeat = await request(beatUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'beat-analysis-api-key-0002' },
    body: JSON.stringify({ source_id: source.id }),
  })
  expect(cachedBeat.status).toBe(202)
  expect(await cachedBeat.json()).toMatchObject({ task: { status: 'succeeded', result: { evidence_id: beatEvidenceId } } })

  const afterTracking = await service.getProject(created.id)
  const variant = afterTracking.delivery_variants[0]!
  const initialVersion = afterTracking.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const compositionUrl = new URL(`http://localhost/api/videos/projects/${created.id}/composition-plans`)
  const composition = await request(compositionUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'composition-api-key-0001' },
    body: JSON.stringify({ variant_id: variant.id, base_variant_version_id: initialVersion.id }),
  })
  expect(composition.status).toBe(201)
  const compositionBody = await composition.json() as { plan: { id: string; proposed_commands: Array<{ kind: string; keyframes?: unknown[] }>; unresolved_ranges: Array<{ item_id: string; reason: string }> } }
  // The source tracker explicitly reports a long tail without coverage. A
  // transform keyframe would be held through that tail, so the composition
  // plan must leave the item untouched and surface the decision instead.
  expect(compositionBody.plan.proposed_commands.some(command => command.kind === 'set_transform_keyframes')).toBeFalse()
  expect(compositionBody.plan.unresolved_ranges).toEqual(expect.arrayContaining([
    expect.objectContaining({ reason: expect.stringContaining('主体轨迹未解决') }),
  ]))
  const variantCommandsUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/commands`)
  const appliedComposition = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'apply-composition-api-key-0001' },
    body: JSON.stringify({ base_variant_version_id: initialVersion.id, commands: [{ kind: 'set_composition_plan', composition_plan_id: compositionBody.plan.id }] }),
  })
  expect(appliedComposition.status).toBe(200)
  const appliedCompositionBody = await appliedComposition.json() as { version: { id: string } }

  const audioUrl = new URL(`http://localhost/api/videos/projects/${created.id}/audio-finishing-plans`)
  const audio = await request(audioUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'audio-plan-api-key-0001' },
    body: JSON.stringify({ variant_id: variant.id, base_variant_version_id: appliedCompositionBody.version.id }),
  })
  expect(audio.status).toBe(201)
  const audioBody = await audio.json() as { plan: {
    id: string
    measured_loudness: unknown[]
    proposed_commands: Array<{ kind: string }>
    semantic_cut_suggestions: Array<{ kind: string; transcript_anchor_ids: string[] }>
    semantic_cut_not_recommended: Array<{ kind: string }>
  } }
  expect(audioBody.plan.measured_loudness).toHaveLength(1)
  expect(audioBody.plan.proposed_commands.some(command => command.kind === 'set_volume_keyframes')).toBeTrue()
  expect(audioBody.plan.proposed_commands.some(command => command.kind === 'set_audio_denoise')).toBeTrue()
  expect(audioBody.plan.semantic_cut_suggestions).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'silence', transcript_anchor_ids: ['segment_00000003'] }),
    expect.objectContaining({ kind: 'filler', transcript_anchor_ids: ['segment_00000003'] }),
  ]))
  expect(audioBody.plan.semantic_cut_not_recommended).toEqual([])
  const appliedAudio = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'apply-audio-api-key-0001' },
    body: JSON.stringify({ base_variant_version_id: appliedCompositionBody.version.id, commands: [{ kind: 'set_audio_finishing_plan', audio_finishing_plan_id: audioBody.plan.id }] }),
  })
  expect(appliedAudio.status).toBe(200)
  const appliedAudioBody = await appliedAudio.json() as { version: { id: string } }
  const currentTimeline = (await service.getProject(created.id)).editorial_timeline_versions.find(candidate => candidate.id === initialVersion.editorial_timeline_version_id)!
  const sourceAudio = currentTimeline.items.find(item => item.kind === 'audio' && item.track_id === currentTimeline.tracks.find(track => track.kind === 'source_audio')?.id)!
  const manualAudio = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'manual-audio-wins-api-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: appliedAudioBody.version.id,
      commands: [{ kind: 'set_volume_keyframes', item_id: sourceAudio.id, keyframes: [{ at: sourceAudio.timeline_range.start, value: 0.5, interpolation: 'linear' }] }],
    }),
  })
  expect(manualAudio.status).toBe(200)
  const compiled = await service.compileDeliveryVariant(created.id, variant.id)
  const transform = compiled.plan.filters.find(filter => filter.kind === 'transform')
  const volume = compiled.plan.filters.find(filter => filter.kind === 'volume')
  const denoise = compiled.plan.filters.find(filter => filter.kind === 'audio_denoise')
  expect(transform).toBeUndefined()
  expect(volume).toMatchObject({ item_id: sourceAudio.id, keyframes: [{ value: 0.5 }] })
  expect(denoise).toMatchObject({ item_id: sourceAudio.id, noise_reduction_db: 6 })
  const renderCommand = buildExecutionPlanRenderCommand('ffmpeg', await service.getProject(created.id), compiled.plan, join(root, 'effective-plan.mp4'))
  expect(renderCommand.join(' ')).toContain('afftdn=nr=6.00:nf=-45:tn=1')
  expect(commands.some(command => command.some(part => part.includes('ebur128')))).toBeTrue()
  service.repository.close()
})

test('构图计划不会变换锁定条目或锁定轨道，旧计划应用也会被拒绝', async () => {
  const root = await testRoot('composition-locks')
  const { service, created } = await seededService(root)
  const original = await service.getProject(created.id)
  const variant = original.delivery_variants[0]!
  const version = original.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const timeline = original.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)!
  const videoItem = timeline.items.find(item => item.kind === 'video')!
  const videoTrack = timeline.tracks.find(track => track.id === videoItem.track_id)!

  await service.repository.saveProject({
    ...original,
    editorial_timeline_versions: original.editorial_timeline_versions.map(candidate => candidate.id === timeline.id
      ? { ...candidate, items: candidate.items.map(item => item.id === videoItem.id ? { ...item, locked: true } : item) }
      : candidate),
    revision: original.revision + 1,
    updated_at: at,
  })
  const itemLocked = await service.createCompositionPlan(created.id, {
    variant_id: variant.id,
    base_variant_version_id: version.id,
  }, 'composition-locked-item-key-0001')
  expect(itemLocked.plan.proposed_commands.some(command => command.kind === 'set_transform_keyframes')).toBeFalse()
  expect(itemLocked.plan.unresolved_ranges).toEqual(expect.arrayContaining([
    expect.objectContaining({ item_id: videoItem.id, reason: expect.stringContaining('条目已锁定') }),
  ]))

  const afterItemLock = await service.getProject(created.id)
  await service.repository.saveProject({
    ...afterItemLock,
    editorial_timeline_versions: afterItemLock.editorial_timeline_versions.map(candidate => candidate.id === timeline.id
      ? {
          ...candidate,
          tracks: candidate.tracks.map(track => track.id === videoTrack.id ? { ...track, locked: true } : track),
          items: candidate.items.map(item => item.id === videoItem.id ? { ...item, locked: false } : item),
        }
      : candidate),
    revision: afterItemLock.revision + 1,
    updated_at: at,
  })
  const trackLocked = await service.createCompositionPlan(created.id, {
    variant_id: variant.id,
    base_variant_version_id: version.id,
  }, 'composition-locked-track-key-0001')
  expect(trackLocked.plan.proposed_commands.some(command => command.kind === 'set_transform_keyframes')).toBeFalse()
  expect(trackLocked.plan.unresolved_ranges).toEqual(expect.arrayContaining([
    expect.objectContaining({ item_id: videoItem.id, reason: expect.stringContaining('轨道已锁定') }),
  ]))

  const afterTrackLock = await service.getProject(created.id)
  const forgedPlanId = 'composition_plan_locked_0001'
  const forgedPlan = videoCompositionPlanSchema.parse({
    ...trackLocked.plan,
    id: forgedPlanId,
    proposed_commands: [
      { kind: 'set_composition_plan', composition_plan_id: forgedPlanId },
      {
        kind: 'set_transform_keyframes',
        item_id: videoItem.id,
        keyframes: [{
          at: videoItem.timeline_range.start,
          value: { x: 0, y: 0, scale: 1.06, rotation: 0, opacity: 1 },
          interpolation: 'linear',
        }],
      },
    ],
  })
  await service.repository.saveProject({
    ...afterTrackLock,
    composition_plans: [...afterTrackLock.composition_plans, forgedPlan],
    revision: afterTrackLock.revision + 1,
    updated_at: at,
  })
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const rejected = await request(new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/commands`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'apply-locked-composition-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: version.id,
      commands: [{ kind: 'set_composition_plan', composition_plan_id: forgedPlanId }],
    }),
  })
  expect(rejected.status).toBe(409)
  service.repository.close()
})

test('稀疏 object 事实必须留下未覆盖范围，不能用关键帧静默重构整段画面', async () => {
  const root = await testRoot('composition-sparse-object')
  const { service, created } = await seededService(root)
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const version = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const timeline = project.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)!
  const videoItem = timeline.items.find(item => item.kind === 'video')!
  const source = project.sources[0]!
  const loadedSource = await service.repository.getFact('source', source.id)
  if (!('fast_identity' in loadedSource) || !loadedSource.fingerprint) throw new Error('fixture source fact must be ready')
  await service.repository.saveFact(createHostedEvidence({
    id: 'evidence_sparse_object_0001',
    kind: 'object',
    projectId: created.id,
    source: loadedSource as VideoFactSource & { fingerprint: `sha256:${string}` },
    range: sourceTimeRange(rationalTime('0', { num: 1_000, den: 1 }), rationalTime('100', { num: 1_000, den: 1 })),
    payload: {
      label: '主持人',
      subject_id: 'subject_sparse_00000001',
      normalized_box: [0.2, 0.2, 0.6, 0.8],
    },
    promptVersion: 'fixture-sparse-object-v1',
    createdAt: at,
    confidence: 0.95,
  }))
  const planned = await service.createCompositionPlan(created.id, {
    variant_id: variant.id,
    base_variant_version_id: version.id,
  }, 'composition-sparse-object-key-0001')
  expect(planned.plan.proposed_commands.some(command => command.kind === 'set_transform_keyframes')).toBeFalse()
  const gap = planned.plan.unresolved_ranges.find(range => range.item_id === videoItem.id && range.reason.includes('主体事实覆盖不足'))
  expect(gap).toBeDefined()
  expect(gap?.range).toMatchObject({ start: { ticks: '9000' }, duration: { ticks: '891000' } })
  service.repository.close()
})

test('音频完成计划只建议带 Transcript 锚点的语义剪辑，并将保守降噪和音乐 ducking 编译为实际滤镜', async () => {
  const root = await testRoot('audio-finishing-contract')
  const { service, created } = await seededService(root)
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const version = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const baseTimeline = project.editorial_timeline_versions.find(candidate => candidate.id === version.editorial_timeline_version_id)!
  const sourceAudio = baseTimeline.items.find(item => item.kind === 'audio'
    && item.track_id === baseTimeline.tracks.find(track => track.kind === 'source_audio')?.id)!
  const musicTrack = { id: 'track_music_00000001', kind: 'music' as const, order: 2, locked: false, muted: false }
  const musicItem = {
    id: 'item_music_00000001',
    track_id: musicTrack.id,
    kind: 'audio' as const,
    timeline_range: structuredClone(sourceAudio.timeline_range),
    binding: { kind: 'project_asset' as const, asset_id: 'asset_music_00000001', asset_content_hash: `sha256:${'a'.repeat(64)}` as const },
    linked_camera_shot_ids: [],
    linked_content_segment_ids: [],
    locked: false,
    evidence_ids: [],
  }
  const timeline = {
    ...structuredClone(baseTimeline),
    tracks: [...baseTimeline.tracks, musicTrack],
    items: [...baseTimeline.items, musicItem],
  }
  const silenceRange = sourceTimeRange(rationalTime('3000', { num: 1_000, den: 1 }), rationalTime('3000', { num: 1_000, den: 1 }))
  const measurement = {
    item_id: sourceAudio.id,
    source_id: project.sources[0]!.id,
    audio_stream_index: 1,
    integrated_lufs: -24,
    true_peak_db: -3,
    silence_ratio: 0.3,
    silence_ranges: [silenceRange],
    source_range: structuredClone(sourceAudio.binding.kind === 'source' ? sourceAudio.binding.source_range : silenceRange),
    receipt_id: 'audio_receipt_00000001',
  }
  const finishing = new FinishingDeliveryApplication(() => new Date(at))
  const noAnchor = finishing.createAudioFinishingPlan(project, variant, version, timeline, [measurement])
  expect(noAnchor.semantic_cut_suggestions).toEqual([])
  expect(noAnchor.semantic_cut_not_recommended).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'silence' }),
    expect.objectContaining({ kind: 'filler' }),
  ]))
  const legacyUnanchored = videoAudioFinishingPlanSchema.parse({
    ...noAnchor,
    semantic_cut_suggestions: [{
      source_id: measurement.source_id,
      range: silenceRange,
      kind: 'silence',
      transcript_anchor_ids: [],
    }],
    semantic_cut_not_recommended: [],
  })
  expect(legacyUnanchored.semantic_cut_suggestions).toEqual([])
  expect(legacyUnanchored.semantic_cut_not_recommended).toEqual([expect.objectContaining({ kind: 'silence' })])

  const musicProject = {
    ...project,
    export_profile_revisions: project.export_profile_revisions.map(profile => profile.id === version.export_profile_revision_id
      ? { ...profile, audio_policy: 'music_with_source' as const }
      : profile),
  }
  const anchored = finishing.createAudioFinishingPlan(musicProject, variant, version, timeline, [measurement], [{
    transcript_id: 'transcript_00000004',
    source_id: project.sources[0]!.id,
    source_range: silenceRange,
    transcript_anchor_ids: ['segment_00000004'],
    text: '嗯',
  }])
  expect(anchored.semantic_cut_suggestions).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'silence', transcript_anchor_ids: ['segment_00000004'] }),
    expect.objectContaining({ kind: 'filler', transcript_anchor_ids: ['segment_00000004'] }),
  ]))
  expect(anchored.ducking).toEqual([expect.objectContaining({
    music_item_id: musicItem.id,
    speech_transcript_anchor_ids: ['segment_00000004'],
    duck_gain: 0.35,
  })])
  const lockedMusicTimeline = {
    ...timeline,
    items: timeline.items.map(item => item.id === musicItem.id ? { ...item, locked: true } : item),
  }
  const lockedMusic = finishing.createAudioFinishingPlan(musicProject, variant, version, lockedMusicTimeline, [measurement], [{
    transcript_id: 'transcript_00000004',
    source_id: project.sources[0]!.id,
    source_range: silenceRange,
    transcript_anchor_ids: ['segment_00000004'],
    text: '嗯',
  }])
  expect(lockedMusic.ducking).toEqual([])
  expect(lockedMusic.proposed_commands.some(command => ('item_id' in command) && command.item_id === musicItem.id)).toBeFalse()

  const compiled = await service.compileDeliveryVariant(created.id, variant.id)
  const execution = structuredClone(compiled.plan) as VideoExecutionPlan
  execution.timeline_items = [...execution.timeline_items, {
    order: execution.timeline_items.length,
    item_id: musicItem.id,
    track_id: musicTrack.id,
    track_kind: 'music',
    kind: 'audio',
    timeline_range: musicItem.timeline_range,
    binding: musicItem.binding,
  }]
  execution.maps = [...execution.maps, { track_id: musicTrack.id, output: 'audio' }]
  execution.inputs = [...execution.inputs, {
    kind: 'project_asset',
    asset_id: musicItem.binding.asset_id,
    asset_content_hash: musicItem.binding.asset_content_hash,
    source_range: musicItem.timeline_range,
    audio_stream_index: 0,
    audio_start: musicItem.timeline_range.start,
    audio_duration: musicItem.timeline_range.duration,
    audio_sample_rate: 48_000,
    audio_channels: 2,
  }]
  execution.filters = [
    ...execution.filters,
    ...anchored.proposed_commands.flatMap(command => command.kind === 'set_audio_denoise'
      ? [{ kind: 'audio_denoise' as const, item_id: command.item_id, noise_reduction_db: command.noise_reduction_db }]
      : command.kind === 'set_volume_keyframes'
        ? [{ kind: 'volume' as const, item_id: command.item_id, keyframes: command.keyframes }]
        : []),
  ]
  execution.audio_pipeline = { ...execution.audio_pipeline, policy: 'music_with_source' }
  const command = buildExecutionPlanRenderCommand('ffmpeg', project, execution, join(root, 'audio-finished.mp4'), undefined, {
    projectAssets: new Map([[
      musicItem.binding.asset_id,
      { path: join(root, 'music.mp3'), content_hash: musicItem.binding.asset_content_hash, mime_type: 'audio/mpeg' },
    ]]),
  })
  expect(command.join(' ')).toContain('afftdn=nr=6.00:nf=-45:tn=1')
  expect(command.join(' ')).toContain('0.35')
  service.repository.close()
})

test('锁定音频拒绝外部覆盖和旧完成计划，冻结静音轨不会被误报为异常', async () => {
  const root = await testRoot('audio-locks-and-intentional-silence')
  const { service, created } = await seededService(root)
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const postVariantCommands = async (
    variantId: string,
    baseVariantVersionId: string,
    commands: readonly unknown[],
    idempotencyKey: string,
  ) => {
    const url = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variantId}/commands`)
    return await handler(new Request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        [MEDIA_UI_CAPABILITY_HEADER]: capability,
      },
      body: JSON.stringify({ base_variant_version_id: baseVariantVersionId, commands }),
    }), url, requestSegments(url))
  }
  const initial = await service.getProject(created.id)
  const baseTimeline = initial.editorial_timeline_versions.find(candidate => candidate.id === initial.current_editorial_timeline_version_id)!
  const sourceAudioTrack = baseTimeline.tracks.find(track => track.kind === 'source_audio')!
  const sourceAudio = baseTimeline.items.find(item => item.kind === 'audio' && item.track_id === sourceAudioTrack.id)!

  const itemLockedTimeline = await service.applyEditorialTimelineCommands(created.id, {
    base_timeline_version_id: baseTimeline.id,
    commands: [{ kind: 'lock', item_ids: [sourceAudio.id], locked: true }],
  }, 'audio-lock-item-timeline-key-0001')
  const itemLockedVariant = await service.createDeliveryVariant(created.id, {
    name: '锁定音频条目交付',
    editorial_timeline_version_id: itemLockedTimeline.version.id,
  }, 'audio-lock-item-variant-key-0001')
  for (const [command, idempotencyKey] of [
    [{ kind: 'set_volume_keyframes', item_id: sourceAudio.id, keyframes: [{ at: sourceAudio.timeline_range.start, value: 0.5, interpolation: 'linear' }] }, 'audio-lock-volume-key-0001'],
    [{ kind: 'set_audio_denoise', item_id: sourceAudio.id, noise_reduction_db: 6 }, 'audio-lock-denoise-key-0001'],
  ] as const) {
    const rejected = await postVariantCommands(itemLockedVariant.variant.id, itemLockedVariant.version.id, [command], idempotencyKey)
    expect(rejected.status).toBe(409)
  }
  const itemLockedPlan = await service.createAudioFinishingPlan(created.id, {
    variant_id: itemLockedVariant.variant.id,
    base_variant_version_id: itemLockedVariant.version.id,
  }, 'audio-lock-item-plan-key-0001')
  expect(itemLockedPlan.plan.proposed_commands.some(command => command.kind === 'set_volume_keyframes' || command.kind === 'set_audio_denoise' || command.kind === 'set_audio_fades')).toBeFalse()

  const trackLockedTimeline = await service.applyEditorialTimelineCommands(created.id, {
    base_timeline_version_id: itemLockedTimeline.version.id,
    commands: [
      { kind: 'lock', item_ids: [sourceAudio.id], locked: false },
      { kind: 'set_track_state', track_id: sourceAudioTrack.id, locked: true },
    ],
  }, 'audio-lock-track-timeline-key-0001')
  const trackLockedVariant = await service.createDeliveryVariant(created.id, {
    name: '锁定音频轨交付',
    editorial_timeline_version_id: trackLockedTimeline.version.id,
  }, 'audio-lock-track-variant-key-0001')
  const rejectedFade = await postVariantCommands(trackLockedVariant.variant.id, trackLockedVariant.version.id, [
    { kind: 'set_audio_fades', item_id: sourceAudio.id, fade_in: { ticks: '1000', tick_rate: { num: 1_000, den: 1 } } },
  ], 'audio-lock-fade-key-0001')
  expect(rejectedFade.status).toBe(409)
  const trackLockedPlan = await service.createAudioFinishingPlan(created.id, {
    variant_id: trackLockedVariant.variant.id,
    base_variant_version_id: trackLockedVariant.version.id,
  }, 'audio-lock-track-plan-key-0001')
  expect(trackLockedPlan.plan.proposed_commands.some(command => command.kind === 'set_volume_keyframes' || command.kind === 'set_audio_denoise' || command.kind === 'set_audio_fades')).toBeFalse()

  const projectWithPlan = await service.getProject(created.id)
  const forgedPlanId = 'audio_plan_locked_00000001'
  const forgedPlan = videoAudioFinishingPlanSchema.parse({
    ...trackLockedPlan.plan,
    id: forgedPlanId,
    proposed_commands: [
      { kind: 'set_audio_finishing_plan', audio_finishing_plan_id: forgedPlanId },
      { kind: 'set_audio_denoise', item_id: sourceAudio.id, noise_reduction_db: 6 },
    ],
  })
  await service.repository.saveProject({
    ...projectWithPlan,
    audio_finishing_plans: [...projectWithPlan.audio_finishing_plans, forgedPlan],
    revision: projectWithPlan.revision + 1,
    updated_at: at,
  })
  const rejectedForgedPlan = await postVariantCommands(trackLockedVariant.variant.id, trackLockedVariant.version.id, [
    { kind: 'set_audio_finishing_plan', audio_finishing_plan_id: forgedPlanId },
  ], 'audio-lock-forged-plan-key-0001')
  expect(rejectedForgedPlan.status).toBe(409)

  const mutedTimeline = await service.applyEditorialTimelineCommands(created.id, {
    base_timeline_version_id: trackLockedTimeline.version.id,
    commands: [{ kind: 'set_track_state', track_id: sourceAudioTrack.id, locked: false, muted: true }],
  }, 'audio-muted-timeline-key-0001')
  const mutedVariant = await service.createDeliveryVariant(created.id, {
    name: '有意静音交付',
    editorial_timeline_version_id: mutedTimeline.version.id,
  }, 'audio-muted-variant-key-0001')
  const compiled = await service.compileDeliveryVariant(created.id, mutedVariant.variant.id)
  expect(compiled.plan.timeline_items.some(item => item.kind === 'audio')).toBeFalse()
  const compiledVersion = compiled.project.delivery_variant_versions.find(candidate => candidate.id === mutedVariant.version.id)!
  const compiledTimeline = compiled.project.editorial_timeline_versions.find(candidate => candidate.id === mutedTimeline.version.id)!
  const compiledProfile = compiled.project.export_profile_revisions.find(candidate => candidate.id === compiledVersion.export_profile_revision_id)!
  const report = new FinishingDeliveryApplication(() => new Date(at)).createPostRenderReport({
    project: compiled.project,
    version: compiledVersion,
    timeline: compiledTimeline,
    profile: compiledProfile,
    executionPlanId: compiled.plan.id,
    output: {
      timeline_version_id: compiledTimeline.id,
      delivery_variant_version_id: compiledVersion.id,
      execution_plan_id: compiled.plan.id,
      byte_size: 123,
      duration_ms: 10_000,
      video_stream_count: 1,
      audio_stream_count: 1,
      width: compiledProfile.width,
      height: compiledProfile.height,
      fps: compiledProfile.frame_rate.num / compiledProfile.frame_rate.den,
      container: compiledProfile.encoding.container,
      video_codec: compiledProfile.encoding.video.codec,
      audio_codec: compiledProfile.encoding.audio.codec,
      pixel_format: compiledProfile.encoding.output_color.pixel_format,
      color_range: compiledProfile.encoding.output_color.range,
      decoded: true,
      packet_timestamps_monotonic: true,
      expected_duration_ms: 10_000,
      duration_delta_ms: 0,
      audio_video_duration_delta_ms: 0,
      black_duration_ms: 0,
      black_ratio: 0,
      silence_duration_ms: 10_000,
      silence_ratio: 1,
      content_hash: `sha256:${'c'.repeat(64)}`,
      verified_at: at,
    },
  })
  expect(report.state).toBe('passed')
  expect(report.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'silence_scan', state: 'passed', message: expect.stringContaining('冻结 ExecutionPlan') }),
  ]))
  service.repository.close()
})

test('短且后置的 music_only 轨道显式补前后静音，正式音频时长始终覆盖视频', async () => {
  const root = await testRoot('sparse-music-padding')
  const { service, created } = await seededService(root)
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const compiled = await service.compileDeliveryVariant(created.id, variant.id)
  const base = structuredClone(compiled.plan) as VideoExecutionPlan
  const mainVideo = base.timeline_items.find(item => item.kind === 'video')!
  const mainAudio = base.timeline_items.find(item => item.kind === 'audio')!
  const musicId = 'asset_music_00000002'
  const musicPath = join(root, 'late-music.mp3')
  await writeFile(musicPath, 'late music bytes')
  const musicHash = await videoFingerprint(musicPath)
  const fullTicks = BigInt(mainVideo.timeline_range.duration.ticks)
  const musicRange = {
    start: { ...mainVideo.timeline_range.start, ticks: (BigInt(mainVideo.timeline_range.start.ticks) + fullTicks * 3n / 5n).toString() },
    duration: { ...mainVideo.timeline_range.duration, ticks: (fullTicks / 5n).toString() },
  }
  const musicSourceRange = {
    start: { ...mainVideo.timeline_range.start, ticks: '0' },
    duration: musicRange.duration,
  }
  const withMusic = {
    ...project,
    assets: [...project.assets, {
      id: musicId,
      role: 'source' as const,
      version_id: 'version_music_00000002',
      storage: { kind: 'managed' as const, locator: join(created.id, 'late-music.mp3') },
      mime_type: 'audio/mpeg',
      content_hash: musicHash,
      byte_size: 16,
      created_at: at,
    }],
    video_asset_attestations: [...project.video_asset_attestations, {
      asset_id: musicId,
      provenance: 'licensed_library' as const,
      license_attestation: 'test music license',
      audio_stream: { stream_index: 0, start: musicSourceRange.start, duration: musicSourceRange.duration, sample_rate: 48_000, channels: 2 },
      approved_at: at,
    }],
  }
  const plan = {
    ...base,
    timeline_items: [
      mainVideo,
      {
        order: mainAudio.order,
        item_id: 'item_music_00000002',
        track_id: 'track_music_00000002',
        track_kind: 'music' as const,
        kind: 'audio' as const,
        timeline_range: musicRange,
        binding: { kind: 'project_asset' as const, asset_id: musicId, asset_content_hash: musicHash },
      },
    ],
    inputs: [...base.inputs, {
      kind: 'project_asset' as const,
      asset_id: musicId,
      asset_content_hash: musicHash,
      source_range: musicSourceRange,
      audio_stream_index: 0,
      audio_start: musicSourceRange.start,
      audio_duration: musicSourceRange.duration,
      audio_sample_rate: 48_000,
      audio_channels: 2,
    }],
    audio_pipeline: { ...base.audio_pipeline, policy: 'music_only' as const },
    maps: [
      { track_id: mainVideo.track_id, output: 'video' as const },
      { track_id: 'track_music_00000002', output: 'audio' as const },
    ],
  } as VideoExecutionPlan
  const command = buildExecutionPlanRenderCommand('ffmpeg', withMusic, plan, join(root, 'late-music.mp4'), undefined, {
    projectAssets: new Map([[musicId, { path: musicPath, content_hash: musicHash, mime_type: 'audio/mpeg' }]]),
  })
  expect(command.join(' ')).toContain('adelay=6000:all=1')
  expect(command.join(' ')).toContain('apad=whole_dur=10.000000')
  expect(command.join(' ')).toContain('atrim=duration=10.000000')
  service.repository.close()
})

test('缺少 afftdn 的本机 FFmpeg 会拒绝音频完成计划，不能静默跳过降噪', async () => {
  const root = await testRoot('audio-filter-unavailable')
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  const { service, created } = await seededService(root, {
    runProcess: async command => command.includes('-filters')
      ? { exitCode: 0, stdout: ' TSC aresample A->A ', stderr: '' }
      : await runner(command),
  })
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const version = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/audio-finishing-plans`)
  const response = await handler(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'audio-filter-unavailable-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ variant_id: variant.id, base_variant_version_id: version.id }),
  }), url, requestSegments(url))
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ error: 'MEDIA_VIDEO_FINISHING_UNAVAILABLE' })
  expect((await service.getProject(created.id)).audio_finishing_plans).toEqual([])
  service.repository.close()
})

test('音频完成计划在源音频 Fact 读取失败时失败关闭，不跳过有音频素材', async () => {
  const root = await testRoot('audio-source-fact-unavailable')
  const { service, created, commands } = await seededService(root)
  const project = await service.getProject(created.id)
  const source = project.sources[0]!
  const variant = project.delivery_variants[0]!
  const version = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const originalGetFact = service.repository.getFact.bind(service.repository)
  let sourceFactReads = 0
  service.repository.getFact = async (kind, factId) => {
    if (kind === 'source' && factId === source.id) {
      sourceFactReads += 1
      // prepareEditorialProject first validates identity and frozen source
      // bounds. The subsequent read is audioMeasurements' mandatory fact.
      if (sourceFactReads >= 4) throw new Error('simulated source fact storage failure')
    }
    return await originalGetFact(kind, factId)
  }
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/audio-finishing-plans`)
  const response = await handler(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'audio-source-fact-unavailable-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ variant_id: variant.id, base_variant_version_id: version.id }),
  }), url, requestSegments(url))
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ error: 'MEDIA_VIDEO_FINISHING_UNAVAILABLE' })
  expect((await service.getProject(created.id)).audio_finishing_plans).toEqual([])
  expect(commands.some(command => command.some(part => part.includes('ebur128') || part.includes('silencedetect')))).toBeFalse()
  service.repository.getFact = originalGetFact
  service.repository.close()
})

test('已创建的降噪计划在接受时也会重新校验本机滤镜能力', async () => {
  const root = await testRoot('audio-filter-drift')
  let hasAfftdn = true
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  const { service, created } = await seededService(root, {
    runProcess: async command => command.includes('-filters')
      ? { exitCode: 0, stdout: hasAfftdn ? ' TSC afftdn A->A ' : ' TSC aresample A->A ', stderr: '' }
      : await runner(command),
  })
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const initialVersion = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const audioUrl = new URL(`http://localhost/api/videos/projects/${created.id}/audio-finishing-plans`)
  const createdPlan = await handler(new Request(audioUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'audio-filter-drift-plan-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ variant_id: variant.id, base_variant_version_id: initialVersion.id }),
  }), audioUrl, requestSegments(audioUrl))
  expect(createdPlan.status).toBe(201)
  const planId = (await createdPlan.json() as { plan: { id: string } }).plan.id
  hasAfftdn = false
  const commandsUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.id}/commands`)
  const accepted = await handler(new Request(commandsUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'audio-filter-drift-accept-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({
      base_variant_version_id: initialVersion.id,
      commands: [{ kind: 'set_audio_finishing_plan', audio_finishing_plan_id: planId }],
    }),
  }), commandsUrl, requestSegments(commandsUrl))
  expect(accepted.status).toBe(422)
  expect(await accepted.json()).toMatchObject({ error: 'MEDIA_VIDEO_FINISHING_UNAVAILABLE' })
  const after = await service.getProject(created.id)
  expect(after.delivery_variants.find(candidate => candidate.id === variant.id)?.current_version_id).toBe(initialVersion.id)
  service.repository.close()
})

test('Beat Sync 仅从完整高置信度网格生成可接受草稿并通过 CommandSet 提交版本', async () => {
  const root = await testRoot('beat-sync-api')
  const pcm = clickTrack(120, 10, 22_050)
  const pcmDecoder: LocalPcmDecoder = () => ({
    chunks: oddChunks(new Uint8Array(pcm.buffer.slice(0))),
    completion: Promise.resolve({ exitCode: 0, stderr: '' }),
  })
  const { service, created } = await seededService(root, { pcmDecoder })
  const project = await service.getProject(created.id)
  const current = project.editorial_timeline_versions.find(version => version.id === project.current_editorial_timeline_version_id)!
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const beat = await request(new URL(`http://localhost/api/videos/projects/${created.id}/beat-analysis`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'beat-sync-analysis-key-0001' },
    body: JSON.stringify({ source_id: project.sources[0]!.id }),
  })
  expect(beat.status).toBe(202)
  const beatTask = await beat.json() as { task: { id: string } }
  const terminal = await waitForTerminalOperation(service, beatTask.task.id)
  expect(terminal).toMatchObject({ status: 'succeeded', result: { confidence: expect.any(Number) } })
  const gridId = String(terminal.result?.evidence_id)
  const grid = await service.repository.getFact('evidence', gridId) as Extract<import('../src/server/video/domain/mediaFacts/model.js').VideoFactEvidence, { kind: 'beat_grid' }>
  expect(grid.payload.confidence).toBeGreaterThanOrEqual(0.65)
  expect(grid.payload.coverage).toEqual([expect.objectContaining({ duration: expect.objectContaining({ ticks: '10000' }) })])
  expect(grid.payload.cache_key).toMatch(/^sha256:/)
  expect(grid.payload.source_cache_key).toMatch(/^sha256:/)

  const draftUrl = new URL(`http://localhost/api/videos/projects/${created.id}/beat-sync-drafts`)
  const input = {
    source_id: project.sources[0]!.id,
    beat_evidence_id: gridId,
    base_timeline_version_id: current.id,
    minimum_cut_interval_ms: 1_500,
  }
  const createdDraft = await request(draftUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'beat-sync-draft-key-0001' },
    body: JSON.stringify(input),
  })
  expect(createdDraft.status).toBe(201)
  const body = await createdDraft.json() as {
    draft: { id: string; base_timeline_version_id: string; beat_sync: { evidence_id: string }; items: Array<{ kind: string }> }
    task: { id: string; kind: string; status: string }
  }
  expect(body).toMatchObject({
    draft: { base_timeline_version_id: current.id, beat_sync: { evidence_id: gridId } },
    task: { kind: 'video.beat_sync_draft', status: 'succeeded' },
  })
  expect(body.draft.items.filter(item => item.kind === 'video').length).toBeGreaterThan(1)
  const replay = await request(draftUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'beat-sync-draft-key-0001' },
    body: JSON.stringify(input),
  })
  expect(replay.status).toBe(201)
  expect(await replay.json()).toMatchObject({ draft: { id: body.draft.id }, task: { id: body.task.id } })

  const accepted = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timeline-drafts/${body.draft.id}/accept`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'beat-sync-accept-key-0001' },
    body: JSON.stringify({ base_timeline_version_id: current.id }),
  })
  expect(accepted.status).toBe(200)
  expect(await accepted.json()).toMatchObject({ reused: false, timeline: { parent_version_id: current.id } })
  const committed = await service.getProject(created.id)
  expect(committed.current_editorial_timeline_version_id).not.toBe(current.id)
  expect(committed.editorial_timeline_versions.find(version => version.id === committed.current_editorial_timeline_version_id)?.items.filter(item => item.kind === 'video').length).toBeGreaterThan(1)
  service.repository.close()
})

test('正式 A/V 链冻结默认音轨及各自 PTS，旧计划缺失映射时失败关闭', async () => {
  const root = await testRoot('av-stream-pts')
  const { service, created, commands } = await seededService(root, { offsetAudio: true })
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const version = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/audio-finishing-plans`)
  const response = await handler(new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'offset-audio-plan-api-key-0001',
      [MEDIA_UI_CAPABILITY_HEADER]: capability,
    },
    body: JSON.stringify({ variant_id: variant.id, base_variant_version_id: version.id }),
  }), url, requestSegments(url))
  expect(response.status).toBe(201)
  const body = await response.json() as { plan: { measured_loudness: Array<{ audio_stream_index: number }> } }
  expect(body.plan.measured_loudness).toEqual([expect.objectContaining({ audio_stream_index: 2 })])
  const analysis = commands.find(command => command.some(part => part.includes('ebur128')))
  expect(analysis).toEqual(expect.arrayContaining(['-ss', '0.500000', '-map', '0:2']))

  const compiled = await service.compileDeliveryVariant(created.id, variant.id)
  const execution = buildExecutionPlanRenderCommand('ffmpeg', compiled.project, compiled.plan, join(root, 'av-pts.mp4'))
  expect(execution.join(' ')).toContain(`-ss 0.500000 -t 10.000000 -i ${compiled.project.sources[0]!.path}`)
  expect(execution.join(' ')).toContain('[1:2]atrim=duration=10.000000')
  const speededPlan = structuredClone(compiled.plan) as VideoExecutionPlan
  speededPlan.timeline_items = speededPlan.timeline_items.map(item => (
    item.kind !== 'video' && item.kind !== 'audio'
      ? item
      : {
          ...item,
          speed: { num: 2, den: 1 },
          timeline_range: {
            ...item.timeline_range,
            duration: { ...item.timeline_range.duration, ticks: (BigInt(item.timeline_range.duration.ticks) / 2n).toString() },
          },
        }
  ))
  const speededExecution = buildExecutionPlanRenderCommand('ffmpeg', compiled.project, speededPlan, join(root, 'av-speed.mp4'))
  expect(speededExecution.join(' ')).toContain('setpts=(PTS-STARTPTS)/2.00000000')
  expect(speededExecution.join(' ')).toContain('atempo=2.00000000')
  const legacyPlan = structuredClone(compiled.plan) as VideoExecutionPlan
  legacyPlan.inputs = legacyPlan.inputs.map(input => input.kind !== 'source'
    ? input
    : {
        kind: 'source' as const,
        source_id: input.source_id,
        source_fingerprint: input.source_fingerprint,
        video_stream_index: input.video_stream_index,
        source_start: input.source_start,
        source_range: input.source_range,
        video_color: input.video_color,
      })
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', compiled.project, legacyPlan, join(root, 'legacy-av-pts.mp4')))
    .toThrow('源音频缺少冻结的流映射或 PTS 边界')
  service.repository.close()
})

test('输出验证拒绝空媒体包，后渲染质量报告校验冻结帧率', async () => {
  const root = await testRoot('empty-packets')
  const output = join(root, 'empty-packets.mp4')
  await writeFile(output, 'not-a-real-video-but-a-hashable-fixture')
  await expect(verifyDeliveryVideoOutput({
    path: output,
    expected_duration_ms: 10_000,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    runProcess: async command => {
      if (command.includes('-show_format')) return { exitCode: 0, stdout: outputProbe(), stderr: '' }
      if (command.includes('-show_packets')) return { exitCode: 0, stdout: JSON.stringify({ packets: [] }), stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })).rejects.toThrow('没有可验证的媒体包')
})

test('正式交付文件组无覆盖发布，sidecar 失败会保留临时字节且不删除用户文件', async () => {
  const root = await testRoot('atomic-delivery-group')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux' })
  const temporaryVideo = join(root, 'delivery.partial.mp4')
  const temporarySidecar = join(root, 'delivery.partial.srt')
  const outputVideo = join(root, 'delivery.mp4')
  const outputSidecar = join(root, 'delivery.srt')
  await Promise.all([
    writeFile(temporaryVideo, 'verified-primary-output'),
    writeFile(temporarySidecar, 'verified-sidecar-output'),
    writeFile(outputSidecar, 'user-existing-sidecar'),
  ])
  const [videoHash, sidecarHash] = await Promise.all([videoFingerprint(temporaryVideo), videoFingerprint(temporarySidecar)])
  const publisher = deliveryRuntime(service) as unknown as {
    publishFiles(files: ReadonlyArray<{ source: string; destination: string; content_hash?: string }>): Promise<void>
  }
  await expect(publisher.publishFiles([
    { source: temporaryVideo, destination: outputVideo, content_hash: videoHash },
    { source: temporarySidecar, destination: outputSidecar, content_hash: sidecarHash },
  ])).rejects.toMatchObject({ code: 'VIDEO_OUTPUT_EXISTS' })
  expect(await Bun.file(outputVideo).exists()).toBeFalse()
  expect(await readFile(outputSidecar, 'utf8')).toBe('user-existing-sidecar')
  expect(await Bun.file(temporaryVideo).exists()).toBeTrue()
  expect(await Bun.file(temporarySidecar).exists()).toBeTrue()

  await rm(outputSidecar, { force: true })
  await publisher.publishFiles([
    { source: temporaryVideo, destination: outputVideo, content_hash: videoHash },
    { source: temporarySidecar, destination: outputSidecar, content_hash: sidecarHash },
  ])
  expect(await Promise.all([readFile(outputVideo, 'utf8'), readFile(outputSidecar, 'utf8')])).toEqual([
    'verified-primary-output',
    'verified-sidecar-output',
  ])
  expect(await Bun.file(temporaryVideo).exists()).toBeFalse()
  expect(await Bun.file(temporarySidecar).exists()).toBeFalse()
  service.repository.close()
})

test('正式输出验证强制单视频单音频流，并持久化黑场和静音扫描收据', async () => {
  const root = await testRoot('delivery-quality-scan')
  const output = join(root, 'delivery-quality-scan.mp4')
  await writeFile(output, 'hashable-output-for-quality-scan')
  const scanned = await verifyDeliveryVideoOutput({
    path: output,
    expected_duration_ms: 10_000,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    runProcess: async command => {
      if (command.includes('-show_format')) return { exitCode: 0, stdout: outputProbe(), stderr: '' }
      if (command.includes('-show_packets')) {
        return { exitCode: 0, stdout: JSON.stringify({ packets: [
          { stream_index: 0, dts: '0' }, { stream_index: 0, dts: '9000' },
          { stream_index: 1, dts: '0' }, { stream_index: 1, dts: '9000' },
        ] }), stderr: '' }
      }
      if (command.some(part => part.includes('blackdetect'))) {
        return { exitCode: 0, stdout: '', stderr: 'black_start:1.0 black_end:2.5 black_duration:1.5' }
      }
      if (command.some(part => part.includes('silencedetect'))) {
        return { exitCode: 0, stdout: '', stderr: 'silence_start:3.0\nsilence_end:5.0 | silence_duration: 2.0' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  expect(scanned).toMatchObject({
    decoded: true,
    packet_timestamps_monotonic: true,
    video_stream_count: 1,
    audio_stream_count: 1,
    black_duration_ms: 1_500,
    black_ratio: 0.15,
    silence_duration_ms: 2_000,
    silence_ratio: 0.2,
  })
  for (const audioStreams of [0, 2]) {
    await expect(verifyDeliveryVideoOutput({
      path: output,
      expected_duration_ms: 10_000,
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      runProcess: async command => command.includes('-show_format')
        ? { exitCode: 0, stdout: outputProbe({ audioStreams }), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    })).rejects.toThrow('恰好包含一条视频流和一条音频流')
  }
  await expect(verifyDeliveryVideoOutput({
    path: output,
    expected_duration_ms: 10_000,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    runProcess: async command => {
      if (command.includes('-show_format')) return { exitCode: 0, stdout: outputProbe(), stderr: '' }
      if (command.includes('-show_packets')) {
        return { exitCode: 0, stdout: JSON.stringify({ packets: [
          { stream_index: 0, dts: '0' }, { stream_index: 1, dts: '0' },
        ] }), stderr: '' }
      }
      if (command.some(part => part.includes('blackdetect'))) return { exitCode: 1, stdout: '', stderr: 'decoder failure' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })).rejects.toThrow('黑场扫描失败')
})

test('后渲染报告将长黑场和长静音标为人工确认，而非静默发布', async () => {
  const root = await testRoot('quality-warning')
  const { service, created } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '质量告警交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'quality-warning-variant-key-0001')
  const compiled = await service.compileDeliveryVariant(created.id, variant.variant.id)
  const project = await service.getProject(created.id)
  const timeline = project.editorial_timeline_versions.find(item => item.id === variant.version.editorial_timeline_version_id)!
  const profile = project.export_profile_revisions.find(item => item.id === variant.version.export_profile_revision_id)!
  const report = new FinishingDeliveryApplication(() => new Date(at)).createPostRenderReport({
    project,
    version: variant.version,
    timeline,
    profile,
    executionPlanId: compiled.plan.id,
    output: {
      timeline_version_id: timeline.id,
      delivery_variant_version_id: variant.version.id,
      execution_plan_id: compiled.plan.id,
      byte_size: 123,
      duration_ms: 10_000,
      video_stream_count: 1,
      audio_stream_count: 1,
      width: profile.width,
      height: profile.height,
      fps: profile.frame_rate.num / profile.frame_rate.den,
      container: profile.encoding.container,
      video_codec: profile.encoding.video.codec,
      audio_codec: profile.encoding.audio.codec,
      pixel_format: profile.encoding.output_color.pixel_format,
      color_range: profile.encoding.output_color.range,
      decoded: true,
      packet_timestamps_monotonic: true,
      expected_duration_ms: 10_000,
      duration_delta_ms: 0,
      audio_video_duration_delta_ms: 0,
      black_duration_ms: 1_000,
      black_ratio: 0.1,
      silence_duration_ms: 3_000,
      silence_ratio: 0.3,
      content_hash: `sha256:${'d'.repeat(64)}`,
      verified_at: at,
    },
  })
  expect(report.state).toBe('needs_user_decision')
  expect(report.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'output_verification_receipt', state: 'passed' }),
    expect.objectContaining({ code: 'output_stream_layout', state: 'passed' }),
    expect.objectContaining({ code: 'black_frame_scan', state: 'needs_user_decision', severity: 'warning' }),
    expect.objectContaining({ code: 'silence_scan', state: 'needs_user_decision', severity: 'warning' }),
  ]))
  service.repository.close()
})

test('正式渲染的后渲染告警必须经精确 API 确认后才发布，并可在重启后继续等待', async () => {
  const root = await testRoot('quality-warning-stops-publication')
  const commands: string[][] = []
  const baseRunner = finishingRunner(commands)
  const runProcess = async (command: string[]) => {
    if (command.some(part => part.includes('blackdetect'))) {
      return { exitCode: 0, stdout: '', stderr: 'black_start:0.0 black_end:1.2 black_duration:1.2' }
    }
    if (command.some(part => part.includes('silencedetect')) && !command.includes('-ss')) {
      return { exitCode: 0, stdout: '', stderr: 'silence_start:0.0 silence_end:1.2 silence_duration:1.2' }
    }
    return await baseRunner(command)
  }
  const { service, created } = await seededService(root, {
    runProcess,
  })
  const initial = await service.getProject(created.id)
  const variant = await service.createDeliveryVariant(created.id, {
    name: '告警阻断交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'quality-stop-variant-key-0001')
  const preflight = await service.preflightDeliveryVariant(created.id, variant.variant.id, {
    base_revision: variant.project.revision,
    base_variant_version_id: variant.version.id,
  }, 'quality-stop-preflight-key-0001')
  const output = join(root, 'blocked-by-quality.mp4')
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => await handler(new Request(url, init), url, requestSegments(url))
  const renderUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variant.variant.id}/render`)
  const renderResponse = await request(renderUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'quality-stop-render-key-0001', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({
      base_revision: preflight.project.revision,
      base_variant_version_id: variant.version.id,
      output_path: output,
    }),
  })
  expect(renderResponse.status).toBe(202)
  const renderBody = await renderResponse.json() as { task: { id: string } }
  const waiting = await waitForQualityConfirmation(service, renderBody.task.id)
  const report = waiting.result?.post_render_report as { id: string; checks: Array<{ id: string; state: string }> }
  const outputHash = String(waiting.result?.output_content_hash)
  const temporary = String(waiting.result?.temporary_output)
  const warningIds = report.checks.filter(check => check.state === 'needs_user_decision').map(check => check.id)
  expect(warningIds.length).toBeGreaterThan(0)
  expect(waiting).toMatchObject({
    status: 'committing',
    result: { awaiting_quality_confirmation: true, post_render_report_id: report.id, output_content_hash: outputHash },
  })
  const project = await service.getProject(created.id)
  expect(project).toMatchObject({ state: 'rendering', task_id: renderBody.task.id })
  expect(project.quality_reports.at(-1)).toMatchObject({ id: report.id, kind: 'post_render', state: 'needs_user_decision' })
  expect(await Bun.file(output).exists()).toBeFalse()
  expect(await Bun.file(temporary).exists()).toBeTrue()

  // Simulate the real crash window after the durable parent Operation was
  // written but before its denormalized Project quality-report projection.
  // Restart must recreate that projection from the frozen render receipt,
  // retain the bytes, and still require the same explicit acknowledgement.
  await service.repository.saveProject({
    ...project,
    quality_reports: project.quality_reports.filter(candidate => candidate.id !== report.id),
  })

  // Startup reconciliation preserves this durable wait state; it must not
  // mistake it for an interrupted FFmpeg process and delete the output.
  service.repository.close()
  const recovered = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess,
  })
  await recovered.recoverInterruptedOperations()
  expect(await recovered.getOperation(renderBody.task.id)).toMatchObject({
    status: 'committing',
    result: { awaiting_quality_confirmation: true, post_render_report_id: report.id },
  })
  expect((await recovered.getProject(created.id)).quality_reports).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: report.id, kind: 'post_render', state: 'needs_user_decision' }),
  ]))
  expect(await Bun.file(temporary).exists()).toBeTrue()

  const recoveredHandler = createVideoWorkbenchDomainApiHandler(recovered, capability)
  const recoveredRequest = async (url: URL, init: RequestInit = {}) => await recoveredHandler(new Request(url, init), url, requestSegments(url))
  const confirmationUrl = new URL(`http://localhost/api/videos/projects/${created.id}/renders/${renderBody.task.id}/quality-confirmation`)
  const confirmationBody = {
    report_id: report.id,
    output_content_hash: outputHash,
    accepted_check_ids: warningIds,
  }
  const confirmationHeaders = {
    'Content-Type': 'application/json',
    'Idempotency-Key': 'quality-confirmation-key-0001',
    [MEDIA_UI_CAPABILITY_HEADER]: capability,
  }
  const noCapability = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(confirmationBody),
  })
  expect(noCapability.status).toBe(403)
  const noIdempotencyKey = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify(confirmationBody),
  })
  expect(noIdempotencyKey.status).toBe(400)
  const unrelated = await recovered.createProject({ title: '无权确认的其他视频项目' })
  const crossProject = await recoveredRequest(new URL(`http://localhost/api/videos/projects/${unrelated.id}/renders/${renderBody.task.id}/quality-confirmation`), {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify(confirmationBody),
  })
  expect(crossProject.status).toBe(404)
  const missingWarning = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify({ ...confirmationBody, accepted_check_ids: [] }),
  })
  expect(missingWarning.status).toBe(400)
  const extraWarning = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify({ ...confirmationBody, accepted_check_ids: [...warningIds, 'quality_extra_00000001'] }),
  })
  expect(extraWarning.status).toBe(409)
  const wrongReport = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify({ ...confirmationBody, report_id: 'quality_report_00000001' }),
  })
  expect(wrongReport.status).toBe(409)
  const wrongHash = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify({ ...confirmationBody, output_content_hash: `sha256:${'0'.repeat(64)}` }),
  })
  expect(wrongHash.status).toBe(409)
  const originalTemporary = await readFile(temporary)
  await writeFile(temporary, 'tampered-before-quality-confirmation')
  const tamperedOutput = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify(confirmationBody),
  })
  expect(tamperedOutput.status).toBe(409)
  expect(await Bun.file(output).exists()).toBeFalse()
  await writeFile(temporary, originalTemporary)
  const confirmed = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify(confirmationBody),
  })
  expect(confirmed.status).toBe(201)
  expect(await confirmed.json()).toMatchObject({
    reused: false,
    acknowledgement: {
      render_operation_id: renderBody.task.id,
      report_id: report.id,
      output_content_hash: outputHash,
      accepted_check_ids: [...warningIds].sort(),
    },
    task: { status: 'succeeded' },
  })
  const completed = await recovered.getProject(created.id)
  expect(completed).toMatchObject({ state: 'complete', output_path: output, output_content_hash: outputHash })
  expect(completed.quality_acknowledgements).toEqual(expect.arrayContaining([
    expect.objectContaining({ render_operation_id: renderBody.task.id, report_id: report.id, output_content_hash: outputHash }),
  ]))
  expect(await Bun.file(output).exists()).toBeTrue()
  expect(await Bun.file(temporary).exists()).toBeFalse()
  const replay = await recoveredRequest(confirmationUrl, {
    method: 'POST',
    headers: confirmationHeaders,
    body: JSON.stringify(confirmationBody),
  })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ reused: true, task: { status: 'succeeded' } })
  // Simulate the narrow crash window after Project publication but before the
  // parent Operation terminal event; recovery must not require a second click.
  const terminalAfterConfirmation = await recovered.getOperation(renderBody.task.id)
  await recovered.repository.saveOperation({
    ...terminalAfterConfirmation,
    status: 'committing',
    progress: 95,
    stage: '模拟项目发布后尚未写入终态',
    error: undefined,
    error_code: undefined,
  })
  await recovered.recoverInterruptedOperations()
  expect(await recovered.getOperation(renderBody.task.id)).toMatchObject({ status: 'succeeded' })
  recovered.repository.close()
})

test('重启恢复只发布同时具备 output_verify 与 post_render 收据的正式导出', async () => {
  const root = await testRoot('delivery-recovery-receipts')
  const commands: string[][] = []
  const first = await seededService(root)
  const initial = await first.service.getProject(first.created.id)
  const variant = await first.service.createDeliveryVariant(first.created.id, {
    name: '恢复交付',
    editorial_timeline_version_id: initial.current_editorial_timeline_version_id!,
  }, 'recovery-variant-key-0001')
  const preflight = await first.service.preflightDeliveryVariant(first.created.id, variant.variant.id, {
    base_revision: variant.project.revision,
    base_variant_version_id: variant.version.id,
  }, 'recovery-preflight-key-0001')
  const output = join(root, 'recovery-delivery.mp4')
  const render = await first.service.renderDeliveryVariant(first.created.id, variant.variant.id, {
    base_revision: preflight.project.revision,
    base_variant_version_id: variant.version.id,
    output_path: output,
  }, 'recovery-render-key-0001')
  const terminal = await waitForTerminalOperation(first.service, render.id)
  expect(terminal.status).toBe('succeeded')
  const outputVerify = (await first.service.repository.listOperations(first.created.id))
    .find(operation => operation.kind === 'video.output_verify')
  if (!outputVerify) throw new Error('fixture did not create output verification receipt')
  const completedProject = await first.service.getProject(first.created.id)
  await first.service.repository.saveProject({ ...completedProject, state: 'rendering', task_id: render.id })
  await first.service.repository.saveOperation({
    ...terminal,
    status: 'committing',
    progress: 95,
    stage: '模拟发布后崩溃',
    error: undefined,
    error_code: undefined,
  })
  first.service.repository.close()

  const recovered = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: finishingRunner(commands),
  })
  await recovered.recoverInterruptedOperations()
  expect(await recovered.getOperation(render.id)).toMatchObject({ status: 'succeeded' })
  const recoveredCompleted = await recovered.getProject(first.created.id)
  expect(recoveredCompleted).toMatchObject({ state: 'complete', output_path: output })
  expect(recoveredCompleted.task_id).toBeUndefined()

  const recoveredOutputVerify = await recovered.repository.getOperation(outputVerify.id)
  await recovered.repository.saveOperation({
    ...recoveredOutputVerify,
    status: 'failed',
    progress: 100,
    stage: '模拟遗失校验收据',
    error: 'fixture receipt lost',
    error_code: 'MEDIA_VIDEO_EXPORT_FAILED',
  })
  const recoveredProject = await recovered.getProject(first.created.id)
  const recoveredRender = await recovered.getOperation(render.id)
  await recovered.repository.saveProject({ ...recoveredProject, state: 'rendering', task_id: render.id })
  await recovered.repository.saveOperation({
    ...recoveredRender,
    status: 'committing',
    progress: 95,
    stage: '模拟再次启动',
    error: undefined,
    error_code: undefined,
  })
  await recovered.recoverInterruptedOperations()
  expect(await recovered.getOperation(render.id)).toMatchObject({ status: 'failed' })
  expect(await recovered.getProject(first.created.id)).toMatchObject({ state: 'ready' })
  expect(await Bun.file(output).exists()).toBeFalse()
  recovered.repository.close()
})

test('正式双文件发布在主文件已 link、sidecar 未 link 后可重启续传并清理全部临时文件', async () => {
  const root = await testRoot('delivery-sidecar-resume')
  const staged = await stagedFormalSidecarPublicationCrash(root, 'resume-sidecar')
  const recovered = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: finishingRunner([]),
  })

  await recovered.recoverInterruptedOperations()

  const completed = await recovered.getOperation(staged.render.id)
  expect(completed).toMatchObject({
    status: 'succeeded',
    result: {
      sidecar_caption_path: staged.sidecarPath,
    },
  })
  expect(completed.result?.temporary_output).toBeUndefined()
  expect(completed.result?.temporary_sidecar_path).toBeUndefined()
  expect(await recovered.getProject(staged.created.id)).toMatchObject({
    state: 'complete',
    output_path: staged.output,
  })
  expect(await readFile(staged.sidecarPath, 'utf8')).toBe(staged.sidecar)
  expect(await Bun.file(staged.temporaryOutput).exists()).toBeFalse()
  expect(await Bun.file(staged.temporarySidecar).exists()).toBeFalse()
  recovered.repository.close()
})

test('质量确认发布在主文件已 link、sidecar 未 link 后按同一 receipt 重启续传', async () => {
  const root = await testRoot('quality-sidecar-resume')
  const staged = await stagedFormalSidecarPublicationCrash(root, 'quality-resume-sidecar')
  const preparing = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: finishingRunner([]),
  })
  const operation = await preparing.getOperation(staged.render.id)
  const project = await preparing.getProject(staged.created.id)
  const originalReport = operation.result?.post_render_report as VideoQualityReport | undefined
  if (!originalReport) throw new Error('fixture formal render must retain the post-render report')
  const warning = originalReport.checks.find(check => check.code === 'black_frame_scan')
  if (!warning) throw new Error('fixture formal report must contain a black-frame check')
  const report: VideoQualityReport = {
    ...originalReport,
    state: 'needs_user_decision',
    checks: originalReport.checks.map(check => check.id === warning.id
      ? { ...check, state: 'needs_user_decision', severity: 'warning', message: 'fixture requires explicit acknowledgement' }
      : check),
  }
  const acknowledgement: VideoQualityAcknowledgement = {
    id: 'quality_ack_sidecar_resume_0001',
    project_id: project.id,
    render_operation_id: operation.id,
    report_id: report.id,
    execution_plan_id: String(operation.result?.execution_plan_id),
    delivery_variant_version_id: String(operation.result?.delivery_variant_version_id),
    output_content_hash: String(operation.result?.output_content_hash) as `sha256:${string}`,
    accepted_check_ids: [warning.id],
    acknowledged_at: at,
  }
  await preparing.repository.saveProject({
    ...project,
    state: 'rendering',
    task_id: operation.id,
    quality_reports: project.quality_reports.map(candidate => candidate.id === report.id ? report : candidate),
  })
  await preparing.repository.saveOperation({
    ...operation,
    status: 'committing',
    progress: 95,
    stage: '模拟质量确认已落库后发布中断',
    result: {
      ...operation.result,
      awaiting_quality_confirmation: false,
      quality_acknowledgement: acknowledgement,
      post_render_report: report,
    },
    error: undefined,
    error_code: undefined,
  })
  preparing.repository.close()

  const recovered = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: finishingRunner([]),
  })
  await recovered.recoverInterruptedOperations()

  expect(await recovered.getOperation(staged.render.id)).toMatchObject({
    status: 'succeeded',
    result: { quality_acknowledgement: { id: acknowledgement.id } },
  })
  const completed = await recovered.getProject(staged.created.id)
  expect(completed).toMatchObject({ state: 'complete', output_path: staged.output })
  expect(completed.quality_acknowledgements).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: acknowledgement.id }),
  ]))
  expect(await readFile(staged.sidecarPath, 'utf8')).toBe(staged.sidecar)
  expect(await Bun.file(staged.temporaryOutput).exists()).toBeFalse()
  expect(await Bun.file(staged.temporarySidecar).exists()).toBeFalse()
  recovered.repository.close()
})

test('正式双文件恢复遇到冲突 sidecar 不覆盖用户文件，并可靠清理本次已 link 的主文件和临时文件', async () => {
  const root = await testRoot('delivery-sidecar-conflict')
  const staged = await stagedFormalSidecarPublicationCrash(root, 'conflict-sidecar', true)
  const recovered = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: finishingRunner([]),
  })

  await recovered.recoverInterruptedOperations()

  expect(await recovered.getOperation(staged.render.id)).toMatchObject({ status: 'failed' })
  expect(await recovered.getProject(staged.created.id)).toMatchObject({ state: 'ready' })
  expect(await readFile(staged.sidecarPath, 'utf8')).toBe('user-sidecar-must-survive')
  expect(await Bun.file(staged.output).exists()).toBeFalse()
  expect(await Bun.file(staged.temporaryOutput).exists()).toBeFalse()
  expect(await Bun.file(staged.temporarySidecar).exists()).toBeFalse()
  recovered.repository.close()
})

test('HDR 素材只走真实 tone-map，未知颜色和 reject Profile 都失败关闭', async () => {
  const root = await testRoot('hdr-delivery')
  const commands: string[][] = []
  const runner = finishingRunner(commands)
  const { service, created } = await seededService(root, {
    runProcess: async command => command.includes('-filters')
      ? { exitCode: 0, stdout: ' TSC afftdn A->A\n T.. subtitles V->V ', stderr: '' }
      : await runner(command),
  })
  const project = await service.getProject(created.id)
  const variant = project.delivery_variants[0]!
  const version = project.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const profile = project.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)!
  const source = project.sources[0]!
  const fact = await service.repository.getFact('source', source.id) as VideoFactSource
  const audio = fact.audio_tracks.find(track => track.disposition_default) ?? fact.audio_tracks[0]
  if (!audio?.duration) throw new Error('fixture audio fact required')
  const profileWithPolicy = (hdrInputPolicy: 'tone_map_to_sdr' | 'reject') => {
    const { content_hash: _ignored, ...withoutHash } = { ...profile, hdr_input_policy: hdrInputPolicy }
    const revised = {
      ...withoutHash,
      content_hash: `sha256:${createHash('sha256').update(JSON.stringify(withoutHash)).digest('hex')}` as const,
    }
    return {
      ...project,
      export_profile_revisions: project.export_profile_revisions.map(candidate => candidate.id === profile.id ? revised : candidate),
      delivery_variant_versions: project.delivery_variant_versions.map(candidate => candidate.id === version.id
        ? { ...candidate, export_profile_hash: revised.content_hash }
        : candidate),
    }
  }
  const pqBounds = new Map([[source.id, {
    video_stream_index: fact.primary_video_stream.stream_index,
    start: fact.primary_video_stream.start_time,
    duration: fact.primary_video_stream.duration!,
    video_color: {
      hdr_kind: 'pq' as const,
      color_space: 'bt2020nc',
      color_transfer: 'smpte2084',
      color_primaries: 'bt2020',
      color_range: 'tv',
      pixel_format: 'yuv420p10le',
    },
    audio: {
      stream_index: audio.stream_index,
      start: audio.start_time,
      duration: audio.duration,
      sample_rate: audio.sample_rate,
      channels: audio.channels,
    },
  }]])
  const editorial = new EditorialApplication(() => new Date(at))
  const toneMapProject = profileWithPolicy('tone_map_to_sdr')
  const compiled = editorial.compile(toneMapProject, variant.id, pqBounds)
  const render = buildExecutionPlanRenderCommand('ffmpeg', compiled.project, compiled.plan, join(root, 'tone-map.mp4'))
  expect(render.join(' ')).toContain('zscale=transfer=linear:npl=100')
  expect(render.join(' ')).toContain('tonemap=tonemap=hable:desat=0')
  expect(render.join(' ')).toContain('zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=tv')
  expect(() => editorial.compile(profileWithPolicy('reject'), variant.id, pqBounds)).toThrow('拒绝 HDR')
  expect(() => editorial.compile(toneMapProject, variant.id, new Map([[source.id, {
    ...pqBounds.get(source.id)!,
    video_color: { hdr_kind: 'unknown' as const },
  }]]))).toThrow('颜色特征缺失')

  // Persisting a PQ source under a tone-map Profile also requires the actual
  // zscale/tonemap filters during formal preflight, not just output tags.
  await service.repository.saveFact({
    ...fact,
    primary_video_stream: {
      ...fact.primary_video_stream,
      ...pqBounds.get(source.id)!.video_color,
    },
  })
  const saved = await service.repository.saveProject(toneMapProject)
  await expect(service.preflightDeliveryVariant(created.id, variant.id, {
    base_revision: saved.revision,
    base_variant_version_id: version.id,
  }, 'hdr-preflight-filter-check-key-0001')).rejects.toMatchObject({ code: 'VIDEO_FINISHING_UNAVAILABLE' })
  service.repository.close()
})

test('正式预检验证冻结编码器，硬件 H.264 不以固定码率伪装 CRF/preset', async () => {
  const h264Root = await testRoot('preflight-h264-encoder')
  const h264Commands: string[][] = []
  const h264Runner = finishingRunner(h264Commands)
  let h264EncoderProbed = false
  const { service: h264Service, created: h264Created } = await seededService(h264Root, {
    runProcess: async command => {
      if (command.includes('-encoders')) {
        h264EncoderProbed = true
        return { exitCode: 0, stdout: ' V..... mpeg4\n', stderr: '' }
      }
      return await h264Runner(command)
    },
  })
  const h264Project = await h264Service.getProject(h264Created.id)
  const h264Variant = h264Project.delivery_variants[0]!
  const h264Version = h264Project.delivery_variant_versions.find(candidate => candidate.id === h264Variant.current_version_id)!
  const h264Profile = h264Project.export_profile_revisions.find(candidate => candidate.id === h264Version.export_profile_revision_id)!
  await expect(h264Service.preflightDeliveryVariant(h264Created.id, h264Variant.id, {
    base_revision: h264Project.revision,
    base_variant_version_id: h264Version.id,
  }, 'preflight-requires-libx264-key-0001')).rejects.toMatchObject({
    code: 'VIDEO_FINISHING_UNAVAILABLE',
    message: expect.stringContaining('libx264'),
  })
  expect(h264EncoderProbed).toBeTrue()
  h264Service.repository.close()

  const inventory = async () => ({
    exitCode: 0,
    stdout: ' V..... h264_videotoolbox\n V..... libx264\n',
    stderr: '',
  })
  const software = await selectDeliveryVideoEncoder(inventory, {}, 'darwin', h264Profile)
  expect(software).toMatchObject({
    name: 'libx264',
    profile_codec: 'h264',
    args: ['-crf', String(h264Profile.encoding.video.quality.value), '-preset', h264Profile.encoding.video.quality.preset],
  })
  expect(software.args).not.toContain('8M')
  await expect(selectDeliveryVideoEncoder(inventory, {
    BB_FFMPEG_VIDEO_ENCODER: 'h264_videotoolbox',
  }, 'darwin', h264Profile)).rejects.toThrow('CRF/preset')

  const proresRoot = await testRoot('preflight-prores-encoder')
  const proresCommands: string[][] = []
  let proresEncoderProbed = false
  const proresRunner = finishingRunner(proresCommands)
  const { service: proresService, created: proresCreated } = await seededService(proresRoot, {
    runProcess: async command => {
      if (command.includes('-encoders')) proresEncoderProbed = true
      return await proresRunner(command)
    },
  })
  const original = await proresService.getProject(proresCreated.id)
  const variant = original.delivery_variants[0]!
  const version = original.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const profile = original.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)!
  const { content_hash: _oldHash, ...withoutHash } = profile
  const proresWithoutHash = {
    ...withoutHash,
    encoding: {
      container: 'mov' as const,
      video: { codec: 'prores_422' as const, quality: { mode: 'prores_profile' as const, profile: 'hq' as const } },
      audio: { codec: 'pcm_s16le' as const, sample_rate: 48_000 as const, channels: 2 as const },
      output_color: { range: 'sdr_bt709' as const, pixel_format: 'yuv422p10le' as const },
    },
  }
  const proresProfile = {
    ...proresWithoutHash,
    content_hash: `sha256:${createHash('sha256').update(JSON.stringify(proresWithoutHash)).digest('hex')}` as const,
  }
  const updated = await proresService.repository.saveProject({
    ...original,
    export_profile_revisions: original.export_profile_revisions.map(candidate => candidate.id === profile.id ? proresProfile : candidate),
    delivery_variant_versions: original.delivery_variant_versions.map(candidate => candidate.id === version.id
      ? { ...candidate, export_profile_hash: proresProfile.content_hash }
      : candidate),
  })
  await expect(proresService.preflightDeliveryVariant(proresCreated.id, variant.id, {
    base_revision: updated.revision,
    base_variant_version_id: version.id,
  }, 'preflight-requires-prores-ks-key-0001')).rejects.toMatchObject({
    code: 'VIDEO_FINISHING_UNAVAILABLE',
    message: expect.stringContaining('ProRes 422'),
  })
  expect(proresEncoderProbed).toBeTrue()
  proresService.repository.close()
})

test('正式输出验证读取真实媒体响应，而不是文件扩展名或缺失流属性', async () => {
  const root = await testRoot('output-profile-contract')
  const { service, created } = await seededService(root)
  const project = await service.getProject(created.id)
  const profile = project.export_profile_revisions[0]!
  const output = join(root, 'looks-like-mp4.mp4')
  await writeFile(output, 'output-contract-fixture')
  const runFor = (options: Parameters<typeof outputProbe>[0]) => async (command: string[]) => {
    if (command.includes('-show_format')) return { exitCode: 0, stdout: outputProbe(options), stderr: '' }
    if (command.includes('-show_packets')) return { exitCode: 0, stdout: JSON.stringify({ packets: [
      { stream_index: 0, dts: '0' }, { stream_index: 0, dts: '9000' }, { stream_index: 1, dts: '0' }, { stream_index: 1, dts: '9000' },
    ] }), stderr: '' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const inputFor = (options: Parameters<typeof outputProbe>[0]) => ({
    path: output,
    expected_duration_ms: 10_000,
    expected_profile: profile,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    runProcess: runFor(options),
  })
  await expect(verifyDeliveryVideoOutput(inputFor({ majorBrand: 'qt' }))).rejects.toThrow('容器')
  await expect(verifyDeliveryVideoOutput(inputFor({ colorRange: 'pc' }))).rejects.toThrow('颜色范围')
  await expect(verifyDeliveryVideoOutput(inputFor({ sampleRate: 44_100 }))).rejects.toThrow('音频采样率')
  await expect(verifyDeliveryVideoOutput(inputFor({ channels: 1 }))).rejects.toThrow('音频声道数')
  await expect(verifyDeliveryVideoOutput(inputFor({ sampleAspectRatio: '4:3' }))).rejects.toThrow('像素宽高比')
  await expect(verifyDeliveryVideoOutput(inputFor({ displayAspectRatio: '16:9' }))).rejects.toThrow('显示宽高比')
  await expect(verifyDeliveryVideoOutput(inputFor({ rotation: 90 }))).rejects.toThrow('旋转')
  await expect(verifyDeliveryVideoOutput(inputFor({ omitVideoDuration: true }))).rejects.toThrow('独立的音视频流时长证据')
  await expect(verifyDeliveryVideoOutput(inputFor({ omitAudioDuration: true }))).rejects.toThrow('独立的音视频流时长证据')
  service.repository.close()
})
