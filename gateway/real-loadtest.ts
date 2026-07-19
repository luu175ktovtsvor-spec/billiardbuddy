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
 *   bun gateway/real-loadtest.ts --execute --users=100 --windows=5 \
 *     --phases=1,20,50,100,256,500 --scenario=stream
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
}

type PhaseSummary = {
  requested: number
  succeeded: number
  failed: number
  statuses: Record<string, number>
  firstByteMs: { p50: number | null; p95: number | null }
  totalMs: { p50: number | null; p95: number | null }
  peakGateway: { active: number; queued: number; oldestQueueMs: number }
  finalGateway: Capacity | null
}

function usage(exitCode = 2): never {
  console.error(`Usage:
  QF_LOADTEST_URL=https://gateway.example/gw \\
  QF_LOADTEST_TOKEN=<app-token> \\
  bun gateway/real-loadtest.ts --execute [options]

Options:
  --users=<n>                 Simulated installation count (default: 100)
  --windows=<n>               Concurrent windows per installation (default: 5)
  --phases=a,b,c              Concurrent request steps (default: 1,20,50,100,...,total)
  --scenario=short|stream     "short" asks for OK; "stream" asks for a short numbered stream
  --max-tokens=<n>            Upstream max_tokens per request (default: 64)
  --pool=deepseek|mimo        Capacity pool sampled from /healthz (auto from model)
  --timeout-ms=<n>            Per-request deadline (default: 180000)
  --health-interval-ms=<n>    Health sampling interval (default: 200)
  --pause-ms=<n>              Cool-down between successful steps (default: 2500)
  --continue-after-failure    Continue after a phase returns any non-2xx response
  --use-server-app-token      Gateway-host only: read its app token solely for
                               http://127.0.0.1:8799 (never an external URL)

The runner uses controlled X-QF-Client-ID values so a 100×5 phase models five
windows per installation, and reads every SSE body to completion. It reports
status/timing/capacity only; it never logs tokens or model output.`)
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

function parsePhases(raw: string | undefined, total: number): number[] {
  const defaults = [1, 20, 50, 100, 256, total].filter(phase => phase <= total)
  const candidates = raw === undefined
    ? defaults
    : raw.split(',').map(value => integer(value.trim(), '--phases', 0))
  const phases = [...new Set(candidates)].sort((a, b) => a - b)
  if (phases.length === 0 || phases.some(phase => phase > total)) {
    throw new Error(`--phases must contain values from 1 through ${total}`)
  }
  return phases
}

function isGatewayLoopback(url: URL): boolean {
  return url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    && url.port === '8799'
    && url.pathname === '/'
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
  let baseUrl: string
  let base: URL
  try {
    base = new URL(rawBaseUrl)
    if (!/^https?:$/.test(base.protocol)) throw new Error('unsupported protocol')
    baseUrl = base.toString().replace(/\/+$/, '')
  } catch {
    throw new Error('QF_LOADTEST_URL must be an absolute HTTP(S) URL')
  }
  const useServerAppToken = args.includes('--use-server-app-token')
  if (useServerAppToken && !isGatewayLoopback(base!)) {
    throw new Error('--use-server-app-token only permits http://127.0.0.1:8799')
  }
  const token = process.env.QF_LOADTEST_TOKEN?.trim()
    ?? (useServerAppToken ? await loadLocalGatewayAppToken() : undefined)
  if (!token) throw new Error('QF_LOADTEST_TOKEN is required with --execute')

  const users = integer(option(args, '--users'), '--users', 100)
  const windows = integer(option(args, '--windows'), '--windows', 5)
  const maxTokens = integer(option(args, '--max-tokens'), '--max-tokens', 64)
  // Gateway's default DeepSeek queue may wait 120 seconds, so a 90-second client
  // timeout would manufacture failures before the capacity test reaches the queue.
  const timeoutMs = integer(option(args, '--timeout-ms'), '--timeout-ms', 180_000)
  const healthIntervalMs = integer(option(args, '--health-interval-ms'), '--health-interval-ms', 200)
  const pauseMs = integer(option(args, '--pause-ms'), '--pause-ms', 2_500)
  const scenario = option(args, '--scenario') ?? 'stream'
  if (scenario !== 'short' && scenario !== 'stream') throw new Error('--scenario must be short or stream')
  const model = process.env.QF_LOADTEST_MODEL?.trim() || 'deepseek-v4-flash'
  const pool = option(args, '--pool') ?? (model.toLowerCase().startsWith('mimo') ? 'mimo' : 'deepseek')
  if (pool !== 'deepseek' && pool !== 'mimo') throw new Error('--pool must be deepseek or mimo')
  const total = users * windows
  if (!Number.isSafeInteger(total)) throw new Error('--users * --windows is too large')
  const phases = parsePhases(option(args, '--phases'), total)
  const continueAfterFailure = args.includes('--continue-after-failure')
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  }
  const prompt = scenario === 'short'
    ? '请只回复 OK。'
    : `请逐行输出从 1 到 ${Math.min(maxTokens, 128)} 的整数，不要加任何解释。`

  async function health(): Promise<Capacity | null> {
    try {
      const response = await fetch(`${baseUrl}/healthz`, { headers })
      if (!response.ok) return null
      const body = await response.json() as GatewayHealth
      return body.capacity?.[pool] ?? null
    } catch {
      return null
    }
  }

  async function runOne(index: number): Promise<Sample> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()
    try {
      const installation = `capacity-${String(index % users).padStart(4, '0')}`
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'X-QF-Client-ID': installation },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      let firstByteMs: number | null = null
      const reader = response.body?.getReader()
      if (reader) {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (firstByteMs === null && next.value.byteLength > 0) firstByteMs = performance.now() - started
        }
      }
      return {
        status: response.status,
        firstByteMs: firstByteMs === null ? null : Math.round(firstByteMs),
        totalMs: Math.round(performance.now() - started),
      }
    } catch {
      return { status: 0, firstByteMs: null, totalMs: Math.round(performance.now() - started) }
    } finally {
      clearTimeout(timeout)
    }
  }

  console.log(JSON.stringify({
    event: 'loadtest_start',
    target: baseUrl,
    users,
    windows,
    phases,
    scenario,
    pool,
    maxTokens,
  }))

  for (const requested of phases) {
    let monitor = true
    let peakActive = 0
    let peakQueued = 0
    let peakOldestQueueMs = 0
    const monitorTask = (async () => {
      while (monitor) {
        const snapshot = await health()
        peakActive = Math.max(peakActive, nonNegative(snapshot?.active))
        peakQueued = Math.max(peakQueued, nonNegative(snapshot?.queued))
        peakOldestQueueMs = Math.max(peakOldestQueueMs, nonNegative(snapshot?.oldestQueueMs))
        await sleep(healthIntervalMs)
      }
    })()
    const samples = await Promise.all(Array.from({ length: requested }, (_, index) => runOne(index)))
    monitor = false
    await monitorTask
    const finalGateway = await health()
    const statuses: Record<string, number> = {}
    for (const sample of samples) statuses[String(sample.status)] = (statuses[String(sample.status)] ?? 0) + 1
    const firstBytes = samples.flatMap(sample => sample.firstByteMs === null ? [] : [sample.firstByteMs])
    const totals = samples.map(sample => sample.totalMs)
    const succeeded = samples.filter(sample => sample.status >= 200 && sample.status < 300).length
    const summary: PhaseSummary = {
      requested,
      succeeded,
      failed: requested - succeeded,
      statuses,
      firstByteMs: { p50: percentile(firstBytes, 0.5), p95: percentile(firstBytes, 0.95) },
      totalMs: { p50: percentile(totals, 0.5), p95: percentile(totals, 0.95) },
      peakGateway: { active: peakActive, queued: peakQueued, oldestQueueMs: peakOldestQueueMs },
      finalGateway,
    }
    console.log(JSON.stringify({ event: 'loadtest_phase', ...summary }))
    if (summary.failed > 0 && !continueAfterFailure) {
      console.error('Stopping after a failed phase. Use --continue-after-failure only when deliberately mapping overload behavior.')
      process.exitCode = 1
      return
    }
    if (requested !== phases.at(-1)) await sleep(pauseMs)
  }
}

await main()
