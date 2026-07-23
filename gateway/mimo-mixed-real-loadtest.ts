/**
 * Controlled real-upstream validation for the MiMo 64-slot reservation.
 *
 * The default wave is deliberately fixed to the production split: 48 native
 * MiMo streams plus 16 DeepSeek -> MiMo image-bridge requests.  It never runs
 * without --execute, never prints credentials/request bodies/model output, and
 * caps the whole run at 64 requests / 16 generated images so it cannot become
 * a disguised 500-image load test.
 */

import { generatedPng, validatePng } from './vision-real-loadtest'

export const DEFAULT_NATIVE_SLOTS = 48
export const DEFAULT_VISION_SLOTS = 16
const MAX_TOTAL_REQUESTS = 64
const MAX_VISION_REQUESTS = 16
const MAX_RESPONSE_BYTES = 1024 * 1024
const PROVIDER_GATEWAY_PROTOCOL = 'bb-provider-gateway/1.0'

type Capacity = {
  active?: number
  queued?: number
  maxConcurrent?: number
  nativeReserved?: number
  visionReserved?: number
}

type VisionCapacity = Capacity & {
  limit?: number
}

export type GatewayHealth = {
  capacity?: {
    mimo?: Capacity
    mimo_native?: Capacity
    mimo_total?: Capacity
    vision?: VisionCapacity
  }
}

export type LoadTarget = {
  base: URL
  baseUrl: string
  targetOrigin: string
}

export type MixedShape = {
  nativeSlots: number
  visionSlots: number
  totalSlots: number
}

type Lane = 'native' | 'bridge'

type RequestResult = {
  lane: Lane
  status: number
  totalMs: number
  completed: boolean
  failure?: 'timeout' | 'network' | 'unexpected_content_type' | 'incomplete_sse' | 'invalid_json' | 'empty_completion' | `http_${number}`
}

type ObservedCapacity = {
  active: number
  queued: number
  maxConcurrent: number
  limit: number
}

type ObservedHealth = Record<'mimo' | 'mimo_native' | 'mimo_total' | 'vision', ObservedCapacity>

function usage(exitCode = 2): never {
  console.error(`Usage:
  QF_LOADTEST_URL=https://gateway.example/gw \\
  QF_LOADTEST_TOKEN=<app-token> \\
  QF_LOADTEST_CONSENT_RECEIPT=<64-hex-consent-receipt> \\
  bun gateway/mimo-mixed-real-loadtest.ts --execute [options]

Options:
  --native-slots=<n>          Native MiMo requests and expected native reservation (default: 48)
  --vision-slots=<n>          Unique bridge-image requests and expected vision reservation (default: 16, max: 16)
  --thinking=enabled|disabled Downstream DeepSeek thinking mode (default: enabled)
  --native-max-tokens=<n>     Native stream token cap (default: 64, max: 128)
  --bridge-max-tokens=<n>     Bridge downstream token cap (default: 256, max: 512)
  --image-seed=<n>            Unique PNG seed (default: current time)
  --timeout-ms=<n>            Per-request deadline (default: 180000)
  --drain-timeout-ms=<n>      Wait for all MiMo views to drain (default: request timeout)
  --health-interval-ms=<n>    Health sampling interval (default: 100)
  --health-timeout-ms=<n>     Health request deadline (default: 1000)
  --use-server-app-token      Only on http://127.0.0.1:8799; read the local app token

The runner sends exactly one same-wave reservation check. It requires an idle,
authenticated health snapshot before traffic, checks the 48 + 16 reservation,
and requires all four MiMo health views to drain back to zero afterwards.`)
  process.exit(exitCode)
}

function option(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length)
}

function positiveInteger(value: string | undefined, name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be a positive integer`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be between 1 and ${max}`)
  }
  return parsed
}

export function parseMixedShape(nativeRaw: string | undefined, visionRaw: string | undefined): MixedShape {
  const nativeSlots = positiveInteger(nativeRaw, '--native-slots', DEFAULT_NATIVE_SLOTS, MAX_TOTAL_REQUESTS)
  const visionSlots = positiveInteger(visionRaw, '--vision-slots', DEFAULT_VISION_SLOTS, MAX_VISION_REQUESTS)
  const totalSlots = nativeSlots + visionSlots
  if (totalSlots > MAX_TOTAL_REQUESTS) {
    throw new Error(`--native-slots plus --vision-slots must not exceed ${MAX_TOTAL_REQUESTS}`)
  }
  return { nativeSlots, visionSlots, totalSlots }
}

export function parseThinkingMode(value: string | undefined): 'enabled' | 'disabled' {
  if (value === undefined) return 'enabled'
  if (value === 'enabled' || value === 'disabled') return value
  throw new Error('--thinking must be enabled or disabled')
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
  return isHttpLoopback(url) && url.port === '8799' && url.pathname === '/'
}

/** Refuse plaintext external targets and URL-embedded secrets before reading any token. */
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

/** A generated image is validated and unique per bridge request, defeating cache/singleflight bias. */
export function uniquePngDataUrl(seed: number, index: number): string {
  const bytes = generatedPng(seed + index)
  validatePng(bytes)
  return `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`
}

function value(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value!)) : 0
}

function capacityView(capacity: Capacity | VisionCapacity | undefined): ObservedCapacity {
  return {
    active: value(capacity?.active),
    queued: value(capacity?.queued),
    maxConcurrent: value(capacity?.maxConcurrent),
    limit: value((capacity as VisionCapacity | undefined)?.limit),
  }
}

function emptyObservedHealth(): ObservedHealth {
  return {
    mimo: { active: 0, queued: 0, maxConcurrent: 0, limit: 0 },
    mimo_native: { active: 0, queued: 0, maxConcurrent: 0, limit: 0 },
    mimo_total: { active: 0, queued: 0, maxConcurrent: 0, limit: 0 },
    vision: { active: 0, queued: 0, maxConcurrent: 0, limit: 0 },
  }
}

function observe(target: ObservedHealth, health: GatewayHealth | null): void {
  const capacity = health?.capacity
  for (const name of ['mimo', 'mimo_native', 'mimo_total', 'vision'] as const) {
    const incoming = capacityView(capacity?.[name])
    target[name].active = Math.max(target[name].active, incoming.active)
    target[name].queued = Math.max(target[name].queued, incoming.queued)
    target[name].maxConcurrent = Math.max(target[name].maxConcurrent, incoming.maxConcurrent)
    target[name].limit = Math.max(target[name].limit, incoming.limit)
  }
}

/** Static reservation fields must agree before any paid/real upstream work starts. */
export function reservationHealthErrors(health: GatewayHealth | null, shape: MixedShape): string[] {
  const capacity = health?.capacity
  const mimo = capacity?.mimo
  const native = capacity?.mimo_native
  const total = capacity?.mimo_total
  const vision = capacity?.vision
  const errors: string[] = []
  if (!mimo || !native || !total || !vision) return ['authenticated health is missing one or more MiMo capacity views']
  const expect = (actual: number | undefined, expected: number, label: string) => {
    if (value(actual) !== expected) errors.push(`${label}=${value(actual)} (expected ${expected})`)
  }
  expect(mimo.maxConcurrent, shape.totalSlots, 'mimo.maxConcurrent')
  expect(total.maxConcurrent, shape.totalSlots, 'mimo_total.maxConcurrent')
  expect(native.maxConcurrent, shape.nativeSlots, 'mimo_native.maxConcurrent')
  expect(vision.limit, shape.visionSlots, 'vision.limit')
  expect(mimo.nativeReserved, shape.nativeSlots, 'mimo.nativeReserved')
  expect(mimo.visionReserved, shape.visionSlots, 'mimo.visionReserved')
  expect(total.nativeReserved, shape.nativeSlots, 'mimo_total.nativeReserved')
  expect(total.visionReserved, shape.visionSlots, 'mimo_total.visionReserved')
  return errors
}

/** The run is controlled only when no prior caller owns or waits for a MiMo slot. */
export function idleHealthErrors(health: GatewayHealth | null): string[] {
  const capacity = health?.capacity
  const errors: string[] = []
  for (const name of ['mimo', 'mimo_native', 'mimo_total', 'vision'] as const) {
    const snapshot = capacity?.[name]
    if (!snapshot) {
      errors.push(`${name} is unavailable`)
      continue
    }
    if (value(snapshot.active) !== 0 || value(snapshot.queued) !== 0) {
      errors.push(`${name} is busy (active=${value(snapshot.active)}, queued=${value(snapshot.queued)})`)
    }
  }
  return errors
}

/** A successful wave must leave every authenticated MiMo capacity view explicitly at zero. */
export function isMiMoCapacityDrained(health: GatewayHealth | null): boolean {
  const capacity = health?.capacity
  return ['mimo', 'mimo_native', 'mimo_total', 'vision'].every(name => {
    const snapshot = capacity?.[name as keyof NonNullable<GatewayHealth['capacity']>]
    return snapshot !== undefined
      && Number.isFinite(snapshot.active)
      && Number.isFinite(snapshot.queued)
      && Math.trunc(snapshot.active!) === 0
      && Math.trunc(snapshot.queued!) === 0
  })
}

/** A full same-wave reservation is only proven if health actually observed every lane at its target. */
export function observedReservationErrors(observed: ObservedHealth, shape: MixedShape): string[] {
  const errors: string[] = []
  const expected: Array<[keyof ObservedHealth, number]> = [
    ['mimo', shape.totalSlots],
    ['mimo_total', shape.totalSlots],
    ['mimo_native', shape.nativeSlots],
    ['vision', shape.visionSlots],
  ]
  for (const [name, active] of expected) {
    if (observed[name].active < active) {
      errors.push(`${name} observed active=${observed[name].active} (expected at least ${active})`)
    }
    if (observed[name].queued > 0) {
      errors.push(`${name} observed queued=${observed[name].queued} during exact reservation wave`)
    }
  }
  return errors
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
}

function completionHasText(input: unknown): boolean {
  if (!isRecord(input) || !Array.isArray(input.choices)) return false
  return input.choices.some(choice =>
    isRecord(choice)
    && isRecord(choice.message)
    && typeof choice.message.content === 'string'
    && choice.message.content.trim().length > 0,
  )
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Deliberately discard error/output bytes.
  }
}

async function readLimitedText(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
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
  const output = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(output)
}

class SseDoneDetector {
  private buffered = ''
  private sawDone = false
  private invalidAfterDone = false

  push(text: string): void {
    this.buffered = `${this.buffered}${text}`.slice(-64 * 1024)
    while (true) {
      const match = /\r\n\r\n|\n\n|\r\r/.exec(this.buffered)
      if (!match || match.index === undefined) return
      const event = this.buffered.slice(0, match.index)
      this.buffered = this.buffered.slice(match.index + match[0].length)
      if (!event) continue
      if (this.sawDone) {
        this.invalidAfterDone = true
        continue
      }
      const dataLines = event.split(/\r\n|\r|\n/).filter(line => line.startsWith('data:'))
      if (dataLines.length === 1 && dataLines[0] === 'data: [DONE]') this.sawDone = true
    }
  }

  completed(): boolean {
    return this.sawDone && !this.invalidAfterDone && this.buffered.trim().length === 0
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
  if (!isRecord(tokens)) throw new Error('qfgw app-token map is unavailable')
  const token = Object.keys(tokens).find(candidate => candidate.length > 0)
  if (!token) throw new Error('qfgw app-token map is unavailable')
  return token
}

function countStatuses(results: RequestResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const result of results) counts[String(result.status)] = (counts[String(result.status)] ?? 0) + 1
  return counts
}

function countFailures(results: RequestResult[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const result of results) {
    if (result.completed) continue
    const key = result.failure ?? `http_${result.status}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function percentiles(results: RequestResult[]): { p50: number | null; p95: number | null } {
  if (results.length === 0) return { p50: null, p95: null }
  const values = results.map(result => result.totalMs).sort((a, b) => a - b)
  const at = (ratio: number) => values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)] ?? null
  return { p50: at(0.5), p95: at(0.95) }
}

async function main(): Promise<void> {
  const args = Bun.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) usage(0)
  if (!args.includes('--execute')) {
    console.error('Refusing to send real MiMo traffic without --execute.')
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

  const shape = parseMixedShape(option(args, '--native-slots'), option(args, '--vision-slots'))
  const thinking = parseThinkingMode(option(args, '--thinking'))
  const nativeMaxTokens = positiveInteger(option(args, '--native-max-tokens'), '--native-max-tokens', 64, 128)
  const bridgeMaxTokens = positiveInteger(option(args, '--bridge-max-tokens'), '--bridge-max-tokens', 256, 512)
  const imageSeed = positiveInteger(option(args, '--image-seed'), '--image-seed', Date.now())
  const timeoutMs = positiveInteger(option(args, '--timeout-ms'), '--timeout-ms', 180_000, 600_000)
  const drainTimeoutMs = positiveInteger(option(args, '--drain-timeout-ms'), '--drain-timeout-ms', timeoutMs, 600_000)
  const healthIntervalMs = positiveInteger(option(args, '--health-interval-ms'), '--health-interval-ms', 100, 10_000)
  const healthTimeoutMs = positiveInteger(option(args, '--health-timeout-ms'), '--health-timeout-ms', 1_000, 30_000)
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-BB-Data-Egress-Consent': consentReceiptId,
    'X-BB-Provider-Protocol': PROVIDER_GATEWAY_PROTOCOL,
  }
  const bridgeImages = Array.from({ length: shape.visionSlots }, (_, index) => uniquePngDataUrl(imageSeed, index))

  async function health(): Promise<GatewayHealth | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), healthTimeoutMs)
    try {
      const response = await fetch(`${baseUrl}/healthz`, { headers, redirect: 'error', signal: controller.signal })
      if (!response.ok) {
        await cancelResponseBody(response)
        return null
      }
      const text = await readLimitedText(response)
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
    while (!isMiMoCapacityDrained(snapshot) && performance.now() < deadline) {
      await sleep(Math.min(250, Math.max(1, deadline - performance.now())))
      snapshot = await health()
    }
    return { snapshot, drained: isMiMoCapacityDrained(snapshot) }
  }

  const initialHealth = await health()
  const preflightErrors = [...reservationHealthErrors(initialHealth, shape), ...idleHealthErrors(initialHealth)]
  if (preflightErrors.length > 0) {
    console.error(`Refusing mixed run: ${preflightErrors.join('; ')}`)
    process.exitCode = 1
    return
  }

  const startGate = (() => {
    let release: (() => void) | undefined
    const promise = new Promise<void>(resolve => { release = resolve })
    return { promise, release: () => release?.() }
  })()

  async function runNative(index: number): Promise<RequestResult> {
    await startGate.promise
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'X-QF-Client-ID': `mixed-native-${String(index).padStart(3, '0')}` },
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({
          model: 'mimo-v2.5',
          stream: true,
          max_tokens: nativeMaxTokens,
          thinking: { type: 'disabled' },
          temperature: 0,
          messages: [{ role: 'user', content: '请逐行输出从 1 到 16 的整数，不要加任何解释。' }],
        }),
      })
      if (!response.ok) {
        await cancelResponseBody(response)
        return { lane: 'native', status: response.status, totalMs: Math.round(performance.now() - started), completed: false, failure: `http_${response.status}` }
      }
      if (response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'text/event-stream') {
        await cancelResponseBody(response)
        return { lane: 'native', status: response.status, totalMs: Math.round(performance.now() - started), completed: false, failure: 'unexpected_content_type' }
      }
      const reader = response.body?.getReader()
      const detector = new SseDoneDetector()
      let sawChunk = false
      if (reader) {
        const decoder = new TextDecoder()
        try {
          while (true) {
            const next = await reader.read()
            if (next.done) break
            if (next.value.byteLength === 0) continue
            sawChunk = true
            detector.push(decoder.decode(next.value, { stream: true }))
          }
          detector.push(decoder.decode())
        } finally {
          reader.releaseLock()
        }
      }
      const completed = sawChunk && detector.completed()
      return {
        lane: 'native',
        status: response.status,
        totalMs: Math.round(performance.now() - started),
        completed,
        failure: completed ? undefined : 'incomplete_sse',
      }
    } catch {
      return {
        lane: 'native',
        status: 0,
        totalMs: Math.round(performance.now() - started),
        completed: false,
        failure: controller.signal.aborted ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  async function runBridge(index: number): Promise<RequestResult> {
    await startGate.promise
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const started = performance.now()
    try {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { ...headers, 'X-QF-Client-ID': `mixed-vision-${String(index).padStart(3, '0')}` },
        redirect: 'error',
        signal: controller.signal,
        body: JSON.stringify({
          model: 'deepseek-v4-flash',
          stream: false,
          max_tokens: bridgeMaxTokens,
          thinking: { type: thinking },
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: '请只回复 OK。' },
              { type: 'image_url', image_url: { url: bridgeImages[index] } },
            ],
          }],
        }),
      })
      if (!response.ok) {
        await cancelResponseBody(response)
        return { lane: 'bridge', status: response.status, totalMs: Math.round(performance.now() - started), completed: false, failure: `http_${response.status}` }
      }
      const text = await readLimitedText(response)
      if (text === null) {
        return { lane: 'bridge', status: response.status, totalMs: Math.round(performance.now() - started), completed: false, failure: 'invalid_json' }
      }
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        return { lane: 'bridge', status: response.status, totalMs: Math.round(performance.now() - started), completed: false, failure: 'invalid_json' }
      }
      const completed = completionHasText(payload)
      return {
        lane: 'bridge',
        status: response.status,
        totalMs: Math.round(performance.now() - started),
        completed,
        failure: completed ? undefined : 'empty_completion',
      }
    } catch {
      return {
        lane: 'bridge',
        status: 0,
        totalMs: Math.round(performance.now() - started),
        completed: false,
        failure: controller.signal.aborted ? 'timeout' : 'network',
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const observed = emptyObservedHealth()
  let unavailableHealthSamples = 0
  let healthSamples = 0
  const sampleHealth = async () => {
    const snapshot = await health()
    healthSamples += 1
    if (!snapshot) unavailableHealthSamples += 1
    observe(observed, snapshot)
  }
  await sampleHealth()

  let monitoring = true
  const monitor = (async () => {
    while (monitoring) {
      const started = performance.now()
      await sampleHealth()
      await sleep(Math.max(0, healthIntervalMs - (performance.now() - started)))
    }
  })()
  const nativeTasks = Array.from({ length: shape.nativeSlots }, (_, index) => runNative(index))
  const bridgeTasks = Array.from({ length: shape.visionSlots }, (_, index) => runBridge(index))
  console.log(JSON.stringify({
    event: 'mimo_mixed_loadtest_start',
    targetOrigin,
    nativeSlots: shape.nativeSlots,
    visionSlots: shape.visionSlots,
    totalSlots: shape.totalSlots,
    bridgeImages: shape.visionSlots,
    thinking,
  }))
  startGate.release()
  const [nativeResults, bridgeResults] = await Promise.all([Promise.all(nativeTasks), Promise.all(bridgeTasks)])
  monitoring = false
  await monitor
  const drain = await waitForDrain()
  const finalHealth = drain.snapshot

  const allResults = [...nativeResults, ...bridgeResults]
  const errors = [
    ...observedReservationErrors(observed, shape),
    ...(drain.drained ? [] : [`MiMo capacity did not drain within ${drainTimeoutMs}ms`]),
  ]
  if (unavailableHealthSamples > 0) errors.push(`health unavailable for ${unavailableHealthSamples} sample(s)`)
  if (allResults.some(result => !result.completed)) errors.push('one or more native or bridge requests did not complete')

  console.log(JSON.stringify({
    event: 'mimo_mixed_loadtest_result',
    targetOrigin,
    native: {
      requested: nativeResults.length,
      succeeded: nativeResults.filter(result => result.completed).length,
      statuses: countStatuses(nativeResults),
      failures: countFailures(nativeResults),
      totalMs: percentiles(nativeResults),
    },
    bridge: {
      requested: bridgeResults.length,
      succeeded: bridgeResults.filter(result => result.completed).length,
      statuses: countStatuses(bridgeResults),
      failures: countFailures(bridgeResults),
      totalMs: percentiles(bridgeResults),
    },
    observedHealth: observed,
    healthSamples,
    unavailableHealthSamples,
    finalGateway: finalHealth?.capacity ?? null,
    drained: drain.drained,
    passed: errors.length === 0,
  }))
  if (errors.length > 0) {
    console.error(`MiMo mixed reservation validation failed: ${errors.join('; ')}`)
    process.exitCode = 1
  }
}

if (import.meta.main) await main()
