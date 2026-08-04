import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler, publicVideoProject } from '../src/server/api/videoWorkbench.js'
import { fastVideoIdentity, videoFingerprint } from '../src/server/services/videoExecution.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { mediaTimeBase, rationalTime, tickRateForTimeBase } from '../src/server/video/domain/mediaFacts/time.js'
import { MEDIA_UI_CAPABILITY_HEADER, type VideoExportProfileRevision } from '../shared/contracts/media.js'

const roots: string[] = []
const at = '2026-08-05T00:00:00.000Z'
const capability = 'capability_0123456789abcdef0123456789'

async function testRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `billiardbuddy-delivery-boundary-${label}-`))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

function requestSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part)
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function revisedProfile(
  base: VideoExportProfileRevision,
  values: Pick<VideoExportProfileRevision, 'id' | 'profile_id' | 'revision' | 'target' | 'width' | 'height'>,
): VideoExportProfileRevision {
  const { content_hash: _contentHash, ...withoutHash } = { ...base, ...values }
  return { ...withoutHash, content_hash: sha256(JSON.stringify(withoutHash)) }
}

async function seededService(root: string) {
  const sourcePath = join(root, 'source.mp4')
  await writeFile(sourcePath, 'delivery-boundary-source')
  const service = new VideoWorkbenchService({
    root,
    now: () => new Date(at),
    platform: 'linux',
    runProcess: async command => {
      if (command.includes('-version')) return { exitCode: 0, stdout: 'ffmpeg fake', stderr: '' }
      if (command.includes('-encoders')) return { exitCode: 0, stdout: ' libx264 ', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  const created = await service.createProject({ title: '交付边界回归' })
  const fingerprint = await videoFingerprint(sourcePath)
  const identity = await fastVideoIdentity(sourcePath)
  const timeBase = mediaTimeBase(1, 1_000)
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
      color_space: 'bt709',
      color_transfer: 'bt709',
      color_primaries: 'bt709',
      color_range: 'tv',
      pixel_format: 'yuv420p',
      hdr_kind: 'sdr',
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
  // The first editor read performs the one-time legacy-to-editorial projection.
  await expect(service.getEditorialTimeline(created.id, 'timeline_missing')).rejects.toMatchObject({ code: 'VIDEO_TIMELINE_MISSING' })
  return { service, created }
}

test('公开视频 DTO 不投影绝对本地路径，所有视频写路由都要求桌面能力令牌', async () => {
  const root = await testRoot('api-capability')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux' })
  const stored = await service.createProject({ title: '安全 DTO' })
  const outputPath = '/private/export/never-public.mp4'
  const workspaceRoot = '/private/workspace/never-public'
  await service.repository.saveProject({ ...stored, output_path: outputPath, workspace_root: workspaceRoot })
  const directProjection = publicVideoProject(await service.getProject(stored.id))
  expect(directProjection).not.toHaveProperty('output_path')
  expect(directProjection).not.toHaveProperty('workspace_root')

  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const createUrl = new URL('http://localhost/api/videos/projects')
  const deniedCreate = await handler(new Request(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '未授权写入' }),
  }), createUrl, requestSegments(createUrl))
  expect(deniedCreate.status).toBe(403)

  const acceptedCreate = await handler(new Request(createUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [MEDIA_UI_CAPABILITY_HEADER]: capability },
    body: JSON.stringify({ title: '已授权写入' }),
  }), createUrl, requestSegments(createUrl))
  expect(acceptedCreate.status).toBe(201)

  const listed = await handler(new Request(createUrl), createUrl, requestSegments(createUrl))
  expect(listed.status).toBe(200)
  const listedBody = await listed.json() as { projects: Record<string, unknown>[] }
  expect(listedBody.projects.find(project => project.id === stored.id)).not.toHaveProperty('output_path')
  expect(listedBody.projects.find(project => project.id === stored.id)).not.toHaveProperty('workspace_root')
  expect(JSON.stringify(listedBody)).not.toContain(outputPath)
  expect(JSON.stringify(listedBody)).not.toContain(workspaceRoot)

  const projectUrl = new URL(`http://localhost/api/videos/projects/${stored.id}`)
  const projected = await handler(new Request(projectUrl), projectUrl, requestSegments(projectUrl))
  expect(projected.status).toBe(200)
  const body = await projected.json() as { project: Record<string, unknown> }
  expect(body.project.output_path).toBeUndefined()
  expect(body.project.workspace_root).toBeUndefined()
  expect(JSON.stringify(body)).not.toContain(outputPath)
  expect(JSON.stringify(body)).not.toContain(workspaceRoot)

  const deniedDelete = await handler(new Request(projectUrl, { method: 'DELETE' }), projectUrl, requestSegments(projectUrl))
  expect(deniedDelete.status).toBe(403)
  service.repository.close()
})

test('工作台快照返回可供桌面权威恢复的版本和 cursor，但不泄露本地路径或内部写入记录', async () => {
  const root = await testRoot('workspace-snapshot')
  const { service, created } = await seededService(root)
  const workspaceRoot = '/private/workspace/snapshot-never-public'
  const stored = await service.getProject(created.id)
  await service.repository.saveProject({ ...stored, workspace_root: workspaceRoot })
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const url = new URL(`http://localhost/api/videos/projects/${created.id}/workspace?event_cursor=0`)
  const response = await handler(new Request(url), url, requestSegments(url))
  expect(response.status).toBe(200)
  const body = await response.json() as Record<string, unknown>
  expect((body.project as { id?: string }).id).toBe(created.id)
  expect(typeof (body.current_timeline as { id?: unknown }).id).toBe('string')
  const variants = body.variants as Array<{ variant?: { id?: unknown }; version?: { id?: unknown } }>
  expect(variants).toHaveLength(1)
  expect(typeof variants[0]?.variant?.id).toBe('string')
  expect(typeof variants[0]?.version?.id).toBe('string')
  expect(body.facts).toEqual({ schema_version: 1, items: [] })
  expect((body.events as { cursor?: unknown; reset_required?: unknown; events?: unknown[] })).toEqual({ cursor: 0, reset_required: false, events: [] })
  const serialized = JSON.stringify(body)
  expect(serialized).not.toContain(root)
  expect(serialized).not.toContain(workspaceRoot)
  expect(serialized).not.toContain('editorial_command_receipts')
  expect(serialized).not.toContain('output_path')

  const invalid = new URL(`http://localhost/api/videos/projects/${created.id}/workspace?event_cursor=-1`)
  const invalidResponse = await handler(new Request(invalid), invalid, requestSegments(invalid))
  expect(invalidResponse.status).toBe(400)
  service.repository.close()
})

test('新的编辑时间线会使旧 Variant 的编译、预检和预检幂等回执全部失效', async () => {
  const root = await testRoot('timeline-stale')
  const { service, created } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = initial.delivery_variants[0]!
  const version = initial.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const preflight = await service.preflightDeliveryVariant(created.id, variant.id, {
    base_revision: initial.revision,
    base_variant_version_id: version.id,
  }, 'preflight-before-editorial-head-0001')
  expect(preflight.report.state).toBe('passed')

  const afterPreflight = await service.getProject(created.id)
  const currentTimeline = afterPreflight.editorial_timeline_versions.find(candidate => candidate.id === afterPreflight.current_editorial_timeline_version_id)!
  await service.applyEditorialTimelineCommands(created.id, {
    base_timeline_version_id: currentTimeline.id,
    commands: [{ kind: 'set_track_state', track_id: currentTimeline.tracks[0]!.id, locked: false }],
  }, 'advance-editorial-head-command-0001')
  const advanced = await service.getProject(created.id)
  expect(advanced.current_editorial_timeline_version_id).not.toBe(version.editorial_timeline_version_id)

  await expect(service.compileDeliveryVariant(created.id, variant.id)).rejects.toMatchObject({ code: 'VIDEO_EDITORIAL_STALE' })
  await expect(service.preflightDeliveryVariant(created.id, variant.id, {
    base_revision: advanced.revision,
    base_variant_version_id: version.id,
  }, 'preflight-after-editorial-head-0001')).rejects.toMatchObject({ code: 'VIDEO_FINISHING_STALE' })
  await expect(service.preflightDeliveryVariant(created.id, variant.id, {
    base_revision: initial.revision,
    base_variant_version_id: version.id,
  }, 'preflight-before-editorial-head-0001')).rejects.toMatchObject({ code: 'VIDEO_FINISHING_STALE' })
  service.repository.close()
})

test('当前 Profile 修订变化会使旧 Variant 计划失效，画幅切换拒绝遗留字幕和构图指针', async () => {
  const root = await testRoot('profile-stale')
  const { service, created } = await seededService(root)
  const initial = await service.getProject(created.id)
  const variant = initial.delivery_variants[0]!
  const version = initial.delivery_variant_versions.find(candidate => candidate.id === variant.current_version_id)!
  const profile = initial.export_profile_revisions.find(candidate => candidate.id === version.export_profile_revision_id)!
  const currentProfileRevision = revisedProfile(profile, {
    id: 'profile_revision_00000002',
    profile_id: profile.profile_id,
    revision: profile.revision + 1,
    target: 'horizontal_video',
    width: 1920,
    height: 1080,
  })
  await service.repository.saveProject({
    ...initial,
    export_profiles: initial.export_profiles.map(candidate => candidate.id === profile.profile_id
      ? { ...candidate, current_revision_id: currentProfileRevision.id }
      : candidate),
    export_profile_revisions: [...initial.export_profile_revisions, currentProfileRevision],
    revision: initial.revision + 1,
  })
  await expect(service.compileDeliveryVariant(created.id, variant.id)).rejects.toMatchObject({ code: 'VIDEO_EDITORIAL_STALE' })
  const replacement = await service.createDeliveryVariant(created.id, { name: '更新规格后的交付' }, 'create-current-profile-variant-0001')
  expect(replacement.version.export_profile_revision_id).toBe(currentProfileRevision.id)
  service.repository.close()

  // Use a separately current landscape Profile: switching to it is legal in
  // principle, but it must not carry the prior portrait Caption/Composition.
  const pointerRoot = await testRoot('profile-pointer-aspect')
  const { service: pointerService, created: pointerCreated } = await seededService(pointerRoot)
  const refreshed = await pointerService.getProject(pointerCreated.id)
  const refreshedVariant = refreshed.delivery_variants[0]!
  const refreshedVersion = refreshed.delivery_variant_versions.find(candidate => candidate.id === refreshedVariant.current_version_id)!
  const refreshedProfile = refreshed.export_profile_revisions.find(candidate => candidate.id === refreshedVersion.export_profile_revision_id)!
  const alternate = revisedProfile(refreshedProfile, {
    id: 'profile_revision_00000003',
    profile_id: 'profile_00000002',
    revision: 1,
    target: 'horizontal_video',
    width: 1920,
    height: 1080,
  })
  const timeline = refreshed.editorial_timeline_versions.find(candidate => candidate.id === refreshed.current_editorial_timeline_version_id)!
  const captionStyle = { id: 'caption_style_00000001', name: '默认字幕', font_family: 'Arial', font_size: 48, fill: '#FFFFFF', outline_fill: '#000000', outline_width: 2, bottom_safe_area: 0.1, max_width: 0.8, created_at: at }
  const captionDocument = { id: 'caption_document_00000001', project_id: pointerCreated.id, current_revision_id: 'caption_revision_00000001', created_at: at }
  const captionRevision = {
    id: 'caption_revision_00000001',
    document_id: captionDocument.id,
    project_id: pointerCreated.id,
    editorial_timeline_version_id: timeline.id,
    transcript_id: 'transcript_00000001',
    language: 'zh',
    style_id: captionStyle.id,
    cues: [{
      id: 'caption_cue_00000001',
      source_anchor: { transcript_id: 'transcript_00000001', segment_ids: ['segment_00000001'], word_ids: [] },
      timeline_range: { start: rationalTime('0', { num: 90_000, den: 1 }), duration: rationalTime('90000', { num: 90_000, den: 1 }) },
      text: '字幕',
      alignment_confidence: 1,
      alignment_state: 'ready' as const,
    }],
    basis_hash: sha256('caption-basis'),
    created_at: at,
  }
  const composition = {
    id: 'composition_plan_00000001',
    project_id: pointerCreated.id,
    editorial_timeline_version_id: timeline.id,
    export_profile_revision_id: refreshedProfile.id,
    export_profile_hash: refreshedProfile.content_hash,
    facts_basis_hash: timeline.facts_basis_hash,
    subject_evidence_ids: [],
    proposed_commands: [],
    unresolved_ranges: [],
    created_at: at,
  }
  await pointerService.repository.saveProject({
    ...refreshed,
    export_profiles: [...refreshed.export_profiles, { id: alternate.profile_id, scope: 'project_custom', current_revision_id: alternate.id, created_at: at }],
    export_profile_revisions: [...refreshed.export_profile_revisions, alternate],
    caption_styles: [...refreshed.caption_styles, captionStyle],
    caption_documents: [...refreshed.caption_documents, captionDocument],
    caption_document_revisions: [...refreshed.caption_document_revisions, captionRevision],
    composition_plans: [...refreshed.composition_plans, composition],
    revision: refreshed.revision + 1,
  })
  const withPointers = await pointerService.applyDeliveryVariantCommands(pointerCreated.id, refreshedVariant.id, {
    base_variant_version_id: refreshedVersion.id,
    commands: [
      { kind: 'set_caption_revision', caption_document_id: captionDocument.id, caption_revision_id: captionRevision.id },
      { kind: 'set_composition_plan', composition_plan_id: composition.id },
    ],
  }, 'attach-portrait-finishing-pointers-0001')
  await expect(pointerService.applyDeliveryVariantCommands(pointerCreated.id, refreshedVariant.id, {
    base_variant_version_id: withPointers.version.id,
    commands: [{ kind: 'set_export_profile', export_profile_revision_id: alternate.id, expected_profile_hash: alternate.content_hash }],
  }, 'change-aspect-with-finishing-pointers-0001')).rejects.toMatchObject({ code: 'VIDEO_EDITORIAL_STALE' })
  pointerService.repository.close()
})
