import { expect, test } from 'bun:test'
import { sanitizeMediaWorkbenchResult } from './MediaWorkbenchTool.js'

test('keeps local media paths and task credentials out of Agent tool results', () => {
  const result = sanitizeMediaWorkbenchResult({
    project: {
      id: 'vid_project01',
      kind: 'video',
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
        has_audio: true,
      }],
    },
    task: {
      id: 'task_render01',
      remote_task_id: 'upstream-task',
      idempotency_key: 'secret-idempotency-key',
      error: 'ffmpeg failed for /Users/example/Movies/source.mp4',
      result: {
        output_path: '/Users/example/Movies/final.mp4',
        temporary_output: '/Users/example/Movies/final.partial.mp4',
        render_revision: 2,
      },
      status: 'failed',
      stage: '导出失败',
    },
  })

  expect(JSON.stringify(result)).not.toContain('/Users/example')
  expect(JSON.stringify(result)).not.toContain('secret-idempotency-key')
  expect(result).toMatchObject({
    project: {
      sources: [{ id: 'src_source01', name: 'source.mp4' }],
    },
    task: {
      id: 'task_render01',
      status: 'failed',
      result: { render_revision: 2 },
    },
  })
})

test('keeps image content bytes and local workspace details out of Agent tool results', () => {
  const result = sanitizeMediaWorkbenchResult({
    project: {
      id: 'img_project01',
      kind: 'image',
      workspace_root: '/Users/example/private-workspace',
      error: 'image provider rejected /Users/example/private-reference.png',
      reference_images: ['data:image/png;base64,cHJpdmF0ZQ=='],
      reference_image_assets: ['ref_0123456789abcdef0123456789abcdef.png'],
      outputs: [{
        id: 'out_output01',
        data_url: 'data:image/png;base64,cHJpdmF0ZS1vdXRwdXQ=',
        asset_path: '/api/media/assets/img_project01/out_output01.png',
        url: 'https://gateway.example/private-output',
        mime_type: 'image/png',
      }],
    },
  })

  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain('private-workspace')
  expect(serialized).not.toContain('cHJpdmF0ZQ==')
  expect(serialized).not.toContain('gateway.example')
  expect(result).toMatchObject({
    project: {
      reference_image_count: 1,
      outputs: [{ id: 'out_output01', mime_type: 'image/png' }],
    },
  })
})
