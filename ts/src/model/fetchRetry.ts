/**
 * 模型调用瞬时错误重试(移植 cc-haha `src/services/api/withRetry.ts` 的核心退避语义,
 * 去掉 OAuth/AWS/GCP 等 Anthropic 官方专属分支)。
 *
 * 背景:本项目走国内网关/代理链路,429/5xx/连接闪断这类瞬时抖动概率不低。旧实现里
 * ProxyModel/AnthropicMessagesModel 单次 fetch 失败就抛错、整轮判败,FallbackModel 还会因此
 * 误切出口。本模块对**可重试**的失败做指数退避重试(尊重 Retry-After),重试耗尽后再抛错交给
 * FallbackModel 做真正的跨供应商切换。
 *
 * 只包在"发请求 + 检查响应状态"这一层(消费流式 body 之前),因此重试不会破坏已开始读取的流。
 */

export interface ModelRetryOptions {
  /** 最多重试次数(不含首次尝试),默认 3。 */
  maxRetries?: number
  /** 指数退避基数(ms),默认 500 → 500/1000/2000。 */
  baseDelayMs?: number
  /** 退避上限(ms),默认 8000。 */
  maxDelayMs?: number
  /** 可注入的 sleep(测试传 no-op 免真等待);默认 setTimeout。 */
  sleep?: (ms: number) => Promise<void>
  /** 中止信号:已中止不再重试。 */
  signal?: AbortSignal
}

const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BASE_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 8000

/** 408 超时 / 429 限流 / 5xx 服务端错误可重试;4xx(除 408/429)是请求本身问题,不重试。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

function backoffMs(attempt: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** attempt)
}

/** 只支持数字秒形式的 Retry-After(常见场景);HTTP-date 形式罕见、不处理。上限 60s。 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const secs = Number(header.trim())
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000)
  return undefined
}

/** 抛错里属于"用户中止 / 超时"的不重试(超时再重试只会叠加更长等待);其余(连接重置/DNS 等)按网络抖动重试。 */
function isNonRetryableThrow(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true
    if (err.message.includes('中断') || err.message.includes('超时')) return true
  }
  return false
}

export async function fetchWithModelRetry(
  doRequest: () => Promise<Response>,
  opts: ModelRetryOptions = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const max = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw new Error('模型请求已中断')

    let resp: Response
    try {
      resp = await doRequest()
    } catch (err) {
      if (attempt >= maxRetries || opts.signal?.aborted || isNonRetryableThrow(err)) throw err
      await sleep(backoffMs(attempt, base, max))
      continue
    }

    if (resp.ok || attempt >= maxRetries || !isRetryableStatus(resp.status)) return resp

    const retryAfterMs = parseRetryAfterMs(resp.headers.get('retry-after'))
    // 丢弃错误响应体,避免连接/句柄泄露(重试会重新发请求)。
    try {
      await resp.body?.cancel()
    } catch {
      // 忽略:body 可能已被消费或不可取消
    }
    await sleep(retryAfterMs ?? backoffMs(attempt, base, max))
  }
}
