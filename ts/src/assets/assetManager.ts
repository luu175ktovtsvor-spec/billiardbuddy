// 资产管理器:瘦安装包的另一半。安装包只装 app + 内核 + bundled md,大块头资产
// (ffmpeg/ffprobe、转写模型权重、字幕中文字体等)首启后从静态资源服务器后台静默下载。
//
// 设计(业界标准 manifest 模式):
// - 清单:QF_ASSET_MANIFEST_URL(默认大陆机 nginx 静态路径)拉 JSON;拉不到用本地缓存的
//   上一份;都没有 → 指数退避静默重试,绝不弹错。
// - 下载:<stateRoot>/assets/tmp/<id>.part,Range 断点续传(nginx 静态文件天然支持 206);
//   SHA-256 校验通过才原子 rename 落位 <stateRoot>/assets/<id>/…;校验不过删掉重下。
// - 调度:Tier1(ffmpeg/ffprobe/中文字体)首启自动串行下(一次一个,不抢满用户带宽);
//   Tier2(转写权重)默认不下,功能门 ensureAsset/requestAsset 按需触发并插队。
// - 状态:pending|downloading|verifying|ready|failed,持久化 state.json(文件式,无 SQL);
//   启动时对 ready 资产做快速校验(存在 + 大小对,不必每次全量 hash)。
// - 面向不懂技术的用户:全程零操作零弹窗,唯一可见的是"某功能正在准备组件 x%"。

import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  AssetManifest,
  AssetPlatform,
  AssetProgressEvent,
  AssetRecord,
  AssetSpec,
  AssetsState,
  AssetTier,
  EnsureAssetResult,
} from './types'

/** 清单默认下载源:owner 大陆机 nginx 静态路径(可换域名/HTTPS 后改这一处或用 env 覆盖)。 */
export const DEFAULT_ASSET_MANIFEST_URL = 'http://39.106.214.21/assets/manifest.json'

/** WS 广播主题(server 把每条 asset_progress 发到这个 topic)。 */
export const ASSET_WS_TOPIC = 'assets'

/** 内核已接线的规范资产 id(manifest 里的 id 必须与此一致才能被功能门找到)。 */
export const ASSET_IDS = {
  ffmpeg: 'ffmpeg',
  ffprobe: 'ffprobe',
  zhFont: 'zh-font',
  whisperCli: 'whisper-cli',
  whisperModel: 'whisper-model',
} as const

const ASSET_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i
const SHA256_RE = /^[0-9a-f]{64}$/i
const RESERVED_IDS = new Set(['tmp', 'state.json', 'manifest.json'])

type AssetFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AssetManagerOptions {
  stateRoot: string
  env?: Record<string, string | undefined>
  fetchImpl?: AssetFetch
  /** 平台键,默认 `${process.platform}-${process.arch}`;测试可注入。 */
  platform?: string
  /** 单资产下载失败的退避基数/上限/次数上限(测试可调小)。 */
  retryBaseMs?: number
  retryMaxMs?: number
  maxAttempts?: number
  /** 达到次数上限标 failed 后,自动再排一次重试的间隔。 */
  failedRetryDelayMs?: number
  /** 清单拉取失败的退避基数/上限。 */
  manifestRetryBaseMs?: number
  manifestRetryMaxMs?: number
}

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function safeDestParts(dest: unknown): string[] | null {
  if (typeof dest !== 'string' || !dest.trim()) return null
  const normalized = dest.trim().replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized)) return null
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return null
  if (parts.some(part => part === '..' || part === '.')) return null
  return parts
}

function parseSpec(raw: unknown): AssetSpec | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const entry = raw as Record<string, unknown>
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!ASSET_ID_RE.test(id) || RESERVED_IDS.has(id)) return null
  const platform = entry.platform
  if (platform !== 'darwin-arm64' && platform !== 'win32-x64' && platform !== 'all') return null
  const tier = entry.tier
  if (tier !== 1 && tier !== 2) return null
  const size = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0 ? Math.floor(entry.size) : null
  if (size === null) return null
  const sha256 = typeof entry.sha256 === 'string' && SHA256_RE.test(entry.sha256.trim()) ? entry.sha256.trim().toLowerCase() : ''
  if (!sha256) return null
  const url = typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url.trim()) ? entry.url.trim() : ''
  if (!url) return null
  const destParts = safeDestParts(entry.dest)
  if (!destParts) return null
  const unpack = entry.unpack === 'zip' ? 'zip' : 'none'
  return { id, platform: platform as AssetPlatform, tier: tier as AssetTier, size, sha256, url, unpack, dest: destParts.join('/') }
}

/** 解析并过滤远端清单;整体形状不对返回 null(退回缓存),个别坏条目丢弃。 */
export function parseAssetManifest(raw: unknown): AssetManifest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const doc = raw as Record<string, unknown>
  const version = typeof doc.version === 'string' && doc.version.trim() ? doc.version.trim() : ''
  if (!version || !Array.isArray(doc.assets)) return null
  const assets: AssetSpec[] = []
  const seen = new Set<string>()
  for (const item of doc.assets) {
    const spec = parseSpec(item)
    if (spec && !seen.has(spec.id)) {
      seen.add(spec.id)
      assets.push(spec)
    }
  }
  return { version, assets }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** 用系统自带工具解 zip:macOS/Linux 用 unzip,Windows 用 tar(win10+ 自带、认 zip)。 */
async function unpackZip(zipPath: string, destDir: string): Promise<void> {
  const tool = process.platform === 'win32'
    ? { bin: 'tar', args: ['-xf', zipPath, '-C', destDir] }
    : { bin: 'unzip', args: ['-o', '-q', zipPath, '-d', destDir] }
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(tool.bin, tool.args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    const errChunks: Buffer[] = []
    child.stderr?.on('data', chunk => errChunks.push(Buffer.from(chunk)))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`解包失败(${tool.bin} 退出码 ${code}):${Buffer.concat(errChunks).toString('utf8').trim().slice(0, 300)}`))
    })
  })
}

export class AssetManager {
  private readonly assetsRoot: string
  private readonly tmpRoot: string
  private readonly statePath: string
  private readonly manifestCachePath: string
  private readonly manifestUrl: string
  private readonly fetchImpl: AssetFetch
  private readonly platform: string
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly maxAttempts: number
  private readonly failedRetryDelayMs: number
  private readonly manifestRetryBaseMs: number
  private readonly manifestRetryMaxMs: number

  private state: AssetsState = { manifestVersion: '', assets: {}, updatedAt: 0 }
  private specs = new Map<string, AssetSpec>()
  private manifestLoaded = false
  private manifestAttempts = 0
  private queue: string[] = []
  private downloadingId: string | null = null
  private wanted = new Set<string>()
  private listeners = new Set<(event: AssetProgressEvent) => void>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private started = false
  private stopped = false
  private pumping = false
  private pumpPromise: Promise<void> = Promise.resolve()
  private startPromise: Promise<void> | null = null
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private readonly opts: AssetManagerOptions) {
    this.assetsRoot = join(opts.stateRoot, 'assets')
    this.tmpRoot = join(this.assetsRoot, 'tmp')
    this.statePath = join(this.assetsRoot, 'state.json')
    this.manifestCachePath = join(this.assetsRoot, 'manifest.json')
    const env = opts.env ?? process.env
    this.manifestUrl = env.QF_ASSET_MANIFEST_URL?.trim() || DEFAULT_ASSET_MANIFEST_URL
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input as string, init))
    this.platform = opts.platform ?? `${process.platform}-${process.arch}`
    this.retryBaseMs = opts.retryBaseMs ?? 3_000
    this.retryMaxMs = opts.retryMaxMs ?? 60_000
    this.maxAttempts = opts.maxAttempts ?? 4
    this.failedRetryDelayMs = opts.failedRetryDelayMs ?? 10 * 60_000
    this.manifestRetryBaseMs = opts.manifestRetryBaseMs ?? 30_000
    this.manifestRetryMaxMs = opts.manifestRetryMaxMs ?? 15 * 60_000
  }

  /** 首启后调用:加载状态 → 快速校验 → 拉清单(退缓存/退避重试)→ 自动排 Tier1。幂等。 */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.startPromise = (async () => {
      await this.loadState()
      await this.quickVerify()
      const manifest = await this.refreshManifest()
      if (!manifest) this.scheduleManifestRetry()
    })().catch(() => {
      // 启动流程任何意外都静默(下次触发会再来),资产未就绪时功能门自会给"准备中"。
    })
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.listeners.clear()
  }

  isStarted(): boolean {
    return this.started && !this.stopped
  }

  onEvent(listener: (event: AssetProgressEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 全部资产状态(GET /api/v1/assets/status 的载荷,snake_case 对外)。 */
  status(): Record<string, unknown> {
    const assets = Object.values(this.state.assets)
      .sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id))
      .map(record => ({
        id: record.id,
        tier: record.tier,
        status: record.status,
        progress: record.progress,
        size: record.size,
        ...(record.path ? { path: record.path } : {}),
        ...(record.error ? { error: record.error } : {}),
        ...(record.nextRetryAt ? { next_retry_at: record.nextRetryAt } : {}),
        updated_at: record.updatedAt,
      }))
    return {
      manifest_version: this.state.manifestVersion || null,
      manifest_url: this.manifestUrl,
      platform: this.platform,
      started: this.isStarted(),
      updated_at: this.state.updatedAt,
      assets,
    }
  }

  /** ready 资产主文件绝对路径;未就绪/文件丢了 → null。 */
  readyPath(id: string): string | null {
    const record = this.state.assets[id]
    if (record?.status === 'ready' && record.path && existsSync(record.path)) return record.path
    return null
  }

  /**
   * 功能门:就绪给路径;没就绪触发按需下载(Tier2 场景)并回进度;失败说明是否已排重试。
   * 未 start(测试/显式关闭)一律 failed+不重试,调用方按"没有资产管理器"走旧兜底。
   */
  ensureAsset(id: string): EnsureAssetResult {
    const path = this.readyPath(id)
    if (path) return { status: 'ready', path }
    if (!this.isStarted()) return { status: 'failed', retryScheduled: false }
    if (this.manifestLoaded && !this.specs.has(id)) return { status: 'failed', retryScheduled: false }
    const before = this.state.assets[id]
    if (before?.status === 'failed') {
      this.requestAsset(id)
      return { status: 'failed', retryScheduled: true }
    }
    this.requestAsset(id)
    return { status: 'downloading', progress: this.state.assets[id]?.progress ?? 0 }
  }

  /** 按需请求某资产:插队到队首(Tier2 触发/用户等着的功能优先)。清单还没到就记账,到了再排。 */
  requestAsset(id: string): void {
    if (this.stopped || !this.started) return
    if (this.readyPath(id)) return
    if (!this.specs.has(id)) {
      if (!this.manifestLoaded) {
        this.wanted.add(id)
        void this.refreshManifest().catch(() => undefined)
      }
      return
    }
    const record = this.state.assets[id]
    if (record?.status === 'failed') {
      record.status = 'pending'
      record.attempts = 0
      record.error = undefined
      record.nextRetryAt = undefined
      this.touch(record)
    }
    this.enqueue(id, { front: true })
  }

  /** 拉远端清单;失败退本地缓存;应用成功返回清单,彻底没有返回 null。并发调用共享一次拉取。 */
  async refreshManifest(): Promise<AssetManifest | null> {
    if (this.manifestRefreshPromise) return this.manifestRefreshPromise
    this.manifestRefreshPromise = this.doRefreshManifest().finally(() => {
      this.manifestRefreshPromise = null
    })
    return this.manifestRefreshPromise
  }

  private manifestRefreshPromise: Promise<AssetManifest | null> | null = null

  private async doRefreshManifest(): Promise<AssetManifest | null> {
    let manifest: AssetManifest | null = null
    try {
      const res = await this.fetchImpl(this.manifestUrl, { headers: { 'Cache-Control': 'no-cache' } })
      if (res.ok) {
        manifest = parseAssetManifest(await res.json().catch(() => null))
        if (manifest) {
          await mkdir(this.assetsRoot, { recursive: true }).catch(() => undefined)
          await writeFile(this.manifestCachePath, JSON.stringify(manifest, null, 2), 'utf8').catch(() => undefined)
        }
      }
    } catch {
      // 静默:下面退缓存。
    }
    if (!manifest) manifest = await this.loadCachedManifest()
    if (!manifest) return null
    this.manifestAttempts = 0
    await this.applyManifest(manifest)
    return manifest
  }

  /** 等当前队列跑空(测试用)。 */
  async whenIdle(): Promise<void> {
    if (this.startPromise) await this.startPromise
    while (this.pumping || this.queue.length > 0) {
      await this.pumpPromise
      await delay(5)
    }
    await this.persistChain
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  private async loadState(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as AssetsState
      if (raw && typeof raw === 'object' && raw.assets && typeof raw.assets === 'object') {
        this.state = {
          manifestVersion: typeof raw.manifestVersion === 'string' ? raw.manifestVersion : '',
          assets: raw.assets,
          updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        }
      }
    } catch {
      // 首次启动/状态损坏:从空状态开始,清单会重建。
    }
  }

  /** ready 资产快速校验:主文件存在 + 大小对(不全量 hash);不对就打回 pending 重下。 */
  private async quickVerify(): Promise<void> {
    for (const record of Object.values(this.state.assets)) {
      if (record.status === 'ready') {
        if (record.path && existsSync(record.path)) {
          if (record.fileSize === undefined) continue
          const actual = await stat(record.path).then(s => s.size).catch(() => -1)
          if (actual === record.fileSize) continue
        }
        record.status = 'pending'
        record.progress = 0
        record.path = undefined
        record.fileSize = undefined
        record.attempts = 0
        this.touch(record)
      } else if (record.status === 'downloading' || record.status === 'verifying') {
        // 上次进程中断留下的中间态;.part 还在,续传会接着跑。
        record.status = 'pending'
        this.touch(record)
      }
    }
    await this.persist()
  }

  private async loadCachedManifest(): Promise<AssetManifest | null> {
    try {
      return parseAssetManifest(JSON.parse(await readFile(this.manifestCachePath, 'utf8')))
    } catch {
      return null
    }
  }

  private scheduleManifestRetry(): void {
    if (this.stopped) return
    this.manifestAttempts += 1
    const wait = Math.min(this.manifestRetryBaseMs * 2 ** (this.manifestAttempts - 1), this.manifestRetryMaxMs)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.refreshManifest().then(manifest => {
        if (!manifest) this.scheduleManifestRetry()
      }).catch(() => this.scheduleManifestRetry())
    }, wait)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.add(timer)
  }

  private async applyManifest(manifest: AssetManifest): Promise<void> {
    const specs = new Map<string, AssetSpec>()
    for (const spec of manifest.assets) {
      if (spec.platform === 'all' || spec.platform === this.platform) specs.set(spec.id, spec)
    }
    this.specs = specs
    this.manifestLoaded = true
    this.state.manifestVersion = manifest.version

    for (const id of Object.keys(this.state.assets)) {
      if (!specs.has(id)) delete this.state.assets[id]
    }
    for (const [id, spec] of specs) {
      const record = this.state.assets[id]
      if (!record) {
        this.state.assets[id] = {
          id,
          tier: spec.tier,
          status: 'pending',
          progress: 0,
          size: spec.size,
          sha256: spec.sha256,
          attempts: 0,
          updatedAt: Date.now(),
        }
        continue
      }
      record.tier = spec.tier
      record.size = spec.size
      if (record.sha256 !== spec.sha256) {
        // 清单换了新版本:旧文件作废重下(旧 part 一并清)。
        record.sha256 = spec.sha256
        record.status = 'pending'
        record.progress = 0
        record.path = undefined
        record.fileSize = undefined
        record.attempts = 0
        record.error = undefined
        record.nextRetryAt = undefined
        await rm(this.partPath(id), { force: true }).catch(() => undefined)
        this.touch(record)
      }
    }
    await this.persist()

    for (const id of [...this.wanted]) {
      this.wanted.delete(id)
      if (specs.has(id) && !this.readyPath(id)) this.enqueue(id, { front: true })
    }
    for (const [id, spec] of specs) {
      if (spec.tier === 1 && this.state.assets[id]?.status !== 'ready') this.enqueue(id)
    }
  }

  private partPath(id: string): string {
    return join(this.tmpRoot, `${id}.part`)
  }

  private enqueue(id: string, opts: { front?: boolean } = {}): void {
    if (this.stopped || !this.started) return
    if (this.downloadingId === id) return
    const existing = this.queue.indexOf(id)
    if (existing >= 0) {
      if (!opts.front || existing === 0) {
        this.kick()
        return
      }
      this.queue.splice(existing, 1)
    }
    if (opts.front) this.queue.unshift(id)
    else this.queue.push(id)
    this.kick()
  }

  private kick(): void {
    if (this.pumping || this.stopped) return
    this.pumping = true
    this.pumpPromise = this.pump().catch(() => undefined).finally(() => {
      this.pumping = false
      // pump 收尾窗口里若又有新任务入队,补一脚。
      if (!this.stopped && this.queue.length > 0) this.kick()
    })
  }

  /** 串行泵:一次只下一个,不并发抢满用户带宽。 */
  private async pump(): Promise<void> {
    while (!this.stopped && this.queue.length > 0) {
      const id = this.queue.shift()!
      const spec = this.specs.get(id)
      if (!spec || this.readyPath(id)) continue
      this.downloadingId = id
      try {
        await this.downloadOne(spec)
      } finally {
        this.downloadingId = null
      }
    }
  }

  /** 单资产:退避重试循环 → 下载(断点续传)→ 校验 → 原子落位。 */
  private async downloadOne(spec: AssetSpec): Promise<void> {
    const record = this.state.assets[spec.id]
    if (!record) return
    for (;;) {
      if (this.stopped) return
      try {
        await this.downloadAndPlace(spec, record)
        return
      } catch (err) {
        record.attempts += 1
        record.error = err instanceof Error ? err.message : String(err)
        if (record.attempts >= this.maxAttempts) {
          record.status = 'failed'
          record.nextRetryAt = Date.now() + this.failedRetryDelayMs
          this.touch(record)
          await this.persist()
          this.emit(record)
          this.scheduleFailedRetry(spec.id)
          return
        }
        this.touch(record)
        await this.persist()
        this.emit(record)
        const wait = Math.min(this.retryBaseMs * 2 ** (record.attempts - 1), this.retryMaxMs)
        await delay(wait)
      }
    }
  }

  /** failed 资产到点自动再排一次(静默;ensureAsset/requestAsset 也随时能手动触发)。 */
  private scheduleFailedRetry(id: string): void {
    if (this.stopped) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.state.assets[id]?.status === 'failed') this.requestAsset(id)
    }, this.failedRetryDelayMs)
    ;(timer as { unref?: () => void }).unref?.()
    this.timers.add(timer)
  }

  private async downloadAndPlace(spec: AssetSpec, record: AssetRecord): Promise<void> {
    await mkdir(this.tmpRoot, { recursive: true })
    const part = this.partPath(spec.id)
    let offset = await stat(part).then(s => s.size).catch(() => 0)
    const needsBody = spec.size === 0 || offset < spec.size

    if (needsBody) {
      const headers: Record<string, string> = {}
      if (offset > 0) headers.Range = `bytes=${offset}-`
      const res = await this.fetchImpl(spec.url, { headers })
      if (offset > 0 && res.status === 200) {
        // 源不认 Range(或文件变了):从头来。
        offset = 0
      } else if (offset > 0 && res.status === 416) {
        // 已下完(上次校验前中断):直接进校验。
        await res.body?.cancel().catch(() => undefined)
        await this.verifyAndPlace(spec, record, part)
        return
      } else if (offset > 0 && res.status !== 206) {
        throw new Error(`下载源不可用(HTTP ${res.status})`)
      } else if (offset === 0 && !res.ok) {
        throw new Error(`下载源不可用(HTTP ${res.status})`)
      }

      record.status = 'downloading'
      record.progress = spec.size > 0 ? Math.min(99, Math.floor((offset / spec.size) * 100)) : 0
      this.touch(record)
      this.emit(record)

      const handle = await open(part, offset > 0 ? 'a' : 'w')
      let written = offset
      let lastEmitted = record.progress
      try {
        if (res.body) {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            if (this.stopped) throw new Error('已停止')
            await handle.write(chunk)
            written += chunk.byteLength
            if (spec.size > 0) {
              const pct = Math.min(99, Math.floor((written / spec.size) * 100))
              if (pct !== lastEmitted) {
                lastEmitted = pct
                record.progress = pct
                this.touch(record)
                this.emit(record)
                await this.persist()
              }
            }
          }
        }
      } finally {
        await handle.close().catch(() => undefined)
      }
      if (spec.size > 0 && written < spec.size) {
        throw new Error(`下载不完整(${written}/${spec.size} 字节),将断点续传`)
      }
    }

    await this.verifyAndPlace(spec, record, part)
  }

  private async verifyAndPlace(spec: AssetSpec, record: AssetRecord, part: string): Promise<void> {
    record.status = 'verifying'
    record.progress = 99
    this.touch(record)
    this.emit(record)

    const digest = await hashFile(part)
    if (digest.toLowerCase() !== spec.sha256) {
      await rm(part, { force: true }).catch(() => undefined)
      throw new Error('校验不通过(SHA-256 不匹配),已删除重下')
    }

    const finalDir = join(this.assetsRoot, spec.id)
    const destPath = join(finalDir, ...spec.dest.split('/'))
    if (spec.unpack === 'zip') {
      const zipPath = join(this.tmpRoot, `${spec.id}.zip`)
      const unpackDir = join(this.tmpRoot, `${spec.id}.unpack`)
      await rm(zipPath, { force: true }).catch(() => undefined)
      await rename(part, zipPath)
      await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined)
      await mkdir(unpackDir, { recursive: true })
      try {
        await unpackZip(zipPath, unpackDir)
        const unpackedDest = join(unpackDir, ...spec.dest.split('/'))
        if (!existsSync(unpackedDest)) throw new Error(`解包后没找到主文件 ${spec.dest}(清单 dest 与包内结构不一致)`)
        await rm(finalDir, { recursive: true, force: true }).catch(() => undefined)
        await mkdir(dirname(finalDir), { recursive: true })
        await rename(unpackDir, finalDir)
      } catch (err) {
        // 解包/落位失败:zip 挪回 .part 保住已下载字节(校验已过,下次直接进校验落位)。
        await rm(unpackDir, { recursive: true, force: true }).catch(() => undefined)
        await rename(zipPath, part).catch(() => rm(zipPath, { force: true }).catch(() => undefined))
        throw err
      }
      await rm(zipPath, { force: true }).catch(() => undefined)
    } else {
      await mkdir(dirname(destPath), { recursive: true })
      await rename(part, destPath)
    }
    if (process.platform !== 'win32') {
      await chmod(destPath, 0o755).catch(() => undefined)
    }

    const fileSize = await stat(destPath).then(s => s.size).catch(() => undefined)
    record.status = 'ready'
    record.progress = 100
    record.path = destPath
    record.fileSize = fileSize
    record.error = undefined
    record.nextRetryAt = undefined
    record.attempts = 0
    this.touch(record)
    await this.persist()
    this.emit(record)
  }

  private touch(record: AssetRecord): void {
    record.updatedAt = Date.now()
    this.state.updatedAt = record.updatedAt
  }

  private async persist(): Promise<void> {
    this.persistChain = this.persistChain.then(async () => {
      try {
        await mkdir(this.assetsRoot, { recursive: true })
        const tmp = `${this.statePath}.tmp`
        await writeFile(tmp, JSON.stringify(this.state, null, 2), 'utf8')
        await rename(tmp, this.statePath)
      } catch {
        // 状态文件写不进(磁盘满等):内存态照常跑,下次写覆盖。
      }
    })
    await this.persistChain
  }

  private emit(record: AssetRecord): void {
    const event: AssetProgressEvent = {
      type: 'asset_progress',
      id: record.id,
      status: record.status,
      progress: record.progress,
      tier: record.tier,
      ...(record.path ? { path: record.path } : {}),
      ...(record.error ? { error: record.error } : {}),
      ts: Date.now(),
    }
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // 单个监听者出错不影响其他人。
      }
    }
  }
}

// ── 进程级注册表:媒体等调用点经此拿"资产管理器 ready 路径",不用层层传实例 ──

/** 注册表接口(测试可用轻量桩替代完整 AssetManager)。 */
export interface ActiveAssetSource {
  readyPath(id: string): string | null
  ensureAsset(id: string): EnsureAssetResult
}

let active: ActiveAssetSource | null = null

export function setActiveAssetManager(source: ActiveAssetSource | null): void {
  active = source
}

export function getActiveAssetManager(): ActiveAssetSource | null {
  return active
}

/** ready 资产主文件绝对路径;没接资产管理器/未就绪 → null(调用方走内置/PATH 兜底)。 */
export function managedAssetPath(id: string): string | null {
  try {
    return active?.readyPath(id) ?? null
  } catch {
    return null
  }
}

/** 功能门入口:没接资产管理器时返回 failed+不重试,调用方据此走旧兜底路径。 */
export function ensureManagedAsset(id: string): EnsureAssetResult {
  if (!active) return { status: 'failed', retryScheduled: false }
  try {
    return active.ensureAsset(id)
  } catch {
    return { status: 'failed', retryScheduled: false }
  }
}
