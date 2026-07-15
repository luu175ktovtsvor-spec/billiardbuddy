// 资产管理器的 server 接口边界:GET /api/v1/assets/status 全量状态 +
// /agent/ws 上的 asset_progress 广播(前端"正在准备组件 x%"的两条数据通道)。

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './index'
import { AssetManager } from '../assets/assetManager'

const MANIFEST_URL = 'https://assets.example/assets/manifest.json'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function makeServerWithAssets() {
  const root = mkdtempSync(join(tmpdir(), 'assets-route-'))
  const content = 'FFMPEG-BINARY'
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input)
    if (url === MANIFEST_URL) {
      return Response.json({
        version: 'v1',
        assets: [{ id: 'ffmpeg', platform: 'all', tier: 1, size: content.length, sha256: sha256(content), url: 'https://assets.example/f/ffmpeg', dest: 'ffmpeg' }],
      })
    }
    if (url === 'https://assets.example/f/ffmpeg') return new Response(content, { status: 200 })
    return new Response('not found', { status: 404 })
  }
  const manager = new AssetManager({
    stateRoot: root,
    env: { QF_ASSET_MANIFEST_URL: MANIFEST_URL },
    fetchImpl,
    platform: 'darwin-arm64',
    retryBaseMs: 1,
  })
  const server = startServer({ port: 0, transcriptRoot: root, assetManager: manager, assetAutoStart: false })
  cleanups.push(() => {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  })
  return { server, manager }
}

test('GET /api/v1/assets/status:返回清单版本/平台/逐资产状态(未启动时资产为空)', async () => {
  const { server, manager } = makeServerWithAssets()
  const before = await fetch(`http://127.0.0.1:${server.port}/api/v1/assets/status`)
  expect(before.status).toBe(200)
  const empty = await before.json() as any
  expect(empty.manifest_version).toBeNull()
  expect(empty.started).toBe(false)
  expect(empty.assets).toEqual([])

  manager.start()
  await manager.whenIdle()
  const after = await fetch(`http://127.0.0.1:${server.port}/api/v1/assets/status`)
  const body = await after.json() as any
  expect(body.manifest_version).toBe('v1')
  expect(body.platform).toBe('darwin-arm64')
  const ffmpeg = body.assets.find((asset: any) => asset.id === 'ffmpeg')
  expect(ffmpeg.status).toBe('ready')
  expect(ffmpeg.progress).toBe(100)
  expect(typeof ffmpeg.path).toBe('string')
})

test('WS /agent/ws:资产下载进度以 asset_progress 事件广播(downloading→verifying→ready)', async () => {
  const { server, manager } = makeServerWithAssets()
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/agent/ws?conversationId=assets-ws`)
  const messages: any[] = []
  ws.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
  await new Promise<void>((resolvePromise, reject) => {
    ws.addEventListener('open', () => resolvePromise(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws open failed')), { once: true })
  })

  manager.start()
  await manager.whenIdle()
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (messages.some(msg => msg.type === 'asset_progress' && msg.status === 'ready')) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  ws.close()

  const progressEvents = messages.filter(msg => msg.type === 'asset_progress' && msg.id === 'ffmpeg')
  const statuses = progressEvents.map(event => event.status)
  expect(statuses).toContain('verifying')
  expect(statuses[statuses.length - 1]).toBe('ready')
  const readyEvent = progressEvents[progressEvents.length - 1]
  expect(readyEvent.progress).toBe(100)
  expect(readyEvent.tier).toBe(1)
  expect(typeof readyEvent.path).toBe('string')
  expect(typeof readyEvent.ts).toBe('number')
})
