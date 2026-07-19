import { createHash } from 'node:crypto'
import { CapacityQueueError, type CapacityPermit, type FairCapacityScheduler } from './modelCapacity'
import { fetchMimoWithRetry } from './mimoChat'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

// 固定、通用、与具体问题无关的结构化抽取提示词 —— 这样同一张图无论用户问什么,缓存文本都可复用。
// 改动措辞会改变模型输出分布,所以任何调整都必须同时推进 VISION_PROMPT_VERSION,让旧缓存自然失效
// (不同版本号 → 不同 cacheKey),不会把旧提示词生成的文本当新提示词的结果用。
const VISION_PROMPT_VERSION = 'v1'
const VISION_PROMPT = `请仔细分析这张图片，用结构化的纯文本输出以下内容（不要使用 markdown 代码块包裹，不要寒暄，不要复述本提示词，不要臆测图片之外的信息）：
一、文字信息（OCR）：完整转录图片中出现的所有可见文字，尽量保持原有阅读顺序；没有文字则注明"无可见文字"。
二、主要对象：列出图片中的关键物体、人物、图形或界面元素。
三、空间布局：描述这些对象/元素之间的位置关系与整体版式（如从上到下、从左到右、居中、并排、分栏等）。
四、界面状态（如适用）：识别可见的按钮、菜单、输入框、复选框、单选项，以及选中/未选中/禁用/高亮/聚焦等状态。
五、错误与提示：如果出现报错信息、警告、通知、状态条或异常高亮，逐条列出其原文与大致位置。
六、其它显著信息：颜色、图表数据、进度条数值、二维码/条形码内容（如可辨识）、水印或其它值得注意的细节。`

// 视觉桥接自己的重试预算(复用 fetchMimoWithRetry 的 429 不重试语义),与其它上游一致夹在 [0,1]，
// 避免与客户端自身的重试相乘。
const MIMO_VISION_RETRY_MAX = 1
const MIMO_VISION_RETRY_BASE_MS = 300
const MIMO_VISION_RETRY_MAX_MS = 2000

export class VisionBridgeError extends Error {
  constructor(readonly status: number, readonly publicMessage: string) {
    super(publicMessage)
    this.name = 'VisionBridgeError'
  }
}

export interface VisionBridgeCaps {
  /** 单次聊天请求里允许的图片张数上限。 */
  maxImages: number
  /** 单张图片(data: URI 解码后的字节数)上限。 */
  maxImageBytes: number
  /** 本次请求所有图片字节合计上限(远程 http(s) 图片字节未知，不计入)。 */
  maxTotalBytes: number
  /** 单张图片调用 MiMo 视觉理解的超时预算(毫秒，覆盖含重试在内的整体耗时)。 */
  visionTimeoutMs: number
  /** 全局在途 MiMo 视觉调用并发上限(跨所有请求共享，保护 MiMo 账号)。 */
  maxConcurrent: number
  /** 全局视觉排队队列上限(不含正在执行的 maxConcurrent 个)；排满后新等待者立即 429，不再入队。 */
  queueMax: number
  /** 视觉请求最多排队多久；满时或超时都快速失败，避免长队拖垮聊天时延。 */
  queueMaxWaitMs: number
  /** 同一受信桌面安装最多同时占用的视觉槽，防单人多窗口挤占全局队列。 */
  perClientConc: number
  /** 单个聊天请求最多同时占用几个全局视觉并发槽(应 ≤ maxConcurrent)；防止一个多图请求独占
   *  全局槽、饿死同时到达的其它请求。请求内相同图片仍按哈希去重只调一次，不受此限流放大延迟。 */
  perRequestConc: number
  /** 视觉理解文本缓存的最大条目数，超出按写入顺序(FIFO)淘汰。 */
  cacheMax: number
  /** 视觉理解文本缓存的存活时间(毫秒)。 */
  cacheTtlMs: number
}

export interface VisionCache {
  get(key: string): string | undefined
  set(key: string, text: string): void
}

/** Structural adapter for the same account-level MiMo RPM bucket used by native chat. */
export interface VisionRateLimiter {
  acquire(maxWaitSeconds: number, signal?: AbortSignal): Promise<void>
}

export interface VisionBridgeDeps {
  mimoBase: string
  mimoKey: string
  fetchImpl: FetchLike
  caps: VisionBridgeCaps
  /** 原生 MiMo 聊天与视觉桥接复用同一个账号级容量池。 */
  mimoCapacity?: FairCapacityScheduler
  /** 原生 MiMo 聊天与视觉桥接也复用同一个账号级 RPM 桶，不能绕过账户速率保护。 */
  mimoRateLimiter?: VisionRateLimiter
  /** Vision's short queue window caps how long it may wait for the shared RPM bucket. */
  mimoRateLimitMaxWaitSeconds?: number
  /** 可选注入，主要给测试用；默认是进程内存 Map,不落盘,只存哈希 key + 文本。 */
  cache?: VisionCache
}

export interface VisionBridgeMetrics {
  visionBridgeMs: number
  /** 命中缓存(含请求内去重命中)的图片张数。 */
  cacheHits: number
  imageCount: number
}

export interface VisionBridge {
  transform(rawBody: string, opts: { signal?: AbortSignal; schedulerId?: string; tokenId?: string }): Promise<{ body: string; metrics: VisionBridgeMetrics }>
  /** Live semaphore state for the authenticated gateway health endpoint. */
  snapshot(): VisionSemaphoreSnapshot
}

/**
 * One deduplicated image lookup may have several request windows waiting for it.  The
 * work owns its own AbortController: individual windows can leave without cancelling
 * their peers, while the last subscriber leaving tears down a queued or active lookup
 * instead of needlessly consuming a VisionSemaphore/MiMo slot.
 */
type SharedVisionLookup = {
  promise: Promise<string>
  controller: AbortController
  subscribers: number
  settled: boolean
}

/**
 * 探测聊天请求体是否携带任意 image_url 内容块(Read 工具结果、粘贴图、Computer Use 截图代理后
 * 都会变成这种形状)。只做只读探测，解析失败/结构不符一律返回 false，交给正常路由与 prepareBody
 * 兜底报错——探测本身绝不抛错、绝不改写请求体。
 */
export function containsImageContent(rawBody: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return false
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.messages)) return false
  for (const message of parsed.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (isRecord(part) && part.type === 'image_url') return true
    }
  }
  return false
}

/**
 * Detect the real Computer Use tool bundle in an OpenAI Chat request. Requiring both a
 * screenshot reader and an input action avoids treating an unrelated project tool named
 * "screenshot" as desktop control. MCP tool names may be namespaced, so suffix matching is
 * deliberate (for example mcp__computer-use__screenshot).
 */
export function containsComputerUseContext(rawBody: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return false
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.tools)) return false
  const names = parsed.tools.flatMap(tool => {
    if (!isRecord(tool) || !isRecord(tool.function) || typeof tool.function.name !== 'string') return []
    return [tool.function.name.toLowerCase()]
  })
  const has = (name: string) => names.some(candidate => candidate === name || candidate.endsWith(`__${name}`))
  return has('screenshot') && (
    has('left_click') ||
    has('computer_batch') ||
    has('request_access')
  )
}

/**
 * 视觉桥接：把聊天请求里的每一张图换成 MiMo v2.5 生成的结构化文本描述，供非原生多模态的文本模型
 * (DeepSeek / Qwen / mimo-v2.5-pro)继续处理。任何环节失败都失败关闭(throw VisionBridgeError)，
 * 绝不把带图的原始请求体透传给文本模型，也绝不改投 MiMo 以外的视觉上游。
 */
export function createVisionBridge(deps: VisionBridgeDeps): VisionBridge {
  // 只兜底非法值(非正数/非有限数),不设"业务上合理"的下限——调用方(app.ts loadConfig)负责
  // 生产环境的合理默认值,这里只防止 0/负数/NaN 把桥接变成一个恒真或恒假的黑洞。
  const caps: VisionBridgeCaps = {
    maxImages: Math.max(1, Math.floor(deps.caps.maxImages)),
    maxImageBytes: Math.max(1, Math.floor(deps.caps.maxImageBytes)),
    maxTotalBytes: Math.max(1, Math.floor(deps.caps.maxTotalBytes)),
    visionTimeoutMs: Math.max(1, Math.floor(deps.caps.visionTimeoutMs)),
    maxConcurrent: Math.max(1, Math.floor(deps.caps.maxConcurrent)),
    queueMax: Math.max(1, Math.floor(deps.caps.queueMax)),
    queueMaxWaitMs: Math.max(1, Math.floor(deps.caps.queueMaxWaitMs)),
    perClientConc: Math.max(1, Math.floor(deps.caps.perClientConc)),
    perRequestConc: Math.max(1, Math.floor(deps.caps.perRequestConc)),
    cacheMax: Math.max(1, Math.floor(deps.caps.cacheMax)),
    cacheTtlMs: Math.max(1, Math.floor(deps.caps.cacheTtlMs)),
  }
  const cache = deps.cache ?? new DefaultVisionCache(caps.cacheMax, caps.cacheTtlMs)
  const semaphore = new VisionSemaphore(caps.maxConcurrent, caps.queueMaxWaitMs, caps.queueMax, caps.perClientConc)
  // 缓存只命中“已完成”结果时，多个窗口同一时刻上传同图仍会重复打 MiMo。实例级
  // singleflight 让相同 hash+promptVersion 复用一次真实识图；请求各自可以离开等待，
  // 但不能由一个取消动作中断其它窗口仍在等的共享上游调用。
  const inFlightByKey = new Map<string, SharedVisionLookup>()

  const settleLookup = (key: string, lookup: SharedVisionLookup) => {
    lookup.settled = true
    if (inFlightByKey.get(key) === lookup) inFlightByKey.delete(key)
  }
  const subscribeToLookup = (lookup: SharedVisionLookup, signal: AbortSignal | undefined): Promise<string> => {
    lookup.subscribers += 1
    return awaitWithAbort(lookup.promise, signal).finally(() => {
      lookup.subscribers = Math.max(0, lookup.subscribers - 1)
      // Do not let an orphaned singleflight task occupy either the visual queue or the
      // shared MiMo capacity queue.  A surviving subscriber keeps the same lookup alive.
      if (lookup.subscribers === 0 && !lookup.settled) lookup.controller.abort()
    })
  }

  return {
    snapshot() {
      return semaphore.snapshot()
    },
    async transform(rawBody, opts) {
      if (opts.signal?.aborted) throw new VisionBridgeError(499, '请求已取消')
      const started = performance.now()
      let parsed: unknown
      try {
        parsed = JSON.parse(rawBody)
      } catch {
        throw new VisionBridgeError(400, '模型请求不是合法 JSON')
      }
      if (!isRecord(parsed) || !Array.isArray(parsed.messages)) {
        throw new VisionBridgeError(400, '模型请求必须包含 messages 数组')
      }

      // 收集所有图片块的引用(直接指向原始 content 数组里的元素)，后面原地改写。
      const images: Array<{ part: Record<string, unknown>; url: string }> = []
      for (const message of parsed.messages) {
        if (!isRecord(message) || !Array.isArray(message.content)) continue
        for (const part of message.content) {
          if (!isRecord(part) || part.type !== 'image_url') continue
          const imageUrl = part.image_url
          if (!isRecord(imageUrl) || typeof imageUrl.url !== 'string') {
            throw new VisionBridgeError(400, '图片内容块格式不合法')
          }
          images.push({ part, url: imageUrl.url })
        }
      }

      if (images.length === 0) {
        // 防御性兜底：调用方应只在 containsImageContent 为真时才调用 transform，这里保持原样返回。
        return { body: rawBody, metrics: { visionBridgeMs: elapsed(started), cacheHits: 0, imageCount: 0 } }
      }
      if (images.length > caps.maxImages) {
        throw new VisionBridgeError(413, `图片数量超过上限（最多 ${caps.maxImages} 张）`)
      }

      // 逐张校验/解码/哈希——任何一张超限都在调用 MiMo 之前失败关闭，不产生任何上游调用。
      const decoded = images.map(({ url }) => decodeImageUrl(url, caps.maxImageBytes))
      const totalBytes = decoded.reduce((sum, d) => sum + (d.byteLength ?? 0), 0)
      if (totalBytes > caps.maxTotalBytes) {
        throw new VisionBridgeError(413, '图片总大小超过上限')
      }

      let cacheHits = 0
      // 不再用 Promise.all 把一个请求的所有图同时扔给全局视觉信号量抢槽——8 图请求会瞬间抢占
      // 8 个全局并发槽，饿死同时到达的其它请求。改用有界并发 map：单个请求最多同时发起
      // caps.perRequestConc 张图的 MiMo 调用(每张仍受全局 semaphore 约束)，相同图片
      // 会按哈希复用实例级 in-flight 调用，不受此限流放大延迟。
      const texts = await mapWithConcurrency(images, caps.perRequestConc, async ({ url }, index) => {
        const cacheKey = `${decoded[index]!.hash}:${VISION_PROMPT_VERSION}`
        const cached = cache.get(cacheKey)
        if (cached !== undefined) {
          cacheHits += 1
          return cached
        }
        let lookup = inFlightByKey.get(cacheKey)
        if (!lookup) {
          const controller = new AbortController()
          const created = semaphore.run(() => callMimoVision(deps, url, {
            schedulerId: opts.schedulerId,
            tokenId: opts.tokenId,
          }, controller.signal), controller.signal, opts.schedulerId).then(text => {
            cache.set(cacheKey, text)
            return text
          })
          lookup = { promise: created, controller, subscribers: 0, settled: false }
          inFlightByKey.set(cacheKey, lookup)
          void created.then(
            () => settleLookup(cacheKey, lookup!),
            () => settleLookup(cacheKey, lookup!),
          )
        }
        return await subscribeToLookup(lookup, opts.signal)
      })

      images.forEach(({ part }, index) => {
        delete part.image_url
        part.type = 'text'
        part.text = `[图片理解结果 ${index + 1}]\n${texts[index]}`
      })

      // 替换后若某条消息的 content 全是 text 块，合并成单个字符串，对 DeepSeek 更稳。
      for (const message of parsed.messages) {
        if (!isRecord(message) || !Array.isArray(message.content)) continue
        const allText = message.content.every(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
        if (allText) {
          message.content = (message.content as Array<Record<string, unknown>>).map(part => String(part.text)).join('\n\n')
        }
      }

      // 结构化二次确认：输出里绝不能残留任何 image_url 内容块(不用子串匹配，避免误伤正常文本)。
      const stillHasImageUrl = parsed.messages.some(message =>
        isRecord(message) && Array.isArray(message.content) && message.content.some(
          part => isRecord(part) && (part.type === 'image_url' || 'image_url' in part),
        ))
      if (stillHasImageUrl) {
        throw new VisionBridgeError(502, '图片处理失败，请稍后重试')
      }

      return {
        body: JSON.stringify(parsed),
        metrics: { visionBridgeMs: elapsed(started), cacheHits, imageCount: images.length },
      }
    },
  }
}

// ── 内部实现 ──────────────────────────────────────────────────────────

/** 简单有界并发 map：同时最多 limit 个 fn 在执行。用于让单个请求不再用 Promise.all 一次性把
 *  所有图片都扔给全局视觉信号量抢槽(会让一个多图请求独占全局并发、饿死同时到达的其它请求)。
 *  结果按原始下标写回，顺序与输入一致；某一项失败时不取消其它 worker，行为与原先的 Promise.all
 *  语义一致(第一个失败即让整体 reject，其它已发起的调用仍在各自的 worker 里跑完/失败)。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

const DATA_URI_PATTERN = /^data:([^;,]*)(;charset=[^;,]+)?(;base64)?,(.*)$/s

/** 解析单张图片的字节来源：data: URI 解码出真实字节做哈希+大小校验；http(s) URL 字节未知，
 *  仅按 URL 文本本身做缓存 key(交给 MiMo 自行拉取，不在网关侧对任意外部 URL 发起请求)。 */
function decodeImageUrl(url: string, maxImageBytes: number): { hash: string; byteLength: number | null } {
  const match = DATA_URI_PATTERN.exec(url)
  if (match) {
    const isBase64 = Boolean(match[3])
    const payload = match[4] ?? ''
    if (isBase64) {
      let bytes: Buffer
      try {
        bytes = Buffer.from(payload, 'base64')
      } catch {
        throw new VisionBridgeError(400, '图片数据格式不合法')
      }
      if (bytes.length === 0) throw new VisionBridgeError(400, '图片数据为空')
      if (bytes.length > maxImageBytes) throw new VisionBridgeError(413, '单张图片体积超过上限')
      return { hash: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }
    }
    const byteLength = Buffer.byteLength(payload, 'utf8')
    if (byteLength === 0) throw new VisionBridgeError(400, '图片数据为空')
    if (byteLength > maxImageBytes) throw new VisionBridgeError(413, '单张图片体积超过上限')
    return { hash: createHash('sha256').update(payload, 'utf8').digest('hex'), byteLength }
  }
  if (/^https?:\/\//i.test(url)) {
    return { hash: createHash('sha256').update(url).digest('hex'), byteLength: null }
  }
  throw new VisionBridgeError(400, '不支持的图片 URL 格式')
}

async function callMimoVision(
  deps: VisionBridgeDeps,
  url: string,
  identity: { schedulerId?: string; tokenId?: string },
  externalSignal?: AbortSignal,
): Promise<string> {
  let permit: CapacityPermit | undefined
  const controller = new AbortController()
  let timedOut = false
  const abortForNoSubscribers = () => controller.abort()
  if (externalSignal?.aborted) abortForNoSubscribers()
  else externalSignal?.addEventListener('abort', abortForNoSubscribers, { once: true })
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, deps.caps.visionTimeoutMs)
  try {
    if (controller.signal.aborted) throw new VisionBridgeError(499, '请求已取消')
    if (deps.mimoRateLimiter) {
      await deps.mimoRateLimiter.acquire(
        Math.max(0, deps.mimoRateLimitMaxWaitSeconds ?? deps.caps.queueMaxWaitMs / 1000),
        controller.signal,
      )
    }
    if (controller.signal.aborted) throw new VisionBridgeError(499, '请求已取消')
    if (deps.mimoCapacity) {
      permit = await deps.mimoCapacity.acquire(identity.schedulerId ?? 'vision', {
        maxWaitMs: deps.caps.queueMaxWaitMs,
        signal: controller.signal,
        tokenId: identity.tokenId ?? identity.schedulerId ?? 'vision',
      })
    }
    if (controller.signal.aborted) throw new VisionBridgeError(499, '请求已取消')
    const body = JSON.stringify({
      model: 'mimo-v2.5',
      stream: false,
      thinking: { type: 'disabled' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url } },
        ],
      }],
    })
    const { response } = await fetchMimoWithRetry(async () => {
      return await deps.fetchImpl(`${deps.mimoBase}/chat/completions`, {
        method: 'POST',
        body,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${deps.mimoKey}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'identity',
        },
      })
    }, {
      maxRetries: MIMO_VISION_RETRY_MAX,
      baseDelayMs: MIMO_VISION_RETRY_BASE_MS,
      maxDelayMs: MIMO_VISION_RETRY_MAX_MS,
      signal: controller.signal,
    })

    if (controller.signal.aborted) throw new VisionBridgeError(timedOut ? 504 : 499, timedOut ? '图片理解超时，请稍后重试' : '请求已取消')

    if (!response.ok) {
      await response.text().catch(() => '')
      if (response.status === 429) throw new VisionBridgeError(429, '图片理解服务繁忙，请稍后重试')
      throw new VisionBridgeError(502, '图片理解服务暂时不可用，请稍后重试')
    }

    let data: unknown
    try {
      data = await response.json()
    } catch {
      throw new VisionBridgeError(502, '图片理解服务返回异常，请稍后重试')
    }
    const content = extractVisionText(data)
    if (!content) throw new VisionBridgeError(502, '图片理解结果为空，请稍后重试')
    return content
  } catch (error) {
    if (error instanceof VisionBridgeError) throw error
    if (error instanceof CapacityQueueError) {
      throw new VisionBridgeError(error.status, error.status === 499 ? '请求已取消' : '图片理解服务繁忙，请稍后重试')
    }
    if (hasPublicStatus(error)) {
      if (error.status === 499) throw new VisionBridgeError(499, '请求已取消')
      if (error.status === 429) throw new VisionBridgeError(429, '图片理解服务繁忙，请稍后重试')
    }
    if (isAbortError(error)) {
      throw timedOut
        ? new VisionBridgeError(504, '图片理解超时，请稍后重试')
        : new VisionBridgeError(499, '请求已取消')
    }
    throw new VisionBridgeError(502, '图片理解服务暂时不可用，请稍后重试')
  } finally {
    permit?.release()
    clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abortForNoSubscribers)
  }
}

/** A requester may leave a shared image lookup without cancelling it for every other
 * requester. Both branches are attached to the shared promise, so a later rejection is
 * still observed after this requester has already returned 499. */
function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new VisionBridgeError(499, '请求已取消'))
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = () => finish(() => reject(new VisionBridgeError(499, '请求已取消')))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

function extractVisionText(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  const choices = data.choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (!isRecord(first) || !isRecord(first.message)) return undefined
  const content = first.message.content
  if (typeof content !== 'string') return undefined
  const trimmed = content.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function hasPublicStatus(error: unknown): error is { status: number } {
  return typeof error === 'object' && error !== null && typeof (error as { status?: unknown }).status === 'number'
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function elapsed(started: number): number {
  return Math.trunc(performance.now() - started)
}

/** 进程内存缓存：key = sha256(图片字节或 URL) + promptVersion，value = 视觉文本 + 过期时间。
 *  按写入顺序做 FIFO 淘汰(Map 保留插入顺序)，绝不落盘，只存哈希 key + 文本(不存图片字节)。 */
export class DefaultVisionCache implements VisionCache {
  private readonly entries = new Map<string, { text: string; expiresAt: number }>()

  constructor(private readonly maxEntries: number, private readonly ttlMs: number) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key)
      return undefined
    }
    return entry.text
  }

  set(key: string, text: string): void {
    if (this.entries.has(key)) this.entries.delete(key)
    this.entries.set(key, { text, expiresAt: Date.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
    }
  }
}

export interface VisionSemaphoreSnapshot {
  active: number
  queued: number
  limit: number
  queueMax: number
  perClientConc: number
  oldestQueueMs: number
}

/** 小信号量：约束全局在途 MiMo 视觉调用数，防图片请求打爆 MiMo 账号。
 *  队列本身也有硬上限(queueMax，默认不限——生产环境由调用方显式传入一个有限值)：排满后
 *  新来的等待者不入队、不占位，立即 429。已入队的等待者仍按 queueMaxWaitMs 短暂排队后超时
 *  失败关闭(不引入长排队)，也会响应调用方传入的 AbortSignal：客户端取消时立即出队+拒绝，
 *  不用等到超时。grant / timeout / abort 三条结算路径通过每个等待者自己的 settled 标志互斥，
 *  只会有一条真正生效，避免重复 resolve/reject 或 active 计数被重复增减。 */
export class VisionSemaphore {
  private active = 0
  private readonly activeByClient = new Map<string, number>()
  // A bounded global queue also needs a bounded contribution from every real desktop.
  // Otherwise one user's five windows can fill all 24 waiting entries before the next
  // installation is even considered, defeating per-client fairness at low MiMo limits.
  private readonly queuedByClient = new Map<string, number>()
  private readonly queue: Array<{ clientId: string; grant: () => void; queuedAt: number }> = []

  constructor(
    private readonly limit: number,
    private readonly queueMaxWaitMs: number,
    private readonly queueMax: number = Infinity,
    private readonly perClientConc: number = Infinity,
  ) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal, clientId = ''): Promise<T> {
    await this.acquire(signal, clientId)
    try {
      return await fn()
    } finally {
      this.release(clientId)
    }
  }

  /** 供测试/可观测性用：当前在途数、排队数、并发上限、队列上限。 */
  snapshot(): VisionSemaphoreSnapshot {
    const oldestQueuedAt = this.queue[0]?.queuedAt
    return {
      active: this.active,
      queued: this.queue.length,
      limit: this.limit,
      queueMax: this.queueMax,
      perClientConc: this.perClientConc,
      oldestQueueMs: oldestQueuedAt === undefined ? 0 : Math.max(0, Math.trunc(performance.now() - oldestQueuedAt)),
    }
  }

  private canStart(clientId: string): boolean {
    return this.active < this.limit && (this.activeByClient.get(clientId) ?? 0) < this.perClientConc
  }

  private canQueue(clientId: string): boolean {
    // Unit-level callers without an installation id preserve the generic semaphore
    // behavior. Gateway calls always have a trusted schedulerId. Divide a finite queue
    // across its active slots: the default 24/12 allows two waiting turns per desktop,
    // while an explicit 450/50 canary can still accept five windows per desktop.
    const maxPerClient = this.queueMax === Infinity ? Infinity : Math.max(1, Math.floor(this.queueMax / this.limit))
    return clientId === '' || (this.queuedByClient.get(clientId) ?? 0) < maxPerClient
  }

  private trackQueued(clientId: string): void {
    if (clientId === '') return
    this.queuedByClient.set(clientId, (this.queuedByClient.get(clientId) ?? 0) + 1)
  }

  private untrackQueued(clientId: string): void {
    if (clientId === '') return
    const next = Math.max(0, (this.queuedByClient.get(clientId) ?? 1) - 1)
    if (next === 0) this.queuedByClient.delete(clientId)
    else this.queuedByClient.set(clientId, next)
  }

  private grant(clientId: string): void {
    this.active += 1
    this.activeByClient.set(clientId, (this.activeByClient.get(clientId) ?? 0) + 1)
  }

  private acquire(signal: AbortSignal | undefined, clientId: string): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new VisionBridgeError(499, '请求已取消'))
    }
    // Preserve queued request fairness: a newly arrived client cannot leapfrog an
    // existing waiter merely because a different client is at its per-client cap.
    if (this.queue.length === 0 && this.canStart(clientId)) {
      this.grant(clientId)
      return Promise.resolve()
    }
    if (this.queue.length >= this.queueMax) {
      // 队列已满：不入队、不占位，立即拒绝，不让等待队伍无界增长。
      return Promise.reject(new VisionBridgeError(429, '图片理解并发已满，请稍后重试'))
    }
    if (!this.canQueue(clientId)) {
      return Promise.reject(new VisionBridgeError(429, '图片理解并发已满，请稍后重试'))
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>
      const entry: { clientId: string; grant: () => void; queuedAt: number } = {
        clientId,
        grant: () => {},
        queuedAt: performance.now(),
      }
      const removeFromQueue = () => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) {
          this.queue.splice(index, 1)
          this.untrackQueued(entry.clientId)
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        if (settled) return
        settled = true
        removeFromQueue()
        cleanup()
        reject(new VisionBridgeError(499, '请求已取消'))
        this.drain()
      }
      entry.grant = () => {
        if (settled) return
        settled = true
        cleanup()
        this.grant(clientId)
        resolve()
      }
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        removeFromQueue()
        cleanup()
        reject(new VisionBridgeError(429, '图片理解并发已满，请稍后重试'))
        this.drain()
      }, this.queueMaxWaitMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
      this.trackQueued(clientId)
      this.drain()
    })
  }

  private release(clientId: string): void {
    this.active = Math.max(0, this.active - 1)
    const nextClientActive = Math.max(0, (this.activeByClient.get(clientId) ?? 1) - 1)
    if (nextClientActive === 0) this.activeByClient.delete(clientId)
    else this.activeByClient.set(clientId, nextClientActive)
    this.drain()
  }

  private drain(): void {
    while (this.active < this.limit) {
      const nextIndex = this.queue.findIndex(entry => this.canStart(entry.clientId))
      if (nextIndex < 0) return
      const [next] = this.queue.splice(nextIndex, 1)
      if (next) this.untrackQueued(next.clientId)
      next?.grant()
    }
  }
}
