import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { startServer } from './index'
import { TaskService } from '../tasks/taskService'
import { MediaJobService } from '../media/mediaJobs'

/**
 * 白标守卫(本任务验收核心)。
 * 铁律:凡用户可见/模型可读到的输出,一律不得出现任何真实大模型名、供应商、baseUrl。
 * 下面对模型出口失败提示、/model 状态、聊天应答 notices、生图结果分别做否定断言。
 */

// 真实名/供应商/endpoint 黑名单 + 本测试注入的具体真名。
const FORBIDDEN = [
  'seedream',
  'doubao',
  '豆包',
  'gpt-image',
  'claude',
  'anthropic',
  'openai',
  'deepseek',
  '火山',
  '方舟',
  'volc',
  'volces',
  'ark',
  'mimo',
  // 本测试注入的真实模型名 / endpoint host。
  'doubao-seedream-4-5-251128',
  'gpt-image-2',
  'ark.cn-beijing.volces.com',
  'api.anthropic.com',
]

function assertNoLeak(payload: string, label: string): void {
  const lower = payload.toLowerCase()
  for (const token of FORBIDDEN) {
    if (lower.includes(token.toLowerCase())) {
      throw new Error(`白标泄露 [${label}]:输出里出现了「${token}」 → ${payload.slice(0, 400)}`)
    }
  }
}

// 模拟上游返回一段"原始报错",里面明晃晃带着真实模型名 + 供应商 endpoint。
const LEAKY_UPSTREAM_ERROR = JSON.stringify({
  error: {
    message: 'model doubao-seedream-4-5-251128 is overloaded on ark.cn-beijing.volces.com',
    type: 'anthropic_upstream',
  },
})

test('白标守卫:模型出口失败切换 → SSE/context_note/notices 不泄露真实名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-guard-failover-'))
  const server = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot: join(root, 'providers'),
    env: {},
    fetchImpl: async (url) => {
      // 首选出口(primary)返回带真实模型名/endpoint 的 502 原始报错。
      if (String(url).startsWith('https://primary.example')) {
        return new Response(LEAKY_UPSTREAM_ERROR, { status: 502 })
      }
      // 备用出口(backup)成功。
      const enc = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              enc.encode(
                `data: ${JSON.stringify({ id: 'x', model: 'backup', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`,
              ),
            )
            c.enqueue(enc.encode('data: [DONE]\n\n'))
            c.close()
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  try {
    // 两个 saved provider:primary(真实名 model+baseUrl)失败,backup 成功。
    await fetch(`http://127.0.0.1:${server.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'primary',
        name: 'Primary Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://primary.example/v1',
        apiKey: 'primary-secret',
        model: 'doubao-seedream-4-5-251128',
      }),
    })
    await fetch(`http://127.0.0.1:${server.port}/providers`, {
      method: 'POST',
      body: JSON.stringify({
        id: 'backup',
        name: 'Backup Provider',
        apiFormat: 'openai_chat',
        baseUrl: 'https://backup.example/v1',
        apiKey: 'backup-secret',
        model: 'gpt-image-2',
      }),
    })

    // 1) 跑一轮:primary 失败 → 切 backup,失败旁白/context_note 走 SSE。
    const run = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'wl-guard-run', permissionMode: 'full' }),
    })
    expect(run.status).toBe(200)
    const runText = await run.text()
    expect(runText).toContain('已切换到备用模型出口') // 确实发生了切换(旁白仍在)
    assertNoLeak(runText, 'SSE run(失败切换旁白)')

    // 2) /model 状态:health.lastError / summary / providers / healthHistory 全脱敏。
    const modelStatus = await (await fetch(`http://127.0.0.1:${server.port}/model`)).json()
    assertNoLeak(JSON.stringify(modelStatus), '/model 状态')

    // 3) 聊天/预热应答体:provider.summary + notices 脱敏。
    const prewarm = await fetch(`http://127.0.0.1:${server.port}/agent/prewarm`, {
      method: 'POST',
      body: JSON.stringify({ conversationId: 'wl-guard-prewarm', workspaceRoot: root }),
    })
    assertNoLeak(JSON.stringify(await prewarm.json()), '/agent/prewarm 应答')

    // 4) providers 列表:去 baseUrl + 真实 model。
    const providers = await (await fetch(`http://127.0.0.1:${server.port}/providers`)).json()
    assertNoLeak(JSON.stringify(providers), 'GET /providers 列表')
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('白标守卫:所有出口都失败(总失败详情)不泄露真实名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-guard-total-fail-'))
  const server = startServer({
    port: 0,
    transcriptRoot: join(root, 'sessions'),
    providerRoot: join(root, 'providers'),
    env: {
      // 唯一 env 出口,且失败 → 触发"任务执行失败:<总失败详情>"。
      OPENAI_BASE_URL: 'https://api.anthropic.com/v1',
      OPENAI_API_KEY: 'env-secret',
      TEXT_MODEL_NAME: 'doubao-seedream-4-5-251128',
    },
    fetchImpl: async () => new Response(LEAKY_UPSTREAM_ERROR, { status: 502 }),
  })
  try {
    const run = await fetch(`http://127.0.0.1:${server.port}/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ message: 'ping', conversationId: 'wl-guard-total', permissionMode: 'full' }),
    })
    expect(run.status).toBe(200)
    const runText = await run.text()
    expect(runText).toContain('任务执行失败') // 确实进了总失败分支
    assertNoLeak(runText, 'SSE run(总失败详情)')
  } finally {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
})

test('白标守卫:生图结果/兜底文案不泄露真实名', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wl-guard-image-'))
  try {
    // 场景 A:OpenAI 通道失败 → 自动兜底 Seedream,warning 走脱敏。
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
      fetchImpl: async (input) => {
        const url = String(input)
        if (url.endsWith('/ark/images/generations')) {
          return Response.json({ data: [{ b64_json: Buffer.from('seedream-png').toString('base64') }] })
        }
        if (url.endsWith('/images/generations')) {
          return Response.json(
            { error: { message: 'model gpt-image-2 rejected by openai upstream' } },
            { status: 502 },
          )
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({
      prompt: 'A photorealistic billiards club poster, cinematic lighting',
      ratio: '16:9',
      count: 1,
    })
    let done: any = null
    for (let i = 0; i < 200; i++) {
      const status = await service.status(started.job_id)
      if (status?.status === 'done') {
        done = status
        break
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(done).not.toBeNull()
    expect(done.result.image_engine).toBe('写实生图')
    assertNoLeak(JSON.stringify(done.result), '生图兜底结果')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
