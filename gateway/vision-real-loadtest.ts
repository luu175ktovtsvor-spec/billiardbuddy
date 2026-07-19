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
  completed: boolean
  failureKind?: 'timeout' | 'network' | 'response_too_large' | 'invalid_json' | 'reasoning_only' | 'reasoning_only_truncated' | 'invalid_completion' | `http_${number}`
}

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10])
const encoder = new TextEncoder()
const MAX_GATEWAY_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES_PER_REQUEST = 8
// Leave room for the per-request tEXt chunk so a valid source image cannot turn
// into a gateway-oversize payload merely because this runner makes it unique.
const MAX_IMAGE_FILE_BYTES = MAX_GATEWAY_IMAGE_BYTES - 256
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_USERS = 100
const MAX_WINDOWS = 10
const MAX_REQUESTS = MAX_USERS * MAX_WINDOWS
const HIGH_TO_LOW_DEFAULT_PHASES = [1_000, 800, 600, 400, 200, 100, 64, 36, 24, 12, 1]
const pools = ['vision', 'mimo', 'deepseek', 'ingress_body'] as const

type Pool = typeof pools[number]
type PoolObservation = { active: number; queued: number; oldestQueueMs: number }
type ValidPng = { bytes: Uint8Array; iendOffset: number }
type LoadTarget = { base: URL; baseUrl: string; targetOrigin: string }
export type ThinkingMode = 'enabled' | 'disabled'

function usage(exitCode = 2): never {
  console.error(`Usage:
  QF_LOADTEST_URL=http://127.0.0.1:8799 \\
  QF_LOADTEST_TOKEN=<app-token> \\
  bun gateway/vision-real-loadtest.ts --execute --generate-image \\
    --unique-image-per-request [options]

Options:
  --users=<n>                 Simulated installation count (default: 1, max: ${MAX_USERS})
  --windows=<n>               Concurrent visual requests per installation (default: 1, max: ${MAX_WINDOWS})
  --phases=a,b,c              Concurrent request steps, highest first by default
  --route=bridge|native       bridge=MiMo VisionBridge then DeepSeek (default)
                               native=direct MiMo v2.5 visual request
  --generate-image            Make a distinct, valid 64x64 PNG for each request
  --image-file=<png>          Use a PNG file, adding unique safe tEXt metadata per request
  --image-seed=<n>            Optional distinct-image seed (default: current time)
  --images-per-request=<n>    Distinct images per chat request (default: 1, max: ${MAX_IMAGES_PER_REQUEST})
  --unique-image-per-request  Required acknowledgement; prevents cache/singleflight bias
  --max-tokens=<n>            Downstream completion cap (default: 16)
  --thinking=enabled|disabled Send an explicit model thinking mode; omitted uses
                               the gateway/upstream default
  --timeout-ms=<n>            Per-request deadline (default: 180000)
  --health-interval-ms=<n>    Health sampling interval (default: 100)
  --health-timeout-ms=<n>     Bound each /healthz sample (default: 1000)
  --pause-ms=<n>              Cool-down between successful steps (default: 2500)
  --drain-timeout-ms=<n>      Wait for visual/MiMo/DeepSeek permits to drain (default: request timeout)
  --stop-after-failure        Stop after a failed phase instead of locating a lower ceiling
  --continue-after-failure    Deprecated compatibility alias; high-to-low continues by default
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

function boundedInteger(value: string | undefined, name: string, fallback: number, maximum: number): number {
  const parsed = integer(value, name, fallback)
  if (parsed > maximum) throw new Error(`${name} must not exceed ${maximum}`)
  return parsed
}

function option(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

export function parseThinkingMode(value: string | undefined): ThinkingMode | undefined {
  if (value === undefined) return undefined
  if (value === 'enabled' || value === 'disabled') return value
  throw new Error('--thinking must be enabled or disabled')
}

export function parseImagesPerRequest(value: string | undefined): number {
  const count = integer(value, '--images-per-request', 1)
  if (count > MAX_IMAGES_PER_REQUEST) {
    throw new Error(`--images-per-request must be at most ${MAX_IMAGES_PER_REQUEST}`)
  }
  return count
}

export function parsePhases(raw: string | undefined, total: number): number[] {
  const values = raw === undefined
    ? [total, ...HIGH_TO_LOW_DEFAULT_PHASES].filter(value => value <= total)
    : raw.split(',').map(value => integer(value.trim(), '--phases', 0))
  const phases = [...new Set(values)].sort((a, b) => b - a)
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
 * external endpoint is not acceptable. The target string itself is never
 * printed: callers get only its origin in the structured summary.
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

function loadTestText(index: number): Uint8Array {
  // PNG tEXt uses a NUL-separated keyword and Latin-1 text. It makes otherwise
  // identical image pixels distinct to the VisionBridge SHA-256 cache as well.
  return encoder.encode(`qf-loadtest\0${index}`)
}

function pngChunkType(bytes: Uint8Array, offset: number): string {
  const tag = bytes.subarray(offset, offset + 4)
  if (tag.byteLength !== 4 || tag.some(value => !((value >= 65 && value <= 90) || (value >= 97 && value <= 122)))) {
    throw new Error('--image-file has an invalid PNG chunk type')
  }
  return new TextDecoder().decode(tag)
}

/** Validate a small PNG without decoding its pixels or retaining unbounded input. */
export function validatePng(bytes: Uint8Array): ValidPng {
  if (bytes.byteLength > MAX_IMAGE_FILE_BYTES) {
    throw new Error('--image-file exceeds the 8 MiB image limit')
  }
  if (!PNG_SIGNATURE.every((value, offset) => bytes[offset] === value)) {
    throw new Error('--image-file must be a valid PNG')
  }

  let sawIhdr = false
  let sawIdat = false
  for (let offset = PNG_SIGNATURE.byteLength; offset < bytes.byteLength;) {
    if (offset + 12 > bytes.byteLength) throw new Error('--image-file has a truncated PNG chunk')
    const length = readUint32(bytes, offset)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const chunkEnd = dataEnd + 4
    if (dataEnd > bytes.byteLength - 4 || chunkEnd > bytes.byteLength) {
      throw new Error('--image-file has a truncated PNG chunk')
    }
    const kind = pngChunkType(bytes, offset + 4)
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== readUint32(bytes, dataEnd)) {
      throw new Error('--image-file has an invalid PNG checksum')
    }
    if (!sawIhdr) {
      if (kind !== 'IHDR' || length !== 13) throw new Error('--image-file must begin with a PNG IHDR chunk')
      const width = readUint32(bytes, dataStart)
      const height = readUint32(bytes, dataStart + 4)
      if (width === 0 || height === 0 || width > MAX_IMAGE_PIXELS || height > Math.floor(MAX_IMAGE_PIXELS / width)) {
        throw new Error('--image-file exceeds the 16 megapixel PNG limit')
      }
      sawIhdr = true
    } else if (kind === 'IHDR') {
      throw new Error('--image-file has more than one PNG IHDR chunk')
    }
    if (kind === 'IDAT') sawIdat = true
    if (kind === 'IEND') {
      if (length !== 0 || !sawIdat || chunkEnd !== bytes.byteLength) {
        throw new Error('--image-file has an invalid PNG IEND chunk')
      }
      return { bytes, iendOffset: offset }
    }
    offset = chunkEnd
  }
  throw new Error('--image-file has no PNG IEND chunk')
}

async function loadPngFile(path: string): Promise<ValidPng> {
  const file = Bun.file(path)
  if (!Number.isSafeInteger(file.size) || file.size < PNG_SIGNATURE.byteLength || file.size > MAX_IMAGE_FILE_BYTES) {
    throw new Error('--image-file exceeds the 8 MiB image limit')
  }
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await file.arrayBuffer())
  } catch {
    throw new Error('--image-file could not be read')
  }
  if (bytes.byteLength !== file.size) throw new Error('--image-file changed while it was being read')
  return validatePng(bytes)
}

export function generatedPng(index: number): Uint8Array {
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
    pngChunk('tEXt', loadTestText(index)),
    pngChunk('IEND', new Uint8Array()),
  ])
}

function uniquePngFile(source: ValidPng, index: number): Uint8Array {
  const metadata = pngChunk('tEXt', loadTestText(index))
  if (source.bytes.byteLength + metadata.byteLength > MAX_GATEWAY_IMAGE_BYTES) {
    throw new Error('--image-file has no room for unique test metadata')
  }
  return concatBytes([
    source.bytes.slice(0, source.iendOffset),
    metadata,
    source.bytes.slice(source.iendOffset),
  ])
}

function dataUrl(bytes: Uint8Array): string {
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type CompletionState = 'completed' | 'reasoning_only' | 'reasoning_only_truncated' | 'invalid_completion'

/**
 * A 2xx transport result is useful only when it contains an actual chat completion.
 * DeepSeek can legitimately return reasoning_content before it has room for user-facing
 * content. Keep that outcome unsuccessful for a user-facing load test, but report the
 * token-limit case separately from malformed gateway output.
 */
export function classifyCompletionJson(value: unknown): CompletionState {
  if (!isRecord(value) || !Array.isArray(value.choices)) return 'invalid_completion'

  let sawReasoningOnly = false
  let sawTruncatedReasoning = false
  for (const choice of value.choices) {
    if (!isRecord(choice) || !isRecord(choice.message)) continue
    const content = choice.message.content
    if (typeof content === 'string' && content.trim().length > 0) return 'completed'

    const reasoning = choice.message.reasoning_content
    if (typeof reasoning === 'string' && reasoning.trim().length > 0) {
      if (choice.finish_reason === 'length') sawTruncatedReasoning = true
      else sawReasoningOnly = true
    }
  }
  if (sawTruncatedReasoning) return 'reasoning_only_truncated'
  if (sawReasoningOnly) return 'reasoning_only'
  return 'invalid_completion'
}

export function hasCompletionJson(value: unknown): boolean {
  return classifyCompletionJson(value) === 'completed'
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Error bodies are deliberately discarded and never surfaced in test output.
  }
}

/** Read just enough successful JSON to validate it, never expose its contents. */
async function readResponseText(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await cancelResponseBody(response)
    return null
  }
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      if (length + next.value.byteLength > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        return null
      }
      length += next.value.byteLength
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(concatBytes(chunks))
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
  const maxTokens = integer(option(args, '--max-tokens'), '--max-tokens', 16)
  const thinking = parseThinkingMode(option(args, '--thinking'))
  const imagesPerRequest = parseImagesPerRequest(option(args, '--images-per-request'))
  const timeoutMs = integer(option(args, '--timeout-ms'), '--timeout-ms', 180_000)
  const healthIntervalMs = integer(option(args, '--health-interval-ms'), '--health-interval-ms', 100)
  const healthTimeoutMs = integer(option(args, '--health-timeout-ms'), '--health-timeout-ms', 1_000)
  const pauseMs = integer(option(args, '--pause-ms'), '--pause-ms', 2_500)
  const drainTimeoutMs = integer(option(args, '--drain-timeout-ms'), '--drain-timeout-ms', timeoutMs)
  const route = option(args, '--route') ?? 'bridge'
  if (route !== 'bridge' && route !== 'native') throw new Error('--route must be bridge or native')
  const generated = args.includes('--generate-image')
  const imagePath = option(args, '--image-file')
  if (Number(generated) + Number(imagePath !== undefined) !== 1) {
    throw new Error('provide exactly one of --generate-image or --image-file=<png>')
  }
  const sourceImage = imagePath === undefined ? null : await loadPngFile(imagePath)
  const imageSeed = integer(option(args, '--image-seed'), '--image-seed', Date.now())
  const total = users * windows
  if (!Number.isSafeInteger(total) || total > MAX_REQUESTS) throw new Error(`--users * --windows must not exceed ${MAX_REQUESTS}`)
  const phases = parsePhases(option(args, '--phases'), total)
  const continueAfterFailure = !args.includes('--stop-after-failure') || args.includes('--continue-after-failure')
  const generatedImageCount = phases.reduce((count, phase) => {
    const next = count + phase * imagesPerRequest
    if (!Number.isSafeInteger(next)) throw new Error('--images-per-request times total staged requests is too large')
    return next
  }, 0)
  if (!Number.isSafeInteger(imageSeed + generatedImageCount - 1)) {
    throw new Error('--image-seed plus total staged image count is too large')
  }
  const model = route === 'bridge' ? 'deepseek-v4-flash' : 'mimo-v2.5'
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

  function uniqueImage(index: number): string {
    const distinctIndex = imageSeed + index
    return dataUrl(sourceImage === null ? generatedPng(distinctIndex) : uniquePngFile(sourceImage, distinctIndex))
  }

  async function health(): Promise<GatewayHealth | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs)
    try {
      const response = await fetch(`${baseUrl}/healthz`, { headers, signal: controller.signal })
      if (!response.ok) {
        await cancelResponseBody(response)
        return null
      }
      const text = await readResponseText(response)
      if (text === null) return null
      try {
        return JSON.parse(text) as GatewayHealth
      } catch {
        return null
      }
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async function waitForDrain(): Promise<{ snapshot: GatewayHealth | null; drained: boolean }> {
    const deadline = performance.now() + drainTimeoutMs
    let snapshot = await health()
    const drained = () => snapshot !== null && pools.every(pool => {
      const capacity = snapshot?.capacity?.[pool]
      return nonNegative(capacity?.active) === 0 && nonNegative(capacity?.queued) === 0
    })
    while (!drained() && performance.now() < deadline) {
      await sleep(Math.min(250, Math.max(1, deadline - performance.now())))
      snapshot = await health()
    }
    return { snapshot, drained: drained() }
  }

  async function runOne(index: number, firstImageIndex: number): Promise<Sample> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()
    try {
      const installation = `vision-capacity-${String(index % users).padStart(4, '0')}`
      const content = [
        { type: 'text', text: '请只回复 OK。' },
        ...Array.from({ length: imagesPerRequest }, (_, offset) => ({
          type: 'image_url',
          image_url: { url: uniqueImage(firstImageIndex + offset) },
        })),
      ]
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'X-QF-Client-ID': installation },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          stream: false,
          max_tokens: maxTokens,
          ...(thinking ? { thinking: { type: thinking } } : {}),
          temperature: 0,
          messages: [{
            role: 'user',
            content,
          }],
        }),
      })
      if (!response.ok) {
        await cancelResponseBody(response)
        return {
          status: response.status,
          totalMs: Math.round(performance.now() - started),
          completed: false,
          failureKind: `http_${response.status}`,
        }
      }
      const text = await readResponseText(response)
      if (text === null) {
        return {
          status: response.status,
          totalMs: Math.round(performance.now() - started),
          completed: false,
          failureKind: 'response_too_large',
        }
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        return {
          status: response.status,
          totalMs: Math.round(performance.now() - started),
          completed: false,
          failureKind: 'invalid_json',
        }
      }
      const completion = classifyCompletionJson(payload)
      const completed = completion === 'completed'
      return {
        status: response.status,
        totalMs: Math.round(performance.now() - started),
        completed,
        failureKind: completed ? undefined : completion,
      }
    } catch {
      return {
        status: 0,
        totalMs: Math.round(performance.now() - started),
        completed: false,
        failureKind: controller.signal.aborted ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  console.log(JSON.stringify({
    event: 'vision_loadtest_start',
    targetOrigin,
    users,
    windows,
    phases,
    route,
    model,
    imageSource: generated ? 'generated-64x64-png' : 'png-file',
    imageSeed,
    imagesPerRequest,
    maxTokens,
    thinking,
  }))

  let imageSequence = 0
  let highestSuccessfulPhase: number | null = null
  let observedFailure = false
  for (const requested of phases) {
    let monitoring = true
    const observed: Record<Pool, PoolObservation> = Object.fromEntries(
      pools.map(pool => [pool, { active: 0, queued: 0, oldestQueueMs: 0 }]),
    ) as Record<Pool, PoolObservation>
    let healthSamples = 0
    let unavailableHealthSamples = 0
    const observe = (snapshot: GatewayHealth | null) => {
      healthSamples += 1
      if (!snapshot) unavailableHealthSamples += 1
      for (const pool of pools) {
        const capacity = snapshot?.capacity?.[pool]
        observed[pool].active = Math.max(observed[pool].active, nonNegative(capacity?.active))
        observed[pool].queued = Math.max(observed[pool].queued, nonNegative(capacity?.queued))
        observed[pool].oldestQueueMs = Math.max(observed[pool].oldestQueueMs, nonNegative(capacity?.oldestQueueMs))
      }
    }
    observe(await health())
    const monitor = (async () => {
      while (monitoring) {
        const started = performance.now()
        observe(await health())
        await sleep(Math.max(0, healthIntervalMs - (performance.now() - started)))
      }
    })()
    const samples = await Promise.all(Array.from({ length: requested }, (_, index) => {
      const firstImageIndex = imageSequence
      imageSequence += imagesPerRequest
      return runOne(index, firstImageIndex)
    }))
    monitoring = false
    await monitor
    const drain = await waitForDrain()
    const finalGateway = drain.snapshot
    const statuses: Record<string, number> = {}
    const failureKinds: Record<string, number> = {}
    for (const sample of samples) {
      const status = String(sample.status)
      statuses[status] = (statuses[status] ?? 0) + 1
      if (sample.failureKind) failureKinds[sample.failureKind] = (failureKinds[sample.failureKind] ?? 0) + 1
    }
    const succeeded = samples.filter(sample => sample.completed).length
    const failed = requested - succeeded
    const phasePassed = failed === 0 && drain.drained
    if (phasePassed && highestSuccessfulPhase === null) highestSuccessfulPhase = requested
    if (!phasePassed) observedFailure = true
    console.log(JSON.stringify({
      event: 'vision_loadtest_phase',
      requested,
      succeeded,
      failed,
      statuses,
      failureKinds,
      totalMs: { p50: percentile(samples.map(sample => sample.totalMs), 0.5), p95: percentile(samples.map(sample => sample.totalMs), 0.95) },
      observedGateway: { pools: observed, samples: healthSamples, unavailableSamples: unavailableHealthSamples },
      finalGateway: finalGateway?.capacity ?? null,
      drained: drain.drained,
    }))
    if (!phasePassed && !continueAfterFailure) {
      console.error('Stopping after a failed phase because --stop-after-failure was supplied.')
      process.exitCode = 1
      return
    }
    if (requested !== phases.at(-1)) await sleep(pauseMs)
  }
  console.log(JSON.stringify({
    event: 'vision_loadtest_result',
    requestedMaximum: phases[0] ?? 0,
    highestSuccessfulPhase,
    allPhasesSucceeded: !observedFailure,
  }))
  // A lower phase can still identify a usable ceiling, but the process must be
  // non-zero whenever the requested upper envelope was not cleanly sustained.
  if (observedFailure || highestSuccessfulPhase === null) process.exitCode = 1
}

if (import.meta.main) await main()
