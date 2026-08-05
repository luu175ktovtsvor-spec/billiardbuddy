import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { buildExecutionPlanRenderCommand, fastVideoIdentity, videoFingerprint } from '../src/server/services/videoExecution.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { EditorialApplication } from '../src/server/video/domain/editorial/editorialApplication.js'
import { mediaTimeBase, rationalTime, tickRateForTimeBase } from '../src/server/video/domain/mediaFacts/time.js'
import { MEDIA_UI_CAPABILITY_HEADER } from '../shared/contracts/media.js'

const roots: string[] = []
const at = '2026-08-03T00:00:00.000Z'

async function testRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `billiardbuddy-editorial-${label}-`))
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

function defaultAudioTrack(durationMs: number) {
  const rate = { num: 48_000, den: 1 }
  return {
    stream_index: 1,
    time_base: mediaTimeBase(1, 48_000),
    start_time: rationalTime('0', rate),
    duration: rationalTime(String(durationMs * 48), rate),
    codec: 'aac',
    sample_rate: 48_000,
    channels: 2,
    disposition_default: true,
  }
}

function sdrVideoColor() {
  return {
    color_space: 'bt709',
    color_transfer: 'bt709',
    color_primaries: 'bt709',
    color_range: 'tv',
    pixel_format: 'yuv420p',
    hdr_kind: 'sdr' as const,
  }
}

test('Editorial v2 API 以单一 CommandSet 写入草稿、版本、变体和受管执行计划', async () => {
  const root = await testRoot('api')
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'editorial fixture bytes')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux' })
  const created = await service.createProject({ title: '编辑版本 API' })
  const fingerprint = await videoFingerprint(sourcePath)
  const identity = await fastVideoIdentity(sourcePath)
  const timeBase = mediaTimeBase(1, 1000)
  const tickRate = tickRateForTimeBase(timeBase)
  const sourceId = 'src_00000001'
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
      ...sdrVideoColor(),
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('10000', tickRate),
    audio_tracks: [defaultAudioTrack(10_000)],
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
      duration_ms: 10_000,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      fingerprint,
      rotation: 0,
      video_stream_count: 1,
      audio_stream_count: 1,
      missing: false,
      content_changed: false,
    }],
    timeline: [{ id: 'clip_00000001', source_id: sourceId, in_ms: 0, out_ms: 10_000 }],
  })

  // Existing projects initialise one v2 baseline only after a stable source
  // fingerprint exists; the previous scene list remains an input projection.
  await expect(service.getEditorialTimeline(created.id, 'timeline_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  let project = await service.getProject(created.id)
  const baseTimelineId = project.current_editorial_timeline_version_id!
  const baseTimeline = project.editorial_timeline_versions.find(version => version.id === baseTimelineId)!
  const capability = 'capability_0123456789abcdef0123456789'
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }

  const commandUrl = new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${baseTimeline.id}/commands`)
  const idempotencyKey = 'editorial-command-key-0001'
  const commandBody = {
    commands: [{ kind: 'set_track_state', track_id: baseTimeline.tracks[0]!.id, locked: false }],
  }
  const firstCommand = await request(commandUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(commandBody),
  })
  expect(firstCommand.status).toBe(200)
  const firstCommandBody = await firstCommand.json() as { timeline: { id: string; parent_version_id: string; tracks: Array<{ locked: boolean }> }; reused: boolean }
  expect(firstCommandBody).toMatchObject({ reused: false, timeline: { parent_version_id: baseTimeline.id } })
  expect(firstCommandBody.timeline.tracks.some(track => track.locked === false)).toBeTrue()

  const repeatedCommand = await request(commandUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(commandBody),
  })
  expect(repeatedCommand.status).toBe(200)
  expect(await repeatedCommand.json()).toMatchObject({ reused: true, timeline: { id: firstCommandBody.timeline.id } })

  const conflictCommand = await request(commandUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ commands: [{ kind: 'set_track_state', track_id: baseTimeline.tracks[0]!.id, muted: true }] }),
  })
  expect(conflictCommand.status).toBe(409)

  const invalidCommandUrl = new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${firstCommandBody.timeline.id}/commands`)
  const invalidOverlap = await request(invalidCommandUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-overlap-key-0001' },
    body: JSON.stringify({
      commands: [{
        kind: 'insert',
        track_id: baseTimeline.tracks[0]!.id,
        item: { ...baseTimeline.items[0]!, id: 'item_00000002', track_id: baseTimeline.tracks[0]!.id },
      }],
    }),
  })
  expect(invalidOverlap.status).toBe(400)
  expect(await invalidOverlap.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })

  const variantUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants`)
  const variantKey = 'delivery-variant-key-0001'
  const createdVariant = await request(variantUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': variantKey },
    body: JSON.stringify({ name: '竖版交付', editorial_timeline_version_id: firstCommandBody.timeline.id }),
  })
  expect(createdVariant.status).toBe(201)
  const variantBody = await createdVariant.json() as { variant: { id: string }; version: { id: string; editorial_timeline_version_id: string }; reused: boolean }
  expect(variantBody).toMatchObject({ reused: false, version: { editorial_timeline_version_id: firstCommandBody.timeline.id } })
  const repeatedVariant = await request(variantUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': variantKey },
    body: JSON.stringify({ name: '竖版交付', editorial_timeline_version_id: firstCommandBody.timeline.id }),
  })
  expect(repeatedVariant.status).toBe(200)
  expect(await repeatedVariant.json()).toMatchObject({ reused: true, variant: { id: variantBody.variant.id } })

  const editedTimeline = (await service.getProject(created.id)).editorial_timeline_versions.find(version => version.id === firstCommandBody.timeline.id)!
  const item = editedTimeline.items[0]!

  // A caption-document item can exist in an older persisted timeline even
  // though the current CommandSet no longer creates one. Its execution path
  // must fail closed rather than letting Preview/Render silently omit it.
  const legacyCaptionTrack = { id: 'track_caption_00000001', kind: 'caption' as const, order: 2, locked: false, muted: false }
  const captionFixtureProject = await service.getProject(created.id)
  await service.repository.saveProject({
    ...captionFixtureProject,
    editorial_timeline_versions: captionFixtureProject.editorial_timeline_versions.map(version => version.id === editedTimeline.id
      ? { ...version, tracks: [...version.tracks, legacyCaptionTrack] }
      : version),
    revision: captionFixtureProject.revision + 1,
  })
  const rejectedLegacyCaptionTrack = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${editedTimeline.id}/commands`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'legacy-caption-track-command-0001' },
    body: JSON.stringify({
      base_timeline_version_id: editedTimeline.id,
      commands: [{
        kind: 'insert',
        track_id: legacyCaptionTrack.id,
        item: {
          id: 'item_caption_00000001',
          track_id: legacyCaptionTrack.id,
          kind: 'caption',
          timeline_range: item.timeline_range,
          binding: {
            kind: 'caption_document',
            caption_document_id: 'caption_document_00000001',
            caption_revision_id: 'caption_revision_00000001',
          },
          linked_camera_shot_ids: [],
          linked_content_segment_ids: [],
          locked: false,
          evidence_ids: [],
        },
      }],
    }),
  })
  expect(rejectedLegacyCaptionTrack.status).toBe(400)
  expect(await rejectedLegacyCaptionTrack.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
  expect((await service.getProject(created.id)).current_editorial_timeline_version_id).toBe(editedTimeline.id)

  const variantCommandsUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${variantBody.variant.id}/commands`)
  const variantCommand = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'variant-command-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: variantBody.version.id,
      commands: [{
        kind: 'set_transform_keyframes',
        item_id: item.id,
        keyframes: [{ at: item.timeline_range.start, value: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, interpolation: 'linear' }],
      }],
    }),
  })
  expect(variantCommand.status).toBe(200)
  const variantCommandBody = await variantCommand.json() as { version: { id: string; parent_version_id: string } }
  expect(variantCommandBody).toMatchObject({ version: { parent_version_id: variantBody.version.id } })

  // Hold is preserved in the immutable Variant Version for the formal
  // renderer. Bezier has no execution-plan compiler and is rejected before a
  // new version can become the variant head.
  const holdVariant = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'variant-hold-keyframe-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: variantCommandBody.version.id,
      commands: [{
        kind: 'set_transform_keyframes',
        item_id: item.id,
        keyframes: [
          { at: item.timeline_range.start, value: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, interpolation: 'hold' },
          { at: { ticks: '90000', tick_rate: { num: 90000, den: 1 } }, value: { x: 0, y: 0, scale: 1.1, rotation: 0, opacity: 1 }, interpolation: 'linear' },
        ],
      }],
    }),
  })
  expect(holdVariant.status).toBe(200)
  const holdVariantBody = await holdVariant.json() as {
    version: {
      id: string
      parent_version_id: string
      item_overrides: Array<{ transform_keyframes?: Array<{ interpolation: string }> }>
    }
  }
  expect(holdVariantBody.version.parent_version_id).toBe(variantCommandBody.version.id)
  expect(holdVariantBody.version.item_overrides[0]?.transform_keyframes?.[0]?.interpolation).toBe('hold')
  const holdCompiled = await service.compileDeliveryVariant(created.id, variantBody.variant.id)
  const holdRenderCommand = buildExecutionPlanRenderCommand('ffmpeg', holdCompiled.project, holdCompiled.plan, join(root, 'hold-keyframe.mp4')).join(' ')
  // The interval from the first (hold) keyframe to the next keyframe must be
  // a constant expression. A linear expression here would move the camera
  // before its keyframe and silently change the editorial decision.
  expect(holdRenderCommand).toContain('if(lt(t,1),1,1.1)')
  expect(holdRenderCommand).not.toContain('*(t-0)')

  const rejectedBezier = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'variant-bezier-keyframe-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: holdVariantBody.version.id,
      commands: [{
        kind: 'set_transform_keyframes',
        item_id: item.id,
        keyframes: [{ at: item.timeline_range.start, value: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, interpolation: 'bezier' }],
      }],
    }),
  })
  expect(rejectedBezier.status).toBe(400)
  expect(await rejectedBezier.json()).toMatchObject({ error: 'MEDIA_INVALID_REQUEST' })
  expect((await service.getDeliveryVariant(created.id, variantBody.variant.id)).version.id).toBe(holdVariantBody.version.id)

  // A pre-existing persisted Variant Version can bypass the HTTP CommandSet
  // parser. The formal compiler must still reject that legacy Bezier payload.
  const holdProject = await service.getProject(created.id)
  await service.repository.saveProject({
    ...holdProject,
    delivery_variant_versions: holdProject.delivery_variant_versions.map(version => version.id === holdVariantBody.version.id
      ? {
          ...version,
          item_overrides: version.item_overrides.map(override => ({
            ...override,
            transform_keyframes: override.transform_keyframes?.map((keyframe, index) => index === 0
              ? { ...keyframe, interpolation: 'bezier' as const }
              : keyframe),
          })),
        }
      : version),
  })
  await expect(service.compileDeliveryVariant(created.id, variantBody.variant.id)).rejects.toMatchObject({ code: 'VIDEO_EDITORIAL_UNSUPPORTED' })
  const afterRejectedLegacyCompile = await service.getProject(created.id)
  await service.repository.saveProject({ ...holdProject, writer_fence: afterRejectedLegacyCompile.writer_fence })

  // Creation replay must remain bound to the immutable first version, even
  // after the variant head moves through another CommandSet.
  const repeatedAfterHeadMoves = await request(variantUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': variantKey },
    body: JSON.stringify({ name: '竖版交付', editorial_timeline_version_id: firstCommandBody.timeline.id }),
  })
  expect(repeatedAfterHeadMoves.status).toBe(200)
  expect(await repeatedAfterHeadMoves.json()).toMatchObject({ reused: true, version: { id: variantBody.version.id } })

  const audioItem = editedTimeline.items.find(candidate => candidate.kind === 'audio')!
  const fadedVariant = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'variant-fade-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: holdVariantBody.version.id,
      commands: [{ kind: 'set_audio_fades', item_id: audioItem.id, fade_in: { ticks: '90000', tick_rate: { num: 90000, den: 1 } } }],
    }),
  })
  expect(fadedVariant.status).toBe(200)
  const fadedVariantBody = await fadedVariant.json() as { version: { id: string } }

  const invalidFade = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'invalid-fade-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: fadedVariantBody.version.id,
      commands: [{ kind: 'set_audio_fades', item_id: audioItem.id, fade_out: { ticks: '9000000', tick_rate: { num: 90000, den: 1 } } }],
    }),
  })
  expect(invalidFade.status).toBe(400)

  const unsupportedCaption = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unsupported-caption-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: fadedVariantBody.version.id,
      commands: [{ kind: 'set_caption_style', item_id: item.id, caption_style_id: 'caption_style_00000001' }],
    }),
  })
  expect(unsupportedCaption.status).toBe(400)
  const unsupportedCaptionRevision = await request(variantCommandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'unsupported-caption-revision-key-0001' },
    body: JSON.stringify({
      base_variant_version_id: fadedVariantBody.version.id,
      commands: [{ kind: 'set_caption_revision', caption_document_id: 'caption_document_00000001', caption_revision_id: 'caption_revision_00000001' }],
    }),
  })
  expect(unsupportedCaptionRevision.status).toBe(400)

  project = await service.getProject(created.id)
  const editorial = new EditorialApplication(() => new Date(at))
  const draft = editorial.createDraft(project, [{
    id: 'scene_00000001',
    source_id: sourceId,
    in_ms: 0,
    out_ms: 5_000,
    story_role: 'hook',
    evidence_ids: [],
    rationale: '仅保留开场',
    needs_review: false,
    locked: false,
  }], new Map([[sourceId, { tick_rate: tickRate, start_ticks: '0' }]]))
  await service.repository.saveProject({ ...project, timeline_drafts: [...project.timeline_drafts, draft], revision: project.revision + 1 })
  const acceptUrl = new URL(`http://localhost/api/videos/projects/${created.id}/timeline-drafts/${draft.id}/accept`)
  const accepted = await request(acceptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'accept-draft-key-0001' },
    body: JSON.stringify({ base_timeline_version_id: firstCommandBody.timeline.id }),
  })
  expect({ status: accepted.status, body: await accepted.json() }).toMatchObject({ status: 200, body: { reused: false, timeline: { parent_version_id: firstCommandBody.timeline.id } } })
  const acceptedAgain = await request(acceptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'accept-draft-key-0001' },
    body: JSON.stringify({ base_timeline_version_id: firstCommandBody.timeline.id }),
  })
  expect(acceptedAgain.status).toBe(200)
  expect(await acceptedAgain.json()).toMatchObject({ reused: true })

  await expect(service.compileDeliveryVariant(created.id, variantBody.variant.id)).rejects.toMatchObject({ code: 'VIDEO_EDITORIAL_STALE' })
  const currentDeliveryProject = await service.getProject(created.id)
  const currentDeliveryTimeline = currentDeliveryProject.editorial_timeline_versions.find(version => version.id === currentDeliveryProject.current_editorial_timeline_version_id)!
  const executableVariant = await service.createDeliveryVariant(created.id, {
    name: '无关键帧的正式交付', editorial_timeline_version_id: currentDeliveryTimeline.id,
  }, 'delivery-variant-executable-key-0001')
  const compileUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-variants/${executableVariant.variant.id}/compile`)
  const compileResponse = await request(compileUrl, { method: 'POST' })
  expect(compileResponse.status).toBe(404)
  const compiled = await service.compileDeliveryVariant(created.id, executableVariant.variant.id)
  expect(compiled.plan).toMatchObject({
    editorial_timeline_version_id: currentDeliveryTimeline.id,
    delivery_variant_version_id: executableVariant.version.id,
    output_target: { kind: 'managed' },
    compiler_version: 'editorial-compiler-v1',
  })
  expect(compiled.plan.timeline_items).toEqual(expect.arrayContaining([
    expect.objectContaining({ order: 0, timeline_range: expect.any(Object) }),
  ]))
  expect(compiled.plan.filters).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'audio_fade' })]))
  expect(JSON.stringify(compiled.plan)).not.toContain(sourcePath)
  const command = buildExecutionPlanRenderCommand('ffmpeg', compiled.project, compiled.plan, join(root, 'execution-plan.mp4'))
  expect(command).toEqual(expect.arrayContaining(['-filter_complex']))
  expect(command.join(' ')).toContain('concat=n=1:v=1:a=0')
  expect(command.join(' ')).toContain('[aout]')
  // Output maps are a frozen routing decision. They must not merely describe
  // the plan while the compiler silently consumes a track that was muted or
  // mapped to a different output.
  const unmappedPrimary = structuredClone(compiled.plan)
  const primaryTrackId = compiled.plan.timeline_items.find(item => item.kind === 'video' && item.track_kind === 'primary_video')!.track_id
  unmappedPrimary.maps = unmappedPrimary.maps.filter(map => map.track_id !== primaryTrackId)
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', compiled.project, unmappedPrimary, join(root, 'unmapped-primary.mp4')))
    .toThrow('缺少视频输出映射')
  const sourceAudioTrackId = compiled.plan.timeline_items.find(item => item.kind === 'audio' && item.track_kind === 'source_audio')!.track_id
  const unmappedAudio = structuredClone(compiled.plan)
  unmappedAudio.maps = unmappedAudio.maps.filter(map => map.track_id !== sourceAudioTrackId)
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', compiled.project, unmappedAudio, join(root, 'unmapped-audio.mp4')))
    .toThrow('缺少冻结轨道输出映射')
  const mismappedPrimary = structuredClone(compiled.plan)
  mismappedPrimary.maps = mismappedPrimary.maps.map(map => map.track_id === primaryTrackId ? { ...map, output: 'audio' as const } : map)
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', compiled.project, mismappedPrimary, join(root, 'mismapped-primary.mp4')))
    .toThrow('输出映射与冻结轨道类型不一致')
  const duplicateMap = structuredClone(compiled.plan)
  duplicateMap.maps = [...duplicateMap.maps, duplicateMap.maps[0]!]
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', compiled.project, duplicateMap, join(root, 'duplicate-map.mp4')))
    .toThrow('未知或重复轨道')
  const inconsistentTrack = structuredClone(compiled.plan)
  const primaryItem = inconsistentTrack.timeline_items.find(item => item.track_id === primaryTrackId)!
  inconsistentTrack.timeline_items = [...inconsistentTrack.timeline_items, {
    ...primaryItem,
    item_id: 'item_inconsistent_track_0001',
    track_kind: 'source_audio',
    kind: 'audio',
  }]
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', compiled.project, inconsistentTrack, join(root, 'inconsistent-track.mp4')))
    .toThrow('同一轨道不能冻结为不同轨道类型')
  const voiceOver = structuredClone(compiled.plan)
  voiceOver.timeline_items = [...voiceOver.timeline_items, {
    ...primaryItem,
    item_id: 'item_voice_over_00000001',
    track_id: 'track_voice_over_00000001',
    track_kind: 'voice_over',
    kind: 'audio',
  }]
  voiceOver.maps = [...voiceOver.maps, { track_id: 'track_voice_over_00000001', output: 'audio' }]
  expect(() => buildExecutionPlanRenderCommand('ffmpeg', compiled.project, voiceOver, join(root, 'voice-over.mp4')))
    .toThrow('声音旁白轨尚未实现')

  // A/V is a structural invariant, not merely a ripple-delete convenience:
  // time-warping one side must fail, while an explicitly equal paired speed
  // reaches the immutable compiler input.
  const latestEditorialProject = await service.getProject(created.id)
  const latestTimeline = latestEditorialProject.editorial_timeline_versions.find(version => version.id === latestEditorialProject.current_editorial_timeline_version_id)!
  const latestVideo = latestTimeline.items.find(candidate => candidate.kind === 'video')!
  const latestAudio = latestTimeline.items.find(candidate => candidate.kind === 'audio')!
  if (latestVideo.binding.kind !== 'source') throw new Error('source expected')
  const sourceRange = { ...latestVideo.binding.source_range, duration: { ticks: '4000', tick_rate: tickRate } }
  const timelineRange = { ...latestVideo.timeline_range, duration: { ticks: '180000', tick_rate: { num: 90000, den: 1 } } }
  expect(() => editorial.applyCommandSet(latestEditorialProject, {
    id: 'command_speed_implicit_0001', project_id: created.id, actor_id: 'local', idempotency_key: 'speed-implicit-command-key-0001', created_at: at,
    target: { kind: 'editorial', base_timeline_version_id: latestTimeline.id },
    commands: [
      { kind: 'trim', item_id: latestVideo.id, source_range: sourceRange, timeline_range: timelineRange },
      { kind: 'trim', item_id: latestAudio.id, source_range: sourceRange, timeline_range: timelineRange },
    ],
  })).toThrow('必须显式声明 speed')
  expect(() => editorial.applyCommandSet(latestEditorialProject, {
    id: 'command_speed_unpaired_0001', project_id: created.id, actor_id: 'local', idempotency_key: 'speed-unpaired-command-key-0001', created_at: at,
    target: { kind: 'editorial', base_timeline_version_id: latestTimeline.id },
    commands: [{ kind: 'trim', item_id: latestVideo.id, source_range: sourceRange, timeline_range: timelineRange, speed: { num: 2, den: 1 } }],
  })).toThrow('A/V link')
  const paired = editorial.applyCommandSet(latestEditorialProject, {
    id: 'command_speed_paired_0001', project_id: created.id, actor_id: 'local', idempotency_key: 'speed-paired-command-key-0001', created_at: at,
    target: { kind: 'editorial', base_timeline_version_id: latestTimeline.id },
    commands: [
      { kind: 'trim', item_id: latestVideo.id, source_range: sourceRange, timeline_range: timelineRange, speed: { num: 2, den: 1 } },
      { kind: 'trim', item_id: latestAudio.id, source_range: sourceRange, timeline_range: timelineRange, speed: { num: 2, den: 1 } },
    ],
  })
  expect((paired.version as { items: Array<{ id: string; speed?: { num: number; den: number } }> }).items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: latestVideo.id, speed: { num: 2, den: 1 } }),
    expect.objectContaining({ id: latestAudio.id, speed: { num: 2, den: 1 } }),
  ]))
  service.repository.close()
})

test('版本化 Review Note 与 Approval 走 Editorial 唯一 writer、幂等回放和不可变处理事件', async () => {
  const root = await testRoot('review-approval')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at) })
  const created = await service.createProject({ title: 'Review 与审批' })
  const hash = `sha256:${'b'.repeat(64)}`
  const tickRate = { num: 1_000, den: 1 }
  const initialTimeline = {
    schema_version: 2 as const,
    id: 'timeline_00000001',
    project_revision: 1,
    source_fingerprint_set_hash: hash,
    facts_basis_hash: hash,
    tick_rate: tickRate,
    tracks: [{ id: 'track_00000001', kind: 'primary_video' as const, order: 0, locked: false, muted: false }],
    items: [{
      id: 'item_00000001',
      track_id: 'track_00000001',
      kind: 'video' as const,
      timeline_range: { start: rationalTime('0', tickRate), duration: rationalTime('10000', tickRate) },
      binding: {
        kind: 'source' as const,
        source_id: 'source_00000001',
        source_fingerprint: hash,
        source_range: { start: rationalTime('0', tickRate), duration: rationalTime('10000', tickRate) },
      },
      linked_camera_shot_ids: [],
      linked_content_segment_ids: [],
      locked: false,
      evidence_ids: [],
    }],
    created_by_command_set_id: 'command_00000001',
    created_at: at,
  }
  const resolvedTimeline = {
    ...initialTimeline,
    id: 'timeline_00000002',
    parent_version_id: initialTimeline.id,
    project_revision: 2,
    created_by_command_set_id: 'command_00000002',
  }
  await service.repository.saveProject({
    ...created,
    state: 'ready',
    revision: 1,
    editorial_timeline_versions: [initialTimeline, resolvedTimeline],
    current_editorial_timeline_version_id: initialTimeline.id,
  })
  const capability = 'capability_0123456789abcdef0123456789'
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const reviewUrl = new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${initialTimeline.id}/review-notes`)
  const reviewBody = {
    actor_id: 'creator_001',
    anchor: {
      kind: 'timeline_range',
      editorial_timeline_version_id: initialTimeline.id,
      range: { start: rationalTime('0', tickRate), duration: rationalTime('1000', tickRate) },
    },
    body: '00:00 到 00:01 需要换成更直接的镜头。',
  }

  const denied = await handler(new Request(reviewUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-note-denied-key-0001' }, body: JSON.stringify(reviewBody),
  }), reviewUrl, requestSegments(reviewUrl))
  expect(denied.status).toBe(403)

  const createdNote = await request(reviewUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-note-key-0001' }, body: JSON.stringify(reviewBody),
  })
  expect(createdNote.status).toBe(201)
  const createdNoteBody = await createdNote.json() as { note: { id: string; status: string; event_sequence: number }; reused: boolean; project: Record<string, unknown> }
  expect(createdNoteBody).toMatchObject({ reused: false, note: { status: 'open', event_sequence: 1 } })
  expect('review_resolutions' in createdNoteBody.project).toBeFalse()

  const unpinned = await request(reviewUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-note-unpinned-key-0001' }, body: JSON.stringify({ ...reviewBody, anchor: { kind: 'project' } }),
  })
  expect(unpinned.status).toBe(400)
  const outOfBounds = await request(reviewUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-note-out-of-bounds-key-0001' }, body: JSON.stringify({
      ...reviewBody,
      anchor: {
        ...reviewBody.anchor,
        range: { start: rationalTime('9900', tickRate), duration: rationalTime('1000', tickRate) },
      },
    }),
  })
  expect(outOfBounds.status).toBe(400)

  const replayedNote = await request(reviewUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-note-key-0001' }, body: JSON.stringify(reviewBody),
  })
  expect(replayedNote.status).toBe(200)
  expect(await replayedNote.json()).toMatchObject({ reused: true, note: { id: createdNoteBody.note.id } })
  const conflictingReplay = await request(reviewUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-note-key-0001' }, body: JSON.stringify({ ...reviewBody, body: '不同反馈' }),
  })
  expect(conflictingReplay.status).toBe(409)

  const approvalUrl = new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${initialTimeline.id}/approval`)
  const approvalBody = { actor_id: 'reviewer_001', state: 'changes_requested', note_ids: [createdNoteBody.note.id] }
  const approval = await request(approvalUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'approval-key-0001' }, body: JSON.stringify(approvalBody),
  })
  expect(approval.status).toBe(201)
  expect(await approval.json()).toMatchObject({ reused: false, decision: { state: 'changes_requested', event_sequence: 2, note_ids: [createdNoteBody.note.id] } })
  const approvalReplay = await request(approvalUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'approval-key-0001' }, body: JSON.stringify(approvalBody),
  })
  expect(approvalReplay.status).toBe(200)
  expect(await approvalReplay.json()).toMatchObject({ reused: true })

  const resolveUrl = new URL(`${reviewUrl}/${createdNoteBody.note.id}/resolve`)
  const resolutionBody = { actor_id: 'editor_001', state: 'addressed', resolved_by_timeline_version_id: resolvedTimeline.id }
  const resolution = await request(resolveUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-resolution-key-0001' }, body: JSON.stringify(resolutionBody),
  })
  expect(resolution.status).toBe(201)
  expect(await resolution.json()).toMatchObject({ reused: false, note: { id: createdNoteBody.note.id, status: 'addressed', resolved_by_timeline_version_id: resolvedTimeline.id, event_sequence: 1 } })
  const resolutionReplay = await request(resolveUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'review-resolution-key-0001' }, body: JSON.stringify(resolutionBody),
  })
  expect(resolutionReplay.status).toBe(200)
  expect(await resolutionReplay.json()).toMatchObject({ reused: true, note: { status: 'addressed' } })
  const finalNote = await request(reviewUrl)
  expect(finalNote.status).toBe(200)
  expect(await finalNote.json()).toMatchObject({ notes: [{ id: createdNoteBody.note.id, status: 'addressed', resolved_by_timeline_version_id: resolvedTimeline.id }] })

  const persisted = await service.getProject(created.id)
  expect(persisted.editorial_timeline_versions.map(item => item.id)).toEqual([initialTimeline.id, resolvedTimeline.id])
  expect(persisted.review_notes).toHaveLength(1)
  expect(persisted.review_resolutions).toHaveLength(1)
  expect(persisted.approval_decisions).toHaveLength(1)
  service.repository.close()
})

test('旧时间线选择、场景锁定和备选应用经由 CommandSet，且保留锁定与 A/V 规则', async () => {
  const root = await testRoot('legacy-command-bridge')
  const sourcePath = join(root, 'source.mp4')
  const outputPath = join(root, 'alternative-output.mp4')
  await writeFile(sourcePath, 'legacy command bridge fixture')
  const renderCommands: string[][] = []
  const runProcess = async (command: string[]) => {
    if (command.includes('-version') || command.includes('-encoders')) return { exitCode: 0, stdout: 'mpeg4', stderr: '' }
    if (command.includes('-show_format') && command.includes('-show_streams')) {
      return { exitCode: 0, stdout: JSON.stringify({ format: { duration: '2.000' }, streams: [{ codec_type: 'video', width: 640, height: 360, avg_frame_rate: '30/1' }, { codec_type: 'audio' }] }), stderr: '' }
    }
    if (command.includes('-filter_complex')) renderCommands.push(command)
    const output = command.at(-1)
    if (!output) return { exitCode: 1, stdout: '', stderr: 'missing output' }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, 'simulated output')
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux', runProcess })
  const created = await service.createProject({ title: '旧接口 CommandSet 桥接' })
  const fingerprint = await videoFingerprint(sourcePath)
  const identity = await fastVideoIdentity(sourcePath)
  const timeBase = mediaTimeBase(1, 1000)
  const tickRate = tickRateForTimeBase(timeBase)
  const revision = `sha256:${'a'.repeat(64)}`
  const sceneA = {
    id: 'scene_00000001',
    source_id: 'src_00000001',
    in_ms: 0,
    out_ms: 3_000,
    story_role: 'hook' as const,
    evidence_ids: [],
    rationale: '锁定开场',
    needs_review: false,
    locked: true,
  }
  const sceneB = {
    id: 'scene_00000002',
    source_id: 'src_00000001',
    in_ms: 3_000,
    out_ms: 6_000,
    story_role: 'result' as const,
    evidence_ids: [],
    rationale: '可替换结尾',
    needs_review: false,
    locked: false,
  }
  const sceneC = {
    id: 'scene_00000003',
    source_id: 'src_00000001',
    in_ms: 6_000,
    out_ms: 9_000,
    story_role: 'cta' as const,
    evidence_ids: [],
    rationale: '验证 A/V ripple 位移',
    needs_review: false,
    locked: false,
  }
  const selectedV1 = {
    id: 'timeline_00000001',
    project_revision: 1,
    evidence_revision: revision,
    scenes: [sceneA, sceneB, sceneC],
    created_at: at,
  }
  await service.repository.saveFact({
    id: 'src_00000001',
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
      ...sdrVideoColor(),
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('10000', tickRate),
    audio_tracks: [defaultAudioTrack(10_000)],
    state: 'ready',
    created_at: at,
    updated_at: at,
  })
  await service.repository.saveProject({
    ...created,
    state: 'ready',
    revision: 1,
    evidence_revision: revision,
    sources: [{
      id: 'src_00000001',
      path: sourcePath,
      name: 'source.mp4',
      duration_ms: 10_000,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      fingerprint,
      rotation: 0,
      video_stream_count: 1,
      audio_stream_count: 1,
      missing: false,
      content_changed: false,
    }],
    timeline: [
      { id: sceneA.id, source_id: sceneA.source_id, in_ms: sceneA.in_ms, out_ms: sceneA.out_ms },
      { id: sceneB.id, source_id: sceneB.source_id, in_ms: sceneB.in_ms, out_ms: sceneB.out_ms },
      { id: sceneC.id, source_id: sceneC.source_id, in_ms: sceneC.in_ms, out_ms: sceneC.out_ms },
    ],
    timeline_versions: [selectedV1],
    current_timeline_version_id: selectedV1.id,
    alternatives: [{
      id: 'alternative_00000001',
      base_timeline_version_id: selectedV1.id,
      label: '保留锁定开场',
      tradeoff: '替换结尾节奏',
      scenes: [
        sceneA,
        { ...sceneB, id: 'scene_00000004', in_ms: 3_000, out_ms: 6_000, rationale: '替换结尾' },
      ],
    }],
  })

  await expect(service.getEditorialTimeline(created.id, 'timeline_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  const initial = await service.getProject(created.id)
  const initialEditorial = initial.editorial_timeline_versions.find(version => version.id === initial.current_editorial_timeline_version_id)!
  expect(initialEditorial.items.filter(item => item.legacy_scene_id === sceneA.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'video', locked: true }),
    expect.objectContaining({ kind: 'audio', locked: true }),
  ]))

  const capability = 'capability_0123456789abcdef0123456789'
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const sceneBItems = initialEditorial.items.filter(item => item.legacy_scene_id === sceneB.id)
  const partialRipple = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${initialEditorial.id}/commands`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'partial-av-ripple-command-0001' },
    body: JSON.stringify({ commands: [{ kind: 'ripple_delete', item_ids: [sceneBItems.find(item => item.kind === 'video')!.id], close_gap: true }] }),
  })
  expect(partialRipple.status).toBe(400)
  const fullRipple = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${initialEditorial.id}/commands`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'full-av-ripple-command-0001' },
    body: JSON.stringify({ commands: [{ kind: 'ripple_delete', item_ids: sceneBItems.map(item => item.id), close_gap: true }] }),
  })
  expect(fullRipple.status).toBe(200)
  const afterRipple = await service.getProject(created.id)
  const rippledTimeline = afterRipple.editorial_timeline_versions.find(version => version.id === afterRipple.current_editorial_timeline_version_id)!
  expect(rippledTimeline.items.filter(item => item.legacy_scene_id === sceneC.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'video', timeline_range: expect.objectContaining({ start: expect.objectContaining({ ticks: '270000' }) }) }),
    expect.objectContaining({ kind: 'audio', timeline_range: expect.objectContaining({ start: expect.objectContaining({ ticks: '270000' }) }) }),
  ]))
  const appliedAlternative = await request(new URL(`http://localhost/api/videos/projects/${created.id}/alternatives/alternative_00000001/apply`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: afterRipple.revision }),
  })
  expect(appliedAlternative.status).toBe(200)
  const afterAlternative = await service.getProject(created.id)
  // Legacy Timeline stays a read-compatible projection. Applying an old
  // alternative creates only the formal Editorial Version through CommandSet.
  expect(afterAlternative.timeline_versions).toHaveLength(1)
  expect(afterAlternative.timeline.map(clip => clip.id)).toEqual([sceneA.id, sceneB.id, sceneC.id])
  expect(afterAlternative.current_timeline_version_id).toBe(selectedV1.id)
  const alternativeEditorial = afterAlternative.editorial_timeline_versions.find(version => version.id === afterAlternative.current_editorial_timeline_version_id)!
  expect(alternativeEditorial.id).not.toBe(initialEditorial.id)
  expect(alternativeEditorial.items.filter(item => item.kind === 'video').map(item => item.legacy_scene_id)).toEqual([sceneA.id, 'scene_00000004'])
  expect(alternativeEditorial.items.filter(item => item.legacy_scene_id === sceneA.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'video', locked: true }),
    expect.objectContaining({ kind: 'audio', locked: true }),
  ]))
  const preview = await request(new URL(`http://localhost/api/videos/projects/${created.id}/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: afterAlternative.revision, timeline_version_id: alternativeEditorial.id }),
  })
  expect(preview.status).toBe(404)
  const render = await request(new URL(`http://localhost/api/videos/projects/${created.id}/render`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ base_revision: afterAlternative.revision, timeline_version_id: alternativeEditorial.id, output_path: outputPath }),
  })
  expect(render.status).toBe(404)
  const select = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timeline/versions/${selectedV1.id}/select`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: afterAlternative.revision }),
  })
  expect(select.status).toBe(200)
  const afterSelect = await service.getProject(created.id)
  expect(afterSelect.timeline_versions).toHaveLength(1)
  expect(afterSelect.current_timeline_version_id).toBe(selectedV1.id)
  expect(afterSelect.current_editorial_timeline_version_id).not.toBe(initialEditorial.id)

  const selectedEditorial = afterSelect.editorial_timeline_versions.find(version => version.id === afterSelect.current_editorial_timeline_version_id)!
  const lockedVideo = selectedEditorial.items.find(item => item.legacy_scene_id === sceneA.id && item.kind === 'video')!
  if (lockedVideo.binding.kind !== 'source') throw new Error('fixture must create a source-bound video item')
  const lockedTrim = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${selectedEditorial.id}/commands`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'locked-trim-command-0001' },
    body: JSON.stringify({
      commands: [{
        kind: 'trim',
        item_id: lockedVideo.id,
        source_range: lockedVideo.binding.source_range,
        timeline_range: lockedVideo.timeline_range,
      }],
    }),
  })
  expect(lockedTrim.status).toBe(409)

  const relock = await request(new URL(`http://localhost/api/videos/projects/${created.id}/scenes/${sceneA.id}/lock`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: afterSelect.revision, timeline_version_id: selectedV1.id, locked: true }),
  })
  expect(relock.status).toBe(200)
  const afterRelock = await service.getProject(created.id)
  expect(afterRelock.timeline_versions).toHaveLength(1)
  expect(afterRelock.editorial_timeline_versions).toHaveLength(initial.editorial_timeline_versions.length + 4)
  service.repository.close()
})

test('无音轨的多场景 Draft 按场景标识保留证据，而非按 A/V 条目索引错配', async () => {
  const root = await testRoot('silent-draft-evidence')
  const firstPath = join(root, 'first.mp4')
  const secondPath = join(root, 'second.mp4')
  await Promise.all([writeFile(firstPath, 'first silent source'), writeFile(secondPath, 'second silent source')])
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux' })
  const created = await service.createProject({ title: '无音轨草稿证据' })
  const [firstFingerprint, secondFingerprint] = await Promise.all([videoFingerprint(firstPath), videoFingerprint(secondPath)])
  const [firstIdentity, secondIdentity] = await Promise.all([fastVideoIdentity(firstPath), fastVideoIdentity(secondPath)])
  const timeBase = mediaTimeBase(1, 1000)
  const tickRate = tickRateForTimeBase(timeBase)
  await Promise.all([
    service.repository.saveFact({
      id: 'src_00000011', project_id: created.id, path: firstPath, name: 'first.mp4', fast_identity: firstIdentity, fingerprint: firstFingerprint, fingerprint_state: 'ready',
      primary_video_stream: { stream_index: 0, time_base: timeBase, start_time: rationalTime('0', tickRate), duration: rationalTime('5000', tickRate), codec: 'h264', width: 1920, height: 1080, rotation: 0, ...sdrVideoColor(), variable_frame_rate: false },
      presentation_duration: rationalTime('5000', tickRate), audio_tracks: [], state: 'ready', created_at: at, updated_at: at,
    }),
    service.repository.saveFact({
      id: 'src_00000012', project_id: created.id, path: secondPath, name: 'second.mp4', fast_identity: secondIdentity, fingerprint: secondFingerprint, fingerprint_state: 'ready',
      primary_video_stream: { stream_index: 0, time_base: timeBase, start_time: rationalTime('0', tickRate), duration: rationalTime('5000', tickRate), codec: 'h264', width: 1920, height: 1080, rotation: 0, ...sdrVideoColor(), variable_frame_rate: false },
      presentation_duration: rationalTime('5000', tickRate), audio_tracks: [], state: 'ready', created_at: at, updated_at: at,
    }),
  ])
  await service.repository.saveProject({
    ...created,
    state: 'ready',
    revision: 1,
    sources: [
      { id: 'src_00000011', path: firstPath, name: 'first.mp4', duration_ms: 5_000, width: 1920, height: 1080, fps: 30, has_audio: false, fingerprint: firstFingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 0, missing: false, content_changed: false },
      { id: 'src_00000012', path: secondPath, name: 'second.mp4', duration_ms: 5_000, width: 1920, height: 1080, fps: 30, has_audio: false, fingerprint: secondFingerprint, rotation: 0, video_stream_count: 1, audio_stream_count: 0, missing: false, content_changed: false },
    ],
    timeline: [
      { id: 'clip_00000011', source_id: 'src_00000011', in_ms: 0, out_ms: 5_000 },
      { id: 'clip_00000012', source_id: 'src_00000012', in_ms: 0, out_ms: 5_000 },
    ],
  })
  await expect(service.getEditorialTimeline(created.id, 'timeline_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  const project = await service.getProject(created.id)
  const draft = new EditorialApplication(() => new Date(at)).createDraft(project, [
    { id: 'scene_00000011', source_id: 'src_00000011', in_ms: 0, out_ms: 5_000, story_role: 'hook', evidence_ids: ['evidence_00000011'], rationale: '第一段', needs_review: false, locked: false },
    { id: 'scene_00000012', source_id: 'src_00000012', in_ms: 0, out_ms: 5_000, story_role: 'result', evidence_ids: ['evidence_00000012'], rationale: '第二段', needs_review: false, locked: false },
  ], new Map())
  expect(draft.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ legacy_scene_id: 'scene_00000011', kind: 'video', evidence_ids: ['evidence_00000011'] }),
    expect.objectContaining({ legacy_scene_id: 'scene_00000012', kind: 'video', evidence_ids: ['evidence_00000012'] }),
  ]))
  expect(draft.items.filter(item => item.kind === 'audio')).toHaveLength(0)
  service.repository.close()
})

test('编辑 API 拒绝越界素材与锁定目标轨道，旧 Timeline Preview/Render 只保留读取兼容', async () => {
  const root = await testRoot('editorial-bounds-and-legacy-preview')
  const sourcePath = join(root, 'source.mp4')
  const outputPath = join(root, 'export.mp4')
  await writeFile(sourcePath, 'editorial bounds fixture')
  const renderCommands: string[][] = []
  const runProcess = async (command: string[]) => {
    if (command.includes('-version') || command.includes('-encoders')) {
      return { exitCode: 0, stdout: 'mpeg4', stderr: '' }
    }
    if (command.includes('-show_format') && command.includes('-show_streams')) {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: '2.000' },
          streams: [{ codec_type: 'video', width: 640, height: 360, avg_frame_rate: '30/1' }, { codec_type: 'audio' }],
        }),
        stderr: '',
      }
    }
    if (command.includes('-filter_complex')) renderCommands.push(command)
    const output = command.at(-1)
    if (!output) return { exitCode: 1, stdout: '', stderr: 'missing output' }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, 'simulated output')
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux', runProcess })
  const created = await service.createProject({ title: '范围与正式投影 API' })
  const fingerprint = await videoFingerprint(sourcePath)
  const identity = await fastVideoIdentity(sourcePath)
  const timeBase = mediaTimeBase(1, 1000)
  const tickRate = tickRateForTimeBase(timeBase)
  const sourceId = 'src_00000021'
  const firstClip = { id: 'clip_00000021', source_id: sourceId, in_ms: 0, out_ms: 1_000 }
  const secondClip = { id: 'clip_00000022', source_id: sourceId, in_ms: 1_000, out_ms: 2_000 }
  const initialVersionId = 'timeline_00000021'
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
      start_time: rationalTime('100', tickRate),
      duration: rationalTime('3000', tickRate),
      codec: 'h264',
      width: 1920,
      height: 1080,
      rotation: 0,
      ...sdrVideoColor(),
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('10000', tickRate),
    audio_tracks: [defaultAudioTrack(3_000)],
    state: 'ready',
    created_at: at,
    updated_at: at,
  })
  await service.repository.saveProject({
    ...created,
    state: 'ready',
    revision: 1,
    evidence_revision: `sha256:${'b'.repeat(64)}`,
    sources: [{
      id: sourceId,
      path: sourcePath,
      name: 'source.mp4',
      duration_ms: 10_000,
      width: 1920,
      height: 1080,
      fps: 30,
      has_audio: true,
      fingerprint,
      rotation: 0,
      video_stream_count: 1,
      audio_stream_count: 1,
      missing: false,
      content_changed: false,
    }],
    timeline: [firstClip, secondClip],
    timeline_versions: [{
      id: initialVersionId,
      project_revision: 1,
      evidence_revision: `sha256:${'b'.repeat(64)}`,
      scenes: [
        { ...firstClip, story_role: 'hook', evidence_ids: [], rationale: '第一段', needs_review: false, locked: false },
        { ...secondClip, story_role: 'result', evidence_ids: [], rationale: '第二段', needs_review: false, locked: false },
      ],
      created_at: at,
    }],
    current_timeline_version_id: initialVersionId,
  })

  await expect(service.getEditorialTimeline(created.id, 'timeline_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  let project = await service.getProject(created.id)
  const baseTimeline = project.editorial_timeline_versions.find(version => version.id === project.current_editorial_timeline_version_id)!
  const lockedMusicTrack = { id: 'track_music_00000021', kind: 'music' as const, order: 2, locked: true, muted: false }
  await service.repository.saveProject({
    ...project,
    editorial_timeline_versions: project.editorial_timeline_versions.map(version => version.id === baseTimeline.id
      ? { ...version, tracks: [...version.tracks, lockedMusicTrack] }
      : version),
  })
  project = await service.getProject(created.id)
  const timeline = project.editorial_timeline_versions.find(version => version.id === project.current_editorial_timeline_version_id)!
  const videoItem = timeline.items.find(item => item.kind === 'video')!
  const audioItem = timeline.items.find(item => item.kind === 'audio')!
  if (videoItem.binding.kind !== 'source') throw new Error('fixture must create a source-bound video item')

  const capability = 'capability_0123456789abcdef0123456789'
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  const commandsUrl = new URL(`http://localhost/api/videos/projects/${created.id}/timelines/${timeline.id}/commands`)
  const outOfBounds = await request(commandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'out-of-bounds-source-command-0001' },
    body: JSON.stringify({
      commands: [{
        kind: 'trim',
        item_id: videoItem.id,
        // Presentation duration is 10s, but the actual primary video stream
        // ends at PTS 3100. This must be rejected from the primary bound.
        source_range: { start: { ticks: '3100', tick_rate: tickRate }, duration: { ticks: '1', tick_rate: tickRate } },
        timeline_range: videoItem.timeline_range,
      }],
    }),
  })
  expect(outOfBounds.status).toBe(400)
  const beforeStart = await request(commandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'before-source-start-command-0001' },
    body: JSON.stringify({
      commands: [{
        kind: 'trim',
        item_id: videoItem.id,
        source_range: { start: { ticks: '99', tick_rate: tickRate }, duration: { ticks: '1', tick_rate: tickRate } },
        timeline_range: videoItem.timeline_range,
      }],
    }),
  })
  expect(beforeStart.status).toBe(400)
  const originalGetFact = service.repository.getFact.bind(service.repository)
  service.repository.getFact = async () => {
    throw new Error('simulated fact storage failure')
  }
  const factReadFailure = await request(commandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'fact-read-failure-command-0001' },
    body: JSON.stringify({
      commands: [{ kind: 'set_track_state', track_id: timeline.tracks[0]!.id, muted: false }],
    }),
  })
  expect(factReadFailure.status).toBe(503)
  service.repository.getFact = originalGetFact

  const moveToLocked = await request(commandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'move-to-locked-track-command-0001' },
    body: JSON.stringify({
      commands: [{ kind: 'reorder', item_id: audioItem.id, track_id: lockedMusicTrack.id, timeline_start: audioItem.timeline_range.start }],
    }),
  })
  expect(moveToLocked.status).toBe(409)

  const replaceToLocked = await request(commandsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'replace-to-locked-track-command-0001' },
    body: JSON.stringify({
      commands: [{ kind: 'replace', item_id: audioItem.id, replacement: { ...audioItem, track_id: lockedMusicTrack.id } }],
    }),
  })
  expect(replaceToLocked.status).toBe(409)

  const updatedClips = [
    { id: secondClip.id, source_id: sourceId, in_ms: 2_000, out_ms: 3_000 },
    firstClip,
  ]
  const updated = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timeline`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: project.revision, base_timeline_version_id: initialVersionId, clips: updatedClips }),
  })
  expect(updated.status).toBe(200)
  const afterUpdate = await service.getProject(created.id)
  const formalVersion = afterUpdate.editorial_timeline_versions.find(version => version.id === afterUpdate.current_editorial_timeline_version_id)!
  expect(formalVersion.id).not.toBe(baseTimeline.id)
  expect(formalVersion.items.filter(item => item.kind === 'video').map(item => item.legacy_scene_id)).toEqual([secondClip.id, firstClip.id])
  expect(afterUpdate.timeline_versions).toHaveLength(1)
  expect(afterUpdate.current_timeline_version_id).toBe(initialVersionId)
  expect(afterUpdate.timeline).toEqual([firstClip, secondClip])

  const preview = await request(new URL(`http://localhost/api/videos/projects/${created.id}/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: afterUpdate.revision, timeline_version_id: formalVersion.id }),
  })
  expect(preview.status).toBe(404)

  const render = await request(new URL(`http://localhost/api/videos/projects/${created.id}/render`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ base_revision: afterUpdate.revision, timeline_version_id: formalVersion.id, output_path: outputPath }),
  })
  expect(render.status).toBe(404)
  service.repository.close()
})

test('交付意图、范围、分层规划和创作 Proposal 只经 Editorial API 持久化，接受时才生成可重放 CommandSet 版本', async () => {
  const root = await testRoot('delivery-intent-creative-api')
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'creative-planning-source')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux' })
  const created = await service.createProject({ title: '创作规划 API' })
  const fingerprint = await videoFingerprint(sourcePath)
  const identity = await fastVideoIdentity(sourcePath)
  const timeBase = mediaTimeBase(1, 1_000)
  const tickRate = tickRateForTimeBase(timeBase)
  const sourceId = 'src_00000091'
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
      ...sdrVideoColor(),
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('20000', tickRate),
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
      duration_ms: 20_000,
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
    timeline: [{ id: 'clip_00000091', source_id: sourceId, in_ms: 0, out_ms: 10_000 }],
  })
  await service.repository.saveFact({
    id: 'segment_00000091',
    project_id: created.id,
    source_id: sourceId,
    source_fingerprint: fingerprint,
    range: { start: rationalTime('0', tickRate), duration: rationalTime('10000', tickRate) },
    camera_shot_ids: [],
    segmentation_source: 'manual',
    created_at: at,
  })
  await expect(service.getEditorialTimeline(created.id, 'timeline_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  const capability = 'capability_0123456789abcdef0123456789'
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }

  let project = await service.getProject(created.id)
  const intentUrl = new URL(`http://localhost/api/videos/projects/${created.id}/delivery-intent`)
  const intentResponse = await request(intentUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_revision: project.revision,
      goal: '保留完整的一次击球过程',
      duration_mode: 'natural',
      coverage_preference: 'complete_when_feasible',
      editing_strategy: 'manual',
    }),
  })
  expect(intentResponse.status).toBe(200)
  expect(await intentResponse.json()).toMatchObject({ intent: { duration_mode: 'natural' }, feasibility: { fit_status: 'fit' } })

  project = await service.getProject(created.id)
  const outOfPrimary = await request(new URL(`http://localhost/api/videos/projects/${created.id}/range-decisions`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'range-decision-invalid-0001' },
    body: JSON.stringify({
      base_revision: project.revision,
      source_id: sourceId,
      source_fingerprint: fingerprint,
      range: { start: rationalTime('10000', tickRate), duration: rationalTime('1', tickRate) },
      decision: 'pick',
    }),
  })
  expect(outOfPrimary.status).toBe(400)

  const decision = await request(new URL(`http://localhost/api/videos/projects/${created.id}/range-decisions`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'range-decision-required-0001' },
    body: JSON.stringify({
      base_revision: project.revision,
      source_id: sourceId,
      source_fingerprint: fingerprint,
      range: { start: rationalTime('0', tickRate), duration: rationalTime('10000', tickRate) },
      decision: 'required',
    }),
  })
  expect(decision.status).toBe(201)

  project = await service.getProject(created.id)
  const plansBody = { base_revision: project.revision }
  const plansResponse = await request(new URL(`http://localhost/api/videos/projects/${created.id}/editorial-plans`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'editorial-plans-api-key-0001' },
    body: JSON.stringify(plansBody),
  })
  expect(plansResponse.status).toBe(201)
  expect((await plansResponse.json() as { plans: Array<{ kind: string }> }).plans.map(plan => plan.kind)).toEqual(['outline', 'chapter', 'global_review'])
  const plansReplay = await request(new URL(`http://localhost/api/videos/projects/${created.id}/editorial-plans`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'editorial-plans-api-key-0001' },
    body: JSON.stringify(plansBody),
  })
  expect(plansReplay.status).toBe(200)
  expect(await plansReplay.json()).toMatchObject({ reused: true, plans: [{ kind: 'outline' }, { kind: 'chapter' }, { kind: 'global_review' }] })

  project = await service.getProject(created.id)
  const beforeQuickCreateTimeline = project.current_editorial_timeline_version_id
  const beforeQuickCreateVersions = project.editorial_timeline_versions.length
  const quickCreateUrl = new URL(`http://localhost/api/videos/projects/${created.id}/quick-create`)
  const quickCreateBody = { base_revision: project.revision, max_candidates: 3 }
  const quickCreated = await request(quickCreateUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'quick-create-api-key-0001' },
    body: JSON.stringify(quickCreateBody),
  })
  expect(quickCreated.status).toBe(201)
  const quickCreate = await quickCreated.json() as { batch: { candidates: Array<{ draft_id: string }>; explanation: string }; drafts: Array<{ id: string; status: string }>; reused: boolean }
  expect(quickCreate).toMatchObject({ reused: false, drafts: [{ status: 'proposed' }] })
  expect(quickCreate.batch.candidates).toHaveLength(1)
  expect(quickCreate.batch.explanation).toContain('一个保守候选')
  const afterQuickCreate = await service.getProject(created.id)
  expect(afterQuickCreate.current_editorial_timeline_version_id).toBe(beforeQuickCreateTimeline)
  expect(afterQuickCreate.editorial_timeline_versions).toHaveLength(beforeQuickCreateVersions)
  const quickReplay = await request(quickCreateUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'quick-create-api-key-0001' },
    body: JSON.stringify(quickCreateBody),
  })
  expect(quickReplay.status).toBe(200)
  expect(await quickReplay.json()).toMatchObject({ reused: true, drafts: [{ id: quickCreate.drafts[0]!.id }] })

  const sessionResponse = await request(new URL(`http://localhost/api/videos/projects/${created.id}/creative-sessions`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'creative-session-api-key-0001' },
    body: JSON.stringify({ title: '手动调整建议' }),
  })
  expect(sessionResponse.status).toBe(201)
  const session = await sessionResponse.json() as { session: { id: string } }
  project = await service.getProject(created.id)
  const beforeTimeline = project.current_editorial_timeline_version_id!
  const beforeVersions = project.editorial_timeline_versions.length
  const timeline = project.editorial_timeline_versions.find(item => item.id === beforeTimeline)!
  const proposalResponse = await request(new URL(`http://localhost/api/videos/projects/${created.id}/creative-sessions/${session.session.id}/messages`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'creative-message-api-key-0001' },
    body: JSON.stringify({
      text: '给这个片段增加人工锁定',
      anchors: [{ kind: 'content_segment', content_segment_id: 'segment_00000091' }],
      proposal: {
        kind: 'timeline_patch',
        summary: '锁定视频轨道',
        rationale: ['保留用户确认的镜头结构'],
        proposed_command_set: {
          id: 'command_00000091',
          project_id: created.id,
          actor_id: 'video-owner',
          idempotency_key: 'proposal-template-command-0001',
          created_at: at,
          target: { kind: 'editorial', base_timeline_version_id: timeline.id },
          commands: [{ kind: 'set_track_state', track_id: timeline.tracks.find(track => track.kind === 'primary_video')!.id, locked: true }],
        },
      },
    }),
  })
  expect(proposalResponse.status).toBe(201)
  const proposal = await proposalResponse.json() as { proposal: { id: string; status: string } }
  expect(proposal.proposal.status).toBe('proposed')
  const afterProposal = await service.getProject(created.id)
  expect(afterProposal.current_editorial_timeline_version_id).toBe(beforeTimeline)
  expect(afterProposal.editorial_timeline_versions).toHaveLength(beforeVersions)

  const acceptUrl = new URL(`http://localhost/api/videos/projects/${created.id}/creative-proposals/${proposal.proposal.id}/accept`)
  const acceptBody = { base_revision: afterProposal.revision }
  const accepted = await request(acceptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'creative-proposal-accept-0001' },
    body: JSON.stringify(acceptBody),
  })
  expect(accepted.status).toBe(200)
  const acceptedBody = await accepted.json() as { timeline: { id: string; parent_version_id: string }; proposal: { status: string }; reused: boolean }
  expect(acceptedBody).toMatchObject({ proposal: { status: 'accepted' }, reused: false, timeline: { parent_version_id: beforeTimeline } })

  const replay = await request(acceptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'creative-proposal-accept-0001' },
    body: JSON.stringify(acceptBody),
  })
  expect(replay.status).toBe(200)
  expect(await replay.json()).toMatchObject({ reused: true, timeline: { id: acceptedBody.timeline.id }, proposal: { status: 'accepted' } })
  const differentReplay = await request(acceptUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'creative-proposal-accept-other-0001' },
    body: JSON.stringify(acceptBody),
  })
  expect(differentReplay.status).toBe(409)
  service.repository.close()
})
