import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { fastVideoIdentity, videoFingerprint } from '../src/server/services/videoExecution.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { EditorialApplication } from '../src/server/video/domain/editorial/editorialApplication.js'
import { mediaTimeBase, rationalTime, tickRateForTimeBase } from '../src/server/video/domain/mediaFacts/time.js'

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
      has_audio: false,
      fingerprint,
      rotation: 0,
      video_stream_count: 1,
      audio_stream_count: 0,
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
    delivery_variant_version_id: variantCommandBody.version.id,
    output_target: { kind: 'managed' },
    compiler_version: 'editorial-compiler-v1',
  })
  expect(JSON.stringify(compiled.plan)).not.toContain(sourcePath)
  service.repository.close()
})
