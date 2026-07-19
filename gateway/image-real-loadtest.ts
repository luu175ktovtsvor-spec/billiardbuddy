/**
 * Deliberately small, paid-upstream smoke runner for the asynchronous image route.
 *
 * This is not a 500-image benchmark: each accepted request can create a billable
 * GPT Image task. It defaults to exactly one task, requires --execute, keeps app
 * tokens on the gateway host, and waits for a terminal relay status so an operator
 * can distinguish “accepted” from a completed image workflow.
 */

type SubmitResult = {
  status: number
  taskId?: string
  clientId: string
  failureKind?: 'timeout' | 'network' | `http_${number}` | 'invalid_response'
}

type PollResult = {
  terminal: string
  elapsedMs: number
  failureKind?: 'timeout' | 'network' | `http_${number}` | 'invalid_response'
}

function usage(exitCode = 2): never {
  console.error(`Usage:
  QF_LOADTEST_URL=http://127.0.0.1:8799 \\
  QF_LOADTEST_TOKEN=<app-token> \\
  bun gateway/image-real-loadtest.ts --execute [options]

Options:
  --tasks=<n>                 Billable image tasks to create (default: 1)
  --size=<WxH>                Image size forwarded to the relay (default: 1024x1024)
  --submit-timeout-ms=<n>     Per-submit deadline (default: 30000)
  --terminal-timeout-ms=<n>   Per-task terminal-status deadline (default: 600000)
  --poll-floor-ms=<n>         Minimum poll delay (default: 5000)
  --use-server-app-token      Gateway-host only: read its app token solely for
                               http://127.0.0.1:8799 (never an external URL)

Each task uses a unique Idempotency-Key. The runner never logs app tokens, task
IDs, request bodies, image bytes, or model output; it reports only counts/timing.`)
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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isGatewayLoopback(url: URL): boolean {
  return url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    && url.port === '8799'
    && url.pathname === '/'
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

function count(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function suggestedPollMs(value: unknown, floorMs: number): number {
  const record = asRecord(value)
  const seconds = record?.poll_after_seconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return floorMs
  return Math.max(floorMs, Math.min(60_000, Math.round(seconds * 1_000)))
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const ordered = [...values].sort((a, b) => a - b)
  return Math.round(ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)]!)
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) usage(0)
  if (!args.includes('--execute')) {
    console.error('Refusing to create a billable image task without --execute.')
    usage()
  }

  const rawBaseUrl = process.env.QF_LOADTEST_URL?.trim()
  if (!rawBaseUrl) throw new Error('QF_LOADTEST_URL is required with --execute')
  let base: URL
  try {
    base = new URL(rawBaseUrl)
    if (!/^https?:$/.test(base.protocol)) throw new Error('unsupported protocol')
  } catch {
    throw new Error('QF_LOADTEST_URL must be an absolute HTTP(S) URL')
  }
  const baseUrl = base.toString().replace(/\/+$/, '')
  const useServerAppToken = args.includes('--use-server-app-token')
  if (useServerAppToken && !isGatewayLoopback(base)) {
    throw new Error('--use-server-app-token only permits http://127.0.0.1:8799')
  }
  const token = process.env.QF_LOADTEST_TOKEN?.trim()
    ?? (useServerAppToken ? await loadLocalGatewayAppToken() : undefined)
  if (!token) throw new Error('QF_LOADTEST_TOKEN is required with --execute')

  const tasks = integer(option(args, '--tasks'), '--tasks', 1)
  const size = option(args, '--size') ?? '1024x1024'
  if (!/^\d{2,4}x\d{2,4}$/.test(size)) throw new Error('--size must look like 1024x1024')
  const submitTimeoutMs = integer(option(args, '--submit-timeout-ms'), '--submit-timeout-ms', 30_000)
  const terminalTimeoutMs = integer(option(args, '--terminal-timeout-ms'), '--terminal-timeout-ms', 600_000)
  const pollFloorMs = integer(option(args, '--poll-floor-ms'), '--poll-floor-ms', 5_000)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const runId = crypto.randomUUID()

  async function submit(index: number): Promise<SubmitResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), submitTimeoutMs)
    const clientId = `image-loadtest-${String(index).padStart(3, '0')}`
    try {
      const response = await fetch(`${baseUrl}/v1/images/tasks`, {
        method: 'POST',
        headers: {
          ...headers,
          'X-QF-Client-ID': clientId,
          'Idempotency-Key': `loadtest-${runId}-${index}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          mode: 'generate',
          model: 'gpt-image-2',
          n: 1,
          size,
          prompt: 'A single blue circle centered on a plain white background. No text, no logo, no watermark.',
        }),
      })
      let body: unknown = null
      try { body = await response.json() } catch { /* status is still useful */ }
      const taskId = asRecord(body)?.task_id
      return {
        status: response.status,
        clientId,
        taskId: response.status === 202 && typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined,
        failureKind: response.status === 202 && typeof taskId === 'string' && taskId.length > 0
          ? undefined
          : response.ok ? 'invalid_response' : `http_${response.status}`,
      }
    } catch {
      return {
        status: 0,
        clientId,
        failureKind: controller.signal.aborted ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function poll(task: { taskId: string; clientId: string }): Promise<PollResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), terminalTimeoutMs)
    const started = performance.now()
    try {
      while (true) {
        const response = await fetch(`${baseUrl}/v1/images/tasks/${encodeURIComponent(task.taskId)}`, {
          headers: { ...headers, 'X-QF-Client-ID': task.clientId },
          signal: controller.signal,
        })
        let body: unknown = null
        try { body = await response.json() } catch { /* handled below */ }
        if (!response.ok) {
          return { terminal: 'unknown', elapsedMs: Math.round(performance.now() - started), failureKind: `http_${response.status}` }
        }
        const state = asRecord(body)?.status
        if (typeof state !== 'string') {
          return { terminal: 'unknown', elapsedMs: Math.round(performance.now() - started), failureKind: 'invalid_response' }
        }
        if (['succeeded', 'failed', 'failed_unknown', 'canceled'].includes(state)) {
          return { terminal: state, elapsedMs: Math.round(performance.now() - started) }
        }
        await sleep(suggestedPollMs(body, pollFloorMs))
      }
    } catch {
      return {
        terminal: 'unknown',
        elapsedMs: Math.round(performance.now() - started),
        failureKind: controller.signal.aborted ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  console.log(JSON.stringify({ event: 'image_loadtest_start', target: baseUrl, tasks, size }))
  const submitted = await Promise.all(Array.from({ length: tasks }, (_, index) => submit(index)))
  const submitStatuses: Record<string, number> = {}
  const submitFailures: Record<string, number> = {}
  for (const result of submitted) {
    count(submitStatuses, String(result.status))
    if (result.failureKind) count(submitFailures, result.failureKind)
  }
  const accepted = submitted.flatMap(result => result.taskId === undefined ? [] : [{ taskId: result.taskId, clientId: result.clientId }])
  console.log(JSON.stringify({
    event: 'image_loadtest_submitted',
    requested: tasks,
    accepted: accepted.length,
    statuses: submitStatuses,
    failureKinds: submitFailures,
  }))
  if (accepted.length !== tasks) {
    process.exitCode = 1
    return
  }

  const terminal = await Promise.all(accepted.map(task => poll(task)))
  const terminalStatuses: Record<string, number> = {}
  const terminalFailures: Record<string, number> = {}
  for (const result of terminal) {
    count(terminalStatuses, result.terminal)
    if (result.failureKind) count(terminalFailures, result.failureKind)
  }
  const succeeded = terminal.filter(result => result.terminal === 'succeeded').length
  console.log(JSON.stringify({
    event: 'image_loadtest_terminal',
    requested: tasks,
    succeeded,
    failed: tasks - succeeded,
    statuses: terminalStatuses,
    failureKinds: terminalFailures,
    totalMs: { p50: percentile(terminal.map(result => result.elapsedMs), 0.5), p95: percentile(terminal.map(result => result.elapsedMs), 0.95) },
  }))
  if (succeeded !== tasks) process.exitCode = 1
}

await main()
