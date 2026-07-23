/**
 * Controlled real-upstream gateway load test.
 *
 * This intentionally has no default target and refuses to send traffic unless
 * `--execute` is present. Keep the bearer token in the process environment;
 * this program never prints it, response text, or request bodies.
 *
 * Example on the gateway host (the token should be populated locally there):
 *   QF_LOADTEST_URL=http://127.0.0.1:8799 \
 *   QF_LOADTEST_TOKEN=... \
 *   QF_LOADTEST_CONSENT_RECEIPT=... \
 *   bun gateway/real-loadtest.ts --execute --users=100 --windows=10 \
 *     --phases=1000,800,600,400,200,100 --scenario=stream --thinking=enabled
 */

type Capacity = {
  active?: number
  queued?: number
  oldestQueueMs?: number
}

type GatewayHealth = {
  capacity?: { deepseek?: Capacity; mimo?: Capacity }
}

type Sample = {
  status: number
  firstByteMs: number | null
  totalMs: number
  /** Metadata only: whether streamed bytes included the reasoning_content field. */
  sawReasoning: boolean
  /** A 2xx response is not enough: the test request must finish its SSE protocol. */
  completed: boolean
  failureKind?: 'timeout' | 'network' | 'unexpected_content_type' | 'empty_stream' | 'incomplete_sse'
}

const PROVIDER_GATEWAY_PROTOCOL = 'bb-provider-gateway/1.0'

export type ThinkingMode = 'enabled' | 'disabled'

/**
 * `phase` means that a phase must observe every request as active at least once.
 * A numeric value is capped at the current phase size so one high threshold can
 * be reused safely while the runner works downward.
 */
export type MinimumObservedActive = 'phase' | number

/**
 * A two-stage barrier: every worker must be waiting before the caller can
 * release any request. This avoids treating task construction as a burst.
 */
export type ConcurrentStartGate = {
  readonly participantCount: number
  readonly arrivedCount: number
  readonly ready: boolean
  readonly released: boolean
  wait(): Promise<void>
  waitUntilReady(): Promise<void>
  release(): void
}

export type LoadTarget = {
  base: URL
  /** Used only to construct requests; never print this value. */
  baseUrl: string
  /** Safe to report in test metadata: it contains neither path nor credentials. */
  targetOrigin: string
}

type PhaseSummary = {
  requested: number
  succeeded: number
  failed: number
  statuses: Record<string, number>
  failureKinds: Record<string, number>
  firstByteMs: { p50: number | null; p95: number | null }
  totalMs: { p50: number | null; p95: number | null }
  responsesWithReasoning: number
  /** Observed through periodic /healthz samples and enforced as a lower bound. */
  observedGateway: { active: number; queued: number; oldestQueueMs: number; samples: number; unavailableSamples: number }
  launch: { participants: number; arrived: number; released: boolean }
  minimumObservedActive: { configured: MinimumObservedActive; required: number; met: boolean }
  maximumObservedQueued: { configured: number; met: boolean }
  finalGateway: Capacity | null
  drained: boolean
}

function usage(exitCode = 2): never {
  console.error(`Usage:
  QF_LOADTEST_URL=https://gateway.example/gw \\
  QF_LOADTEST_TOKEN=<app-token> \\
  QF_LOADTEST_CONSENT_RECEIPT=<64-hex-consent-receipt> \\
  bun gateway/real-loadtest.ts --execute [options]

Options:
  --users=<n>                 Simulated installation count (default: 100)
  --windows=<n>               Concurrent windows per installation (default: 10)
  --phases=a,b,c              Concurrent request steps, highest first by default
  --scenario=short|stream     "short" asks for OK; "stream" asks for a short numbered stream
  --max-tokens=<n>            Upstream max_tokens per request (default: 64)
  --thinking=enabled|disabled DeepSeek thinking mode (default: enabled)
  --pool=deepseek|mimo        Capacity pool sampled from /healthz (auto from model)
  --timeout-ms=<n>            Per-request deadline (default: 180000)
  --health-interval-ms=<n>    Health sampling interval (default: 100)
  --health-timeout-ms=<n>     Bound each /healthz sample (default: 1000)
  --min-observed-active=phase|n
                              Required /healthz active peak (default: phase request count).
                              0 is smoke-test only and cannot prove concurrent capacity.
  --max-observed-queued=<n>   Largest acceptable /healthz queued peak (default: 0).
  --pause-ms=<n>              Cool-down between successful steps (default: 2500)
  --drain-timeout-ms=<n>      Wait for the sampled pool to drain (default: request timeout)
  --stop-after-failure        Stop after a phase has an HTTP or incomplete-SSE failure
  --continue-after-failure    Deprecated compatibility alias; high-to-low continues by default
  --use-server-app-token      Gateway-host only: read its app token solely for
                               http://127.0.0.1:8799 (never an external URL)

The runner uses controlled X-QF-Client-ID values so a 100×10 phase models ten
windows per installation, reads every SSE body to completion, and requires a
terminal data: [DONE] event for success. It reports only status/timing/capacity
metadata; it never logs tokens, request bodies, or model output.`)
  process.exit(exitCode)
}

function integer(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function option(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

/**
 * Defaulting to every request in the phase makes a passing production-capacity
 * result evidence of an observed burst rather than merely fast serial responses.
 * Use zero only for a deliberately non-capacity smoke test.
 */
export function parseMinimumObservedActive(value: string | undefined, total: number): MinimumObservedActive {
  if (value === undefined || value === 'phase') return 'phase'
  if (!/^\d+$/.test(value)) throw new Error('--min-observed-active must be phase or a non-negative integer')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > total) {
    throw new Error(`--min-observed-active must be between 0 and ${total}`)
  }
  return parsed
}

export function requiredMinimumObservedActive(configured: MinimumObservedActive, requested: number): number {
  return configured === 'phase' ? requested : Math.min(configured, requested)
}

/** A capacity pass is queue-free by default, matching the interactive UX target. */
export function parseMaximumObservedQueued(value: string | undefined, total: number): number {
  if (value === undefined) return 0
  if (!/^\d+$/.test(value)) throw new Error('--max-observed-queued must be a non-negative integer')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > total) {
    throw new Error(`--max-observed-queued must be between 0 and ${total}`)
  }
  return parsed
}

/**
 * The caller constructs every worker first, waits for all of them to arrive,
 * then releases them in the same event-loop turn. Timers begin after release,
 * so staging at the barrier cannot manufacture request timeouts.
 */
export function createConcurrentStartGate(participantCount: number): ConcurrentStartGate {
  if (!Number.isSafeInteger(participantCount) || participantCount < 1) {
    throw new Error('concurrent start gate requires at least one participant')
  }

  let arrivedCount = 0
  let released = false
  let resolveReady: (() => void) | undefined
  let resolveRelease: (() => void) | undefined
  const readyPromise = new Promise<void>(resolve => { resolveReady = resolve })
  const releasePromise = new Promise<void>(resolve => { resolveRelease = resolve })

  return {
    participantCount,
    get arrivedCount() { return arrivedCount },
    get ready() { return arrivedCount === participantCount },
    get released() { return released },
    async wait(): Promise<void> {
      if (released) throw new Error('concurrent start gate cannot admit workers after release')
      arrivedCount += 1
      if (arrivedCount > participantCount) throw new Error('concurrent start gate received too many workers')
      if (arrivedCount === participantCount) resolveReady?.()
      await releasePromise
    },
    waitUntilReady(): Promise<void> {
      return readyPromise
    },
    release(): void {
      if (released) throw new Error('concurrent start gate was already released')
      if (arrivedCount !== participantCount) {
        throw new Error(`concurrent start gate is not ready (${arrivedCount}/${participantCount})`)
      }
      released = true
      resolveRelease?.()
    },
  }
}

/** Keep test traffic on the two documented DeepSeek spellings. */
export function parseThinkingMode(value: string | undefined): ThinkingMode | undefined {
  if (value === undefined) return undefined
  if (value === 'enabled' || value === 'disabled') return value
  throw new Error('--thinking must be enabled or disabled')
}

/** Production desktop tasks default to deep thinking; real capacity tests must match. */
export function resolveLoadtestThinkingMode(value: string | undefined): ThinkingMode {
  return parseThinkingMode(value) ?? 'enabled'
}

/** Deliberately inspect only the protocol field name, never a reasoning value. */
export function sawReasoningInSse(text: string): boolean {
  return text.includes('"reasoning_content"')
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  return Math.round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]!)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function nonNegative(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : 0
}

/** A missing or too-small health observation must fail a capacity phase. */
export function meetsMinimumObservedActive(peakActive: number, requiredActive: number): boolean {
  return nonNegative(peakActive) >= requiredActive
}

export function meetsMaximumObservedQueued(peakQueued: number, maximumQueued: number): boolean {
  return nonNegative(peakQueued) <= maximumQueued
}

function recordCount(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

export function parsePhases(raw: string | undefined, total: number): number[] {
  // The first real probe must answer the user's actual capacity question instead of
  // normalizing a server with an easy warm-up. If it fails, the following lower phases
  // identify a usable ceiling in the same invocation.
  const defaults = [total, 800, 600, 400, 200, 100, 50, 20, 1].filter(phase => phase <= total)
  const candidates = raw === undefined
    ? defaults
    : raw.split(',').map(value => integer(value.trim(), '--phases', 0))
  const phases = [...new Set(candidates)].sort((a, b) => b - a)
  if (phases.length === 0 || phases.some(phase => phase > total)) {
    throw new Error(`--phases must contain values from 1 through ${total}`)
  }
  return phases
}

export function isCapacityDrained(snapshot: Capacity | null): boolean {
  return snapshot !== null && nonNegative(snapshot.active) === 0 && nonNegative(snapshot.queued) === 0
}

/** High-to-low continuation is default; an explicit safety stop always wins. */
export function shouldContinueAfterFailure(args: readonly string[]): boolean {
  return !args.includes('--stop-after-failure')
}

function isHttpLoopback(url: URL): boolean {
  if (url.protocol !== 'http:') return false
  const host = url.hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]' || host === '::1') return true
  const octets = host.split('.')
  return octets.length === 4
    && octets[0] === '127'
    && octets.every(octet => /^\d+$/.test(octet) && Number(octet) <= 255)
}

function isGatewayLoopback(url: URL): boolean {
  return isHttpLoopback(url)
    && url.port === '8799'
    && url.pathname === '/'
}

/**
 * An app token may be supplied to this runner, so an accidental plaintext
 * external endpoint or URL-embedded secret is not acceptable. Keep the
 * request path private as well: callers get only targetOrigin in the summary.
 */
export function parseLoadTarget(raw: string): LoadTarget {
  let base: URL
  try {
    base = new URL(raw)
  } catch {
    throw new Error('QF_LOADTEST_URL must be an absolute HTTP(S) URL')
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('QF_LOADTEST_URL must be an absolute HTTP(S) URL')
  }
  if (base.username || base.password || base.search || base.hash || raw.includes('?') || raw.includes('#')) {
    throw new Error('QF_LOADTEST_URL must not include credentials, a query, or a fragment')
  }
  if (base.protocol === 'http:' && !isHttpLoopback(base)) {
    throw new Error('QF_LOADTEST_URL requires HTTPS unless it is a loopback HTTP target')
  }
  const path = base.pathname.replace(/\/+$/, '')
  return {
    base,
    baseUrl: `${base.origin}${path === '/' ? '' : path}`,
    targetOrigin: base.origin,
  }
}

export function isSseContentType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream'
}

/**
 * Bounded incremental parser for the one terminal SSE event we need. It never
 * retains model output beyond one event-sized buffer and accepts only an exact
 * `data: [DONE]` line framed by an SSE blank-line event boundary.
 */
export class SseTerminalDetector {
  private static readonly maxBufferedChars = 64 * 1024
  private buffered = ''
  private sawDone = false
  private sawEventAfterDone = false
  private overflowed = false

  push(text: string): void {
    if (!text) return
    this.buffered += text
    if (this.buffered.length > SseTerminalDetector.maxBufferedChars) {
      this.overflowed = true
      this.buffered = this.buffered.slice(-SseTerminalDetector.maxBufferedChars)
    }

    while (true) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(this.buffered)
      if (!boundary || boundary.index === undefined) return
      const event = this.buffered.slice(0, boundary.index)
      this.buffered = this.buffered.slice(boundary.index + boundary[0].length)
      if (!event) continue
      if (this.sawDone) {
        this.sawEventAfterDone = true
        continue
      }
      const dataLines = event.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:'))
      if (dataLines.length === 1 && dataLines[0] === 'data: [DONE]') this.sawDone = true
    }
  }

  hasTerminalDone(): boolean {
    return this.sawDone
      && !this.sawEventAfterDone
      && !this.overflowed
      && this.buffered.trim().length === 0
  }
}

/**
 * This is deliberately narrower than a generic token-file option. It is usable only
 * on the qfgw host and only after `isGatewayLoopback` rejects every external target,
 * so a production app token cannot accidentally be sent to an arbitrary URL.
 */
async function loadLocalGatewayAppToken(): Promise<string> {
  const raw = await Bun.file('/opt/qfgw/gw.env').text()
  const line = raw.split(/\r?\n/).find(value => value.startsWith('GW_APP_TOKENS='))
  if (!line) throw new Error('qfgw app-token map is unavailable')
  let encoded = line.slice('GW_APP_TOKENS='.length).trim()
  if (encoded.startsWith("'") && encoded.endsWith("'")) encoded = encoded.slice(1, -1)
  else if (encoded.startsWith('"') && encoded.endsWith('"')) {
    try {
      const decoded = JSON.parse(encoded)
      if (typeof decoded !== 'string') throw new Error('not a string')
      encoded = decoded
    } catch {
      throw new Error('qfgw app-token map is unavailable')
    }
  }
  let tokens: unknown
  try {
    tokens = JSON.parse(encoded)
  } catch {
    throw new Error('qfgw app-token map is unavailable')
  }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new Error('qfgw app-token map is unavailable')
  }
  const token = Object.keys(tokens).find(value => value.length > 0)
  if (!token) throw new Error('qfgw app-token map is unavailable')
  return token
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) usage(0)
  if (!args.includes('--execute')) {
    console.error('Refusing to send real upstream traffic without --execute.')
    usage()
  }

  const rawBaseUrl = process.env.QF_LOADTEST_URL?.trim()
  if (!rawBaseUrl) throw new Error('QF_LOADTEST_URL is required with --execute')
  const { base, baseUrl, targetOrigin } = parseLoadTarget(rawBaseUrl)
  const useServerAppToken = args.includes('--use-server-app-token')
  if (useServerAppToken && !isGatewayLoopback(base)) {
    throw new Error('--use-server-app-token only permits http://127.0.0.1:8799')
  }
  const token = process.env.QF_LOADTEST_TOKEN?.trim()
    ?? (useServerAppToken ? await loadLocalGatewayAppToken() : undefined)
  if (!token) throw new Error('QF_LOADTEST_TOKEN is required with --execute')
  const consentReceiptId = process.env.QF_LOADTEST_CONSENT_RECEIPT?.trim() ?? ''
  if (!/^[a-f0-9]{64}$/.test(consentReceiptId)) {
    throw new Error('QF_LOADTEST_CONSENT_RECEIPT must be a 64-character lowercase hex receipt')
  }

  const users = integer(option(args, '--users'), '--users', 100)
  const windows = integer(option(args, '--windows'), '--windows', 10)
  const maxTokens = integer(option(args, '--max-tokens'), '--max-tokens', 64)
  // Keep the caller deadline above a valid upstream stream even when an explicit
  // deployment uses a longer bounded queue. The current production default is much
  // shorter (15s), but the runner should not manufacture failures when auditing a
  // different safe profile.
  const timeoutMs = integer(option(args, '--timeout-ms'), '--timeout-ms', 180_000)
  const healthIntervalMs = integer(option(args, '--health-interval-ms'), '--health-interval-ms', 100)
  const healthTimeoutMs = integer(option(args, '--health-timeout-ms'), '--health-timeout-ms', 1_000)
  const pauseMs = integer(option(args, '--pause-ms'), '--pause-ms', 2_500)
  const drainTimeoutMs = integer(option(args, '--drain-timeout-ms'), '--drain-timeout-ms', timeoutMs)
  const scenario = option(args, '--scenario') ?? 'stream'
  if (scenario !== 'short' && scenario !== 'stream') throw new Error('--scenario must be short or stream')
  const thinking = resolveLoadtestThinkingMode(option(args, '--thinking'))
  const model = process.env.QF_LOADTEST_MODEL?.trim() || 'deepseek-v4-flash'
  const pool = option(args, '--pool') ?? (model.toLowerCase().startsWith('mimo') ? 'mimo' : 'deepseek')
  if (pool !== 'deepseek' && pool !== 'mimo') throw new Error('--pool must be deepseek or mimo')
  const total = users * windows
  if (!Number.isSafeInteger(total)) throw new Error('--users * --windows is too large')
  const phases = parsePhases(option(args, '--phases'), total)
  const minimumObservedActive = parseMinimumObservedActive(option(args, '--min-observed-active'), total)
  const maximumObservedQueued = parseMaximumObservedQueued(option(args, '--max-observed-queued'), total)
  // A high-to-low capacity run needs to continue after a failed upper bound in order
  // to locate the first viable lower bound. The explicit stop switch remains for
  // incident-style probes where any failure must halt traffic immediately.
  const continueAfterFailure = shouldContinueAfterFailure(args)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-BB-Data-Egress-Consent': consentReceiptId,
    'X-BB-Provider-Protocol': PROVIDER_GATEWAY_PROTOCOL,
  }
  const prompt = scenario === 'short'
    ? '请只回复 OK。'
    : `请逐行输出从 1 到 ${Math.min(maxTokens, 128)} 的整数，不要加任何解释。`

  async function health(): Promise<Capacity | null> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), healthTimeoutMs)
    try {
      const response = await fetch(`${baseUrl}/healthz`, {
        headers,
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) return null
      const body = await response.json() as GatewayHealth
      return body.capacity?.[pool] ?? null
    } catch {
      return null
    } finally {
      clearTimeout(timeout)
    }
  }

  async function waitForDrain(): Promise<{ snapshot: Capacity | null; drained: boolean }> {
    const deadline = performance.now() + drainTimeoutMs
    let snapshot = await health()
    while (!isCapacityDrained(snapshot) && performance.now() < deadline) {
      await sleep(Math.min(250, Math.max(1, deadline - performance.now())))
      snapshot = await health()
    }
    return { snapshot, drained: isCapacityDrained(snapshot) }
  }

  async function runOne(index: number, startGate: ConcurrentStartGate): Promise<Sample> {
    await startGate.wait()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()
    try {
      const installation = `capacity-${String(index % users).padStart(4, '0')}`
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'X-QF-Client-ID': installation },
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: maxTokens,
          ...(thinking ? { thinking: { type: thinking } } : {}),
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      let firstByteMs: number | null = null
      let sawChunk = false
      let sawReasoning = false
      const sse = new SseTerminalDetector()
      let reasoningTail = ''
      const hasSseContentType = isSseContentType(response.headers.get('content-type'))
      const decoder = new TextDecoder()
      const reader = response.body?.getReader()
      if (reader) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (next.value.byteLength === 0) continue
          sawChunk = true
          if (firstByteMs === null) firstByteMs = performance.now() - started
          const decoded = decoder.decode(next.value, { stream: true })
          if (sawReasoningInSse(`${reasoningTail}${decoded}`)) sawReasoning = true
          reasoningTail = `${reasoningTail}${decoded}`.slice(-64)
          if (hasSseContentType) sse.push(decoded)
        }
      }
      const finalText = decoder.decode()
      if (sawReasoningInSse(`${reasoningTail}${finalText}`)) sawReasoning = true
      if (hasSseContentType) sse.push(finalText)
      const completed = response.ok && hasSseContentType && sawChunk && sse.hasTerminalDone()
      return {
        status: response.status,
        firstByteMs: firstByteMs === null ? null : Math.round(firstByteMs),
        totalMs: Math.round(performance.now() - started),
        sawReasoning,
        completed,
        failureKind: completed || !response.ok
          ? undefined
          : !hasSseContentType ? 'unexpected_content_type' : sawChunk ? 'incomplete_sse' : 'empty_stream',
      }
    } catch {
      return {
        status: 0,
        firstByteMs: null,
        totalMs: Math.round(performance.now() - started),
        sawReasoning: false,
        completed: false,
        failureKind: controller.signal.aborted ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timeout)
    }
  }

  console.log(JSON.stringify({
    event: 'loadtest_start',
    targetOrigin,
    users,
    windows,
    phases,
    scenario,
    pool,
    maxTokens,
    thinking,
    minimumObservedActive,
    maximumObservedQueued,
  }))

  let highestSuccessfulPhase: number | null = null
  let observedFailure = false
  for (const requested of phases) {
    let monitor = true
    let peakActive = 0
    let peakQueued = 0
    let peakOldestQueueMs = 0
    let healthSamples = 0
    let unavailableHealthSamples = 0
    const observeHealth = (snapshot: Capacity | null) => {
      healthSamples += 1
      if (!snapshot) unavailableHealthSamples += 1
      peakActive = Math.max(peakActive, nonNegative(snapshot?.active))
      peakQueued = Math.max(peakQueued, nonNegative(snapshot?.queued))
      peakOldestQueueMs = Math.max(peakOldestQueueMs, nonNegative(snapshot?.oldestQueueMs))
    }
    // Establish the authenticated health path before the burst. Periodic samples
    // remain observations, not an exact concurrency proof for very short streams.
    observeHealth(await health())
    const monitorTask = (async () => {
      while (monitor) {
        const sampledAt = performance.now()
        observeHealth(await health())
        await sleep(Math.max(0, healthIntervalMs - (performance.now() - sampledAt)))
      }
    })()
    const startGate = createConcurrentStartGate(requested)
    const samplesTask = Promise.all(Array.from({ length: requested }, (_, index) => runOne(index, startGate)))
    await startGate.waitUntilReady()
    startGate.release()
    // Yield once after the synchronized release so the worker fetch calls enter
    // the runtime before this additional immediate health observation.
    await Promise.resolve()
    observeHealth(await health())
    const samples = await samplesTask
    monitor = false
    await monitorTask
    const drain = await waitForDrain()
    const finalGateway = drain.snapshot
    const statuses: Record<string, number> = {}
    const failureKinds: Record<string, number> = {}
    for (const sample of samples) {
      recordCount(statuses, String(sample.status))
      if (!sample.completed) recordCount(failureKinds, sample.failureKind ?? `http_${sample.status}`)
    }
    const firstBytes = samples.flatMap(sample => sample.firstByteMs === null ? [] : [sample.firstByteMs])
    const totals = samples.map(sample => sample.totalMs)
    const succeeded = samples.filter(sample => sample.completed).length
    const requiredActive = requiredMinimumObservedActive(minimumObservedActive, requested)
    const activeRequirementMet = meetsMinimumObservedActive(peakActive, requiredActive)
    const queueRequirementMet = meetsMaximumObservedQueued(peakQueued, maximumObservedQueued)
    const summary: PhaseSummary = {
      requested,
      succeeded,
      failed: requested - succeeded,
      statuses,
      failureKinds,
      firstByteMs: { p50: percentile(firstBytes, 0.5), p95: percentile(firstBytes, 0.95) },
      totalMs: { p50: percentile(totals, 0.5), p95: percentile(totals, 0.95) },
      responsesWithReasoning: samples.filter(sample => sample.completed && sample.sawReasoning).length,
      observedGateway: {
        active: peakActive,
        queued: peakQueued,
        oldestQueueMs: peakOldestQueueMs,
        samples: healthSamples,
        unavailableSamples: unavailableHealthSamples,
      },
      launch: {
        participants: startGate.participantCount,
        arrived: startGate.arrivedCount,
        released: startGate.released,
      },
      minimumObservedActive: {
        configured: minimumObservedActive,
        required: requiredActive,
        met: activeRequirementMet,
      },
      maximumObservedQueued: {
        configured: maximumObservedQueued,
        met: queueRequirementMet,
      },
      finalGateway,
      drained: drain.drained,
    }
    console.log(JSON.stringify({ event: 'loadtest_phase', ...summary }))
    const phasePassed = summary.failed === 0
      && summary.drained
      && summary.minimumObservedActive.met
      && summary.maximumObservedQueued.met
    if (phasePassed && highestSuccessfulPhase === null) highestSuccessfulPhase = requested
    if (!phasePassed) observedFailure = true
    if (!phasePassed && !continueAfterFailure) {
      console.error('Stopping after a failed phase because --stop-after-failure was supplied.')
      process.exitCode = 1
      return
    }
    if (requested !== phases.at(-1)) await sleep(pauseMs)
  }
  console.log(JSON.stringify({
    event: 'loadtest_result',
    requestedMaximum: phases[0] ?? 0,
    highestSuccessfulPhase,
    allPhasesSucceeded: !observedFailure,
  }))
  // Continuing downward maps a usable ceiling, but must not produce a successful
  // process result when any requested higher phase failed or leaked permits.
  if (observedFailure || highestSuccessfulPhase === null) process.exitCode = 1
}

if (import.meta.main) await main()
