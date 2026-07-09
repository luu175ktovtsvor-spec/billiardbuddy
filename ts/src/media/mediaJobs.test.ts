import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as QRCode from 'qrcode'
import { MediaJobService } from './mediaJobs'
import { TaskService } from '../tasks/taskService'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

function pngHeaderWithSize(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0)
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}

test('MediaJobService creates local preview image jobs when no backend is configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-local-'))
  try {
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1 })
    const started = await service.startStudioGenerate({ prompt: '开业活动海报', ratio: '9:16', count: 2 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    expect(done.kind).toBe('generate')
    expect(done.progress).toBe(100)
    expect(done.result?.local_preview).toBe(true)
    expect(done.result?.urls).toHaveLength(2)

    const url = (done.result?.urls as string[])[0]!
    const served = service.serveUpload(url)
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toContain('image/svg+xml')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService inspects print QR source quality and preserves QR edges during overlay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-print-qr-quality-'))
  const uploadDir = join(root, 'uploads', 'local')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'qr.png'), pngHeaderWithSize(80, 120))
  const ffmpegPath = join(root, 'fake-ffmpeg.sh')
  const ffmpegArgsPath = join(root, 'ffmpeg-args.txt')
  writeFileSync(ffmpegPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${ffmpegArgsPath}"`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    'printf "qr-overlaid" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        FFMPEG_BIN: ffmpegPath,
      },
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('base-image').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({
      prompt: '印刷海报',
      print_mode: true,
      _print_qr_path: '/uploads/local/qr.png',
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const result = done.result as any
    expect(result).toMatchObject({
      print_mode: true,
      print_qr_overlay: 'ffmpeg',
      print_qr_regeneration: 'source_only',
      print_qr_source_quality: 'warning',
      print_qr_source_width: 80,
      print_qr_source_height: 120,
    })
    expect(result.print_qr_source_warnings.join('\n')).toContain('较小')
    expect(result.print_qr_source_warnings.join('\n')).toContain('不是标准方形')
    expect(result.images[0]).toMatchObject({ print_qr_source_quality: 'warning' })
    expect(readFileSync(ffmpegArgsPath, 'utf8')).toContain('flags=neighbor')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService regenerates print QR from saved content before overlay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-print-qr-regenerate-'))
  const ffmpegPath = join(root, 'fake-ffmpeg.sh')
  const ffmpegArgsPath = join(root, 'ffmpeg-args.txt')
  writeFileSync(ffmpegPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${ffmpegArgsPath}"`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    'printf "qr-regenerated-overlaid" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        FFMPEG_BIN: ffmpegPath,
      },
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('base-image').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({
      prompt: '印刷海报',
      print_mode: true,
      _print_qr_content: 'https://example.com/store/print',
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    const result = done.result as any
    expect(result).toMatchObject({
      print_mode: true,
      print_qr_overlay: 'ffmpeg',
      print_qr_regeneration: 'generated',
    })
    expect(result.images[0]).toMatchObject({ print_qr_regeneration: 'generated' })
    const ffmpegArgs = readFileSync(ffmpegArgsPath, 'utf8')
    expect(ffmpegArgs).toContain('/uploads/tmp/print-qr-')
    const generatedInput = ffmpegArgs.split('\n').find(line => line.includes('/uploads/tmp/print-qr-'))?.trim()
    expect(generatedInput).toBeTruthy()
    expect(existsSync(generatedInput!)).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService decodes uploaded print QR image and regenerates it before overlay', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-print-qr-decode-'))
  const uploadDir = join(root, 'uploads', 'local')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'qr.png'), await QRCode.toBuffer('https://example.com/store/from-image', {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 360,
  }))
  const ffmpegPath = join(root, 'fake-ffmpeg.sh')
  const ffmpegArgsPath = join(root, 'ffmpeg-args.txt')
  writeFileSync(ffmpegPath, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" > "${ffmpegArgsPath}"`,
    'out=""',
    'for arg in "$@"; do out="$arg"; done',
    'printf "qr-decoded-regenerated-overlaid" > "$out"',
    '',
  ].join('\n'), { mode: 0o755 })
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        FFMPEG_BIN: ffmpegPath,
      },
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('base-image').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({
      prompt: '印刷海报',
      print_mode: true,
      _print_qr_path: '/uploads/local/qr.png',
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    const result = done.result as any
    expect(result).toMatchObject({
      print_mode: true,
      print_qr_overlay: 'ffmpeg',
      print_qr_regeneration: 'generated',
      print_qr_regeneration_source: 'decoded_image',
    })
    expect(result.images[0]).toMatchObject({ print_qr_regeneration_source: 'decoded_image' })
    const ffmpegArgs = readFileSync(ffmpegArgsPath, 'utf8')
    expect(ffmpegArgs).toContain('/uploads/tmp/print-qr-')
    expect(ffmpegArgs).not.toContain('/uploads/local/qr.png')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService bridges legacy media backend and stores normalized result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-proxy-'))
  const calls: string[] = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      backendUrl: 'http://legacy.example',
      pollIntervalMs: 1,
      fetchImpl: async input => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/api/v1/studio/generate')) {
          return Response.json({ job_id: 'legacy-job-1' })
        }
        if (url.endsWith('/api/v1/agent/media-jobs/legacy-job-1')) {
          return Response.json({
            id: 'legacy-job-1',
            kind: 'generate',
            status: calls.filter(c => c.includes('media-jobs')).length > 1 ? 'done' : 'running',
            progress: calls.filter(c => c.includes('media-jobs')).length > 1 ? 100 : 30,
            stage: '正在出图',
            result: calls.filter(c => c.includes('media-jobs')).length > 1 ? { urls: ['/uploads/posters/a.jpg'] } : null,
            error: null,
          })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({ prompt: '会员日海报' })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    expect(done.result).toEqual({ urls: ['/uploads/posters/a.jpg'] })
    expect(calls.some(c => c.endsWith('/api/v1/studio/generate'))).toBe(true)
    expect(calls.filter(c => c.includes('/api/v1/agent/media-jobs/legacy-job-1')).length).toBeGreaterThanOrEqual(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService generates real images through configured gateway before local placeholder fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-direct-image-'))
  const calls: Array<{ url: string; body: any }> = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/images/generations')) {
          return Response.json({
            data: [{ b64_json: Buffer.from('png-bytes').toString('base64'), revised_prompt: '会员日海报' }],
          })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({ prompt: '会员日海报', ratio: '9:16', count: 1 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(calls[0]?.url).toBe('http://image-gateway.example/gw/v1/images/generations')
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-image-2', prompt: '会员日海报', n: 1, size: '1024x1536' })
    expect(done.result).toMatchObject({ local_preview: false, provider: 'openai-compatible', model: 'gpt-image-2' })
    expect(done.result?.urls).toHaveLength(1)

    const url = (done.result?.urls as string[])[0]!
    expect(url).toMatch(/^\/uploads\/posters\/image_.*\.png$/)
    const served = service.serveUpload(url)
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toContain('image/png')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService routes GPT image through async submit/poll tasks when QF_GPT_IMAGE_ASYNC=1', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-async-gpt-'))
  const calls: Array<{ url: string; method: string; body: any }> = []
  let polls = 0
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        QF_GPT_IMAGE_ASYNC: '1',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (method === 'POST' && url.endsWith('/images/tasks')) {
          return Response.json({ task_id: 'task-1', status: 'queued' })
        }
        if (method === 'GET' && url.endsWith('/images/tasks/task-1')) {
          polls++
          if (polls < 2) return Response.json({ status: 'running' })
          return Response.json({ status: 'succeeded', data: [{ b64_json: Buffer.from('async-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({ prompt: '复杂创意海报 cinematic', ratio: '1:1', count: 1, image_provider: 'openai' })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    // 根治:GPT 走异步任务而非一次性同步 /images/generations;每一跳都是短请求。
    const submit = calls.find(c => c.method === 'POST' && c.url.endsWith('/images/tasks'))
    expect(submit?.url).toBe('http://image-gateway.example/gw/v1/images/tasks')
    expect(submit?.body).toMatchObject({ mode: 'generate', model: 'gpt-image-2', prompt: '复杂创意海报 cinematic', n: 1 })
    expect(calls.some(c => c.method === 'GET' && c.url.endsWith('/images/tasks/task-1'))).toBe(true)
    expect(polls).toBeGreaterThanOrEqual(2)
    // 全程没有走同步 /images/generations
    expect(calls.some(c => c.url.endsWith('/images/generations'))).toBe(false)
    expect(done.result).toMatchObject({ local_preview: false, provider: 'openai-compatible', model: 'gpt-image-2' })
    expect(done.result?.urls).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService auto-routes default Chinese poster generation to Seedream when gateway is configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-route-seedream-'))
  const calls: Array<{ url: string; body: any }> = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/ark/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({ prompt: '会员日海报，适合台球房朋友圈', ratio: '9:16', count: 1 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(calls[0]?.url).toBe('http://image-gateway.example/gw/v1/ark/images/generations')
    expect(calls[0]?.body).toMatchObject({
      model: 'doubao-seedream-4-5-251128',
      prompt: '会员日海报，适合台球房朋友圈',
      // 9:16(1152×2048=2,359,296)低于火山 Seedream 像素下限 3,686,400,等比放大到 1440×2560(=3,686,400)、各边 16 倍数。
      size: '1440x2560',
    })
    expect(done.result).toMatchObject({
      provider: 'seedream-gateway',
      model: 'doubao-seedream-4-5-251128',
      image_model_route: 'default_seedream',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService marks hard text poster jobs for explicit text QA', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-hard-text-'))
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
        IMAGE_MODEL_NAME: 'doubao-seedream-4-5-251128',
      },
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/ark/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({
      prompt: '做一张会员充值海报，标题写上“会员充值优惠”',
      poster_text: { subtitle: '充多少送多少' },
      ratio: '9:16',
      count: 1,
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(done.result).toMatchObject({
      hard_text_required: true,
      text_quality_status: 'pending_ocr',
      text_quality_warning: true,
    })
    expect(done.result?.hard_text_expected).toEqual(['充多少送多少', '会员充值优惠'])
    expect(String(done.result?.text_quality_warning_message)).toContain('会员充值优惠')
    expect((done.result?.images as any[])[0]).toMatchObject({
      hard_text_required: true,
      text_quality_warning: true,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService retries transient Seedream image gateway throttling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-seedream-retry-'))
  const calls: string[] = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
      },
      fetchImpl: async (input) => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/ark/images/generations') && calls.length === 1) {
          return Response.json({ detail: 'rate limited' }, { status: 429 })
        }
        if (url.endsWith('/ark/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({ prompt: '周末活动海报', ratio: '3:4', count: 1 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(calls.filter(url => url.endsWith('/ark/images/generations'))).toHaveLength(2)
    expect(done.result).toMatchObject({ provider: 'seedream-gateway', image_model_route: 'default_seedream' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService routes western/complex image prompts to OpenAI-compatible images', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-route-openai-'))
  const calls: Array<{ url: string; body: any }> = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('openai-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const prompt = 'A photorealistic portrait of a billiards coach, cinematic lighting, high detail'
    const started = await service.startStudioGenerate({ prompt, ratio: '1:1', count: 1 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(calls[0]?.url).toBe('http://image-gateway.example/gw/v1/images/generations')
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-image-2', prompt, size: '1024x1024' })
    expect(done.result).toMatchObject({
      provider: 'openai-compatible',
      model: 'gpt-image-2',
      image_model_route: 'complex_creative_openai',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService falls back from auto-routed OpenAI image failures to Seedream with redacted warning', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-route-openai-fallback-'))
  const calls: Array<{ url: string; body: any }> = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'sk-openai-secret',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/ark/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
        }
        if (url.endsWith('/images/generations')) {
          return Response.json({ detail: 'upstream failed Bearer sk-openai-secret' }, { status: 502 })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({
      prompt: 'A photorealistic billiards club poster, high fidelity, cinematic lighting',
      ratio: '16:9',
      count: 1,
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(calls.map(call => call.url)).toEqual([
      'http://image-gateway.example/gw/v1/images/generations',
      'http://image-gateway.example/gw/v1/ark/images/generations',
    ])
    expect(done.result).toMatchObject({
      provider: 'seedream-gateway',
      model: 'doubao-seedream-4-5-251128',
      image_model_route: 'openai_failed_seedream_fallback',
      requested_image_model: 'gpt-image-2',
    })
    expect(String(done.result?.image_model_route_warning)).toContain('Bearer [redacted]')
    expect(JSON.stringify(done.result)).not.toContain('sk-openai-secret')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService honors explicit image model except Seedream-only ratios', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-route-explicit-ratio-'))
  const calls: Array<{ url: string; body: any }> = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/ark/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
        }
        if (url.endsWith('/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('openai-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const explicit = await service.startStudioGenerate({
      prompt: '中文海报但用户明确指定 GPT',
      image_model: 'gpt-image-2',
      ratio: '3:4',
      count: 1,
    })
    const explicitDone = await waitFor(async () => {
      const status = await service.status(explicit.job_id)
      return status?.status === 'done' ? status : null
    })
    const forced = await service.startStudioGenerate({
      prompt: '易拉宝竖版',
      image_model: 'gpt-image-2',
      ratio: '2:5',
      count: 1,
    })
    const forcedDone = await waitFor(async () => {
      const status = await service.status(forced.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(calls[0]?.url).toBe('http://image-gateway.example/gw/v1/images/generations')
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-image-2', size: '1024x1536' })
    expect(explicitDone.result).toMatchObject({ provider: 'openai-compatible', image_model_route: 'explicit_model' })
    expect(calls[1]?.url).toBe('http://image-gateway.example/gw/v1/ark/images/generations')
    expect(calls[1]?.body).toMatchObject({ model: 'doubao-seedream-4-5-251128', size: '1216x3040' })
    expect(forcedDone.result).toMatchObject({
      provider: 'seedream-gateway',
      image_model_route: 'seedream_only_ratio',
      requested_image_model: 'gpt-image-2',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService sends local reference images to configured Seedream gateway', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-direct-seedream-ref-'))
  const uploadDir = join(root, 'uploads', 'posters')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'ref.png'), 'reference-bytes')
  let requestBody: any
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
        IMAGE_MODEL_NAME: 'doubao-seedream-4-5-251128',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/ark/images/generations')) {
          requestBody = JSON.parse(String(init?.body))
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({ prompt: '照这个风格再做一张', reference_generation_ids: ['direct-ref'], count: 1 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(requestBody).toMatchObject({
      model: 'doubao-seedream-4-5-251128',
      prompt: '照这个风格再做一张',
      sequential_image_generation: 'disabled',
    })
    expect(String(requestBody.image).startsWith('data:image/png;base64,')).toBe(true)
    expect(requestBody.input_images).toHaveLength(1)
    expect(done.result).toMatchObject({ local_preview: false, provider: 'seedream-gateway', mode: 'generate' })
    expect(done.result?.generation_ids).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService edits a generated image through OpenAI-compatible image edits', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-direct-image-edit-'))
  const uploadDir = join(root, 'uploads', 'posters')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'source.png'), 'source-bytes')
  let form: any = null
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/images/edits')) {
          form = init?.body as FormData
          return Response.json({ data: [{ b64_json: Buffer.from('edited-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioEdit({ prompt: '把背景改成深绿色', source_generation_id: 'direct-source', count: 1 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(form).toBeTruthy()
    expect(form.get('model')).toBe('gpt-image-2')
    expect(form.get('prompt')).toBe('把背景改成深绿色')
    // gpt-image-2 恒最高保真、API 不接受 input_fidelity(传了 400),故不设。非 gpt-image-2 的 gpt-image 系列才设。
    expect(form.get('input_fidelity')).toBeNull()
    expect(form.getAll('image')).toHaveLength(1)
    expect(done.result).toMatchObject({ local_preview: false, provider: 'openai-compatible', mode: 'edit' })
    expect(done.result?.urls).toHaveLength(1)
    const served = service.serveUpload((done.result?.urls as string[])[0]!)
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toContain('image/png')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService routes text-fix image edits to Seedream gateway', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-route-edit-text-'))
  const uploadDir = join(root, 'uploads', 'posters')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'source.png'), 'source-bytes')
  let requestBody: any
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
      },
      fetchImpl: async (input, init) => {
        const url = String(input)
        if (url.endsWith('/ark/images/generations')) {
          requestBody = JSON.parse(String(init?.body))
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-edited').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioEdit({
      prompt: '标题里有个错别字，改文字',
      source_generation_id: 'direct-source',
      count: 1,
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(requestBody).toMatchObject({
      model: 'doubao-seedream-4-5-251128',
      prompt: '标题里有个错别字，改文字',
      sequential_image_generation: 'disabled',
    })
    expect(String(requestBody.image).startsWith('data:image/png;base64,')).toBe(true)
    expect(done.result).toMatchObject({
      provider: 'seedream-gateway',
      image_model_route: 'edit_text_fix_seedream',
      mode: 'edit',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
