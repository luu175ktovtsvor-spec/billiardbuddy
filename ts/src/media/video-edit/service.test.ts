import { expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskService } from '../../tasks/taskService'
import { VideoEditingService } from './service'

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (done(value)) return value
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw new Error('waitFor timeout')
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'video-service-'))
  const source = join(root, 'source.mp4')
  const ffmpeg = join(root, 'ffmpeg.sh')
  const ffprobe = join(root, 'ffprobe.sh')
  writeFileSync(source, 'video-source')
  writeFileSync(ffmpeg, '#!/bin/sh\nexit 0\n')
  writeFileSync(ffprobe, '#!/bin/sh\nprintf %s \'{"format":{"duration":"3"},"streams":[{"codec_type":"video","width":320,"height":180,"avg_frame_rate":"24/1","r_frame_rate":"24/1"},{"codec_type":"audio"}]}\'\n')
  chmodSync(ffmpeg, 0o755)
  chmodSync(ffprobe, 0o755)
  const tasks = new TaskService(root)
  const env = { PATH: '', FFMPEG_BIN: ffmpeg, FFPROBE_BIN: ffprobe, WHISPER_CLI: '/missing' }
  const service = new VideoEditingService({ stateRoot: root, tasks, env })
  return { root, source, tasks, service, env }
}

test('video service connects create -> analyze -> brief -> drafts on one v2 project', async () => {
  const { source, service } = setup()
  const created = await service.createProject({ video_paths: [source], source_roles: { [source]: 'space_wide' }, user_request: '展示真实环境' })
  const analyzed = await waitFor(() => service.getJob(created.analysis_job.job_id), job => job?.status === 'done' || job?.status === 'done_with_warnings')
  expect(analyzed?.status).toBe('done')
  const compiled = await service.compileBrief(created.project.project_id, { user_request: '做一条自然的环境短片', content_type: 'venue_atmosphere', preferred_view: 'ambient' })
  expect(compiled.brief.user_request).toBe('做一条自然的环境短片')
  const draftStart = await service.startDrafts(created.project.project_id)
  const drafted = await waitFor(() => service.getJob(draftStart.job_id), job => job?.status === 'done' || job?.status === 'done_with_warnings')
  expect(drafted?.result?.alternative_ids).toHaveLength(3)
  expect(drafted?.result?.plan_summary).toMatchObject({
    understanding: '展示环境与氛围 / 做一条自然的环境短片 / 1 段素材',
    preferred_view: 'ambient',
    source_count: 1,
    scene_count: 1,
  })
  expect(JSON.stringify(drafted?.result?.plan_summary)).not.toContain(source)
  const project = await service.store.load(created.project.project_id)
  expect(project.scenes.length).toBeGreaterThan(0)
  expect(project.status.missing_coverage.length).toBeGreaterThan(0)
})

test('video jobs keep cancelled and interrupted states and retry creates a successor job', async () => {
  const { root, source, tasks, service } = setup()
  const project = await service.store.create({ video_paths: [source], source_roles: { [source]: 'space_wide' } })
  const renderService = new VideoEditingService({
    stateRoot: root,
    tasks,
    env: { PATH: '' },
    gateAssets: () => ({ blocked: true, asset_progress: 10, message: '组件准备中' }),
    waitForAssetRetry: signal => new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true })),
  })
  const render = await renderService.startRender(project.project_id, { revision: project.revision })
  await waitFor(() => renderService.getJob(render.job_id), job => job?.status === 'blocked')
  const cancelled = await renderService.cancelJob(render.job_id)
  expect(cancelled.status).toBe('cancelled')
  const retry = await renderService.retryJob(render.job_id)
  expect(retry.job_id).not.toBe(render.job_id)
  await waitFor(() => renderService.getJob(retry.job_id), job => job?.status === 'blocked')
  await renderService.cancelJob(retry.job_id)

  const stale = await tasks.create({
    title: 'stale', kind: 'video_v2_analyze',
    params: { project_id: project.project_id, video_kind: 'analyze', video_status: 'analyzing', checkpoint: { source: 1 } },
  })
  await tasks.touch(stale.id, { status: 'running' })
  const restartedService = new VideoEditingService({ stateRoot: root, tasks, env: { PATH: '' } })
  const interrupted = await restartedService.getJob(stale.id)
  expect(interrupted).toMatchObject({ status: 'interrupted', retryable: true, checkpoint: { source: 1 } })
}, 15_000)

test('blocked component preparation automatically continues the same job when assets become ready', async () => {
  const { root, source, tasks, env } = setup()
  let gateChecks = 0
  const retryWaiters: Array<() => void> = []
  const service = new VideoEditingService({
    stateRoot: root,
    tasks,
    env,
    gateAssets: () => ++gateChecks <= 2
      ? { blocked: true, asset_progress: gateChecks * 35, message: `组件准备中 ${gateChecks * 35}%` }
      : null,
    waitForAssetRetry: () => new Promise(resolve => retryWaiters.push(resolve)),
  })
  const created = await service.createProject({ video_paths: [source] })
  const blocked = await waitFor(() => service.getJob(created.analysis_job.job_id), job => job?.status === 'blocked')
  expect(blocked?.warnings[0]).toContain('组件准备中')
  await waitFor(async () => retryWaiters.length, count => count === 1)
  retryWaiters.shift()?.()
  await waitFor(async () => retryWaiters.length, count => count === 1)
  retryWaiters.shift()?.()
  const done = await waitFor(() => service.getJob(created.analysis_job.job_id), job => job?.status === 'done' || job?.status === 'done_with_warnings')
  expect(done?.id).toBe(created.analysis_job.job_id)
  expect(gateChecks).toBeGreaterThanOrEqual(3)
}, 10_000)

test('continuing an existing video project waits for FFmpeg and ffprobe before drafting', async () => {
  const { root, source, tasks, env } = setup()
  const requested: string[][] = []
  const service = new VideoEditingService({
    stateRoot: root,
    tasks,
    env,
    gateAssets: (_runtimeEnv, needs) => {
      requested.push([...needs])
      return { blocked: true, asset_progress: 1, message: '组件准备中 1%' }
    },
  })
  const project = await service.store.create({ video_paths: [source] })
  const started = await service.startDrafts(project.project_id)
  await waitFor(async () => requested.length, count => count >= 1)
  expect(requested[0]).toEqual(['ffmpeg', 'ffprobe'])
  await service.cancelJob(started.job_id)
})

test('video render requests the Tier2 Chinese font only when subtitles are enabled', async () => {
  const { root, source, tasks, env } = setup()
  const requested: string[][] = []
  const service = new VideoEditingService({
    stateRoot: root,
    tasks,
    env,
    gateAssets: (_runtimeEnv, needs) => {
      requested.push([...needs])
      return { blocked: true, asset_progress: 1, message: '组件准备中 1%' }
    },
  })
  const project = await service.store.create({ video_paths: [source] })
  const withSubtitles = await service.startRender(project.project_id, { revision: project.revision, include_subtitles: true })
  await waitFor(async () => requested.length, count => count >= 1)
  expect(requested[0]).toEqual(['ffmpeg', 'ffprobe', 'zh-font'])
  await service.cancelJob(withSubtitles.job_id)

  requested.length = 0
  const withoutSubtitles = await service.startRender(project.project_id, { revision: project.revision, include_subtitles: false })
  await waitFor(async () => requested.length, count => count >= 1)
  expect(requested[0]).toEqual(['ffmpeg', 'ffprobe'])
  await service.cancelJob(withoutSubtitles.job_id)
})

test('source range responses support browser suffix requests and reject multiple ranges', async () => {
  const { source, service } = setup()
  const created = await service.store.create({ video_paths: [source] })
  const sourceId = created.sources[0]!.id
  const suffix = await service.sourceResponse(created.project_id, sourceId, new Request('http://local/video', { headers: { Range: 'bytes=-5' } }))
  expect(suffix.status).toBe(206)
  expect(suffix.headers.get('content-range')).toBe('bytes 7-11/12')
  expect(await suffix.text()).toBe('ource')
  const multiple = await service.sourceResponse(created.project_id, sourceId, new Request('http://local/video', { headers: { Range: 'bytes=0-1,4-5' } }))
  expect(multiple.status).toBe(416)
})
