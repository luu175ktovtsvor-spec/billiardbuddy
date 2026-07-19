import { expect, test } from 'bun:test'
import { MediaWorkbenchTool, sanitizeMediaWorkbenchResult } from './MediaWorkbenchTool.js'

test('keeps local media paths and task credentials out of Agent tool results', () => {
  const result = sanitizeMediaWorkbenchResult({
    server_debug: '/Users/example/private-server-log',
    project: {
      id: 'vid_project01',
      kind: 'video',
      title: '活动集锦',
      state: 'ready',
      revision: 4,
      workspace_root: '/Users/example/private-workspace',
      output_path: '/Users/example/Movies/final.mp4',
      error: 'ffmpeg failed for /Users/example/Movies/source.mp4',
      sources: [{
        id: 'src_source01',
        path: '/Users/example/Movies/source.mp4',
        name: 'source.mp4',
        duration_ms: 1200,
        width: 1080,
        height: 1920,
        fps: 30,
        has_audio: true,
        raw_probe: '/private/var/folders/probe.json',
      }],
      timeline: [{
        id: 'clip_clip001',
        source_id: 'src_source01',
        in_ms: 0,
        out_ms: 1200,
        raw_note: '/Users/example/Movies/source.mp4',
      }],
      output: { width: 1080, height: 1920, fps: 30, encoder: 'private-encoder' },
      task_id: 'task_render01',
      hidden: 'secret-project-field',
    },
    task: {
      id: 'task_render01',
      project_id: 'vid_project01',
      kind: 'video.render',
      status: 'failed',
      progress: 40,
      stage: '导出失败: /Users/example/Movies/source.mp4',
      remote_task_id: 'upstream-task',
      idempotency_key: 'secret-idempotency-key',
      error: 'ffmpeg failed for /Users/example/Movies/source.mp4',
      outcome_unknown: true,
      result: {
        output_path: '/Users/example/Movies/final.mp4',
        temporary_output: '/Users/example/Movies/final.partial.mp4',
        render_revision: 2,
        stderr: 'ffmpeg /Users/example/Movies/source.mp4',
      },
      hidden: 'secret-task-field',
    },
  })

  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain('/Users/example')
  expect(serialized).not.toContain('/private/var')
  expect(serialized).not.toContain('secret-idempotency-key')
  expect(serialized).not.toContain('private-server-log')
  expect(serialized).not.toContain('secret-project-field')
  expect(serialized).not.toContain('secret-task-field')
  expect(result).toEqual({
    project: {
      id: 'vid_project01',
      kind: 'video',
      state: 'ready',
      title: '活动集锦',
      revision: 4,
      sources: [{
        id: 'src_source01',
        name: 'source.mp4',
        duration_ms: 1200,
        width: 1080,
        height: 1920,
        fps: 30,
        has_audio: true,
      }],
      timeline: [{ id: 'clip_clip001', source_id: 'src_source01', in_ms: 0, out_ms: 1200 }],
      output: { width: 1080, height: 1920, fps: 30 },
      task_id: 'task_render01',
    },
    task: {
      id: 'task_render01',
      kind: 'video.render',
      project_id: 'vid_project01',
      status: 'failed',
      progress: 40,
      outcome_unknown: true,
      result: { render_revision: 2 },
    },
  })
})

test('keeps image bytes and nested task output details out of Agent tool results', () => {
  const result = sanitizeMediaWorkbenchResult({
    message: 'gateway returned https://gateway.example/private-output',
    project: {
      id: 'img_project01',
      kind: 'image',
      title: '会员日海报',
      state: 'ready',
      revision: 2,
      mode: 'edit',
      prompt: '制作会员日海报',
      size: '1024x1536',
      count: 2,
      workspace_root: '/Users/example/private-workspace',
      error: 'image provider rejected /Users/example/private-reference.png',
      notice: 'provider endpoint https://gateway.example/internal',
      reference_images: ['data:image/png;base64,cHJpdmF0ZQ=='],
      reference_image_assets: ['ref_0123456789abcdef0123456789abcdef.png'],
      outputs: [{
        id: 'out_output01',
        data_url: 'data:image/png;base64,cHJpdmF0ZS1vdXRwdXQ=',
        asset_path: '/api/media/assets/img_project01/out_output01.png',
        url: 'https://gateway.example/private-output',
        mime_type: 'image/png',
      }],
      task_id: 'task_image001',
    },
    task: {
      id: 'task_image001',
      project_id: 'img_project01',
      kind: 'image.generate',
      status: 'succeeded',
      progress: 100,
      stage: '生成完成',
      remote_task_id: 'remote-upstream-task',
      idempotency_key: 'secret-idempotency-key',
      error: 'provider error https://gateway.example/private',
      result: {
        output_count: 1,
        outputs: [{
          id: 'out_output01',
          data_url: 'data:image/png;base64,cHJpdmF0ZS10YXNrLW91dHB1dA==',
          asset_path: '/api/media/assets/img_project01/out_output01.png',
          url: 'https://gateway.example/private-task-output',
        }],
        input_fidelity_status: 'unsupported',
        input_fidelity_risk: '请访问 https://gateway.example/private-risk',
        nested: { data_url: 'data:image/png;base64,bmVzdGVk' },
      },
    },
  })

  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain('private-workspace')
  expect(serialized).not.toContain('cHJpdmF0ZQ==')
  expect(serialized).not.toContain('cHJpdmF0ZS10YXNrLW91dHB1dA==')
  expect(serialized).not.toContain('gateway.example')
  expect(serialized).not.toContain('secret-idempotency-key')
  expect(result).toEqual({
    project: {
      id: 'img_project01',
      kind: 'image',
      state: 'ready',
      title: '会员日海报',
      revision: 2,
      mode: 'edit',
      prompt: '制作会员日海报',
      size: '1024x1536',
      count: 2,
      reference_image_count: 1,
      task_id: 'task_image001',
      output_count: 1,
    },
    task: {
      id: 'task_image001',
      kind: 'image.generate',
      project_id: 'img_project01',
      status: 'succeeded',
      progress: 100,
      result: { output_count: 1, input_fidelity_status: 'unsupported' },
    },
  })
})

test('replaces server and connection failures with safe media-tool messages', async () => {
  const originalServerUrl = process.env.BB_DESKTOP_SERVER_URL
  const originalFetch = globalThis.fetch
  process.env.BB_DESKTOP_SERVER_URL = 'http://127.0.0.1:31415'
  try {
    globalThis.fetch = (async (_input, init) => {
      expect(init?.redirect).toBe('error')
      return Response.json({
        message: 'ffprobe failed for /Users/example/Movies/private.mov with token=secret',
      }, { status: 422 })
    }) as typeof fetch

    await expect(MediaWorkbenchTool.call({
      action: 'get_project',
      project_id: 'vid_project01',
    }, { abortController: new AbortController() } as never)).rejects.toThrow(
      '媒体素材暂时无法读取，请在工作台检查后重试',
    )

    globalThis.fetch = (async () => {
      throw new Error('connect ECONNREFUSED http://127.0.0.1:31415/private-token')
    }) as typeof fetch
    await expect(MediaWorkbenchTool.call({
      action: 'get_task',
      task_id: 'task_render01',
    }, { abortController: new AbortController() } as never)).rejects.toThrow(
      '媒体工作台暂时无法连接，请稍后重试',
    )
  } finally {
    globalThis.fetch = originalFetch
    if (originalServerUrl === undefined) delete process.env.BB_DESKTOP_SERVER_URL
    else process.env.BB_DESKTOP_SERVER_URL = originalServerUrl
  }
})
