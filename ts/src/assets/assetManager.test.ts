// 资产管理器边界测试:mock fetch 全离线——清单拉取/缓存回退/静默重试、Tier 调度、
// Range 断点续传(206)、SHA-256 校验失败重下、平台过滤、功能门语义、zip 解包、重启快速校验。

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssetManager, DEFAULT_ASSET_MANIFEST_URL, parseAssetManifest, setActiveAssetManager, managedAssetPath, ensureManagedAsset } from './assetManager'
import type { AssetManifest, AssetProgressEvent } from './types'

const MANIFEST_URL = 'https://assets.example/assets/manifest.json'

const roots: string[] = []
const managers: AssetManager[] = []

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.stop()
  setActiveAssetManager(null)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => undefined)
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'qf-assets-'))
  roots.push(root)
  return root
}

function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

interface MockFile {
  bytes: Uint8Array
  /** 前 N 次请求返回坏内容(校验失败重下用)。 */
  corruptFirst?: number
  served: number
}

interface MockNet {
  manifest: () => AssetManifest | null
  files: Record<string, MockFile>
  calls: string[]
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

function mockNet(manifest: () => AssetManifest | null, files: Record<string, MockFile>): MockNet {
  const calls: string[] = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    if (url === MANIFEST_URL) {
      calls.push('manifest')
      const doc = manifest()
      if (!doc) throw new Error('网络不可达')
      return Response.json(doc)
    }
    const file = files[url]
    if (!file) return new Response('not found', { status: 404 })
    file.served += 1
    calls.push(`fetch:${url}`)
    let bytes = file.bytes
    if (file.corruptFirst && file.served <= file.corruptFirst) {
      bytes = bytesOf('x'.repeat(file.bytes.length))
    }
    const range = new Headers(init?.headers).get('range')
    if (range) {
      const match = /^bytes=(\d+)-$/.exec(range)
      const start = match ? Number(match[1]) : 0
      calls.push(`range:${url}:${start}`)
      if (start >= bytes.length) return new Response(null, { status: 416 })
      return new Response(bytes.slice(start), { status: 206 })
    }
    return new Response(bytes, { status: 200 })
  }
  return { manifest, files, calls, fetch: fetchImpl }
}

function makeManager(root: string, net: MockNet, extra: Partial<ConstructorParameters<typeof AssetManager>[0]> = {}): AssetManager {
  const manager = new AssetManager({
    stateRoot: root,
    env: { QF_ASSET_MANIFEST_URL: MANIFEST_URL },
    fetchImpl: net.fetch,
    platform: 'darwin-arm64',
    retryBaseMs: 1,
    retryMaxMs: 5,
    maxAttempts: 3,
    failedRetryDelayMs: 60_000,
    manifestRetryBaseMs: 10,
    manifestRetryMaxMs: 20,
    ...extra,
  })
  managers.push(manager)
  return manager
}

async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
}

function manifestWith(assets: Array<Record<string, unknown>>, version = 'v1'): AssetManifest {
  return parseAssetManifest({ version, assets })!
}

function plainAsset(id: string, url: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const bytes = bytesOf(content)
  return { id, platform: 'all', tier: 1, size: bytes.length, sha256: sha256(bytes), url, dest: id === 'ffmpeg' ? 'ffmpeg' : `${id}.bin`, ...extra }
}

// ── 清单/调度/校验/落位 ───────────────────────────────────────────────────────

test('首启:拉清单→Tier1 串行下载→校验→原子落位;Tier2 不自动下', async () => {
  const root = makeRoot()
  const events: AssetProgressEvent[] = []
  const net = mockNet(
    () => manifestWith([
      plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', 'FFMPEG-BINARY'),
      plainAsset('zh-font', 'https://assets.example/f/font', 'FONT-DATA'),
      plainAsset('whisper-model', 'https://assets.example/f/model', 'MODEL-DATA', { tier: 2 }),
    ]),
    {
      'https://assets.example/f/ffmpeg': { bytes: bytesOf('FFMPEG-BINARY'), served: 0 },
      'https://assets.example/f/font': { bytes: bytesOf('FONT-DATA'), served: 0 },
      'https://assets.example/f/model': { bytes: bytesOf('MODEL-DATA'), served: 0 },
    },
  )
  const manager = makeManager(root, net)
  manager.onEvent(event => events.push(event))
  manager.start()
  await manager.whenIdle()

  const ffmpegPath = manager.readyPath('ffmpeg')
  expect(ffmpegPath).toBe(join(root, 'assets', 'ffmpeg', 'ffmpeg'))
  expect(readFileSync(ffmpegPath!, 'utf8')).toBe('FFMPEG-BINARY')
  expect(manager.readyPath('zh-font')).toBe(join(root, 'assets', 'zh-font', 'zh-font.bin'))
  if (process.platform !== 'win32') {
    expect(statSync(ffmpegPath!).mode & 0o111).toBeGreaterThan(0) // 可执行位
  }

  // Tier2 默认不自动下。
  expect(manager.readyPath('whisper-model')).toBeNull()
  expect(net.calls).not.toContain('fetch:https://assets.example/f/model')

  // 串行:第二个资产的请求发生在第一个 ready 之后(一次只下一个,不抢带宽)。
  const readyIdx = events.findIndex(event => event.id === 'ffmpeg' && event.status === 'ready')
  expect(readyIdx).toBeGreaterThanOrEqual(0)
  const fontFetchIdx = net.calls.indexOf('fetch:https://assets.example/f/font')
  const ffmpegFetchIdx = net.calls.indexOf('fetch:https://assets.example/f/ffmpeg')
  expect(ffmpegFetchIdx).toBeGreaterThanOrEqual(0)
  expect(fontFetchIdx).toBeGreaterThan(ffmpegFetchIdx)

  // 状态持久化(文件式)。
  const state = JSON.parse(readFileSync(join(root, 'assets', 'state.json'), 'utf8'))
  expect(state.assets.ffmpeg.status).toBe('ready')
  expect(state.assets['whisper-model'].status).toBe('pending')
  // 事件流:downloading → verifying → ready。
  const ffmpegStatuses = events.filter(event => event.id === 'ffmpeg').map(event => event.status)
  expect(ffmpegStatuses).toContain('downloading')
  expect(ffmpegStatuses).toContain('verifying')
  expect(ffmpegStatuses[ffmpegStatuses.length - 1]).toBe('ready')
})

test('Range 断点续传:预置半截 .part → 请求带 bytes=N-,206 接着下完', async () => {
  const root = makeRoot()
  const content = 'RESUMABLE-CONTENT-0123456789'
  const net = mockNet(
    () => manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', content)]),
    { 'https://assets.example/f/ffmpeg': { bytes: bytesOf(content), served: 0 } },
  )
  mkdirSync(join(root, 'assets', 'tmp'), { recursive: true })
  writeFileSync(join(root, 'assets', 'tmp', 'ffmpeg.part'), content.slice(0, 10))

  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()

  expect(net.calls).toContain('range:https://assets.example/f/ffmpeg:10')
  expect(readFileSync(manager.readyPath('ffmpeg')!, 'utf8')).toBe(content)
})

test('SHA-256 校验不过:删掉 .part 重下,第二次成功', async () => {
  const root = makeRoot()
  const content = 'GOOD-CONTENT'
  const net = mockNet(
    () => manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', content)]),
    { 'https://assets.example/f/ffmpeg': { bytes: bytesOf(content), corruptFirst: 1, served: 0 } },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()

  expect(net.files['https://assets.example/f/ffmpeg']!.served).toBe(2)
  expect(readFileSync(manager.readyPath('ffmpeg')!, 'utf8')).toBe(content)
  expect(existsSync(join(root, 'assets', 'tmp', 'ffmpeg.part'))).toBe(false)
})

test('重试上限后标 failed(带 retryScheduled),ensureAsset 再触发能重来', async () => {
  const root = makeRoot()
  const content = 'NEVER-GOOD'
  const net = mockNet(
    () => manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', content)]),
    { 'https://assets.example/f/ffmpeg': { bytes: bytesOf(content), corruptFirst: 3, served: 0 } },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()

  const status = manager.status() as { assets: Array<Record<string, unknown>> }
  const record = status.assets.find(asset => asset.id === 'ffmpeg')!
  expect(record.status).toBe('failed')
  expect(String(record.error)).toContain('校验不通过')

  // 功能门再触发:failed → 报告已排重试,并真的重下成功(第 4 次内容正确)。
  const ensure = manager.ensureAsset('ffmpeg')
  expect(ensure).toEqual({ status: 'failed', retryScheduled: true })
  await manager.whenIdle()
  expect(manager.readyPath('ffmpeg')).not.toBeNull()
})

test('清单拉不到 → 用本地缓存的上一份继续下', async () => {
  const root = makeRoot()
  const content = 'CACHED-MANIFEST-ASSET'
  const cached = manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', content)])
  mkdirSync(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'assets', 'manifest.json'), JSON.stringify(cached), 'utf8')

  const net = mockNet(
    () => null, // 远端不可达
    { 'https://assets.example/f/ffmpeg': { bytes: bytesOf(content), served: 0 } },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()
  expect(readFileSync(manager.readyPath('ffmpeg')!, 'utf8')).toBe(content)
})

test('清单与缓存都没有 → 静默退避重试,网络恢复后自动继续(不弹错)', async () => {
  const root = makeRoot()
  const content = 'LATE-MANIFEST'
  let reachable = false
  const net = mockNet(
    () => (reachable ? manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', content)]) : null),
    { 'https://assets.example/f/ffmpeg': { bytes: bytesOf(content), served: 0 } },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()
  expect(manager.readyPath('ffmpeg')).toBeNull()

  reachable = true
  await until(() => manager.readyPath('ffmpeg') !== null)
  expect(readFileSync(manager.readyPath('ffmpeg')!, 'utf8')).toBe(content)
})

test('平台过滤:只认当前平台 + all,别的平台的资产不进状态', async () => {
  const root = makeRoot()
  const net = mockNet(
    () => manifestWith([
      { ...plainAsset('ffmpeg', 'https://assets.example/f/mac', 'MAC'), platform: 'darwin-arm64' },
      { ...plainAsset('ffprobe', 'https://assets.example/f/win', 'WIN'), platform: 'win32-x64' },
      { ...plainAsset('zh-font', 'https://assets.example/f/font', 'FONT'), platform: 'all' },
    ]),
    {
      'https://assets.example/f/mac': { bytes: bytesOf('MAC'), served: 0 },
      'https://assets.example/f/win': { bytes: bytesOf('WIN'), served: 0 },
      'https://assets.example/f/font': { bytes: bytesOf('FONT'), served: 0 },
    },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()

  const ids = (manager.status() as { assets: Array<{ id: string }> }).assets.map(asset => asset.id)
  expect(ids.sort()).toEqual(['ffmpeg', 'zh-font'])
  expect(net.calls).not.toContain('fetch:https://assets.example/f/win')
})

test('同一资产 id 可在清单中按平台重复，客户端只下载当前平台版本', async () => {
  const root = makeRoot()
  const net = mockNet(
    () => manifestWith([
      { ...plainAsset('ffmpeg', 'https://assets.example/f/mac', 'MAC'), platform: 'darwin-arm64', dest: 'ffmpeg' },
      { ...plainAsset('ffmpeg', 'https://assets.example/f/win', 'WINDOWS'), platform: 'win32-x64', dest: 'ffmpeg.exe' },
    ]),
    {
      'https://assets.example/f/mac': { bytes: bytesOf('MAC'), served: 0 },
      'https://assets.example/f/win': { bytes: bytesOf('WINDOWS'), served: 0 },
    },
  )
  const manager = makeManager(root, net, { platform: 'win32-x64' })
  manager.start()
  await manager.whenIdle()

  expect(readFileSync(manager.readyPath('ffmpeg')!, 'utf8')).toBe('WINDOWS')
  expect(net.calls).toContain('fetch:https://assets.example/f/win')
  expect(net.calls).not.toContain('fetch:https://assets.example/f/mac')
})

test('功能门:Tier2 ensureAsset 触发按需下载并插队;就绪后返回 ready+path', async () => {
  const root = makeRoot()
  const net = mockNet(
    () => manifestWith([plainAsset('whisper-model', 'https://assets.example/f/model', 'MODEL', { tier: 2 })]),
    { 'https://assets.example/f/model': { bytes: bytesOf('MODEL'), served: 0 } },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()
  expect(manager.readyPath('whisper-model')).toBeNull()

  const first = manager.ensureAsset('whisper-model')
  expect(first.status).toBe('downloading')
  await manager.whenIdle()
  const done = manager.ensureAsset('whisper-model')
  expect(done.status).toBe('ready')
  expect((done as { path: string }).path).toBe(join(root, 'assets', 'whisper-model', 'whisper-model.bin'))
})

test('功能门:未知 id / 未启动 → failed 且不排重试(调用方走旧兜底)', async () => {
  const root = makeRoot()
  const net = mockNet(() => manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', 'X')]), {
    'https://assets.example/f/ffmpeg': { bytes: bytesOf('X'), served: 0 },
  })
  const idle = makeManager(root, net)
  expect(idle.ensureAsset('ffmpeg')).toEqual({ status: 'failed', retryScheduled: false })

  const manager = makeManager(makeRoot(), net)
  manager.start()
  await manager.whenIdle()
  expect(manager.ensureAsset('no-such-asset')).toEqual({ status: 'failed', retryScheduled: false })
})

test('zip 资产:系统 unzip 解包后原子落位,dest 为主文件', async () => {
  if (spawnSync('which', ['zip']).status !== 0 || spawnSync('which', ['unzip']).status !== 0) return // 无 zip 工具的环境跳过
  const root = makeRoot()
  const workDir = mkdtempSync(join(tmpdir(), 'qf-zip-src-'))
  roots.push(workDir)
  mkdirSync(join(workDir, 'bin'), { recursive: true })
  writeFileSync(join(workDir, 'bin', 'ffmpeg'), 'ZIPPED-FFMPEG')
  const zipPath = join(workDir, 'ffmpeg.zip')
  expect(spawnSync('zip', ['-r', '-q', zipPath, 'bin'], { cwd: workDir }).status).toBe(0)
  const zipBytes = new Uint8Array(readFileSync(zipPath))

  const net = mockNet(
    () => manifestWith([{
      id: 'ffmpeg', platform: 'all', tier: 1, size: zipBytes.length, sha256: sha256(zipBytes),
      url: 'https://assets.example/f/ffmpeg.zip', unpack: 'zip', dest: 'bin/ffmpeg',
    }]),
    { 'https://assets.example/f/ffmpeg.zip': { bytes: zipBytes, served: 0 } },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()

  const path = manager.readyPath('ffmpeg')
  expect(path).toBe(join(root, 'assets', 'ffmpeg', 'bin', 'ffmpeg'))
  expect(readFileSync(path!, 'utf8')).toBe('ZIPPED-FFMPEG')
})

test('重启:快速校验(存在+大小对)直接 ready 不重下;文件被删则打回重下', async () => {
  const root = makeRoot()
  const content = 'PERSISTED'
  const net = mockNet(
    () => manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', content)]),
    { 'https://assets.example/f/ffmpeg': { bytes: bytesOf(content), served: 0 } },
  )
  const first = makeManager(root, net)
  first.start()
  await first.whenIdle()
  expect(net.files['https://assets.example/f/ffmpeg']!.served).toBe(1)
  first.stop()

  // 重启:不重下。
  const second = makeManager(root, net)
  second.start()
  await second.whenIdle()
  expect(net.files['https://assets.example/f/ffmpeg']!.served).toBe(1)
  expect(second.readyPath('ffmpeg')).not.toBeNull()
  second.stop()

  // 文件丢了:打回 pending 重下。
  await rm(join(root, 'assets', 'ffmpeg'), { recursive: true, force: true })
  const third = makeManager(root, net)
  third.start()
  await third.whenIdle()
  expect(net.files['https://assets.example/f/ffmpeg']!.served).toBe(2)
  expect(third.readyPath('ffmpeg')).not.toBeNull()
})

test('清单换新版本(sha 变了):已 ready 的资产重下', async () => {
  const root = makeRoot()
  let content = 'V1-BINARY'
  const net = mockNet(
    () => manifestWith([plainAsset('ffmpeg', 'https://assets.example/f/ffmpeg', content)], content),
    { 'https://assets.example/f/ffmpeg': { bytes: bytesOf('V1-BINARY'), served: 0 } },
  )
  const manager = makeManager(root, net)
  manager.start()
  await manager.whenIdle()
  expect(readFileSync(manager.readyPath('ffmpeg')!, 'utf8')).toBe('V1-BINARY')

  content = 'V2-BINARY-LONGER'
  net.files['https://assets.example/f/ffmpeg']!.bytes = bytesOf('V2-BINARY-LONGER')
  await manager.refreshManifest()
  await manager.whenIdle()
  expect(readFileSync(manager.readyPath('ffmpeg')!, 'utf8')).toBe('V2-BINARY-LONGER')
})

// ── 清单解析与进程级注册表 ────────────────────────────────────────────────────

test('parseAssetManifest:坏条目丢弃、恶意 dest/id 拒收、整体坏返回 null', () => {
  expect(parseAssetManifest(null)).toBeNull()
  expect(parseAssetManifest({ version: 'v1' })).toBeNull()
  const doc = parseAssetManifest({
    version: 'v1',
    assets: [
      { id: 'ok', platform: 'all', tier: 1, size: 3, sha256: 'a'.repeat(64), url: 'https://x/y', dest: 'ok.bin' },
      { id: 'local-dev', platform: 'all', tier: 2, size: 3, sha256: 'b'.repeat(64), url: 'http://127.0.0.1:9000/y', dest: 'local.bin' },
      { id: 'insecure', platform: 'all', tier: 1, size: 3, sha256: 'a'.repeat(64), url: 'http://x/y', dest: 'z' },
      { id: '../escape', platform: 'all', tier: 1, size: 3, sha256: 'a'.repeat(64), url: 'https://x/y', dest: 'z' },
      { id: 'bad-dest', platform: 'all', tier: 1, size: 3, sha256: 'a'.repeat(64), url: 'https://x/y', dest: '../../etc/passwd' },
      { id: 'abs-dest', platform: 'all', tier: 1, size: 3, sha256: 'a'.repeat(64), url: 'https://x/y', dest: '/etc/passwd' },
      { id: 'bad-sha', platform: 'all', tier: 1, size: 3, sha256: 'zz', url: 'https://x/y', dest: 'z' },
      { id: 'bad-url', platform: 'all', tier: 1, size: 3, sha256: 'a'.repeat(64), url: 'file:///etc', dest: 'z' },
      { id: 'tmp', platform: 'all', tier: 1, size: 3, sha256: 'a'.repeat(64), url: 'https://x/y', dest: 'z' },
    ],
  })
  expect(doc!.assets.map(asset => asset.id)).toEqual(['ok', 'local-dev'])
})

test('资产清单地址拒绝公网 HTTP，但允许本地开发 loopback', () => {
  expect(DEFAULT_ASSET_MANIFEST_URL).toBe('https://zzyppz.cn/assets/manifest.json')
  const insecure = new AssetManager({ stateRoot: makeRoot(), env: { QF_ASSET_MANIFEST_URL: 'http://assets.example/manifest.json' } })
  expect(insecure.status().manifest_url).toBe(DEFAULT_ASSET_MANIFEST_URL)
  const local = new AssetManager({ stateRoot: makeRoot(), env: { QF_ASSET_MANIFEST_URL: 'http://127.0.0.1:9000/manifest.json' } })
  expect(local.status().manifest_url).toBe('http://127.0.0.1:9000/manifest.json')
})

test('注册表:没接资产管理器时 managedAssetPath=null、ensureManagedAsset=failed 不重试', () => {
  setActiveAssetManager(null)
  expect(managedAssetPath('ffmpeg')).toBeNull()
  expect(ensureManagedAsset('ffmpeg')).toEqual({ status: 'failed', retryScheduled: false })
})
