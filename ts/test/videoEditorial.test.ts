import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { fastVideoIdentity, videoFingerprint } from '../src/server/services/videoExecution.js'
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
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('10000', tickRate),
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
  const handler = createVideoWorkbenchDomainApiHandler(service)
  const request = async (url: URL, init: RequestInit = {}) => await handler(new Request(url, init), url, requestSegments(url))

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
      base_variant_version_id: variantCommandBody.version.id,
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

  const compiled = await service.compileDeliveryVariant(created.id, variantBody.variant.id)
  expect(compiled.plan).toMatchObject({
    editorial_timeline_version_id: firstCommandBody.timeline.id,
    delivery_variant_version_id: fadedVariantBody.version.id,
    output_target: { kind: 'managed' },
    compiler_version: 'editorial-compiler-v1',
  })
  expect(compiled.plan.timeline_items).toEqual(expect.arrayContaining([
    expect.objectContaining({ order: 0, item_id: item.id, timeline_range: item.timeline_range }),
  ]))
  expect(compiled.plan.filters).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'audio_fade', item_id: audioItem.id }),
  ]))
  expect(JSON.stringify(compiled.plan)).not.toContain(sourcePath)
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
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('10000', tickRate),
    audio_tracks: [],
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
  const request = async (url: URL, init: RequestInit = {}) => await handler(new Request(url, init), url, requestSegments(url))
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
  expect(afterAlternative.timeline_versions).toHaveLength(2)
  expect(afterAlternative.timeline.map(clip => clip.id)).toEqual([sceneA.id, 'scene_00000004'])
  const alternativeFormalVersion = afterAlternative.timeline_versions.find(version => version.id === afterAlternative.current_timeline_version_id)!
  expect(alternativeFormalVersion.id).not.toBe(selectedV1.id)
  expect(alternativeFormalVersion.scenes.map(scene => scene.id)).toEqual([sceneA.id, 'scene_00000004'])
  const alternativeEditorial = afterAlternative.editorial_timeline_versions.find(version => version.id === afterAlternative.current_editorial_timeline_version_id)!
  expect(alternativeEditorial.items.filter(item => item.legacy_scene_id === sceneA.id)).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'video', locked: true }),
    expect.objectContaining({ kind: 'audio', locked: true }),
  ]))
  const preview = await request(new URL(`http://localhost/api/videos/projects/${created.id}/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: afterAlternative.revision, timeline_version_id: alternativeFormalVersion.id }),
  })
  expect(preview.status).toBe(202)
  const previewTask = await preview.json() as { task: { id: string } }
  expect((await waitForTerminalOperation(service, previewTask.task.id)).status).toBe('succeeded')
  const render = await request(new URL(`http://localhost/api/videos/projects/${created.id}/render`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ base_revision: afterAlternative.revision, timeline_version_id: alternativeFormalVersion.id, output_path: outputPath }),
  })
  expect(render.status).toBe(202)
  const renderTask = await render.json() as { task: { id: string } }
  expect((await waitForTerminalOperation(service, renderTask.task.id)).status).toBe('succeeded')
  expect(renderCommands).toHaveLength(2)
  for (const command of renderCommands) {
    const sourceOffsets = command.flatMap((value, index) => value === '-ss' ? [command[index + 1]!] : [])
    expect(sourceOffsets).toEqual(['0.000', '3.000'])
  }
  const select = await request(new URL(`http://localhost/api/videos/projects/${created.id}/timeline/versions/${selectedV1.id}/select`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: afterAlternative.revision }),
  })
  expect(select.status).toBe(200)
  const afterSelect = await service.getProject(created.id)
  expect(afterSelect.timeline_versions).toHaveLength(2)
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
  expect(afterRelock.timeline_versions).toHaveLength(2)
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
      primary_video_stream: { stream_index: 0, time_base: timeBase, start_time: rationalTime('0', tickRate), duration: rationalTime('5000', tickRate), codec: 'h264', width: 1920, height: 1080, rotation: 0, variable_frame_rate: false },
      presentation_duration: rationalTime('5000', tickRate), audio_tracks: [], state: 'ready', created_at: at, updated_at: at,
    }),
    service.repository.saveFact({
      id: 'src_00000012', project_id: created.id, path: secondPath, name: 'second.mp4', fast_identity: secondIdentity, fingerprint: secondFingerprint, fingerprint_state: 'ready',
      primary_video_stream: { stream_index: 0, time_base: timeBase, start_time: rationalTime('0', tickRate), duration: rationalTime('5000', tickRate), codec: 'h264', width: 1920, height: 1080, rotation: 0, variable_frame_rate: false },
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

test('编辑 API 拒绝越界素材与锁定目标轨道，并让旧 Timeline Version 驱动 Preview/Render', async () => {
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
      variable_frame_rate: false,
    },
    presentation_duration: rationalTime('10000', tickRate),
    audio_tracks: [],
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
  const request = async (url: URL, init: RequestInit = {}) => await handler(new Request(url, init), url, requestSegments(url))
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
  const formalVersion = afterUpdate.timeline_versions.find(version => version.id === afterUpdate.current_timeline_version_id)!
  expect(formalVersion.id).not.toBe(initialVersionId)
  expect(formalVersion.scenes.map(scene => [scene.id, scene.in_ms, scene.out_ms])).toEqual([
    [secondClip.id, 2_000, 3_000],
    [firstClip.id, 0, 1_000],
  ])
  expect(afterUpdate.timeline).toEqual(updatedClips)

  const preview = await request(new URL(`http://localhost/api/videos/projects/${created.id}/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_revision: afterUpdate.revision, timeline_version_id: formalVersion.id }),
  })
  expect(preview.status).toBe(202)
  const previewTask = await preview.json() as { task: { id: string } }
  expect((await waitForTerminalOperation(service, previewTask.task.id)).status).toBe('succeeded')

  const render = await request(new URL(`http://localhost/api/videos/projects/${created.id}/render`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ base_revision: afterUpdate.revision, timeline_version_id: formalVersion.id, output_path: outputPath }),
  })
  expect(render.status).toBe(202)
  const renderTask = await render.json() as { task: { id: string } }
  expect((await waitForTerminalOperation(service, renderTask.task.id)).status).toBe('succeeded')
  expect(renderCommands).toHaveLength(2)
  for (const command of renderCommands) {
    const sourceOffsets = command.flatMap((value, index) => value === '-ss' ? [command[index + 1]!] : [])
    expect(sourceOffsets).toEqual(['2.000', '0.000'])
  }
  service.repository.close()
})
