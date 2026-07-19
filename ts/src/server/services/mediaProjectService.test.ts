import { afterEach, describe, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaProject } from '../../../shared/contracts/media.js'
import { MediaProjectService, MediaServiceError, type MediaProcessRunner } from './mediaProjectService.js'

const roots: string[] = []
const originalGatewayUrl = process.env.QF_GATEWAY_URL
const originalGatewayToken = process.env.QF_GATEWAY_TOKEN

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'billiardbuddy-media-'))
  roots.push(value)
  return value
}

afterEach(async () => {
  if (originalGatewayUrl === undefined) delete process.env.QF_GATEWAY_URL
  else process.env.QF_GATEWAY_URL = originalGatewayUrl
  if (originalGatewayToken === undefined) delete process.env.QF_GATEWAY_TOKEN
  else process.env.QF_GATEWAY_TOKEN = originalGatewayToken
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('MediaProjectService image projects', () => {
  test('uses one idempotent relay task and persists image bytes outside project JSON', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const calls: Array<{ url: string; key: string | null }> = []
    let polls = 0
    const mediaRoot = await root()
    const service = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async (input, init) => {
        const requestUrl = String(input)
        const headers = new Headers(init?.headers)
        calls.push({ url: requestUrl, key: headers.get('idempotency-key') })
        if (init?.method === 'POST') return Response.json({ task_id: 'remote-1', status: 'queued' }, { status: 202 })
        polls += 1
        return Response.json(polls === 1
          ? { task_id: 'remote-1', status: 'running' }
          : {
              task_id: 'remote-1',
              status: 'succeeded',
              data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }],
              input_fidelity_requested: 'high',
              input_fidelity_status: 'unsupported',
              input_fidelity_risk: '请人工确认参考图一致性',
            })
      },
    })

    const project = await service.createImageProject({ prompt: '蓝色台球活动海报' })
    const first = await service.submitImageProject(project.id)
    const duplicate = await service.submitImageProject(project.id)
    expect(duplicate.id).toBe(first.id)
    expect(calls.filter(call => call.url.endsWith('/v1/images/tasks'))).toHaveLength(1)
    expect(calls[0]?.key).toMatch(/^bb-media-[a-f0-9]{64}$/)

    expect((await service.getTask(first.id)).status).toBe('running')
    const completed = await service.getTask(first.id)
    expect(completed.status).toBe('succeeded')
    expect(completed.result).toMatchObject({
      input_fidelity_status: 'unsupported',
      input_fidelity_risk: '请人工确认参考图一致性',
    })
    const ready = await service.getProject(project.id)
    expect(ready.kind).toBe('image')
    if (ready.kind !== 'image') throw new Error('wrong kind')
    expect(ready.state).toBe('ready')
    expect(ready.outputs[0]?.asset_path).toContain(`/api/media/assets/${project.id}/`)
    const persisted = await readFile(join(mediaRoot, 'projects', `${project.id}.json`), 'utf8')
    expect(persisted).not.toContain(Buffer.from('png-bytes').toString('base64'))
    const asset = await service.assetResponse(project.id, ready.outputs[0]!.asset_path!.split('/').pop()!)
    expect(await asset.text()).toBe('png-bytes')
    const taskScopedAsset = await service.imageOutputResponse(project.id, ready.outputs[0]!.id)
    expect(await taskScopedAsset.text()).toBe('png-bytes')
    await expect(service.imageOutputResponse(project.id, 'out_missing')).rejects.toMatchObject({
      code: 'IMAGE_OUTPUT_NOT_FOUND',
      status: 404,
    })
    const savedPath = join(mediaRoot, 'saved-output.png')
    expect(await service.saveImageOutput(project.id, {
      output_id: ready.outputs[0]!.id,
      output_path: savedPath,
    })).toEqual({ path: savedPath })
    expect(await readFile(savedPath, 'utf8')).toBe('png-bytes')
  })

  test('rejects a project asset directory symlink that points outside the media asset root', async () => {
    const mediaRoot = await root()
    const service = new MediaProjectService({ root: mediaRoot })
    const project = await service.createImageProject({ prompt: '安全测试图片' })
    const outsideDir = join(mediaRoot, 'outside-assets')
    await Promise.all([
      mkdir(join(mediaRoot, 'assets'), { recursive: true }),
      mkdir(outsideDir, { recursive: true }),
    ])
    await writeFile(join(outsideDir, 'image.png'), 'private-image')
    await symlink(
      outsideDir,
      join(mediaRoot, 'assets', project.id),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(service.assetResponse(project.id, 'image.png')).rejects.toMatchObject({
      code: 'ASSET_OUTSIDE_PROJECT',
      status: 403,
    })
  })

  test('rejects an image output asset symlink that points outside its project directory', async () => {
    const mediaRoot = await root()
    const service = new MediaProjectService({ root: mediaRoot })
    const project = await service.createImageProject({ prompt: '保存安全测试图片' })
    const projectAssetDir = join(mediaRoot, 'assets', project.id)
    const outsidePath = join(mediaRoot, 'outside.png')
    await mkdir(projectAssetDir, { recursive: true })
    await writeFile(outsidePath, 'private-image')
    await symlink(outsidePath, join(projectAssetDir, 'output.png'))
    await writeFile(join(mediaRoot, 'projects', `${project.id}.json`), `${JSON.stringify({
      ...project,
      outputs: [{
        id: 'out_12345678',
        mime_type: 'image/png',
        asset_path: `/api/media/assets/${project.id}/output.png`,
      }],
    }, null, 2)}\n`)

    await expect(service.saveImageOutput(project.id, {
      output_id: 'out_12345678',
      output_path: join(mediaRoot, 'saved.png'),
    })).rejects.toMatchObject({
      code: 'ASSET_OUTSIDE_PROJECT',
      status: 403,
    })
  })

  test('does not submit without a configured gateway', async () => {
    delete process.env.QF_GATEWAY_URL
    delete process.env.QF_GATEWAY_TOKEN
    const service = new MediaProjectService({ root: await root() })
    const project = await service.createImageProject({ prompt: '活动海报' })
    await expect(service.submitImageProject(project.id)).rejects.toMatchObject({
      code: 'GATEWAY_NOT_CONFIGURED',
      status: 503,
    })
  })

  test('requires explicit confirmation before an unknown submission is replaced by an edited draft', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const keys: string[] = []
    let submissions = 0
    const service = new MediaProjectService({
      root: await root(),
      fetchImpl: async (_input, init) => {
        keys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
        submissions += 1
        return submissions === 1
          ? Response.json({ error: 'temporary failure' }, { status: 502 })
          : Response.json({ task_id: 'remote-retry', status: 'queued' }, { status: 202 })
      },
    })
    const project = await service.createImageProject({ prompt: '第一版海报' })
    await expect(service.submitImageProject(project.id)).rejects.toBeInstanceOf(MediaServiceError)
    const failed = await service.getProject(project.id)
    if (failed.kind !== 'image') throw new Error('wrong kind')
    expect(failed.state).toBe('failed')
    const failedTask = await service.getTask(failed.task_id!, false)
    expect(failedTask.outcome_unknown).toBe(true)
    expect(failedTask.remote_task_id).toBeUndefined()

    await expect(service.updateImageProject(project.id, {
      revision: failed.revision,
      prompt: '第二版海报',
      size: '1536x1024',
      count: 2,
    })).rejects.toMatchObject({ code: 'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED' })

    const edited = await service.updateImageProject(project.id, {
      revision: failed.revision,
      prompt: '第二版海报',
      size: '1536x1024',
      count: 2,
      confirm_unknown_retry: true,
    })
    expect(edited).toMatchObject({ state: 'draft', task_id: undefined })
    const retry = await service.submitImageProject(edited.id)
    expect(retry.remote_task_id).toBe('remote-retry')
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  test('reuses the persisted idempotency key when a submit response is lost', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const keys: string[] = []
    let calls = 0
    const service = new MediaProjectService({
      root: await root(),
      fetchImpl: async (_input, init) => {
        keys.push(new Headers(init?.headers).get('idempotency-key') ?? '')
        calls += 1
        if (calls === 1) throw new Error('connection reset after request write')
        return Response.json({ task_id: 'remote-recovered', status: 'queued', reused: true }, { status: 202 })
      },
    })
    const project = await service.createImageProject({ prompt: '只生成一次' })
    await expect(service.submitImageProject(project.id)).rejects.toMatchObject({ code: 'IMAGE_SUBMIT_UNKNOWN' })
    const failed = await service.getProject(project.id)
    if (failed.kind !== 'image') throw new Error('wrong kind')
    const recovered = await service.submitImageProject(project.id)

    expect(recovered).toMatchObject({ remote_task_id: 'remote-recovered', outcome_unknown: false })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  test('recovers a crash after intent persistence but before remote task id persistence', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const mediaRoot = await root()
    let firstKey = ''
    const interrupted = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async (_input, init) => {
        firstKey = new Headers(init?.headers).get('idempotency-key') ?? ''
        return await new Promise<Response>(() => {})
      },
    })
    const project = await interrupted.createImageProject({ prompt: '崩溃恢复' })
    void interrupted.submitImageProject(project.id).catch(() => undefined)

    let persisted = await interrupted.getProject(project.id)
    for (let index = 0; index < 50 && (!persisted.task_id || !firstKey); index += 1) {
      await Bun.sleep(2)
      persisted = await interrupted.getProject(project.id)
    }
    expect(persisted.task_id).toBeTruthy()
    expect(firstKey).toMatch(/^bb-media-/)

    let recoveredKey = ''
    const restarted = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async (_input, init) => {
        recoveredKey = new Headers(init?.headers).get('idempotency-key') ?? ''
        return Response.json({ task_id: 'remote-after-restart', status: 'queued', reused: true }, { status: 202 })
      },
    })
    const recovered = await restarted.getTask(persisted.task_id!)
    expect(recovered.remote_task_id).toBe('remote-after-restart')
    expect(recoveredKey).toBe(firstKey)
  })

  test('surfaces failed_unknown as a possible-charge warning instead of silently retrying', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const keys: string[] = []
    let postCount = 0
    const service = new MediaProjectService({
      root: await root(),
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') {
          keys.push(new Headers(init.headers).get('idempotency-key') ?? '')
          postCount += 1
          return Response.json({
            task_id: postCount === 1 ? 'remote-unknown' : 'remote-confirmed-retry',
            status: 'queued',
          }, { status: 202 })
        }
        return Response.json({ status: 'failed_unknown', error: '服务重启前任务仍在执行' })
      },
    })
    const project = await service.createImageProject({ prompt: '活动海报' })
    const task = await service.submitImageProject(project.id)
    const failed = await service.getTask(task.id)
    expect(failed.status).toBe('failed')
    expect(failed.outcome_unknown).toBe(true)
    expect(failed.error).toContain('可能已经产生费用')
    const failedProject = await service.getProject(project.id)
    expect(failedProject).toMatchObject({ state: 'failed' })

    await expect(service.submitImageProject(project.id)).rejects.toMatchObject({
      code: 'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED',
    })
    const retried = await service.submitImageProject(project.id, { confirm_unknown_retry: true })
    expect(retried.remote_task_id).toBe('remote-confirmed-retry')
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })

  test('stores reference images as private assets and migrates legacy inline projects on read', async () => {
    const mediaRoot = await root()
    const reference = `data:image/png;base64,${Buffer.from('private-reference').toString('base64')}`
    const service = new MediaProjectService({ root: mediaRoot })
    const created = await service.createImageProject({
      prompt: '参考图编辑',
      mode: 'edit',
      reference_images: [reference],
    })
    const persistedPath = join(mediaRoot, 'projects', `${created.id}.json`)
    const persisted = await readFile(persistedPath, 'utf8')
    expect(persisted).not.toContain(reference)
    expect(created.reference_image_assets).toHaveLength(1)
    const assetPath = join(mediaRoot, 'assets', created.id, 'references', created.reference_image_assets![0]!)
    expect((await stat(assetPath)).mode & 0o777).toBe(0o600)

    await writeFile(persistedPath, `${JSON.stringify({
      ...created,
      reference_images: [reference],
      reference_image_assets: undefined,
    }, null, 2)}\n`)
    const migrated = await new MediaProjectService({ root: mediaRoot }).getProject(created.id)
    expect(migrated.kind).toBe('image')
    if (migrated.kind !== 'image') throw new Error('wrong kind')
    expect(migrated.reference_images).toEqual([])
    expect(migrated.reference_image_assets).toHaveLength(1)
    expect(await readFile(persistedPath, 'utf8')).not.toContain(reference)
  })

  test('rejects a reference-image symlink before it can be sent to the image service', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const mediaRoot = await root()
    const service = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async () => Response.json({ task_id: 'should-not-submit', status: 'queued' }),
    })
    const reference = `data:image/png;base64,${Buffer.from('trusted-reference').toString('base64')}`
    const project = await service.createImageProject({
      prompt: '带参考图的海报',
      mode: 'edit',
      reference_images: [reference],
    })
    const referenceName = project.reference_image_assets?.[0]
    if (!referenceName) throw new Error('reference asset missing')

    const referencePath = join(mediaRoot, 'assets', project.id, 'references', referenceName)
    const outsidePath = join(mediaRoot, 'outside-reference.png')
    await writeFile(outsidePath, 'private-file')
    await rm(referencePath)
    await symlink(outsidePath, referencePath)

    await expect(service.submitImageProject(project.id)).rejects.toMatchObject({
      code: 'ASSET_OUTSIDE_PROJECT',
      status: 403,
    })
  })

  test('reconciles a succeeded image task whose project update was interrupted', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const mediaRoot = await root()
    const service = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async (_input, init) => init?.method === 'POST'
        ? Response.json({ task_id: 'remote-image-reconcile', status: 'queued' }, { status: 202 })
        : Response.json({
            status: 'succeeded',
            data: [{ b64_json: Buffer.from('recovered-image').toString('base64') }],
          }),
    })
    const created = await service.createImageProject({ prompt: '恢复图片' })
    const task = await service.submitImageProject(created.id)
    await service.getTask(task.id)
    const ready = await service.getProject(created.id)
    if (ready.kind !== 'image') throw new Error('wrong kind')
    await writeFile(join(mediaRoot, 'projects', `${ready.id}.json`), `${JSON.stringify({
      ...ready,
      state: 'generating',
      outputs: [],
    }, null, 2)}\n`)

    await new MediaProjectService({ root: mediaRoot }).getTask(task.id, false)
    expect(await new MediaProjectService({ root: mediaRoot }).getProject(created.id)).toMatchObject({
      state: 'ready',
      outputs: [expect.objectContaining({ asset_path: expect.stringContaining('/api/media/assets/') })],
    })
  })

  test('does not attach a stale image task result to a project already bound to a replacement task', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const mediaRoot = await root()
    const service = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async (_input, init) => init?.method === 'POST'
        ? Response.json({ task_id: 'remote-stale-image', status: 'queued' }, { status: 202 })
        : Response.json({
            status: 'succeeded',
            data: [{ b64_json: Buffer.from('stale-image').toString('base64') }],
          }),
    })
    const project = await service.createImageProject({ prompt: '旧版海报' })
    const task = await service.submitImageProject(project.id)
    const replacementTaskId = 'task_replacement001'
    const persisted = await service.getProject(project.id)
    if (persisted.kind !== 'image') throw new Error('wrong kind')
    await writeFile(join(mediaRoot, 'projects', `${project.id}.json`), `${JSON.stringify({
      ...persisted,
      task_id: replacementTaskId,
      state: 'generating',
      outputs: [],
    }, null, 2)}\n`)

    const completed = await service.getTask(task.id)
    expect(completed).toMatchObject({ status: 'succeeded', result: { output_count: 1 } })
    expect(completed.result).not.toHaveProperty('outputs')
    expect(await service.getProject(project.id)).toMatchObject({
      task_id: replacementTaskId,
      state: 'generating',
      outputs: [],
    })
    await expect(stat(join(mediaRoot, 'assets', project.id))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('cancels only a remotely confirmed queued image task', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const service = new MediaProjectService({
      root: await root(),
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/cancel')) return Response.json({ status: 'cancelled' })
        if (init?.method === 'POST') return Response.json({ task_id: 'remote-cancellable', status: 'queued' }, { status: 202 })
        return Response.json({ status: 'queued' })
      },
    })
    const project = await service.createImageProject({ prompt: '排队图片' })
    const task = await service.submitImageProject(project.id)
    expect((await service.cancelTask(task.id)).status).toBe('cancelled')
    expect(await service.getProject(project.id)).toMatchObject({ state: 'failed', error: '生成已取消' })
  })
})

describe('MediaProjectService video projects', () => {
  test('probes real source metadata and builds a deterministic local FFmpeg render', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const outputPath = join(mediaRoot, 'exports', 'final.mp4')
    await writeFile(sourcePath, 'source')
    const commands: string[][] = []
    const runProcess: MediaProcessRunner = async command => {
      commands.push(command)
      if (command.includes('-version')) return { exitCode: 0, stdout: 'version', stderr: '' }
      if (command.includes('-encoders')) return { exitCode: 0, stdout: ' V..... mpeg4 MPEG-4 part 2', stderr: '' }
      if (command.includes('-show_streams')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: '4.5' },
            streams: [
              { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001' },
              { codec_type: 'audio' },
            ],
          }),
          stderr: '',
        }
      }
      await writeFile(command.at(-1)!, 'rendered')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess })
    const created = await service.createVideoProject({ title: '门店活动' })
    const { project } = await service.addVideoSource(created.id, { path: sourcePath })
    expect(project.sources[0]).toMatchObject({ duration_ms: 4500, width: 1920, height: 1080, has_audio: true })
    expect(project.sources[0]?.fps).toBeCloseTo(29.97, 2)

    const clipped = await service.updateVideoTimeline(project.id, {
      revision: project.revision,
      clips: [{ ...project.timeline[0]!, in_ms: 500, out_ms: 3500 }],
    })
    const task = await service.renderVideo(clipped.id, { revision: clipped.revision, output_path: outputPath })
    let done = await service.getTask(task.id, false)
    for (let index = 0; index < 20 && done.status !== 'succeeded'; index += 1) {
      await Bun.sleep(5)
      done = await service.getTask(task.id, false)
    }
    expect(done.status).toBe('succeeded')
    expect(await readFile(outputPath, 'utf8')).toBe('rendered')
    const ffmpeg = commands.find(command => command.includes('-filter_complex'))
    expect(ffmpeg).toContain('mpeg4')
    expect(ffmpeg).toContain('+faststart')
    expect(ffmpeg?.join(' ')).toContain('concat=n=1:v=1:a=1')
    expect(ffmpeg?.join(' ')).toContain('channel_layouts=stereo')
  })

  test('rejects timeline ranges beyond the source duration', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    await writeFile(sourcePath, 'source')
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess: async command => command.includes('-show_streams')
        ? { exitCode: 0, stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video', width: 1, height: 1 }] }), stderr: '' }
        : { exitCode: 0, stdout: '', stderr: '' },
    })
    const created = await service.createVideoProject({})
    const { project } = await service.addVideoSource(created.id, { path: sourcePath })
    await expect(service.updateVideoTimeline(project.id, {
      revision: project.revision,
      clips: [{ ...project.timeline[0]!, out_ms: 2000 }],
    })).rejects.toBeInstanceOf(MediaServiceError)
  })

  test('reuses an active render, supports cancellation, deletion, and interrupted-render recovery', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const outputPath = join(mediaRoot, 'output.mp4')
    await writeFile(sourcePath, 'source')
    const runProcess: MediaProcessRunner = async (command, options) => {
      if (command.includes('-version')) return { exitCode: 0, stdout: 'version', stderr: '' }
      if (command.includes('-encoders')) return { exitCode: 0, stdout: ' V..... mpeg4 MPEG-4 part 2', stderr: '' }
      if (command.includes('-show_streams')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: '2' },
            streams: [{ codec_type: 'video', width: 1280, height: 720 }],
          }),
          stderr: '',
        }
      }
      return await new Promise(resolve => {
        options?.signal?.addEventListener('abort', () => {
          resolve({ exitCode: 1, stdout: '', stderr: 'cancelled' })
        }, { once: true })
      })
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess })
    const created = await service.createVideoProject({})
    const { project } = await service.addVideoSource(created.id, { path: sourcePath })
    const first = await service.renderVideo(project.id, { revision: project.revision, output_path: outputPath })
    const duplicate = await service.renderVideo(project.id, { revision: project.revision, output_path: outputPath })
    expect(duplicate.id).toBe(first.id)

    const cancelled = await service.cancelTask(first.id)
    expect(cancelled.status).toBe('cancelled')
    await Bun.sleep(5)
    expect(await service.getProject(project.id)).toMatchObject({ state: 'ready' })
    await service.deleteProject(project.id)
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })

    const interrupted = await service.createVideoProject({ title: '中断项目' })
    const withSource = await service.addVideoSource(interrupted.id, { path: sourcePath })
    const interruptedTask = await service.renderVideo(withSource.project.id, {
      revision: withSource.project.revision,
      output_path: join(mediaRoot, 'interrupted.mp4'),
    })
    const restarted = new MediaProjectService({ root: mediaRoot, runProcess })
    const recovered = await restarted.getTask(interruptedTask.id)
    expect(recovered).toMatchObject({ status: 'failed', stage: '导出已中断' })
    expect(await restarted.getProject(interrupted.id)).toMatchObject({ state: 'ready' })
  })

  test('allows only one local FFmpeg render and waits for cancellation cleanup', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    await writeFile(sourcePath, 'source')
    let renderStarted = false
    const runProcess: MediaProcessRunner = async (command, options) => {
      if (command.includes('-version')) return { exitCode: 0, stdout: 'version', stderr: '' }
      if (command.includes('-encoders')) return { exitCode: 0, stdout: ' V..... mpeg4 MPEG-4 part 2', stderr: '' }
      if (command.includes('-show_streams')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: '2' },
            streams: [{ codec_type: 'video', width: 1280, height: 720 }],
          }),
          stderr: '',
        }
      }
      renderStarted = true
      return await new Promise(resolve => {
        const finish = () => setTimeout(() => resolve({ exitCode: 1, stdout: '', stderr: 'cancelled' }), 20)
        if (options?.signal?.aborted) finish()
        else options?.signal?.addEventListener('abort', finish, { once: true })
      })
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess })
    const first = await service.createVideoProject({ title: 'first' })
    const second = await service.createVideoProject({ title: 'second' })
    const firstReady = await service.addVideoSource(first.id, { path: sourcePath })
    const secondReady = await service.addVideoSource(second.id, { path: sourcePath })
    const firstTask = await service.renderVideo(first.id, {
      revision: firstReady.project.revision,
      output_path: join(mediaRoot, 'first.mp4'),
    })
    for (let index = 0; index < 50 && !renderStarted; index += 1) await Bun.sleep(2)
    expect(renderStarted).toBe(true)

    const cancelling = service.cancelTask(firstTask.id)
    await expect(service.renderVideo(second.id, {
      revision: secondReady.project.revision,
      output_path: join(mediaRoot, 'second.mp4'),
    })).rejects.toMatchObject({ code: 'VIDEO_RENDER_BUSY' })
    expect((await cancelling).status).toBe('cancelled')
    expect(await service.getProject(first.id)).toMatchObject({ state: 'ready', task_id: firstTask.id })

    const secondTask = await service.renderVideo(second.id, {
      revision: secondReady.project.revision,
      output_path: join(mediaRoot, 'second.mp4'),
    })
    expect(secondTask.project_id).toBe(second.id)
    await service.cancelTask(secondTask.id)
  })

  test('rejects cancellation once final output commit starts', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const outputPath = join(mediaRoot, 'output.mp4')
    await writeFile(sourcePath, 'source')

    let notifyCommitStarted!: () => void
    let finishCommit!: () => void
    const commitStarted = new Promise<void>(resolve => { notifyCommitStarted = resolve })
    const commitRelease = new Promise<void>(resolve => { finishCommit = resolve })
    const runProcess: MediaProcessRunner = async command => {
      if (command.includes('-version')) return { exitCode: 0, stdout: 'version', stderr: '' }
      if (command.includes('-encoders')) return { exitCode: 0, stdout: ' V..... mpeg4 MPEG-4 part 2', stderr: '' }
      if (command.includes('-show_streams')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: '2' },
            streams: [{ codec_type: 'video', width: 1280, height: 720 }],
          }),
          stderr: '',
        }
      }
      await writeFile(command.at(-1)!, 'rendered')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess,
      moveFile: async (source, destination) => {
        notifyCommitStarted()
        await commitRelease
        await rename(source, destination)
      },
    })
    const created = await service.createVideoProject({})
    const { project } = await service.addVideoSource(created.id, { path: sourcePath })
    const task = await service.renderVideo(project.id, {
      revision: project.revision,
      output_path: outputPath,
    })

    await commitStarted
    expect(await service.getTask(task.id, false)).toMatchObject({
      status: 'committing',
      stage: '正在完成导出',
    })
    await expect(service.cancelTask(task.id)).rejects.toMatchObject({
      code: 'TASK_NOT_CANCELLABLE',
    })
    await expect(service.deleteProject(project.id)).rejects.toMatchObject({
      code: 'TASK_IN_PROGRESS',
    })

    finishCommit()
    let completed = await service.getTask(task.id, false)
    for (let index = 0; index < 20 && completed.status !== 'succeeded'; index += 1) {
      await Bun.sleep(5)
      completed = await service.getTask(task.id, false)
    }
    expect(completed.status).toBe('succeeded')
    expect(await readFile(outputPath, 'utf8')).toBe('rendered')
  })

  test('never exports over a source path or a hard link to the source', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const linkedPath = join(mediaRoot, 'same-file.mp4')
    await writeFile(sourcePath, 'source')
    await link(sourcePath, linkedPath)
    const runProcess: MediaProcessRunner = async command => {
      if (command.includes('-show_streams')) {
        return { exitCode: 0, stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] }), stderr: '' }
      }
      return { exitCode: 0, stdout: ' V..... mpeg4 MPEG-4 part 2', stderr: '' }
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess })
    const created = await service.createVideoProject({})
    const { project } = await service.addVideoSource(created.id, { path: sourcePath })
    for (const output_path of [sourcePath, linkedPath]) {
      await expect(service.renderVideo(project.id, { revision: project.revision, output_path })).rejects.toMatchObject({
        code: 'OUTPUT_OVERWRITES_SOURCE',
      })
    }
    expect(await readFile(sourcePath, 'utf8')).toBe('source')
  })

  test('serializes concurrent source additions without losing either source', async () => {
    const mediaRoot = await root()
    const firstPath = join(mediaRoot, 'first.mp4')
    const secondPath = join(mediaRoot, 'second.mp4')
    await Promise.all([writeFile(firstPath, 'first'), writeFile(secondPath, 'second')])
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess: async command => {
        if (command.includes('-show_streams')) await Bun.sleep(5)
        return {
          exitCode: 0,
          stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] }),
          stderr: '',
        }
      },
    })
    const created = await service.createVideoProject({})
    await Promise.all([
      service.addVideoSource(created.id, { path: firstPath }),
      service.addVideoSource(created.id, { path: secondPath }),
    ])
    const project = await service.getProject(created.id)
    expect(project.kind).toBe('video')
    if (project.kind !== 'video') throw new Error('wrong kind')
    expect(project.sources.map(source => source.path).sort()).toEqual([firstPath, secondPath].sort())
  })

  test('serializes timeline edits and render startup behind a source import', async () => {
    const mediaRoot = await root()
    const firstPath = join(mediaRoot, 'first.mp4')
    const secondPath = join(mediaRoot, 'second.mp4')
    const outputPath = join(mediaRoot, 'output.mp4')
    await Promise.all([writeFile(firstPath, 'first'), writeFile(secondPath, 'second')])

    let notifySecondProbeStarted!: () => void
    let releaseSecondProbe!: () => void
    const secondProbeStarted = new Promise<void>(resolve => { notifySecondProbeStarted = resolve })
    const secondProbeRelease = new Promise<void>(resolve => { releaseSecondProbe = resolve })
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess: async command => {
        if (command.includes('-show_streams')) {
          if (command.at(-1) === secondPath) {
            notifySecondProbeStarted()
            await secondProbeRelease
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] }),
            stderr: '',
          }
        }
        if (command.includes('-version') || command.includes('-encoders')) {
          return { exitCode: 0, stdout: ' V..... mpeg4 MPEG-4 part 2', stderr: '' }
        }
        return { exitCode: 1, stdout: '', stderr: 'unexpected render' }
      },
    })
    const created = await service.createVideoProject({})
    const initial = await service.addVideoSource(created.id, { path: firstPath })
    const importing = service.addVideoSource(created.id, { path: secondPath })
    await secondProbeStarted

    const timelineUpdate = service.updateVideoTimeline(created.id, {
      revision: initial.project.revision,
      clips: [{ ...initial.project.timeline[0]!, in_ms: 100, out_ms: 900 }],
    })
    const rendering = service.renderVideo(created.id, {
      revision: initial.project.revision,
      output_path: outputPath,
    })

    const duringImport = await service.getProject(created.id)
    expect(duringImport.kind).toBe('video')
    if (duringImport.kind !== 'video') throw new Error('wrong kind')
    expect(duringImport).toMatchObject({ state: 'ready', revision: initial.project.revision })
    expect(duringImport.sources).toHaveLength(1)

    releaseSecondProbe()
    const [imported, timeline, render] = await Promise.allSettled([importing, timelineUpdate, rendering])
    expect(imported.status).toBe('fulfilled')
    expect(timeline).toMatchObject({ status: 'rejected', reason: { code: 'REVISION_CONFLICT' } })
    expect(render).toMatchObject({ status: 'rejected', reason: { code: 'REVISION_CONFLICT' } })

    const latest = await service.getProject(created.id)
    expect(latest.kind).toBe('video')
    if (latest.kind !== 'video') throw new Error('wrong kind')
    expect(latest).toMatchObject({ state: 'ready', revision: initial.project.revision + 1 })
    expect(latest.sources.map(source => source.path).sort()).toEqual([firstPath, secondPath].sort())
    expect(latest.timeline).toHaveLength(2)
    expect(latest.timeline[0]).toEqual(initial.project.timeline[0])
    expect(latest.timeline.some(clip => clip.in_ms === 100)).toBe(false)
  })

  test('promotes a committing render when the final file exists and the task partial is gone', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const outputPath = join(mediaRoot, 'recovered.mp4')
    await writeFile(sourcePath, 'source')
    let moved!: () => void
    const movedPromise = new Promise<void>(resolve => { moved = resolve })
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess: async command => {
        if (command.includes('-show_streams')) return { exitCode: 0, stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] }), stderr: '' }
        if (command.includes('-version') || command.includes('-encoders')) return { exitCode: 0, stdout: ' V..... mpeg4 MPEG-4 part 2', stderr: '' }
        await writeFile(command.at(-1)!, 'rendered')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
      moveFile: async (source, destination) => {
        await rename(source, destination)
        moved()
        return await new Promise<void>(() => {})
      },
    })
    const created = await service.createVideoProject({})
    const { project } = await service.addVideoSource(created.id, { path: sourcePath })
    const task = await service.renderVideo(project.id, { revision: project.revision, output_path: outputPath })
    await movedPromise

    const restarted = new MediaProjectService({ root: mediaRoot })
    expect(await restarted.getTask(task.id)).toMatchObject({ status: 'succeeded' })
    expect(await restarted.getProject(project.id)).toMatchObject({ state: 'complete', output_path: outputPath })
    expect(await readFile(outputPath, 'utf8')).toBe('rendered')
  })

  test('persists one opaque product-task owner without affecting legacy standalone projects', async () => {
    const mediaRoot = await root()
    const service = new MediaProjectService({ root: mediaRoot })
    const project = await service.createImageProject({ prompt: '任务关联海报' })
    expect(project.product_task_id).toBeUndefined()

    const owner = 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb'
    const attached = await service.attachProjectToProductTask(project.id, owner)
    expect(attached.product_task_id).toBe(owner)
    expect(await new MediaProjectService({ root: mediaRoot }).getProject(project.id))
      .toMatchObject({ product_task_id: owner })

    await expect(service.attachProjectToProductTask(project.id, 'task_0123456789abcdef'))
      .rejects.toMatchObject({ code: 'PROJECT_ALREADY_ATTACHED', status: 409 })
  })

  test('serializes competing task attachments across separate media service instances', async () => {
    const mediaRoot = await root()
    const creator = new MediaProjectService({ root: mediaRoot })
    const project = await creator.createImageProject({ prompt: '并发关联海报' })
    const first = new MediaProjectService({ root: mediaRoot })
    const second = new MediaProjectService({ root: mediaRoot })
    const firstOwner = 'task_0f15e1d4-7ced-4a8d-a980-d52dc0b55ffb'
    const secondOwner = 'task_0123456789abcdef'

    const results = await Promise.allSettled([
      first.attachProjectToProductTask(project.id, firstOwner),
      second.attachProjectToProductTask(project.id, secondOwner),
    ])
    const attached = results.filter((result): result is PromiseFulfilledResult<MediaProject> => result.status === 'fulfilled')
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

    expect(attached).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]?.reason).toMatchObject({ code: 'PROJECT_ALREADY_ATTACHED', status: 409 })
    expect(await creator.getProject(project.id)).toMatchObject({
      product_task_id: attached[0]!.value.product_task_id,
    })
  })
})
