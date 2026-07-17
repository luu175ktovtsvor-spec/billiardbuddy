import { createHash } from 'node:crypto'
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

// 视觉桥接并发信号量的排队等待窗口：必须"短暂排队后失败关闭"，不能引入长排队拖垮整体时延。
const VISION_QUEUE_MAX_WAIT_MS = 3000

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
  /** 视觉理解文本缓存的最大条目数，超出按写入顺序(FIFO)淘汰。 */
  cacheMax: number
  /** 视觉理解文本缓存的存活时间(毫秒)。 */
  cacheTtlMs: number
}

export interface VisionCache {
  get(key: string): string | undefined
  set(key: string, text: string): void
}

export interface VisionBridgeDeps {
  mimoBase: string
  mimoKey: string
  fetchImpl: FetchLike
  caps: VisionBridgeCaps
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
  transform(rawBody: string, opts: { signal?: AbortSignal }): Promise<{ body: string; metrics: VisionBridgeMetrics }>
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
    cacheMax: Math.max(1, Math.floor(deps.caps.cacheMax)),
    cacheTtlMs: Math.max(1, Math.floor(deps.caps.cacheTtlMs)),
  }
  const cache = deps.cache ?? new DefaultVisionCache(caps.cacheMax, caps.cacheTtlMs)
  const semaphore = new VisionSemaphore(caps.maxConcurrent, VISION_QUEUE_MAX_WAIT_MS)

  return {
    async transform(rawBody, opts) {
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
      const pendingByKey = new Map<string, Promise<string>>()
      const texts = await Promise.all(images.map(async ({ url }, index) => {
        const cacheKey = `${decoded[index]!.hash}:${VISION_PROMPT_VERSION}`
        const cached = cache.get(cacheKey)
        if (cached !== undefined) {
          cacheHits += 1
          return cached
        }
        // 同一请求内的重复图片只发起一次 MiMo 调用(按哈希去重共享同一个 in-flight promise)。
        let pending = pendingByKey.get(cacheKey)
        if (!pending) {
          pending = semaphore.run(() => callMimoVision(deps, url, opts.signal)).then(text => {
            cache.set(cacheKey, text)
            return text
          })
          pendingByKey.set(cacheKey, pending)
        }
        return pending
      }))

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

async function callMimoVision(deps: VisionBridgeDeps, url: string, signal: AbortSignal | undefined): Promise<string> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, deps.caps.visionTimeoutMs)
  const onOuterAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
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
    if (isAbortError(error)) {
      throw timedOut
        ? new VisionBridgeError(504, '图片理解超时，请稍后重试')
        : new VisionBridgeError(499, '请求已取消')
    }
    throw new VisionBridgeError(502, '图片理解服务暂时不可用，请稍后重试')
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onOuterAbort)
  }
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

/** 小信号量：约束全局在途 MiMo 视觉调用数，防图片请求打爆 MiMo 账号。满了短暂排队(见
 *  VISION_QUEUE_MAX_WAIT_MS)后失败关闭，不引入长排队。 */
export class VisionSemaphore {
  private active = 0
  private readonly queue: Array<{ grant: () => void; reject: (error: Error) => void }> = []

  constructor(private readonly limit: number, private readonly queueMaxWaitMs: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire()
    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const entry = {
        grant: () => { this.active += 1; resolve() },
        reject,
      }
      const timer = setTimeout(() => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(new VisionBridgeError(429, '图片理解并发已满，请稍后重试'))
      }, this.queueMaxWaitMs)
      // 包一层，成功授予时清掉排队超时计时器。
      const original = entry.grant
      entry.grant = () => { clearTimeout(timer); original() }
      this.queue.push(entry)
    })
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1)
    const next = this.queue.shift()
    if (next) next.grant()
  }
}
