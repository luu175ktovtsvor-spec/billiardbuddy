import { afterAll, beforeAll, expect, test } from 'bun:test'
import { startServer } from './index'

let server: ReturnType<typeof startServer>
beforeAll(() => { server = startServer({ port: 0 }) }) // port:0 = OS 随机端口
afterAll(() => { server.stop(true) })

test('GET /health returns 200 ok', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/health`)
  expect(res.status).toBe(200)
  const body = (await res.json()) as { ok: boolean; service: string }
  expect(body.ok).toBe(true)
  expect(body.service).toBe('ts-harness')
})

test('GET /agent/hello streams the real agent loop as SSE', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/agent/hello`)
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  const text = await res.text()
  // 真循环 demo:think → list_dir → 结果回灌 → final;真模型出口 = W6
  expect(text).toContain('event: tool_call')
  expect(text).toContain('list_dir')
  expect(text).toContain('event: tool_result')
  expect(text).toContain('event: final')
  expect(text).toContain('event: done')
})

test('unknown route returns 404', async () => {
  const res = await fetch(`http://127.0.0.1:${server.port}/nope`)
  expect(res.status).toBe(404)
})
