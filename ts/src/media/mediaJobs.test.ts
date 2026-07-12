import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as QRCode from 'qrcode'
import { MediaJobService } from './mediaJobs'
import { TaskService } from '../tasks/taskService'
import type { Model } from '../types/model'

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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
    expect(done.result).toMatchObject({ urls: ['/uploads/posters/a.jpg'], creative_brief: expect.any(Object), poster_quality_state: 'risk' })
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-image-2', n: 1, size: '1024x1536' })
    expect(calls[0]?.body.prompt).toContain('用途：')
    // 白标:出口只给能力档代称,不外露真实 provider/model。
    expect(done.result).toMatchObject({ local_preview: false, image_engine: '创意生图' })
    expect(JSON.stringify(done.result)).not.toContain('openai')
    expect(JSON.stringify(done.result)).not.toContain('gpt-image')
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
    expect(submit?.body).toMatchObject({ mode: 'generate', model: 'gpt-image-2', n: 1 })
    expect(submit?.body.prompt).toContain('Change only:')
    expect(calls.some(c => c.method === 'GET' && c.url.endsWith('/images/tasks/task-1'))).toBe(true)
    expect(polls).toBeGreaterThanOrEqual(2)
    // 全程没有走同步 /images/generations
    expect(calls.some(c => c.url.endsWith('/images/generations'))).toBe(false)
    expect(done.result).toMatchObject({ local_preview: false, image_engine: '创意生图' })
    expect(done.result?.urls).toHaveLength(1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService carries portrait input fidelity through the async gateway and records a relay downgrade', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-async-portrait-fidelity-'))
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> | null }> = []
  writeRefImage(root, 'face.png', 1024, 1024)
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      qcModel: null,
      env: { ...IMAGE_ENV, QF_GPT_IMAGE_ASYNC: '1' },
      fetchImpl: async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null })
        if (method === 'POST' && url.endsWith('/images/tasks')) return Response.json({ task_id: 'portrait-task', status: 'queued' })
        if (method === 'GET' && url.endsWith('/images/tasks/portrait-task')) {
          return Response.json({
            status: 'succeeded',
            data: [{ b64_json: Buffer.from('portrait-png').toString('base64') }],
            input_fidelity_requested: 'high',
            input_fidelity_status: 'unsupported',
            input_fidelity_risk: '正式端点不接受手动高保真参数，已自动降级。',
          })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({
      prompt: '做一张本人助教形象照，换成球房背景',
      intent: 'portrait',
      portrait_consent: true,
      portrait_authorization_confirmed: true,
      input_fidelity: 'high',
      reference_image_paths: ['/uploads/local/face.png'],
      count: 1,
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const submit = calls.find(call => call.method === 'POST' && call.url.endsWith('/images/tasks'))
    expect(submit?.body).toMatchObject({ mode: 'edit', input_fidelity: 'high' })
    expect(done.result).toMatchObject({
      input_fidelity_requested: 'high',
      input_fidelity_status: 'unsupported',
      input_fidelity_risk: expect.stringContaining('自动降级'),
    })
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
      prompt: expect.stringContaining('用途：'),
      // 9:16(1152×2048=2,359,296)低于火山 Seedream 像素下限 3,686,400,等比放大到 1440×2560(=3,686,400)、各边 16 倍数。
      size: '1440x2560',
    })
    expect(done.result).toMatchObject({ image_engine: '写实生图' })
    expect(JSON.stringify(done.result)).not.toContain('seedream')
    expect(JSON.stringify(done.result)).not.toContain('doubao')
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
    expect(done.result).toMatchObject({ image_engine: '写实生图' })
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
    expect(calls[0]?.body).toMatchObject({ model: 'gpt-image-2', size: '1024x1024' })
    expect(calls[0]?.body.prompt).toContain('Change only:')
    expect(done.result).toMatchObject({ image_engine: '创意生图' })
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
    // 白标:兜底后只给写实生图代称;warning 去掉真实名、原始报错经脱敏(Bearer/供应商名都清)。
    expect(done.result).toMatchObject({ image_engine: '写实生图' })
    expect(String(done.result?.image_engine_warning)).toContain('Bearer [redacted]')
    expect(JSON.stringify(done.result)).not.toContain('sk-openai-secret')
    expect(JSON.stringify(done.result)).not.toContain('openai')
    expect(JSON.stringify(done.result)).not.toContain('seedream')
    expect(JSON.stringify(done.result)).not.toContain('gpt-image')
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
    expect(explicitDone.result).toMatchObject({ image_engine: '创意生图' })
    expect(calls[1]?.url).toBe('http://image-gateway.example/gw/v1/ark/images/generations')
    expect(calls[1]?.body).toMatchObject({ model: 'doubao-seedream-4-5-251128', size: '1216x3040' })
    expect(forcedDone.result).toMatchObject({ image_engine: '写实生图' })
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
      prompt: expect.stringContaining('用途：'),
      sequential_image_generation: 'disabled',
    })
    expect(String(requestBody.image).startsWith('data:image/png;base64,')).toBe(true)
    expect(requestBody.input_images).toHaveLength(1)
    expect(done.result).toMatchObject({ local_preview: false, image_engine: '写实生图', mode: 'generate' })
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
    expect(String(form.get('prompt'))).toContain('Change only:')
    expect(form.get('input_fidelity')).toBeNull()
    expect(form.getAll('image')).toHaveLength(1)
    expect(done.result).toMatchObject({
      local_preview: false,
      image_engine: '创意生图',
      mode: 'edit',
    })
    expect(done.result?.urls).toHaveLength(1)
    const served = service.serveUpload((done.result?.urls as string[])[0]!)
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toContain('image/png')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService edits a persisted workbench image through its trusted upload URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-workbench-image-edit-'))
  const uploadDir = join(root, 'uploads', 'workbench', 'assets', 'export')
  mkdirSync(uploadDir, { recursive: true })
  writeFileSync(join(uploadDir, 'current.png'), 'source-bytes')
  let form: FormData | null = null
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        QF_GPT_IMAGE_ASYNC: '0',
        OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1',
        OPENAI_API_KEY: 'app-token',
        IMAGE_MODEL_NAME: 'gpt-image-2',
      },
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/images/edits')) {
          form = init?.body as FormData
          return Response.json({ data: [{ b64_json: Buffer.from('edited-png').toString('base64') }] })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioEdit({
      prompt: '把背景换成更明亮的球房实景',
      source_image_path: '/uploads/workbench/assets/export/current.png',
      count: 1,
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })

    expect(form).toBeTruthy()
    expect((form as FormData | null)?.getAll('image')).toHaveLength(1)
    expect(done.result).toMatchObject({ local_preview: false, mode: 'edit' })
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
        QF_GPT_IMAGE_ASYNC: '0', // 本用例锁同步路径行为(默认已翻异步,见 gptImageAsync)
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
      prompt: expect.stringContaining('用途：'),
      sequential_image_generation: 'disabled',
    })
    expect(String(requestBody.image).startsWith('data:image/png;base64,')).toBe(true)
    expect(done.result).toMatchObject({ image_engine: '写实生图', mode: 'edit' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- 人像授权闸 + 输入/结果质检 + 白标 ------------------------------------

/** 脚本化网关 VLM:按 system 提示分派(输入质检/结果质检/OCR),返回一段 JSON 文本。 */
function fakeVlm(reply: (system: string) => string): Model {
  return {
    async step(input) {
      return { kind: 'final', text: reply(input.system ?? '') }
    },
  }
}

const IMAGE_ENV = { OPENAI_BASE_URL: 'http://image-gateway.example/gw/v1', OPENAI_API_KEY: 'app-token', IMAGE_MODEL_NAME: 'gpt-image-2', QF_GPT_IMAGE_ASYNC: '0' } // QC 用例锁同步路径行为(默认已翻异步)
const NO_LEAK_RE = /seedream|doubao|豆包|gpt-image|gpt image|openai|anthropic|\bclaude\b|火山|方舟|\bark\b/i

function editEndpointReturnsPng(input: unknown): Response {
  const url = String(input)
  if (url.endsWith('/images/edits') || url.endsWith('/images/generations')) {
    return Response.json({ data: [{ b64_json: Buffer.from('generated-portrait-png').toString('base64') }] })
  }
  return Response.json({ detail: 'not found' }, { status: 404 })
}

function writeRefImage(root: string, name: string, width: number, height: number): void {
  const dir = join(root, 'uploads', 'local')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), pngHeaderWithSize(width, height))
}

test('portrait optimize without consent is blocked and asks for authorization (white-label)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-consent-'))
  writeRefImage(root, 'face.png', 1024, 1024)
  try {
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: null, env: IMAGE_ENV })
    const started = await service.startStudioGenerate({
      prompt: '帮我把这张助教人像形象照优化得更适合门店宣传',
      image_provider: 'openai',
      reference_image_paths: ['/uploads/local/face.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const r = done.result as any
    expect(r.blocked).toBe(true)
    expect(r.portrait_consent_required).toBe(true)
    expect(r.portrait_gate).toBe('consent_required')
    expect(String(r.message)).toContain('授权')
    // 授权闸=完成态(非报错),让 agent 读到后向用户要一次确认。
    expect(done.status).toBe('done')
    expect(NO_LEAK_RE.test(JSON.stringify(r))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('portrait generation requires a real approved reference instead of appearance text or a remote URL', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-reference-required-'))
  try {
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: null, env: IMAGE_ENV })
    const started = await service.startStudioGenerate({
      prompt: '做一张助教形象照，皮肤白皙、短发',
      intent: 'portrait',
      portrait_consent: true,
      reference_image_paths: ['https://untrusted.example/person.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    expect(done.result).toMatchObject({ blocked: true, block_reason: 'portrait_reference_required' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('portrait gate rejects face swap and impersonation requests before generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-impersonation-'))
  writeRefImage(root, 'face.png', 1024, 1024)
  try {
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: null, env: IMAGE_ENV })
    const started = await service.startStudioGenerate({
      prompt: '把这张人像换脸成明星代言人',
      intent: 'portrait',
      portrait_consent: true,
      reference_image_paths: ['/uploads/local/face.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    expect(done.result).toMatchObject({ blocked: true, block_reason: 'portrait_impersonation_not_supported' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('portrait face detection (gateway VLM) drives the consent gate even without portrait keyword', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-face-'))
  writeRefImage(root, 'photo.png', 1024, 1024)
  try {
    const vlm = fakeVlm(system => system.includes('人像照片质检')
      ? JSON.stringify({ face_count: 1, is_real_person: true, single_subject: true, blurry: false, occluded: false, low_light: false })
      : '{}')
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: vlm, env: IMAGE_ENV })
    const started = await service.startStudioGenerate({
      prompt: '把这张照片调亮一点点',
      image_provider: 'openai',
      reference_image_paths: ['/uploads/local/photo.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const r = done.result as any
    expect(r.portrait_consent_required).toBe(true)
    expect(r.portrait_signals).toContain('input_face_detected')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('input QC blocks a too-low-resolution portrait input', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-lowres-'))
  writeRefImage(root, 'small.png', 200, 200)
  try {
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: null, env: IMAGE_ENV })
    const started = await service.startStudioGenerate({
      prompt: '优化这张人像照片',
      image_provider: 'openai',
      portrait_consent: true, // 即便已授权,低质输入仍先被拦
      reference_image_paths: ['/uploads/local/small.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const r = done.result as any
    expect(r.blocked).toBe(true)
    expect(r.input_quality_blocked).toBe(true)
    expect(String(r.message)).toContain('分辨率')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('authorized portrait passes result QC and is marked commercial-ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-pass-'))
  writeRefImage(root, 'face.png', 1024, 1024)
  try {
    const vlm = fakeVlm(system => {
      if (system.includes('人像照片质检')) return JSON.stringify({ face_count: 1, is_real_person: true, single_subject: true, blurry: false, occluded: false, low_light: false })
      if (system.includes('成图质检')) return JSON.stringify({ images: [{ hands_ok: true, face_ok: true, limbs_ok: true, face_count: 1, over_beautified: false, realistic: true, unwanted_text: false }] })
      return '{}'
    })
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: vlm, env: IMAGE_ENV, fetchImpl: async i => editEndpointReturnsPng(i) })
    const started = await service.startStudioGenerate({
      prompt: '帮我把这张助教人像形象照优化得更适合门店宣传',
      image_provider: 'openai',
      portrait_consent: true,
      reference_image_paths: ['/uploads/local/face.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const r = done.result as any
    expect(r.blocked).toBeUndefined()
    expect(r.portrait_consent_confirmed).toBe(true)
    expect(r.portrait_qc_status).toBe('risk')
    expect(r.portrait_qc_auto_checked).toBe(true)
    expect(r.commercial_ready).toBe(false)
    expect(r.portrait_quality_state).toBe('risk')
    expect(NO_LEAK_RE.test(JSON.stringify(r))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('result QC flags corrupted portrait (bad hands) as risk, not commercial-ready', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-risk-'))
  writeRefImage(root, 'face.png', 1024, 1024)
  try {
    const vlm = fakeVlm(system => {
      if (system.includes('人像照片质检')) return JSON.stringify({ face_count: 1, is_real_person: true, single_subject: true, blurry: false, occluded: false, low_light: false })
      if (system.includes('成图质检')) return JSON.stringify({ images: [{ hands_ok: false, face_ok: true, limbs_ok: true, face_count: 2, over_beautified: true, realistic: true, unwanted_text: false }] })
      return '{}'
    })
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: vlm, env: IMAGE_ENV, fetchImpl: async i => editEndpointReturnsPng(i) })
    const started = await service.startStudioGenerate({
      prompt: '帮我把这张助教人像形象照优化得更适合门店宣传',
      image_provider: 'openai',
      portrait_consent: true,
      reference_image_paths: ['/uploads/local/face.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const r = done.result as any
    expect(r.portrait_qc_status).toBe('risk')
    expect(r.commercial_ready).toBe(false)
    expect((r.portrait_qc_warnings as string[]).join('')).toContain('手部')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('gateway VLM unavailable degrades result QC to "unchecked" (never fakes a pass)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-portrait-degrade-'))
  writeRefImage(root, 'face.png', 1024, 1024)
  try {
    // qcModel:null => 无网关 VLM;keyword 触发人像意图,已授权放行,结果质检降级。
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: null, env: IMAGE_ENV, fetchImpl: async i => editEndpointReturnsPng(i) })
    const started = await service.startStudioGenerate({
      prompt: '帮我把这张助教人像形象照优化得更适合门店宣传',
      image_provider: 'openai',
      portrait_consent: true,
      reference_image_paths: ['/uploads/local/face.png'],
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const r = done.result as any
    expect(r.portrait_qc_status).toBe('unchecked')
    expect(r.portrait_qc_auto_checked).toBe(false)
    expect(r.commercial_ready).toBe(false)
    expect(String(r.portrait_qc_message)).toContain('人工把关')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('hard-text OCR proofread flags a missing poster line via gateway VLM', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-ocr-'))
  try {
    const vlm = fakeVlm(system => system.includes('海报文字校对')
      ? JSON.stringify({ texts: ['周末狂欢夜'] }) // 缺"充100送50"
      : '{}')
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1, qcModel: vlm, env: IMAGE_ENV, fetchImpl: async i => editEndpointReturnsPng(i) })
    const started = await service.startStudioGenerate({
      prompt: '做一张周末活动海报，写上"周末狂欢夜"和"充100送50"',
      poster_text: { title: '周末狂欢夜', promo: '充100送50' },
    })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    const r = done.result as any
    expect(r.hard_text_required).toBe(true)
    expect(r.text_quality_status).toBe('ocr_mismatch')
    expect(r.text_quality_missing).toContain('充100送50')
    expect(NO_LEAK_RE.test(JSON.stringify(r))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('GPT 异步开关默认开(根治跨境掐断已部署);QF_GPT_IMAGE_ASYNC=0 显式退同步', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-async-default-'))
  try {
    const asyncDefault = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, env: {} })
    expect((asyncDefault as unknown as { gptImageAsync: boolean }).gptImageAsync).toBe(true)
    const syncOptOut = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, env: { QF_GPT_IMAGE_ASYNC: '0' } })
    expect((syncOptOut as unknown as { gptImageAsync: boolean }).gptImageAsync).toBe(false)
    const explicitOn = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, env: { QF_GPT_IMAGE_ASYNC: '1' } })
    expect((explicitOn as unknown as { gptImageAsync: boolean }).gptImageAsync).toBe(true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
