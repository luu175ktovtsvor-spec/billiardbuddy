import { afterEach, describe, expect, test } from 'bun:test'
import { link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MediaProject, VideoStudioProject } from '../../../shared/contracts/media.js'
import { MediaProjectService, MediaServiceError, type MediaProcessRunner } from './mediaProjectService.js'

const roots: string[] = []
const originalGatewayUrl = process.env.QF_GATEWAY_URL
const originalGatewayToken = process.env.QF_GATEWAY_TOKEN
const DATA_EGRESS_CONSENT = {
  policy_revision: 'bb-04e-image-v1' as const,
  acknowledged: true as const,
  acknowledged_at: '2026-07-24T00:00:00.000Z',
}

function pngBytes(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

function pngDataUrl(width: number, height: number): string {
  return `data:image/png;base64,${pngBytes(width, height).toString('base64')}`
}

function submitImage(
  service: MediaProjectService,
  projectId: string,
  input: { confirm_unknown_retry?: boolean } = {},
) {
  return service.submitImageProject(projectId, { ...input, data_egress_consent: DATA_EGRESS_CONSENT })
}

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
  test('uses one idempotent GPT edit task without legacy parameters and persists local image bytes', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const calls: Array<{ url: string; key: string | null; consent: string | null; body?: Record<string, unknown> }> = []
    let polls = 0
    const mediaRoot = await root()
    const service = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async (input, init) => {
        const requestUrl = String(input)
        const headers = new Headers(init?.headers)
        const body = init?.method === 'POST' && typeof init.body === 'string'
          ? JSON.parse(init.body) as Record<string, unknown>
          : undefined
        calls.push({ url: requestUrl, key: headers.get('idempotency-key'), consent: headers.get('x-bb-data-egress-consent'), body })
        if (init?.method === 'POST') return Response.json({ task_id: 'remote-1', status: 'queued' }, { status: 202 })
        polls += 1
        return Response.json(polls === 1
          ? { task_id: 'remote-1', status: 'running' }
          : {
              task_id: 'remote-1',
              status: 'succeeded',
              data: [{ b64_json: Buffer.from('png-bytes').toString('base64') }],
            })
      },
    })

    const project = await service.createImageProject({
      prompt: '蓝色台球活动海报',
      mode: 'edit',
      reference_images: [`data:image/png;base64,${Buffer.from('reference-image').toString('base64')}`],
      reference_roles: ['subject'],
    })
    const first = await submitImage(service, project.id)
    const duplicate = await submitImage(service, project.id)
    expect(duplicate.id).toBe(first.id)
    expect(calls.filter(call => call.url.endsWith('/v1/images/tasks'))).toHaveLength(1)
    expect(calls[0]?.key).toMatch(/^bb-media-[a-f0-9]{64}$/)
    expect(calls[0]?.consent).toMatch(/^[a-f0-9]{64}$/)
    expect(first.data_egress_consent).toMatchObject({
      purpose: 'image_generation', capability: 'ImageGeneration', receiver: 'OpenAI',
      relay_region: 'United States', retention: 'input-until-terminal;result-up-to-7-days',
      billable: true, revocable_until: 'provider_submission',
    })
    expect(calls[0]?.body).toMatchObject({ mode: 'edit', model: 'gpt-image-2' })
    expect(calls[0]?.body?.response_format).toBeUndefined()
    expect(calls[0]?.body?.input_fidelity).toBeUndefined()

    expect((await service.getTask(first.id)).status).toBe('running')
    const completed = await service.getTask(first.id)
    expect(completed.status).toBe('succeeded')
    expect(completed.result?.input_fidelity_status).toBeUndefined()
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

  test('ignores caller provider fields and routes a three-candidate operation through the registry', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    let submittedBody: Record<string, unknown> | undefined
    let polls = 0
    const mediaRoot = await root()
    const service = new MediaProjectService({
      root: mediaRoot,
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') {
          submittedBody = JSON.parse(String(init.body)) as Record<string, unknown>
          return Response.json({ task_id: 'seedream-task', status: 'queued' }, { status: 202 })
        }
        polls += 1
        return Response.json(polls === 1
          ? { task_id: 'seedream-task', status: 'running' }
          : {
              task_id: 'seedream-task',
              status: 'succeeded',
              data: Array.from({ length: 3 }, (_, index) => ({
                b64_json: Buffer.from(`webp-bytes-${index}`).toString('base64'),
                mime_type: 'image/webp',
              })),
            })
      },
    })
    const project = await service.createImageProject({
      prompt: '竖版中文活动海报',
      model: 'doubao-seedream-4-5-251128',
      size: '2048x2048',
    })
    const task = await submitImage(service, project.id)
    await service.getTask(task.id)
    await service.getTask(task.id)

    expect(submittedBody).toMatchObject({
      model: 'doubao-seedream-4-5-251128',
      size: '2048x2048',
      n: 3,
    })
    const ready = await service.getProject(project.id)
    if (ready.kind !== 'image') throw new Error('wrong kind')
    expect(ready.model).toBe('doubao-seedream-4-5-251128')
    expect(ready.size).toBe('2048x2048')
    expect(ready.count).toBe(3)
    expect(ready.outputs).toHaveLength(3)
    expect(ready.outputs.every(output => output.mime_type === 'image/webp' && output.asset_path?.endsWith('.webp'))).toBe(true)
    expect(new Set(ready.outputs.map(output => output.operation_id))).toEqual(new Set([task.operation_id]))
    expect(new Set(ready.outputs.map(output => output.version_id)).size).toBe(3)
    expect(ready.outputs.every(output => ready.assets.some(asset => asset.id === output.id && asset.version_id === output.version_id))).toBe(true)
  })

  test('branches edit, inpaint, exact text, upscale, rollback, and export from explicit base versions', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const submissions: Record<string, unknown>[] = []
    let remoteIndex = 0
    const service = new MediaProjectService({
      root: await root(),
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') {
          submissions.push(JSON.parse(String(init.body)) as Record<string, unknown>)
          remoteIndex += 1
          return Response.json({ task_id: `remote-${remoteIndex}`, status: 'queued' }, { status: 202 })
        }
        return Response.json({
          task_id: `remote-${remoteIndex}`,
          status: 'succeeded',
          data: Array.from({ length: remoteIndex === 1 ? 3 : 1 }, () => ({
            b64_json: pngBytes(1, 1).toString('base64'),
            mime_type: 'image/png',
          })),
        })
      },
    })
    const draft = await service.createImageProject({ user_request: '标题：“会员日” 的活动海报' })
    const generatedTask = await submitImage(service, draft.id)
    await service.getTask(generatedTask.id)
    const generated = await service.getProject(draft.id)
    if (generated.kind !== 'image') throw new Error('wrong kind')
    const candidate = generated.outputs[0]!
    expect(generated.outputs).toHaveLength(3)
    expect(candidate.version_id).toBeDefined()
    expect(generated.current_version_id).toBeUndefined()

    const selected = await service.selectImageVersion(generated.id, {
      revision: generated.revision,
      version_id: candidate.version_id!,
    })
    await expect(service.selectImageVersion(selected.id, {
      revision: selected.revision,
      version_id: 'ver_missing0000000000000000000000000000',
    })).rejects.toMatchObject({ code: 'IMAGE_VERSION_NOT_FOUND' })
    await expect(service.startImageOperation(selected.id, {
      revision: selected.revision,
      base_version_id: candidate.version_id!,
      kind: 'inpaint',
      instruction: '只修改蒙版区域',
      mask_data_url: pngDataUrl(2, 1),
      data_egress_consent: DATA_EGRESS_CONSENT,
    })).rejects.toMatchObject({ code: 'IMAGE_MASK_DIMENSIONS_MISMATCH' })
    const operationTask = await service.startImageOperation(selected.id, {
      revision: selected.revision,
      base_version_id: candidate.version_id!,
      kind: 'inpaint',
      instruction: '只把左上角球杆改成红色，其余内容保持不变',
      mask_data_url: pngDataUrl(1, 1),
      data_egress_consent: DATA_EGRESS_CONSENT,
    })
    expect(submissions[1]).toMatchObject({
      mode: 'edit',
      model: 'gpt-image-2',
      n: 1,
      images: [pngDataUrl(1, 1)],
      mask: pngDataUrl(1, 1),
    })
    await service.getTask(operationTask.id)
    const edited = await service.getProject(selected.id)
    if (edited.kind !== 'image') throw new Error('wrong kind')
    const editedVersion = edited.versions.find(version => version.id === edited.current_version_id)!
    expect(editedVersion).toMatchObject({
      kind: 'inpaint',
      parent_version_id: candidate.version_id,
    })

    await expect(service.commitImageVersion(edited.id, {
      revision: edited.revision,
      base_version_id: editedVersion.id,
      kind: 'text_layout',
      rendered_image: pngDataUrl(1, 1),
      width: 1,
      height: 1,
      text_layers: [{ id: 'text_missing01', text: '错误文字', x: 0, y: 0 }],
    })).rejects.toMatchObject({ code: 'IMAGE_EXACT_TEXT_MISSING' })
    await expect(service.commitImageVersion(edited.id, {
      revision: edited.revision,
      base_version_id: editedVersion.id,
      kind: 'text_layout',
      rendered_image: pngDataUrl(1, 1),
      width: 1,
      height: 1,
      text_layers: [{ id: 'text_embedded01', text: '超级会员日', x: 0, y: 0 }],
    })).rejects.toMatchObject({ code: 'IMAGE_EXACT_TEXT_MISSING' })

    const textVersionProject = await service.commitImageVersion(edited.id, {
      revision: edited.revision,
      base_version_id: editedVersion.id,
      kind: 'text_layout',
      rendered_image: pngDataUrl(1, 1),
      width: 1,
      height: 1,
      text_layers: [{ id: 'text_member01', text: '会员日', x: 0, y: 0 }],
    })
    const textVersionId = textVersionProject.current_version_id!
    const upscaled = await service.commitImageVersion(textVersionProject.id, {
      revision: textVersionProject.revision,
      base_version_id: textVersionId,
      kind: 'upscale',
      rendered_image: pngDataUrl(2, 2),
      width: 2,
      height: 2,
      scale: 2,
      text_layers: [],
    })
    expect(upscaled.versions.find(version => version.id === upscaled.current_version_id)).toMatchObject({
      kind: 'upscale',
      parent_version_id: textVersionId,
      width: 2,
      height: 2,
    })

    const rolledBack = await service.selectImageVersion(upscaled.id, {
      revision: upscaled.revision,
      version_id: candidate.version_id!,
    })
    expect(rolledBack.current_version_id).toBe(candidate.version_id)
    expect(rolledBack.versions.some(version => version.id === upscaled.current_version_id)).toBe(true)
    const exportPath = join(await root(), 'selected.png')
    await service.saveImageOutput(rolledBack.id, { version_id: candidate.version_id, output_path: exportPath })
    expect(await readFile(exportPath)).toEqual(pngBytes(1, 1))
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
    await expect(submitImage(service, project.id)).rejects.toMatchObject({
      code: 'GATEWAY_NOT_CONFIGURED',
      status: 503,
    })
  })

  test('requires an explicit data egress acknowledgement before persisting or forwarding a paid image task', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    let calls = 0
    const service = new MediaProjectService({ root: await root(), fetchImpl: async () => { calls++; return Response.json({}) } })
    const project = await service.createImageProject({ prompt: '需要确认的活动海报' })
    await expect(service.submitImageProject(project.id)).rejects.toMatchObject({
      code: 'DATA_EGRESS_CONSENT_REQUIRED',
      status: 428,
    })
    expect(calls).toBe(0)
    expect((await service.getProject(project.id)).state).toBe('draft')
  })

  test('persists a safe image failure instead of the upstream response detail', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    const rawDetail = 'provider quota rejected token=private-token at /private/gateway.log'
    const service = new MediaProjectService({
      root: await root(),
      fetchImpl: async () => Response.json({ error: rawDetail }, { status: 400 }),
    })
    const project = await service.createImageProject({ prompt: '安全失败海报' })

    await expect(submitImage(service, project.id)).rejects.toMatchObject({
      code: 'IMAGE_SUBMIT_FAILED',
      message: '图片生成暂时不可用，请稍后重试。',
    })
    const failedProject = await service.getProject(project.id)
    if (failedProject.kind !== 'image') throw new Error('wrong kind')
    const failedTask = await service.getTask(failedProject.task_id!, false)
    expect(failedProject).toMatchObject({
      state: 'failed',
      error: '图片生成暂时不可用，请稍后重试。',
      error_code: 'MEDIA_IMAGE_UNAVAILABLE',
    })
    expect(failedTask).toMatchObject({
      status: 'failed',
      error: '图片生成暂时不可用，请稍后重试。',
      error_code: 'MEDIA_IMAGE_UNAVAILABLE',
    })
    expect(JSON.stringify({ failedProject, failedTask })).not.toContain(rawDetail)
  })

  test('requires explicit confirmation before an unknown submission is replaced by an edited draft', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
    await expect(submitImage(service, project.id)).rejects.toBeInstanceOf(MediaServiceError)
    const failed = await service.getProject(project.id)
    if (failed.kind !== 'image') throw new Error('wrong kind')
    expect(failed.state).toBe('failed')
    const failedTask = await service.getTask(failed.task_id!, false)
    expect(failedTask.outcome_unknown).toBe(true)
    expect(failedTask.remote_task_id).toBeUndefined()

    await expect(service.updateImageProject(project.id, {
      revision: failed.revision,
      user_request: '第二版海报',
      size: '1536x1024',
    })).rejects.toMatchObject({ code: 'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED' })

    const edited = await service.updateImageProject(project.id, {
      revision: failed.revision,
      user_request: '第二版海报',
      size: '1536x1024',
      confirm_unknown_retry: true,
    })
    expect(edited).toMatchObject({ state: 'draft', task_id: undefined })
    const retry = await submitImage(service, edited.id)
    expect(retry.remote_task_id).toBe('remote-retry')
    expect(keys).toHaveLength(2)
    expect(keys[0]).not.toBe(keys[1])
  })

  test('reuses the persisted idempotency key when a submit response is lost', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
    await expect(submitImage(service, project.id)).rejects.toMatchObject({ code: 'IMAGE_SUBMIT_UNKNOWN' })
    const failed = await service.getProject(project.id)
    if (failed.kind !== 'image') throw new Error('wrong kind')
    const recovered = await submitImage(service, project.id)

    expect(recovered).toMatchObject({ remote_task_id: 'remote-recovered', outcome_unknown: false })
    expect(keys).toHaveLength(2)
    expect(keys[0]).toBe(keys[1])
  })

  test('recovers a crash after intent persistence but before remote task id persistence', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
    void submitImage(interrupted, project.id).catch(() => undefined)

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
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
    const task = await submitImage(service, project.id)
    const failed = await service.getTask(task.id)
    expect(failed.status).toBe('failed')
    expect(failed.outcome_unknown).toBe(true)
    expect(failed.error).toContain('可能已经产生费用')
    const failedProject = await service.getProject(project.id)
    expect(failedProject).toMatchObject({ state: 'failed' })

    await expect(submitImage(service, project.id)).rejects.toMatchObject({
      code: 'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED',
    })
    const retried = await submitImage(service, project.id, { confirm_unknown_retry: true })
    expect(retried.remote_task_id).toBe('remote-confirmed-retry')
    expect(keys).toHaveLength(2)
    expect(keys[1]).not.toBe(keys[0])
  })

  test('bounds a stalled gateway result body while keeping the remote task pollable', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    let resultBodyAborted = false
    const service = new MediaProjectService({
      root: await root(),
      imageResultTimeoutMs: 20,
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') {
          return Response.json({ task_id: 'remote-stalled-body', status: 'queued' }, { status: 202 })
        }
        init?.signal?.addEventListener('abort', () => { resultBodyAborted = true }, { once: true })
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const project = await service.createImageProject({ prompt: '等待图片结果' })
    const submitted = await submitImage(service, project.id)
    const refreshed = await service.getTask(submitted.id)

    expect(refreshed).toMatchObject({ status: 'queued', remote_task_id: 'remote-stalled-body' })
    expect(resultBodyAborted).toBe(true)
  })

  test('deduplicates concurrent final image polls and materializes the result once', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
    process.env.QF_GATEWAY_TOKEN = 'app-token'
    let resultPolls = 0
    let releaseResult!: () => void
    const resultReady = new Promise<void>(resolve => { releaseResult = resolve })
    const service = new MediaProjectService({
      root: await root(),
      fetchImpl: async (_input, init) => {
        if (init?.method === 'POST') {
          return Response.json({ task_id: 'remote-deduplicated', status: 'running' }, { status: 202 })
        }
        resultPolls += 1
        await resultReady
        return Response.json({
          status: 'succeeded',
          data: [{ b64_json: Buffer.from('one-image-result').toString('base64') }],
        })
      },
    })
    const project = await service.createImageProject({ prompt: '只落盘一次' })
    const submitted = await submitImage(service, project.id)
    const first = service.getTask(submitted.id)
    const second = service.getTask(submitted.id)
    await Bun.sleep(5)
    expect(resultPolls).toBe(1)
    releaseResult()

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.result).toEqual(secondResult.result)
    expect(resultPolls).toBe(1)
    const ready = await service.getProject(project.id)
    expect(ready).toMatchObject({ state: 'ready', outputs: [{ asset_path: expect.stringContaining('/api/media/assets/') }] })
  })

  test('stores reference images as private assets and migrates legacy inline projects on read', async () => {
    const mediaRoot = await root()
    const reference = `data:image/png;base64,${Buffer.from('private-reference').toString('base64')}`
    const service = new MediaProjectService({ root: mediaRoot })
    const created = await service.createImageProject({
      prompt: '参考图编辑',
      mode: 'edit',
      reference_images: [reference],
      reference_roles: ['subject'],
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

  test('migrates legacy output lists into independent immutable versions without losing results', async () => {
    const mediaRoot = await root()
    const service = new MediaProjectService({ root: mediaRoot })
    const created = await service.createImageProject({ user_request: '旧图片结果' })
    const outputId = 'out_legacy001'
    const fileName = `${outputId}.png`
    await mkdir(join(mediaRoot, 'assets', created.id), { recursive: true })
    await writeFile(join(mediaRoot, 'assets', created.id, fileName), pngBytes(1, 1))
    await writeFile(join(mediaRoot, 'projects', `${created.id}.json`), `${JSON.stringify({
      ...created,
      state: 'ready',
      outputs: [{
        id: outputId,
        mime_type: 'image/png',
        asset_path: `/api/media/assets/${created.id}/${fileName}`,
      }],
    }, null, 2)}\n`)

    const migrated = await new MediaProjectService({ root: mediaRoot }).getProject(created.id)
    if (migrated.kind !== 'image') throw new Error('wrong kind')
    expect(migrated.outputs[0]).toMatchObject({
      id: outputId,
      version_kind: 'generated',
      operation_id: expect.stringMatching(/^op_/),
      version_id: expect.stringMatching(/^ver_/),
    })
    expect(migrated.versions).toContainEqual(expect.objectContaining({
      id: migrated.outputs[0]!.version_id,
      asset_ids: [outputId],
    }))
    const reread = await new MediaProjectService({ root: mediaRoot }).getProject(created.id)
    expect(reread.writer_fence).toBe(migrated.writer_fence)
  })

  test('rejects a reference-image symlink before it can be sent to the image service', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
      reference_roles: ['subject'],
    })
    const referenceName = project.reference_image_assets?.[0]
    if (!referenceName) throw new Error('reference asset missing')

    const referencePath = join(mediaRoot, 'assets', project.id, 'references', referenceName)
    const outsidePath = join(mediaRoot, 'outside-reference.png')
    await writeFile(outsidePath, 'private-file')
    await rm(referencePath)
    await symlink(outsidePath, referencePath)

    await expect(submitImage(service, project.id)).rejects.toMatchObject({
      code: 'ASSET_OUTSIDE_PROJECT',
      status: 403,
    })
  })

  test('reconciles a succeeded image task whose project update was interrupted', async () => {
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
    const task = await submitImage(service, created.id)
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
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
    const task = await submitImage(service, project.id)
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
    process.env.QF_GATEWAY_URL = 'https://gateway.example/gw'
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
    const task = await submitImage(service, project.id)
    expect((await service.cancelTask(task.id)).status).toBe('cancelled')
    expect(await service.getProject(project.id)).toMatchObject({
      state: 'failed',
      error: '图片生成已取消。',
      error_code: 'MEDIA_IMAGE_CANCELLED',
    })
  })
})

describe('MediaProjectService video projects', () => {
  test('returns a safe source-read error instead of probe diagnostics', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const rawDetail = 'ffprobe could not parse /private/Movies/source.mp4 token=private-token'
    await writeFile(sourcePath, 'source')
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess: async () => ({ exitCode: 1, stdout: '', stderr: rawDetail }),
    })
    const project = await service.createVideoProject({})

    await expect(service.addVideoSource(project.id, { path: sourcePath })).rejects.toMatchObject({
      code: 'VIDEO_PROBE_FAILED',
      message: '无法读取该视频素材，请确认文件可正常播放后重试。',
    })
  })

  test('persists a safe export failure instead of local process output', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const outputPath = join(mediaRoot, 'output.mp4')
    const rawDetail = 'ffmpeg failed for /private/Movies/source.mp4 token=private-token'
    await writeFile(sourcePath, 'source')
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess: async command => {
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
        return { exitCode: 1, stdout: '', stderr: rawDetail }
      },
    })
    const created = await service.createVideoProject({})
    const { project } = await service.addVideoSource(created.id, { path: sourcePath })
    const task = await service.renderVideo(project.id, {
      revision: project.revision,
      output_path: outputPath,
    })

    let failed = await service.getTask(task.id, false)
    for (let index = 0; index < 20 && failed.status !== 'failed'; index += 1) {
      await Bun.sleep(5)
      failed = await service.getTask(task.id, false)
    }
    const failedProject = await service.getProject(project.id)
    expect(failed).toMatchObject({
      status: 'failed',
      error: '视频导出失败，请检查素材和导出位置后重试。',
      error_code: 'MEDIA_VIDEO_EXPORT_FAILED',
    })
    expect(failedProject).toMatchObject({
      state: 'failed',
      error: '视频导出失败，请检查素材和导出位置后重试。',
      error_code: 'MEDIA_VIDEO_EXPORT_FAILED',
    })
    expect(JSON.stringify({ failed, failedProject })).not.toContain(rawDetail)
  })

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
    expect(await service.availableVideoOutputMimeType(project.id)).toBe('video/mp4')
    const preview = await service.videoOutputResponse(
      project.id,
      new Request('http://localhost/video', { headers: { Range: 'bytes=0-3' } }),
    )
    expect(preview.status).toBe(206)
    expect(preview.headers.get('Content-Type')).toBe('video/mp4')
    expect(preview.headers.get('Content-Range')).toBe('bytes 0-3/8')
    expect(await preview.text()).toBe('rend')
    const ffmpeg = commands.find(command => command.includes('-filter_complex'))
    expect(ffmpeg).toContain('mpeg4')
    expect(ffmpeg).toContain('+faststart')
    expect(ffmpeg?.join(' ')).toContain('concat=n=1:v=1:a=1')
    expect(ffmpeg?.join(' ')).toContain('channel_layouts=stereo')
  })

  test('falls back once from an automatic VideoToolbox encoder failure to portable mpeg4', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    await writeFile(sourcePath, 'source')
    const attemptedEncoders: string[] = []
    const runProcess: MediaProcessRunner = async command => {
      if (command.includes('-version')) return { exitCode: 0, stdout: 'version', stderr: '' }
      if (command.includes('-encoders')) {
        return { exitCode: 0, stdout: ' V..... h264_videotoolbox H.264\n V..... mpeg4 MPEG-4 part 2', stderr: '' }
      }
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
      const encoder = command[command.indexOf('-c:v') + 1]
      attemptedEncoders.push(encoder ?? '')
      if (encoder === 'h264_videotoolbox') {
        return { exitCode: 1, stdout: '', stderr: 'Cannot create compression session: -12908' }
      }
      await writeFile(command.at(-1)!, 'rendered')
      return { exitCode: 0, stdout: '', stderr: '' }
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess, platform: 'darwin' })
    const first = await service.createVideoProject({ title: 'hardware fallback' })
    const firstReady = await service.addVideoSource(first.id, { path: sourcePath })
    const firstTask = await service.renderVideo(firstReady.project.id, {
      revision: firstReady.project.revision,
      output_path: join(mediaRoot, 'first.mp4'),
    })
    let completed = await service.getTask(firstTask.id, false)
    for (let index = 0; index < 20 && completed.status !== 'succeeded'; index += 1) {
      await Bun.sleep(5)
      completed = await service.getTask(firstTask.id, false)
    }
    expect(completed).toMatchObject({ status: 'succeeded', result: { video_encoder: 'mpeg4' } })
    expect(attemptedEncoders).toEqual(['h264_videotoolbox', 'mpeg4'])

    const second = await service.createVideoProject({ title: 'cached software fallback' })
    const secondReady = await service.addVideoSource(second.id, { path: sourcePath })
    const secondTask = await service.renderVideo(secondReady.project.id, {
      revision: secondReady.project.revision,
      output_path: join(mediaRoot, 'second.mp4'),
    })
    let secondCompleted = await service.getTask(secondTask.id, false)
    for (let index = 0; index < 20 && secondCompleted.status !== 'succeeded'; index += 1) {
      await Bun.sleep(5)
      secondCompleted = await service.getTask(secondTask.id, false)
    }
    expect(secondCompleted).toMatchObject({ status: 'succeeded', result: { video_encoder: 'mpeg4' } })
    expect(attemptedEncoders).toEqual(['h264_videotoolbox', 'mpeg4', 'mpeg4'])
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
    const service = new MediaProjectService({
      root: mediaRoot,
      runProcess,
      env: { BB_MEDIA_MAX_QUEUED_RENDERS: '0' },
    })
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

  test('reserves a final output path while another video task owns it', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    const outputPath = join(mediaRoot, 'shared-output.mp4')
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
        const finish = () => resolve({ exitCode: 1, stdout: '', stderr: 'cancelled' })
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
      output_path: outputPath,
    })
    for (let index = 0; index < 50 && !renderStarted; index += 1) await Bun.sleep(2)

    await expect(service.renderVideo(second.id, {
      revision: secondReady.project.revision,
      output_path: outputPath,
    })).rejects.toMatchObject({ code: 'VIDEO_OUTPUT_PATH_BUSY' })

    await service.cancelTask(firstTask.id)
    const secondTask = await service.renderVideo(second.id, {
      revision: secondReady.project.revision,
      output_path: outputPath,
    })
    await service.cancelTask(secondTask.id)
  })

  test('admits one desktop sidecar\'s ten video windows while keeping only one FFmpeg encoder active', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    await writeFile(sourcePath, 'source')
    let renderStarts = 0
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
      renderStarts += 1
      return await new Promise(resolve => {
        const finish = () => resolve({ exitCode: 1, stdout: '', stderr: 'cancelled' })
        if (options?.signal?.aborted) finish()
        else options?.signal?.addEventListener('abort', finish, { once: true })
      })
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess })
    const ready: Array<{ project: VideoStudioProject }> = []
    for (let index = 0; index < 11; index += 1) {
      const project = await service.createVideoProject({ title: `window-${index + 1}` })
      ready.push(await service.addVideoSource(project.id, { path: sourcePath }))
    }
    const outcomes = await Promise.all(ready.map(async (item, index) => {
      try {
        return {
          task: await service.renderVideo(item.project.id, {
            revision: item.project.revision,
            output_path: join(mediaRoot, 'exports', `window-${index + 1}.mp4`),
          }),
        }
      } catch (error) {
        return { error }
      }
    }))
    const accepted = outcomes.flatMap(outcome => 'task' in outcome ? [outcome.task] : [])
    const rejected = outcomes.flatMap(outcome => 'error' in outcome ? [outcome.error] : [])
    expect(accepted).toHaveLength(10)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ code: 'VIDEO_RENDER_BUSY' })
    for (let index = 0; index < 50 && renderStarts < 1; index += 1) await Bun.sleep(2)
    expect(renderStarts).toBe(1)
    await Promise.all(accepted.map(task => service.cancelTask(task.id)))
  })

  test('runs 100 local sidecars with ten admitted video windows each without sharing an FFmpeg encoder', async () => {
    let renderStarts = 0
    let activeEncoders = 0
    let peakEncoders = 0
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
      renderStarts += 1
      activeEncoders += 1
      peakEncoders = Math.max(peakEncoders, activeEncoders)
      return await new Promise(resolve => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          activeEncoders -= 1
          resolve({ exitCode: 1, stdout: '', stderr: 'cancelled' })
        }
        if (options?.signal?.aborted) finish()
        else options?.signal?.addEventListener('abort', finish, { once: true })
      })
    }
    const users = await Promise.all(Array.from({ length: 100 }, async (_, userIndex) => {
      const mediaRoot = await root()
      const sourcePath = join(mediaRoot, 'source.mp4')
      await writeFile(sourcePath, 'source')
      const service = new MediaProjectService({ root: mediaRoot, runProcess })
      const projects = await Promise.all(Array.from({ length: 10 }, (_, windowIndex) => (
        service.createVideoProject({ title: `user-${userIndex + 1}-window-${windowIndex + 1}` })
      )))
      const prepared = await Promise.all(projects.map(project => service.addVideoSource(project.id, { path: sourcePath })))
      const tasks = await Promise.all(prepared.map((ready, windowIndex) => (
        service.renderVideo(ready.project.id, {
          revision: ready.project.revision,
          output_path: join(mediaRoot, 'exports', `window-${windowIndex + 1}.mp4`),
        })
      )))
      return { service, tasks }
    }))

    const accepted = users.flatMap(user => user.tasks)
    expect(accepted).toHaveLength(1_000)
    expect(users.every(user => user.tasks[0]?.stage === '等待导出')).toBe(true)
    expect(users.every(user => user.tasks.slice(1).every(task => task.stage === '正在排队等待本机视频导出'))).toBe(true)
    for (let index = 0; index < 500 && renderStarts < 100; index += 1) await Bun.sleep(2)
    expect(renderStarts).toBe(100)
    expect(peakEncoders).toBe(100)

    const cancelledQueued = await Promise.all(users.flatMap(user => (
      user.tasks.slice(1).map(task => user.service.cancelTask(task.id))
    )))
    expect(cancelledQueued).toHaveLength(900)
    expect(cancelledQueued.every(task => task.status === 'cancelled')).toBe(true)
    const cancelledActive = await Promise.all(users.map(user => user.service.cancelTask(user.tasks[0]!.id)))
    expect(cancelledActive.every(task => task.status === 'cancelled')).toBe(true)
    expect(renderStarts).toBe(100)
    expect(activeEncoders).toBe(0)
  })

  test('limits each local sidecar to two FFprobe scans and eight waiting windows', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    await writeFile(sourcePath, 'source')
    let activeProbes = 0
    let peakProbes = 0
    const runProcess: MediaProcessRunner = async command => {
      if (!command.includes('-show_streams')) throw new Error(`unexpected command: ${command[0]}`)
      activeProbes += 1
      peakProbes = Math.max(peakProbes, activeProbes)
      await Bun.sleep(5)
      activeProbes -= 1
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: '2' },
          streams: [{ codec_type: 'video', width: 1280, height: 720 }],
        }),
        stderr: '',
      }
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess })
    const projectIds = await Promise.all(Array.from({ length: 10 }, async (_, index) => (
      (await service.createVideoProject({ title: `probe-window-${index + 1}` })).id
    )))

    const results = await Promise.all(projectIds.map(projectId => service.addVideoSource(projectId, { path: sourcePath })))
    expect(results).toHaveLength(10)
    expect(peakProbes).toBe(2)
    expect(activeProbes).toBe(0)
  })

  test('rejects excess FFprobe admissions instead of opening an unbounded local scan burst', async () => {
    const mediaRoot = await root()
    const sourcePath = join(mediaRoot, 'source.mp4')
    await writeFile(sourcePath, 'source')
    const runProcess: MediaProcessRunner = async command => {
      if (!command.includes('-show_streams')) throw new Error(`unexpected command: ${command[0]}`)
      await Bun.sleep(5)
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          format: { duration: '2' },
          streams: [{ codec_type: 'video', width: 1280, height: 720 }],
        }),
        stderr: '',
      }
    }
    const service = new MediaProjectService({ root: mediaRoot, runProcess })
    const projectIds = await Promise.all(Array.from({ length: 11 }, async (_, index) => (
      (await service.createVideoProject({ title: `probe-overflow-${index + 1}` })).id
    )))
    const outcomes = await Promise.all(projectIds.map(async projectId => {
      try {
        return { result: await service.addVideoSource(projectId, { path: sourcePath }) }
      } catch (error) {
        return { error }
      }
    }))
    const accepted = outcomes.flatMap(outcome => 'result' in outcome ? [outcome.result] : [])
    const rejected = outcomes.flatMap(outcome => 'error' in outcome ? [outcome.error] : [])
    expect(accepted).toHaveLength(10)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toMatchObject({ code: 'VIDEO_PROBE_BUSY' })
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

  test('materializes owner, operation, immutable assets, versions, and writer fences', async () => {
    const mediaRoot = await root()
    const reference = `data:image/png;base64,${Buffer.from('foundation-reference').toString('base64')}`
    const service = new MediaProjectService({ root: mediaRoot })
    const project = await service.createImageProject({
      prompt: '媒体基础合同',
      mode: 'edit',
      reference_images: [reference],
      reference_roles: ['subject'],
    })

    expect(project.owner).toEqual({ kind: 'standalone', owner_id: 'local_workbench' })
    expect(project.assets).toHaveLength(1)
    expect(project.assets[0]).toMatchObject({
      role: 'reference',
      storage: { kind: 'cas' },
    })
    expect(project.assets[0]?.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(project.versions).toHaveLength(1)
    expect(project.versions[0]).toMatchObject({ project_revision: 0 })
    const duplicate = await service.createImageProject({
      prompt: '同内容去重',
      mode: 'edit',
      reference_images: [reference],
      reference_roles: ['subject'],
    })
    expect(duplicate.assets[0]?.content_hash).toBe(project.assets[0]?.content_hash)
    expect(await readdir(join(mediaRoot, 'cas', 'sha256'))).toHaveLength(1)
    await writeFile(
      join(mediaRoot, 'assets', project.id, 'references', project.reference_image_assets![0]!),
      'tampered-reference',
    )
    await expect(service.updateImageProject(project.id, {
      revision: project.revision,
      user_request: '不能覆盖不可变素材',
      size: project.size,
    })).rejects.toMatchObject({ code: 'ASSET_IMMUTABLE', status: 409 })
    expect(project.writer_fence).toMatch(/^fence_[a-f0-9]{32}$/)
    expect(project.writer_fence).not.toBe(`fence_${'0'.repeat(32)}`)

    const video = await service.createVideoProject({})
    const sourcePath = join(mediaRoot, 'foundation.mp4')
    await writeFile(sourcePath, 'source')
    const imported = await new MediaProjectService({
      root: mediaRoot,
      runProcess: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ format: { duration: '1' }, streams: [{ codec_type: 'video' }] }),
        stderr: '',
      }),
    }).addVideoSource(video.id, { path: sourcePath })
    expect(imported.task).toMatchObject({
      owner: { kind: 'standalone', owner_id: 'local_workbench' },
      attempt: 1,
    })
    expect(imported.task.operation_id).toMatch(/^op_[a-f0-9]{32}$/)
    expect(imported.project.assets).toContainEqual(expect.objectContaining({
      role: 'source', storage: { kind: 'external', locator: sourcePath },
    }))
  })

  test('uses compare-and-swap fencing so concurrent draft writes never silently overwrite', async () => {
    const mediaRoot = await root()
    const creator = new MediaProjectService({ root: mediaRoot })
    const project = await creator.createImageProject({ prompt: '初始文案' })
    const writers = Array.from({ length: 12 }, () => new MediaProjectService({ root: mediaRoot }))
    const results = await Promise.allSettled(writers.map((writer, index) => writer.updateImageProject(project.id, {
      revision: project.revision,
      user_request: `并发文案 ${index}`,
      size: '1024x1024',
    })))

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(11)
    expect((await creator.getProject(project.id)).revision).toBe(1)
  })

  test('moves a deletion into an accounted recovery window and restores every managed byte', async () => {
    const mediaRoot = await root()
    const now = new Date('2026-07-24T04:00:00.000Z')
    const service = new MediaProjectService({ root: mediaRoot, now: () => now, deletionRetentionDays: 30 })
    const referenceBytes = Buffer.from('recoverable-reference')
    const project = await service.createImageProject({
      prompt: '可恢复删除',
      mode: 'edit',
      reference_images: [`data:image/png;base64,${referenceBytes.toString('base64')}`],
      reference_roles: ['subject'],
    })
    const referenceName = project.reference_image_assets![0]!

    const deleted = await service.deleteProject(project.id)
    expect(deleted).toMatchObject({
      status: 'deleted',
      managed_asset_count: 1,
      managed_asset_bytes: referenceBytes.byteLength,
      owner: { kind: 'standalone', owner_id: 'local_workbench' },
    })
    expect(deleted.purge_after).toBe('2026-08-23T04:00:00.000Z')
    await expect(service.getProject(project.id)).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
    await expect(service.restoreProject(project.id, {
      kind: 'product_task',
      owner_id: 'task_0123456789abcdef',
    })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })

    expect(await service.restoreProject(project.id, {
      kind: 'standalone', owner_id: 'local_workbench',
    })).toMatchObject({ status: 'restored' })
    expect(await service.getProject(project.id)).toMatchObject({ id: project.id })
    expect(await readFile(join(mediaRoot, 'assets', project.id, 'references', referenceName), 'utf8'))
      .toBe(referenceBytes.toString())
  })

  test('garbage collection purges expired trash but retains the accounting receipt', async () => {
    const mediaRoot = await root()
    let now = new Date('2026-07-24T04:00:00.000Z')
    const service = new MediaProjectService({ root: mediaRoot, now: () => now, deletionRetentionDays: 1 })
    const project = await service.createImageProject({
      prompt: '过期回收',
      mode: 'edit',
      reference_images: [`data:image/png;base64,${Buffer.from('expiring-cas').toString('base64')}`],
      reference_roles: ['subject'],
    })
    const deleted = await service.deleteProject(project.id)
    now = new Date('2026-07-25T04:00:01.000Z')

    expect(await service.purgeExpiredDeletions()).toEqual([
      expect.objectContaining({ deletion_id: deleted.deletion_id, status: 'purged' }),
    ])
    expect(await stat(join(mediaRoot, 'trash', deleted.trash_key)).catch(() => null)).toBeNull()
    expect(await readdir(join(mediaRoot, 'cas', 'sha256'))).toHaveLength(0)
    const persisted = JSON.parse(await readFile(join(mediaRoot, 'deletions', `${deleted.deletion_id}.json`), 'utf8'))
    expect(persisted).toMatchObject({ status: 'purged', managed_asset_count: 1 })
    await expect(service.restoreProject(project.id, {
      kind: 'standalone', owner_id: 'local_workbench',
    })).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  test('deduplicates concurrent deletion and resumes a restore after project publication', async () => {
    const mediaRoot = await root()
    const creator = new MediaProjectService({ root: mediaRoot })
    const project = await creator.createImageProject({ prompt: '并发删除恢复' })
    const [first, second] = await Promise.all([
      new MediaProjectService({ root: mediaRoot }).deleteProject(project.id),
      new MediaProjectService({ root: mediaRoot }).deleteProject(project.id),
    ])
    expect(second.deletion_id).toBe(first.deletion_id)

    const trash = join(mediaRoot, 'trash', first.trash_key)
    await rename(join(trash, 'project.json'), join(mediaRoot, 'projects', `${project.id}.json`))
    await writeFile(
      join(mediaRoot, 'deletions', `${first.deletion_id}.json`),
      `${JSON.stringify({ ...first, status: 'restoring' }, null, 2)}\n`,
    )

    expect(await creator.restoreProject(project.id, {
      kind: 'standalone', owner_id: 'local_workbench',
    })).toMatchObject({ status: 'restored' })
    expect(await creator.getProject(project.id)).toMatchObject({ id: project.id })
  })
})
