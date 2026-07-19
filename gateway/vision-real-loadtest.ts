/**
 * Controlled real-upstream test for the visual chat path.
 *
 * This is deliberately separate from real-loadtest.ts: a repeated image can hit
 * the VisionBridge cache/singleflight and make a high-concurrency run look much
 * healthier than it really is. Every request here carries distinct valid PNG
 * bytes, and the runner refuses to run without that explicit acknowledgement.
 */

import { deflateSync } from 'node:zlib'

type Capacity = {
  active?: number
  queued?: number
  oldestQueueMs?: number
}

type GatewayHealth = {
  capacity?: Partial<Record<'deepseek' | 'mimo' | 'vision' | 'ingress_body', Capacity>>
}

type Sample = {
  status: number
  totalMs: number
  failureKind?: 'timeout' | 'network' | `http_${number}`
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const encoder = new TextEncoder()

function usage(exitCode = 2): never {
  console.error(`Usage:
  QF_LOADTEST_URL=http://127.0.0.1:8799 \\
  QF_LOADTEST_TOKEN=<app-token> \\
  bun gateway/vision-real-loadtest.ts --execute --generate-image \\
    --unique-image-per-request [options]

Options:
  --users=<n>                 Simulated installation count (default: 1)
  --windows=<n>               Concurrent visual requests per installation (default: 1)
  --phases=a,b,c              Concurrent request steps (default: total)
  --route=bridge|native       bridge=MiMo VisionBridge then DeepSeek (default)
                               native=direct MiMo v2.5 visual request
  --generate-image            Make a distinct, valid 64x64 PNG for each request
  --image-file=<png>          Use a PNG file, adding unique safe tEXt metadata per request
  --image-seed=<n>            Optional distinct-image seed (default: current time)
  --unique-image-per-request  Required acknowledgement; prevents cache/singleflight bias
  --max-tokens=<n>            Downstream completion cap (default: 16)
  --timeout-ms=<n>            Per-request deadline (default: 180000)
  --health-interval-ms=<n>    Health sampling interval (default: 100)
  --health-timeout-ms=<n>     Bound each /healthz sample (default: 1000)
  --pause-ms=<n>              Cool-down between successful steps (default: 2500)
  --use-server-app-token      Gateway-host only: read its app token solely for
                               http://127.0.0.1:8799 (never an external URL)

This runner never logs app tokens, request bodies, image bytes, or model output.
It reports only status, timing, and observed gateway-capacity metadata.`)
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

function parsePhases(raw: string | undefined, total: number): number[] {
  const values = raw === undefined
    ? [total]
    : raw.split(',').map(value => integer(value.trim(), '--phases', 0))
  const phases = [...new Set(values)].sort((a, b) => a - b)
  if (phases.length === 0 || phases.some(value => value > total)) {
    throw new Error(`--phases must contain values from 1 through ${total}`)
  }
  return phases
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

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value >>> 0)
  return out
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0)
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, byte) => {
  let value = byte
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value >>> 0
})

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff]! ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(kind: string, data: Uint8Array): Uint8Array {
  const tag = encoder.encode(kind)
  if (tag.byteLength !== 4) throw new Error('invalid PNG chunk tag')
  return concatBytes([uint32(data.byteLength), tag, data, uint32(crc32(concatBytes([tag, data])))])
}

function generatedPng(index: number): Uint8Array {
  const width = 64
  const height = 64
  const raw = new Uint8Array(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 3)
    raw[row] = 0
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3
      raw[pixel] = (index * 37 + x * 5 + y * 3) & 0xff
      raw[pixel + 1] = (index * 73 + x * 2 + y * 7) & 0xff
      raw[pixel + 2] = (index * 109 + x * 11 + y) & 0xff
    }
  }
  const ihdr = new Uint8Array(13)
  const view = new DataView(ihdr.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return concatBytes([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  ])
}

function uniquePngFile(bytes: Uint8Array, index: number): Uint8Array {
  if (!PNG_SIGNATURE.every((value, offset) => bytes[offset] === value)) {
    throw new Error('--image-file must be a valid PNG when using --unique-image-per-request')
  }
  for (let offset = PNG_SIGNATURE.byteLength; offset + 12 <= bytes.byteLength;) {
    const length = readUint32(bytes, offset)
    const dataEnd = offset + 12 + length
    if (dataEnd > bytes.byteLength) break
    const kind = new TextDecoder().decode(bytes.slice(offset + 4, offset + 8))
    if (kind === 'IEND') {
      const metadata = encoder.encode(`qf-loadtest=${index}`)
      return concatBytes([bytes.slice(0, offset), pngChunk('tEXt', metadata), bytes.slice(offset)])
    }
    offset = dataEnd
  }
  throw new Error('--image-file has no PNG IEND chunk')
}

function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) usage(0)
  if (!args.includes('--execute')) {
    console.error('Refusing to send real visual upstream traffic without --execute.')
    usage()
  }
  if (!args.includes('--unique-image-per-request')) {
    throw new Error('--unique-image-per-request is required to avoid VisionBridge cache/singleflight bias')
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

  const users = integer(option(args, '--users'), '--users', 1)
  const windows = integer(option(args, '--windows'), '--windows', 1)
  const maxTokens = integer(option(args, '--max-tokens'), '--max-tokens', 16)
  const timeoutMs = integer(option(args, '--timeout-ms'), '--timeout-ms', 180_000)
  const healthIntervalMs = integer(option(args, '--health-interval-ms'), '--health-interval-ms', 100)
  const healthTimeoutMs = integer(option(args, '--health-timeout-ms'), '--health-timeout-ms', 1_000)
  const pauseMs = integer(option(args, '--pause-ms'), '--pause-ms', 2_500)
  const route = option(args, '--route') ?? 'bridge'
  if (route !== 'bridge' && route !== 'native') throw new Error('--route must be bridge or native')
  const generated = args.includes('--generate-image')
  const imagePath = option(args, '--image-file')
  if (Number(generated) + Number(imagePath !== undefined) !== 1) {
    throw new Error('provide exactly one of --generate-image or --image-file=<png>')
  }
  const sourceImage = imagePath === undefined ? null : new Uint8Array(await Bun.file(imagePath).arrayBuffer())
  const imageSeed = integer(option(args, '--image-seed'), '--image-seed', Date.now())
  const total = users * windows
  if (!Number.isSafeInteger(total)) throw new Error('--users * --windows is too large')
  const phases = parsePhases(option(args, '--phases'), total)
  const model = route === 'bridge' ? 'deepseek-v4-flash' : 'mimo-v2.5'
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  const pools = ['vision', 'mimo', 'deepseek', 'ingress_body'] as const
  type Pool = typeof pools[number]
  type PoolObservation = { active: number; queued: number; oldestQueueMs: number }
  const observed: Record<Pool, PoolObservation> = Object.fromEntries(pools.map(pool => [pool, { active: 0, queued: 0, oldestQueueMs: 0 }])) as Record<Pool, PoolObservation>
  let healthSamples = 0
  let unavailableHealthSamples = 0

  function uniqueImage(index: number): string {
    const distinctIndex = imageSeed + index
    return dataUrl(sourceImage === null ? generatedPng(distinctIndex) : uniquePngFile(sourceImage, distinctIndex))
  }

  async function health(): Promise<GatewayHealth | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs)
    try {
      const response = await fetch(`${baseUrl}/healthz`, { headers, signal: controller.signal })
      if (!response.ok) return null
      return await response.json() as GatewayHealth
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  function observe(snapshot: GatewayHealth | null): void {
    healthSamples += 1
    if (!snapshot) unavailableHealthSamples += 1
    for (const pool of pools) {
      const capacity = snapshot?.capacity?.[pool]
      observed[pool].active = Math.max(observed[pool].active, nonNegative(capacity?.active))
      observed[pool].queued = Math.max(observed[pool].queued, nonNegative(capacity?.queued))
      observed[pool].oldestQueueMs = Math.max(observed[pool].oldestQueueMs, nonNegative(capacity?.oldestQueueMs))
    }
  }

  async function runOne(index: number, imageIndex: number): Promise<Sample> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()
    try {
      const installation = `vision-capacity-${String(index % users).padStart(4, '0')}`
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'X-QF-Client-ID': installation },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '请只回复 OK。' },
              { type: 'image_url', image_url: { url: uniqueImage(imageIndex) } },
            ],
          }],
        }),
      })
      await response.arrayBuffer()
      return {
        status: response.status,
        totalMs: Math.round(performance.now() - started),
        failureKind: response.ok ? undefined : `http_${response.status}`,
      }
    } catch {
      return {
        status: 0,
        totalMs: Math.round(performance.now() - started),
        failureKind: controller.signal.aborted ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  console.log(JSON.stringify({
    event: 'vision_loadtest_start',
    target: baseUrl,
    users,
    windows,
    phases,
    route,
    model,
    imageSource: generated ? 'generated-64x64-png' : 'png-file',
    imageSeed,
    maxTokens,
  }))

  let imageSequence = 0
  for (const requested of phases) {
    let monitoring = true
    observe(await health())
    const monitor = (async () => {
      while (monitoring) {
        const started = performance.now()
        observe(await health())
        await sleep(Math.max(0, healthIntervalMs - (performance.now() - started)))
      }
    })()
    const samples = await Promise.all(Array.from({ length: requested }, (_, index) => runOne(index, imageSequence++)))
    monitoring = false
    await monitor
    const finalGateway = await health()
    const statuses: Record<string, number> = {}
    const failureKinds: Record<string, number> = {}
    for (const sample of samples) {
      const status = String(sample.status)
      statuses[status] = (statuses[status] ?? 0) + 1
      if (sample.failureKind) failureKinds[sample.failureKind] = (failureKinds[sample.failureKind] ?? 0) + 1
    }
    const succeeded = samples.filter(sample => sample.status >= 200 && sample.status < 300).length
    console.log(JSON.stringify({
      event: 'vision_loadtest_phase',
      requested,
      succeeded,
      failed: requested - succeeded,
      statuses,
      failureKinds,
      totalMs: { p50: percentile(samples.map(sample => sample.totalMs), 0.5), p95: percentile(samples.map(sample => sample.totalMs), 0.95) },
      observedGateway: { pools: observed, samples: healthSamples, unavailableSamples: unavailableHealthSamples },
      finalGateway: finalGateway?.capacity ?? null,
    }))
    if (succeeded !== requested) {
      console.error('Stopping after a failed phase; visual overload must be mapped deliberately in a separate run.')
      process.exitCode = 1
      return
    }
    if (requested !== phases.at(-1)) await sleep(pauseMs)
  }
}

await main()
