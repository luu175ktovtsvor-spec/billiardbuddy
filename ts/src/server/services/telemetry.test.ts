import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createTelemetryService, sanitizeDiagnosticText } from './telemetry'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'telemetry-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('sanitizeDiagnosticText:home 归一 + 密钥形态遮蔽 + 截断', () => {
  const s = sanitizeDiagnosticText('key sk-ABCD1234EFGH5678 and Bearer abcdef12345678 and hex ' + 'a'.repeat(40))
  expect(s).toContain('[redacted]')
  expect(s).not.toContain('sk-ABCD1234EFGH5678')
  expect(s).toContain('Bearer [redacted]')
  expect(sanitizeDiagnosticText('x'.repeat(9000)).length).toBeLessThanOrEqual(4000)
})

test('缺 env 配置 = 禁用:不发任何请求(enabled=false)', async () => {
  let called = 0
  const svc = createTelemetryService({ stateRoot: root, env: {}, fetchImpl: async () => { called++; return new Response('{}') } })
  expect(svc.enabled).toBe(false)
  expect(await svc.uploadOnBoot('1.0.0')).toEqual({ sent: 0 })
  expect(called).toBe(0)
})

test('开机上传:走真 receiver /ingest,鉴权+gzip+机器id+心跳+崩溃日志脱敏+幂等键', async () => {
  // 起一个仿 dataeye receiver 的真服务:验 Bearer、解 gzip、按 (machine_id,kind,ref_id) 幂等
  const seen = new Set<string>()
  const received: Array<{ kind: string; ref_id: string; payload: Record<string, unknown> }> = []
  let machineIdSeen = ''
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/ingest' || req.method !== 'POST') return new Response('nf', { status: 404 })
      if (req.headers.get('authorization') !== 'Bearer tok-123') return new Response('unauth', { status: 401 })
      const raw = Buffer.from(await req.arrayBuffer())
      const body = JSON.parse((req.headers.get('content-encoding') === 'gzip' ? gunzipSync(raw) : raw).toString('utf8'))
      machineIdSeen = body.machine_id
      let accepted = 0, duplicated = 0
      for (const item of body.batch) {
        const key = `${body.machine_id}|${item.kind}|${item.ref_id}`
        if (seen.has(key)) { duplicated++; continue }
        seen.add(key); received.push(item); accepted++
      }
      return Response.json({ accepted, duplicated })
    },
  })
  try {
    // 放一份含密钥的崩溃日志
    mkdirSync(join(root, 'logs'), { recursive: true })
    writeFileSync(join(root, 'logs', 'crash-2026-07-11T00-00-00-000000-uncaught.log'), 'boom sk-SECRET12345678 stack...', 'utf8')
    const env = { QF_DATAEYE_URL: `http://127.0.0.1:${server.port}`, QF_DATAEYE_TOKEN: 'tok-123' }
    const svc = createTelemetryService({ stateRoot: root, env })
    expect(svc.enabled).toBe(true)
    const r1 = await svc.uploadOnBoot('1.2.3')
    expect(r1.sent).toBe(2) // 心跳 + 1 崩溃
    // 心跳
    const boot = received.find(i => i.kind === 'event')!
    expect(boot.payload.event).toBe('app_boot')
    expect((boot.payload.props as Record<string, unknown>).app_version).toBe('1.2.3')
    // 崩溃日志脱敏后上传(密钥被遮),ref_id = 文件名
    const diag = received.find(i => i.kind === 'diag')!
    expect(diag.ref_id).toContain('crash-')
    expect(String(diag.payload.content)).not.toContain('sk-SECRET12345678')
    expect(String(diag.payload.content)).toContain('[redacted]')
    // 机器 id 稳定落盘,重开机同 id
    expect(machineIdSeen).toMatch(/^[A-Za-z0-9-]{8,64}$/)
    // 第二次开机:崩溃文件 ref_id 不变 → 服务端幂等去重(不重复入库)
    const before = received.length
    await svc.uploadOnBoot('1.2.3')
    const newDiag = received.slice(before).filter(i => i.kind === 'diag')
    expect(newDiag.length).toBe(0) // 崩溃日志已幂等,不再重复
  } finally {
    server.stop(true)
  }
})

test('上传失败静默吞(sent=0),不抛错', async () => {
  const svc = createTelemetryService({
    stateRoot: root,
    env: { QF_DATAEYE_URL: 'http://127.0.0.1:1', QF_DATAEYE_TOKEN: 't' },
    fetchImpl: async () => { throw new Error('network down') },
  })
  expect(await svc.uploadOnBoot('1.0.0')).toEqual({ sent: 0 })
})
