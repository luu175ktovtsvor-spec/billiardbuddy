// 视觉桥接的假 upstream 端到端测试(经 createGatewayFetch,不打真上游)。验证:文字请求不碰 MiMo、
// 带图请求恰好桥接一次再转发给目标文本模型且去图后的 body 无 image_url、跨请求缓存命中、MiMo 失败
// 时严格失败关闭(不改投 DeepSeek/Qwen)、显式 mimo-v2.5 跳过桥接走原生多模态、usage 行不泄漏图片
// 内容、以及请求体过大在任何许可/MiMo 调用之前就被拒绝。

import { expect, test } from 'bun:test'
import { createGatewayFetch, MemoryUsageStore } from './app'

const PNG_DATA_URI = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    GW_QWEN_KEY: 'qwen-secret', GW_QWEN_BASE: 'https://qwen.example/v1', GW_QWEN_MODEL: 'qwen3-coder-plus',
    GW_MIMO_KEY: 'mimo-secret', GW_MIMO_BASE: 'https://mimo.example/v1', GW_MIMO_MODEL: 'mimo-v2.5',
    GW_DEEPSEEK_KEY: 'deepseek-secret', GW_DEEPSEEK_BASE: 'https://deepseek.example', GW_DEEPSEEK_MODEL: 'deepseek-v4-flash',
    GW_RELAY_BASE: 'https://relay.example/v1', GW_RELAY_TOKEN: 'relay-secret',
    GW_APP_TOKENS: JSON.stringify({ 'app-token': 'owner-a' }),
    GW_VISION_MAX_IMAGES: '4',
    GW_VISION_MAX_IMAGE_BYTES: '2000000',
    GW_VISION_MAX_TOTAL_BYTES: '5000000',
    GW_VISION_TIMEOUT_MS: '2000',
    GW_VISION_CONC: '4',
    GW_VISION_CACHE_MAX: '16',
    GW_VISION_CACHE_TTL_MS: '600000',
    ...overrides,
  }
}

function authed(init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: 'Bearer app-token',
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    },
  }
}

type MimoBehavior = 'ok' | 'fail500' | 'fail429' | 'timeout'

/** 假 upstream:按 URL 分流到 qwen/mimo/deepseek;MiMo 端点会区分"视觉调用形状"
 *  (stream:false + 数组 content)与其它调用,只对视觉调用应用 mimoBehavior。 */
function makeGateway(overrides: Record<string, string | undefined> = {}, mimoBehavior: MimoBehavior = 'ok') {
  const calls: Array<{ url: string; body: string }> = []
  const usage = new MemoryUsageStore()
  const fetch = createGatewayFetch({
    env: env(overrides),
    usageStore: usage,
    transcribeImpl: null,
    webSearchImpl: null,
    fetchImpl: async (input, init) => {
      const url = String(input)
      const body = typeof init?.body === 'string' ? init.body : ''
      calls.push({ url, body })

      if (url.includes('mimo.example') && url.endsWith('/chat/completions')) {
        let parsedBody: Record<string, unknown> | null = null
        try { parsedBody = JSON.parse(body) } catch { /* ignore */ }
        const messages = Array.isArray(parsedBody?.messages) ? parsedBody!.messages as Array<Record<string, unknown>> : []
        const looksLikeVisionCall = parsedBody?.stream === false && Array.isArray(messages[0]?.content)
        if (looksLikeVisionCall) {
          if (mimoBehavior === 'fail500') return new Response('mimo upstream boom', { status: 500 })
          if (mimoBehavior === 'fail429') return new Response('mimo busy', { status: 429, headers: { 'retry-after': '0' } })
          if (mimoBehavior === 'timeout') {
            return await new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                const err = new Error('aborted')
                err.name = 'AbortError'
                reject(err)
              })
            })
          }
          return Response.json({ choices: [{ message: { content: '图片理解结果：截图里有一只猫。' } }] })
        }
        // 显式 mimo-v2.5 原生多模态直连(未走桥接)时走这里,返回一个普通 SSE 响应。
        return new Response('data: mimo-native\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.includes('deepseek.example')) {
        return new Response('data: deepseek-ok\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url.includes('qwen.example')) {
        return new Response('data: qwen-ok\n\n', { headers: { 'content-type': 'text/event-stream' } })
      }
      return Response.json({ ok: true })
    },
  })
  return { fetch, calls, usage }
}

function textOnlyBody(model: string) {
  return JSON.stringify({ model, messages: [{ role: 'user', content: '普通文字请求' }] })
}

function withImageBody(model: string, url = PNG_DATA_URI) {
  return JSON.stringify({
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这是什么' },
        { type: 'image_url', image_url: { url } },
      ],
    }],
  })
}

async function healthzCapacity(fetch: (r: Request) => Promise<Response>) {
  const res = await fetch(new Request('http://local/healthz', authed({ method: 'GET' })))
  const body = await res.json()
  return body.capacity as Record<'qwen' | 'mimo' | 'deepseek', { active: number; queued: number }>
}

test('① plain-text DeepSeek request calls MiMo zero times', async () => {
  const { fetch, calls } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: textOnlyBody('deepseek-v4-flash') })))
  expect(res.status).toBe(200)
  await res.text()
  expect(calls.filter(c => c.url.includes('mimo.example')).length).toBe(0)
  expect(calls.filter(c => c.url.includes('deepseek.example')).length).toBe(1)
})

test('② DeepSeek + image bridges through MiMo exactly once, then DeepSeek exactly once, with vision text and no image_url in the DeepSeek body', async () => {
  const { fetch, calls } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: withImageBody('deepseek-v4-flash') })))
  expect(res.status).toBe(200)
  await res.text()
  const mimoCalls = calls.filter(c => c.url.includes('mimo.example'))
  const deepseekCalls = calls.filter(c => c.url.includes('deepseek.example'))
  expect(mimoCalls).toHaveLength(1)
  expect(deepseekCalls).toHaveLength(1)
  expect(deepseekCalls[0]!.body).not.toContain('image_url')
  expect(deepseekCalls[0]!.body).toContain('图片理解结果')
})

test('③ the same image across two requests hits the cache — MiMo is called only once total', async () => {
  const { fetch, calls } = makeGateway()
  const raw = withImageBody('deepseek-v4-flash')
  await (await fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: raw })))).text()
  await (await fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: raw })))).text()
  expect(calls.filter(c => c.url.includes('mimo.example')).length).toBe(1)
  expect(calls.filter(c => c.url.includes('deepseek.example')).length).toBe(2)
})

test('④ MiMo failure (500 / 429 / timeout) fails closed: no DeepSeek call, no Qwen call, correct status, no permit leak', async () => {
  const fail500 = makeGateway({}, 'fail500')
  const res500 = await fail500.fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: withImageBody('deepseek-v4-flash') })))
  expect(res500.status).toBeGreaterThanOrEqual(500)
  expect(fail500.calls.filter(c => c.url.includes('deepseek.example')).length).toBe(0)
  expect(fail500.calls.filter(c => c.url.includes('qwen.example')).length).toBe(0)
  expect((await healthzCapacity(fail500.fetch)).deepseek).toMatchObject({ active: 0, queued: 0 })

  const fail429 = makeGateway({}, 'fail429')
  const res429 = await fail429.fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: withImageBody('deepseek-v4-flash') })))
  expect(res429.status).toBe(429)
  // 429 不重试:MiMo 只应被打一次。
  expect(fail429.calls.filter(c => c.url.includes('mimo.example')).length).toBe(1)
  expect(fail429.calls.filter(c => c.url.includes('deepseek.example')).length).toBe(0)
  expect((await healthzCapacity(fail429.fetch)).deepseek).toMatchObject({ active: 0, queued: 0 })

  const timeout = makeGateway({ GW_VISION_TIMEOUT_MS: '50' }, 'timeout')
  const resTimeout = await timeout.fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: withImageBody('deepseek-v4-flash') })))
  expect(resTimeout.status).toBe(504)
  expect(timeout.calls.filter(c => c.url.includes('deepseek.example')).length).toBe(0)
  expect((await healthzCapacity(timeout.fetch)).deepseek).toMatchObject({ active: 0, queued: 0 })
})

test('⑤ explicit mimo-v2.5 with an image skips the bridge entirely — direct native multimodal call', async () => {
  const { fetch, calls } = makeGateway()
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: withImageBody('mimo-v2.5') })))
  expect(res.status).toBe(200)
  await res.text()
  const mimoCalls = calls.filter(c => c.url.includes('mimo.example'))
  expect(mimoCalls).toHaveLength(1)
  // 直连 MiMo,请求体原样带 image_url(未经桥接改写)。
  expect(mimoCalls[0]!.body).toContain('image_url')
  expect(mimoCalls[0]!.body).toContain('"model":"mimo-v2.5"')
})

test('⑥ usage rows never contain base64 or vision text, and capacity fully drains after a bridged request', async () => {
  const { fetch, usage } = makeGateway()
  await (await fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: withImageBody('deepseek-v4-flash') })))).text()
  const dump = JSON.stringify(usage.rows)
  expect(dump).not.toContain('base64')
  expect(dump).not.toContain('图片理解结果')
  expect(dump).not.toContain(PNG_DATA_URI)
  expect(usage.rows.some(r => r.model === 'vision' && r.ok === true)).toBe(true)
  expect((await healthzCapacity(fetch)).deepseek).toMatchObject({ active: 0, queued: 0 })
})

test('⑦ an oversized request body is rejected with 413 before any capacity permit or MiMo call', async () => {
  const { fetch, calls } = makeGateway({ GW_VISION_MAX_TOTAL_BYTES: '100' })
  const raw = JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'x'.repeat(1000) }] })
  const res = await fetch(new Request('http://local/v1/chat/completions', authed({ method: 'POST', body: raw })))
  expect(res.status).toBe(413)
  expect(calls.length).toBe(0)
})
