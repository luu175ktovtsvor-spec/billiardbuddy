/**
 * Controlled paid-upstream test for the asynchronous image route.
 *
 * This is intentionally not an unlimited image benchmark. A real GPT Image task
 * may bill even when the caller later loses the response, so the runner defaults
 * to one task, requires --execute, and requires a second acknowledgement before
 * any batch. It polls only compact relay metadata, never image bytes.
 */

type FailureKind = 'timeout' | 'network' | 'response_too_large' | 'invalid_response' | `http_${number}`
type TerminalState = 'succeeded' | 'failed' | 'failed_unknown' | 'cancelled' | 'unknown'

type SubmittedTask = {
  taskId: string
  clientId: string
  acceptedAt: number
}

type SubmitResult = {
  status: number
  task?: SubmittedTask
  failureKind?: FailureKind
}

type CancelResult = {
  status: number
  failureKind?: FailureKind
}

type PollResult = {
  terminal: TerminalState
  elapsedMs: number
  failureKind?: FailureKind
}

export type ImageLoadtestPlan = {
  users: number
  windows: number
  total: number
}

export type ImageLoadtestOptions = ImageLoadtestPlan & {
  baseUrl: string
  targetOrigin: string
  token: string
  size: '1024x1024' | '1536x1024' | '1024x1536'
  submitTimeoutMs: number
  terminalTimeoutMs: number
  pollFloorMs: number
  pollRequestTimeoutMs: number
  submitConcurrency: number
}

export type ImageLoadtestSummary = {
  requested: number
  accepted: number
  succeeded: number
  failed: number
  exitCode: 0 | 1
  cleanupAttempted: number
}

type LoadTarget = { base: URL; baseUrl: string; targetOrigin: string }
type FetchLike = typeof fetch
type SleepLike = (ms: number, signal: AbortSignal) => Promise<boolean>
type RunnerDeps = {
  fetchImpl?: FetchLike
  now?: () => number
  sleepImpl?: SleepLike
  onEvent?: (event: Record<string, unknown>) => void
}
type JsonRead = { ok: true; value: unknown } | { ok: false; reason: 'response_too_large' | 'invalid_response' }
type FetchAttempt = { response: Response } | { failure: 'timeout' | 'network' | 'terminal_timeout' }

const MAX_USERS = 100
const MAX_WINDOWS = 8
const MAX_TASKS = MAX_USERS * MAX_WINDOWS
const MAX_SUBMIT_CONCURRENCY = 32
const MAX_METADATA_RESPONSE_BYTES = 64 * 1024
const IMAGE_SIZES = new Set(['1024x1024', '1536x1024', '1024x1536'])
const TERMINAL_STATES = new Set<TerminalState>(['succeeded', 'failed', 'failed_unknown', 'cancelled'])

function usage(exitCode = 2): never {
  console.error(`Usage:
  QF_LOADTEST_URL=http://127.0.0.1:8799 \\
  QF_LOADTEST_TOKEN=<app-token> \\
  bun gateway/image-real-loadtest.ts --execute [options]

Options:
  --users=<n>                 Simulated installations (default: 1, max: ${MAX_USERS})
  --windows=<n>               Image windows per installation (default: 1, max: ${MAX_WINDOWS})
  --confirm-billable-batch    Required whenever users × windows is greater than one
  --submit-concurrency=<n>    Bounded submit workers (default: 16, max: ${MAX_SUBMIT_CONCURRENCY})
  --size=<WxH>                1024x1024, 1536x1024, or 1024x1536 (default: 1024x1024)
  --submit-timeout-ms=<n>     Per-submit deadline (default: 30000)
  --terminal-timeout-ms=<n>   Per-task terminal-status deadline (default: 600000)
  --poll-floor-ms=<n>         Minimum poll delay, capped at 60000 (default: 5000)
  --poll-request-timeout-ms=<n>  Per-status-request deadline (default: 15000)
  --use-server-app-token      Gateway-host only: read its app token solely for
                               http://127.0.0.1:8799 (never an external URL)

The runner uses one X-QF-Client-ID per simulated installation, so --users=100
--windows=5 models five windows from each installation. It never logs app tokens,
task IDs, request bodies, image bytes, model output, or a target URL path/query.`)
  process.exit(exitCode)
}

function assertKnownArgs(args: string[]): void {
  const booleans = new Set(['--execute', '--confirm-billable-batch', '--use-server-app-token'])
  const values = [
    '--users',
    '--windows',
    '--submit-concurrency',
    '--size',
    '--submit-timeout-ms',
    '--terminal-timeout-ms',
    '--poll-floor-ms',
    '--poll-request-timeout-ms',
  ]
  for (const arg of args) {
    if (booleans.has(arg)) continue
    if (values.some(name => arg.startsWith(`${name}=`))) continue
    if (arg === '--tasks' || arg.startsWith('--tasks=')) {
      throw new Error('--tasks was replaced by --users and --windows')
    }
    throw new Error('unrecognized load-test option')
  }
}

function option(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  const matches = args.filter(arg => arg.startsWith(prefix))
  if (matches.length > 1) throw new Error(`${name} may be specified only once`)
  return matches[0]?.slice(prefix.length)
}

function integer(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`)
  return parsed
}

function boundedInteger(value: string | undefined, name: string, fallback: number, maximum: number): number {
  const parsed = integer(value, name, fallback)
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`)
  return parsed
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  return Math.round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]!)
}

function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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

/** Keep a supplied app token away from plaintext external or URL-embedded targets. */
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

export function createImageLoadtestPlan(users: number, windows: number, confirmedBatch: boolean): ImageLoadtestPlan {
  if (users > MAX_USERS) throw new Error(`--users must not exceed ${MAX_USERS}`)
  if (windows > MAX_WINDOWS) throw new Error(`--windows must not exceed ${MAX_WINDOWS}`)
  const total = users * windows
  if (!Number.isSafeInteger(total) || total > MAX_TASKS) throw new Error(`users × windows must not exceed ${MAX_TASKS}`)
  if (total > 1 && !confirmedBatch) {
    throw new Error('--confirm-billable-batch is required before creating more than one paid image task')
  }
  return { users, windows, total }
}

export function clientIdForTask(index: number, users: number): string {
  return `image-loadtest-user-${String(index % users).padStart(3, '0')}`
}

function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function pollDelayMs(value: unknown, floorMs: number): number {
  const seconds = asRecord(value)?.poll_after_seconds
  const suggested = typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.min(60_000, Math.max(0, Math.round(seconds * 1_000)))
    : floorMs
  return Math.min(60_000, Math.max(floorMs, suggested))
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Error/result bodies are deliberately never surfaced by this runner.
  }
}

async function readJsonBounded(response: Response): Promise<JsonRead> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_METADATA_RESPONSE_BYTES) {
    await cancelResponseBody(response)
    return { ok: false, reason: 'response_too_large' }
  }
  const reader = response.body?.getReader()
  if (!reader) return { ok: false, reason: 'invalid_response' }
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (length + next.value.byteLength > MAX_METADATA_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        return { ok: false, reason: 'response_too_large' }
      }
      length += next.value.byteLength
      chunks.push(next.value)
    }
  } catch {
    return { ok: false, reason: 'invalid_response' }
  } finally {
    reader.releaseLock()
  }
  try {
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) }
  } catch {
    return { ok: false, reason: 'invalid_response' }
  }
}

async function fetchAttempt(
  fetchImpl: FetchLike,
  input: string,
  init: RequestInit,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<FetchAttempt> {
  if (parentSignal?.aborted) return { failure: 'terminal_timeout' }
  const controller = new AbortController()
  let attemptTimedOut = false
  const abortForParent = () => controller.abort()
  parentSignal?.addEventListener('abort', abortForParent, { once: true })
  const timer = setTimeout(() => {
    attemptTimedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return { response: await fetchImpl(input, { ...init, signal: controller.signal }) }
  } catch {
    if (parentSignal?.aborted) return { failure: 'terminal_timeout' }
    return { failure: attemptTimedOut ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
    parentSignal?.removeEventListener('abort', abortForParent)
  }
}

async function sleepAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false
  return await new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => finish(false)
    const finish = (completed: boolean) => {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(completed)
    }
    timer = setTimeout(() => finish(true), ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) finish(false)
  })
}

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

async function submitTask(index: number, options: ImageLoadtestOptions, deps: Required<Pick<RunnerDeps, 'fetchImpl' | 'now'>>): Promise<SubmitResult> {
  const clientId = clientIdForTask(index, options.users)
  const attempt = await fetchAttempt(
    deps.fetchImpl,
    `${options.baseUrl}/v1/images/tasks`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.token}`,
        'Content-Type': 'application/json',
        'X-QF-Client-ID': clientId,
        'Idempotency-Key': `loadtest-${crypto.randomUUID()}-${index}`,
      },
      body: JSON.stringify({
        mode: 'generate',
        model: 'gpt-image-2',
        n: 1,
        size: options.size,
        prompt: 'A single blue circle centered on a plain white background. No text, no logo, no watermark.',
      }),
    },
    undefined,
    options.submitTimeoutMs,
  )
  if ('failure' in attempt) return { status: 0, failureKind: attempt.failure === 'terminal_timeout' ? 'timeout' : attempt.failure }
  const { response } = attempt
  if (response.status !== 202) {
    await cancelResponseBody(response)
    return { status: response.status, failureKind: `http_${response.status}` }
  }
  const body = await readJsonBounded(response)
  if (!body.ok) return { status: response.status, failureKind: body.reason }
  const taskId = asRecord(body.value)?.task_id
  if (!isTaskId(taskId)) return { status: response.status, failureKind: 'invalid_response' }
  return {
    status: response.status,
    task: { taskId, clientId, acceptedAt: deps.now() },
  }
}

async function cancelTask(task: SubmittedTask, options: ImageLoadtestOptions, fetchImpl: FetchLike): Promise<CancelResult> {
  const attempt = await fetchAttempt(
    fetchImpl,
    `${options.baseUrl}/v1/images/tasks/${encodeURIComponent(task.taskId)}/cancel`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.token}`, 'X-QF-Client-ID': task.clientId },
    },
    undefined,
    options.pollRequestTimeoutMs,
  )
  if ('failure' in attempt) return { status: 0, failureKind: attempt.failure === 'terminal_timeout' ? 'timeout' : attempt.failure }
  await cancelResponseBody(attempt.response)
  return attempt.response.ok
    ? { status: attempt.response.status }
    : { status: attempt.response.status, failureKind: `http_${attempt.response.status}` }
}

async function pollTask(
  task: SubmittedTask,
  options: ImageLoadtestOptions,
  deps: Required<Pick<RunnerDeps, 'fetchImpl' | 'now' | 'sleepImpl'>>,
): Promise<PollResult> {
  const remainingBudget = options.terminalTimeoutMs - Math.max(0, deps.now() - task.acceptedAt)
  if (remainingBudget <= 0) return { terminal: 'unknown', elapsedMs: Math.round(deps.now() - task.acceptedAt), failureKind: 'timeout' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), remainingBudget)
  const elapsed = () => Math.round(deps.now() - task.acceptedAt)
  try {
    while (!controller.signal.aborted) {
      const attempt = await fetchAttempt(
        deps.fetchImpl,
        `${options.baseUrl}/v1/images/tasks/${encodeURIComponent(task.taskId)}?metadata_only=1`,
        { headers: { Authorization: `Bearer ${options.token}`, 'X-QF-Client-ID': task.clientId } },
        controller.signal,
        options.pollRequestTimeoutMs,
      )
      if ('failure' in attempt) {
        if (attempt.failure === 'terminal_timeout') break
        if (!await deps.sleepImpl(options.pollFloorMs, controller.signal)) break
        continue
      }

      const { response } = attempt
      const body = await readJsonBounded(response)
      if (!response.ok) {
        const failureKind: FailureKind = `http_${response.status}`
        if (response.status !== 429 && response.status < 500) {
          return { terminal: 'unknown', elapsedMs: elapsed(), failureKind }
        }
        const delay = body.ok ? pollDelayMs(body.value, options.pollFloorMs) : options.pollFloorMs
        if (!await deps.sleepImpl(delay, controller.signal)) break
        continue
      }
      if (!body.ok) return { terminal: 'unknown', elapsedMs: elapsed(), failureKind: body.reason }
      const record = asRecord(body.value)
      const state = record?.status
      if (record?.metadata_only !== true || typeof state !== 'string') {
        return { terminal: 'unknown', elapsedMs: elapsed(), failureKind: 'invalid_response' }
      }
      if (state === 'succeeded') {
        const outputCount = record.output_count
        if (record.result_available !== true || typeof outputCount !== 'number' || !Number.isInteger(outputCount) || outputCount < 1) {
          return { terminal: 'unknown', elapsedMs: elapsed(), failureKind: 'invalid_response' }
        }
        return { terminal: 'succeeded', elapsedMs: elapsed() }
      }
      if (TERMINAL_STATES.has(state as TerminalState)) {
        return { terminal: state as TerminalState, elapsedMs: elapsed() }
      }
      if (state !== 'queued' && state !== 'running') {
        return { terminal: 'unknown', elapsedMs: elapsed(), failureKind: 'invalid_response' }
      }
      if (!await deps.sleepImpl(pollDelayMs(record, options.pollFloorMs), controller.signal)) break
    }
    return { terminal: 'unknown', elapsedMs: elapsed(), failureKind: 'timeout' }
  } finally {
    clearTimeout(timeout)
  }
}

export async function runImageLoadtest(options: ImageLoadtestOptions, suppliedDeps: RunnerDeps = {}): Promise<ImageLoadtestSummary> {
  const deps = {
    fetchImpl: suppliedDeps.fetchImpl ?? globalThis.fetch,
    now: suppliedDeps.now ?? (() => performance.now()),
    sleepImpl: suppliedDeps.sleepImpl ?? sleepAbortable,
    onEvent: suppliedDeps.onEvent ?? ((event: Record<string, unknown>) => console.log(JSON.stringify(event))),
  }
  const headers = { targetOrigin: options.targetOrigin, users: options.users, windows: options.windows, requested: options.total, size: options.size }
  deps.onEvent({ event: 'image_loadtest_start', ...headers })

  const submitted = await mapWithConcurrency(
    Array.from({ length: options.total }, (_, index) => index),
    options.submitConcurrency,
    index => submitTask(index, options, deps),
  )
  const submitStatuses: Record<string, number> = {}
  const submitFailures: Record<string, number> = {}
  for (const result of submitted) {
    count(submitStatuses, String(result.status))
    if (result.failureKind) count(submitFailures, result.failureKind)
  }
  const accepted = submitted.flatMap(result => result.task === undefined ? [] : [result.task])
  deps.onEvent({
    event: 'image_loadtest_submitted',
    requested: options.total,
    accepted: accepted.length,
    statuses: submitStatuses,
    failureKinds: submitFailures,
  })

  let cleanup: CancelResult[] = []
  if (accepted.length !== options.total && accepted.length > 0) {
    cleanup = await mapWithConcurrency(accepted, options.submitConcurrency, task => cancelTask(task, options, deps.fetchImpl))
    const statuses: Record<string, number> = {}
    const failures: Record<string, number> = {}
    for (const result of cleanup) {
      count(statuses, String(result.status))
      if (result.failureKind) count(failures, result.failureKind)
    }
    deps.onEvent({ event: 'image_loadtest_partial_submit_cleanup', attempted: cleanup.length, statuses, failureKinds: failures })
  }

  const terminal = await Promise.all(accepted.map(task => pollTask(task, options, deps)))
  const unresolved = accepted.filter((_, index) => terminal[index]?.terminal === 'unknown')
  if (unresolved.length > 0) {
    const afterPollCleanup = await mapWithConcurrency(unresolved, options.submitConcurrency, task => cancelTask(task, options, deps.fetchImpl))
    cleanup = [...cleanup, ...afterPollCleanup]
    const statuses: Record<string, number> = {}
    const failures: Record<string, number> = {}
    for (const result of afterPollCleanup) {
      count(statuses, String(result.status))
      if (result.failureKind) count(failures, result.failureKind)
    }
    deps.onEvent({ event: 'image_loadtest_unresolved_cleanup', attempted: afterPollCleanup.length, statuses, failureKinds: failures })
  }
  const terminalStatuses: Record<string, number> = {}
  const terminalFailures: Record<string, number> = {}
  for (const result of terminal) {
    count(terminalStatuses, result.terminal)
    if (result.failureKind) count(terminalFailures, result.failureKind)
  }
  const succeeded = terminal.filter(result => result.terminal === 'succeeded').length
  const summary: ImageLoadtestSummary = {
    requested: options.total,
    accepted: accepted.length,
    succeeded,
    failed: options.total - succeeded,
    cleanupAttempted: cleanup.length,
    exitCode: accepted.length === options.total && succeeded === options.total ? 0 : 1,
  }
  deps.onEvent({
    event: 'image_loadtest_terminal',
    requested: summary.requested,
    accepted: summary.accepted,
    succeeded: summary.succeeded,
    failed: summary.failed,
    statuses: terminalStatuses,
    failureKinds: terminalFailures,
    totalMs: { p50: percentile(terminal.map(result => result.elapsedMs), 0.5), p95: percentile(terminal.map(result => result.elapsedMs), 0.95) },
  })
  return summary
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) usage(0)
  assertKnownArgs(args)
  if (!args.includes('--execute')) {
    console.error('Refusing to create a billable image task without --execute.')
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

  const users = boundedInteger(option(args, '--users'), '--users', 1, MAX_USERS)
  const windows = boundedInteger(option(args, '--windows'), '--windows', 1, MAX_WINDOWS)
  const plan = createImageLoadtestPlan(users, windows, args.includes('--confirm-billable-batch'))
  const size = option(args, '--size') ?? '1024x1024'
  if (!IMAGE_SIZES.has(size)) throw new Error('--size must be 1024x1024, 1536x1024, or 1024x1536')
  const options: ImageLoadtestOptions = {
    ...plan,
    baseUrl,
    targetOrigin,
    token,
    size: size as ImageLoadtestOptions['size'],
    submitConcurrency: boundedInteger(option(args, '--submit-concurrency'), '--submit-concurrency', 16, MAX_SUBMIT_CONCURRENCY),
    submitTimeoutMs: boundedInteger(option(args, '--submit-timeout-ms'), '--submit-timeout-ms', 30_000, 60_000),
    terminalTimeoutMs: boundedInteger(option(args, '--terminal-timeout-ms'), '--terminal-timeout-ms', 600_000, 24 * 60 * 60_000),
    pollFloorMs: boundedInteger(option(args, '--poll-floor-ms'), '--poll-floor-ms', 5_000, 60_000),
    pollRequestTimeoutMs: boundedInteger(option(args, '--poll-request-timeout-ms'), '--poll-request-timeout-ms', 15_000, 30_000),
  }
  const summary = await runImageLoadtest(options)
  if (summary.exitCode !== 0) process.exitCode = summary.exitCode
}

if (import.meta.main) await main()
