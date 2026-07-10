import { Buffer } from 'node:buffer'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { decode as decodeJpeg } from 'jpeg-js'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'
import * as QRCode from 'qrcode'
import type { FetchLike } from '../proxy/ProxyModel'
import type { Model } from '../types/model'
import type { TaskMeta, TaskRunnerContext, TaskService, TaskStatus } from '../tasks/taskService'
import { VideoEditProjectStore } from './videoEditProjects'
import { ffmpegBinFrom, gateMediaAssets } from './mediaBinaries'
import { PUBLIC_IMAGE_FALLBACK_NOTE, publicImageEngineLabel, scrubProviderIdentifiers } from '../model/publicModelNames'
import {
  detectPortraitIntent,
  inputQualityBlockedResult,
  portraitConsentGranted,
  portraitConsentRequiredResult,
  portraitFlagged,
  type PortraitIntent,
} from './portraitGate'
import {
  buildQcModelFromEnv,
  inspectInputImage,
  inspectPortraitResult,
  normalizeImageMediaType,
  proofreadHardText,
  type InputInspection,
  type QcImage,
} from './imageQC'

export type MediaJobKind =
  | 'generate'
  | 'edit'
  | 'variations'
  | 'compose'
  | 'video_inventory'
  | 'video_render'
  | 'video_auto_plan'

export interface MediaJobStatus {
  id: string
  kind: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number
  stage: string | null
  result: Record<string, unknown> | null
  error: string | null
}

export interface MediaJobStartResult {
  job_id: string
  project?: string
}

export interface MediaJobServiceOptions {
  tasks: TaskService
  stateRoot: string
  backendUrl?: string
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
  pollIntervalMs?: number
  prepareImageBody?: (body: Record<string, unknown>, mode: 'generate' | 'edit') => Record<string, unknown> | Promise<Record<string, unknown>>
  /** 人像质检/OCR 用的网关 VLM(测试注入 fake;传 null 显式禁用;不传则按 env 构造,缺配置=优雅降级)。 */
  qcModel?: Model | null
}

/** 人像闸预检结果:blocked=true 则任务直接返回该结果(正常完成、非报错),不进模型。 */
type PortraitPreflightOutcome = { blocked: true; result: Record<string, unknown> } | { blocked: false }

/** 预检与生成后加工之间共享的人像上下文(同一次 start* 的两个闭包共享)。 */
interface PortraitShared {
  intent?: PortraitIntent
  inputInspection?: InputInspection
}

interface StartMediaJobInput {
  kind: MediaJobKind
  title: string
  body: Record<string, unknown>
  conversationId?: string
  workspaceRoot?: string
  proxyPath?: string
  project?: string
  fallback?: (ctx: TaskRunnerContext, task: TaskMeta) => Promise<Record<string, unknown>>
  /** 生成前的合规/质检闸;返回 blocked 则短路,不调模型。 */
  preflight?: (ctx: TaskRunnerContext) => Promise<PortraitPreflightOutcome>
  /** 生成后加工(结果质检/OCR 等),把质检字段并进结果。 */
  postprocess?: (ctx: TaskRunnerContext, result: Record<string, unknown>) => Promise<Record<string, unknown>>
}

interface DirectImageConfig {
  baseUrl: string
  token: string
  model: string
  endpointPath: '/images/generations' | '/ark/images/generations'
  provider: 'openai-compatible' | 'seedream-gateway'
  route: ImageModelRoute
}

interface ResolvedImageReference {
  role: string
  url: string
  contentType?: string
  bytes?: Buffer
  filename?: string
}

interface PrintQrInspection {
  status: 'ok' | 'warning' | 'unknown'
  width?: number
  height?: number
  warnings: string[]
}

type PrintQrRegenerationStatus = 'generated' | 'source_only' | 'failed' | 'none'
type PrintQrRegenerationSource = 'declared' | 'decoded_image'

interface PrintQrRegeneration {
  status: Extract<PrintQrRegenerationStatus, 'generated' | 'failed' | 'none'>
  path?: string
  warning?: string
  source?: PrintQrRegenerationSource
}

interface PrintQrDecodeResult {
  content: string | null
  warning?: string
}

interface HardTextInspection {
  status: 'pending_ocr'
  expected: string[]
  message: string
}

interface ImageModelRoute {
  reason: string
  explicit: boolean
  requestedModel?: string
  warning?: string
}

const POLL_LIMIT = 1800
const DEFAULT_POLL_MS = 1000
const MIN_PRINT_QR_SOURCE_PX = 240
const MAX_PRINT_QR_CONTENT_LENGTH = 2048
const MAX_PRINT_QR_DECODE_PIXELS = 16_000_000
const DEFAULT_SEEDREAM_IMAGE_RETRIES = 2
const DEFAULT_SEEDREAM_IMAGE_MODEL = 'doubao-seedream-4-5-251128'
const DEFAULT_GPT_IMAGE_MODEL = 'gpt-image-2'
const SEEDREAM_ONLY_RATIOS = new Set(['2:5', '5:2'])
const COMPLEX_CREATIVE_KEYWORDS = [
  '写实人像',
  '高保真',
  '高保真度',
  'photorealistic',
  'photo-realistic',
  'high fidelity',
  'high-fidelity',
  '复杂创意',
  '艺术级',
  '电影感人像',
  '肖像重塑',
]
const EDIT_TEXT_FIX_KEYWORDS = [
  '错别字',
  '打错',
  '改错字',
  '字错了',
  '文字错',
  '别字',
  '重复字',
  '多了个字',
  '少了个字',
  '文字看不清',
  '文字模糊',
  '改文字',
  '改个字',
]

function normalizeBackendUrl(url: string | undefined): string | undefined {
  const trimmed = url?.trim().replace(/\/+$/, '')
  return trimmed || undefined
}

function normalizeProvider(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function resolveMediaBackendUrl(env: Record<string, string | undefined> = process.env): string | undefined {
  return normalizeBackendUrl(
    env.MEDIA_BACKEND_URL ??
    env.PYTHON_BACKEND_URL ??
    env.LEGACY_BACKEND_URL ??
    env.QF_MEDIA_BACKEND_URL,
  )
}

function statusFromTask(status: TaskStatus): MediaJobStatus['status'] {
  if (status === 'queued') return 'queued'
  if (status === 'running') return 'running'
  if (status === 'completed') return 'done'
  return 'error'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { text: value }
  } catch {
    return { text: value }
  }
}

function numberFrom(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : NaN
  return Number.isFinite(n) ? n : fallback
}

function upstreamStatusFrom(value: Record<string, unknown>): MediaJobStatus {
  const rawStatus = value.status
  const status: MediaJobStatus['status'] = rawStatus === 'done' || rawStatus === 'completed'
    ? 'done'
    : rawStatus === 'error' || rawStatus === 'failed' || rawStatus === 'cancelled'
      ? 'error'
      : rawStatus === 'queued'
        ? 'queued'
        : 'running'
  return {
    id: String(value.id ?? value.job_id ?? ''),
    kind: String(value.kind ?? 'media'),
    status,
    progress: numberFrom(value.progress, status === 'done' ? 100 : 0),
    stage: typeof value.stage === 'string' ? value.stage : null,
    result: asRecord(value.result),
    error: typeof value.error === 'string' ? value.error : typeof value.detail === 'string' ? value.detail : null,
  }
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isSeedreamImageModel(model: string | undefined): boolean {
  return /(?:seedream|doubao-seedream)/i.test(model ?? '')
}

function isOpenAiImageModel(model: string | undefined): boolean {
  return /(?:gpt-image|openai)/i.test(model ?? '')
}

function seedreamImageModelFrom(env: Record<string, string | undefined>, envModel: string | undefined): string {
  return stringFrom(env.SEEDREAM_IMAGE_MODEL_NAME) ??
    stringFrom(env.IMAGE_SEEDREAM_MODEL_NAME) ??
    (isSeedreamImageModel(envModel) ? envModel! : DEFAULT_SEEDREAM_IMAGE_MODEL)
}

function openAiImageModelFrom(env: Record<string, string | undefined>, envModel: string | undefined): string {
  return stringFrom(env.OPENAI_IMAGE_MODEL_NAME) ??
    stringFrom(env.GPT_IMAGE_MODEL_NAME) ??
    (!isSeedreamImageModel(envModel) && envModel ? envModel : DEFAULT_GPT_IMAGE_MODEL)
}

function containsAny(text: string, needles: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return needles.some(needle => lower.includes(needle.toLowerCase()))
}

function hasHardTextRequirement(prompt: string, posterText: unknown): boolean {
  const collect = (value: unknown): boolean => {
    if (typeof value === 'string') return value.trim().length > 0
    if (typeof value === 'number') return Number.isFinite(value)
    if (Array.isArray(value)) return value.some(collect)
    if (value && typeof value === 'object') return Object.values(value).some(collect)
    return false
  }
  if (collect(posterText)) return true
  return containsAny(prompt, ['写上', '写着', '中文文案排版', '标题文字要'])
}

function addHardTextCandidate(out: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number') return
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (text.length < 2) return
  const clipped = text.length > 80 ? `${text.slice(0, 80)}...` : text
  const key = clipped.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  out.push(clipped)
}

function collectStructuredHardText(value: unknown, out: string[], seen: Set<string>): void {
  if (typeof value === 'string' || typeof value === 'number') {
    addHardTextCandidate(out, seen, value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredHardText(item, out, seen)
    return
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStructuredHardText(item, out, seen)
  }
}

function collectPromptHardText(prompt: string, out: string[], seen: Set<string>): void {
  for (const match of prompt.matchAll(/[“"《「『‘']([^”"》」』’']{2,60})[”"》」』’']/gu)) {
    addHardTextCandidate(out, seen, match[1])
  }
  for (const match of prompt.matchAll(/(?:写上|写着|写成|加上|主标题|副标题|标题文字|海报文字|文案)\s*(?:[：:为叫是]\s*)?([^，。；;！!\n“"《「『‘”"》」』’']{2,48})/giu)) {
    addHardTextCandidate(out, seen, match[1])
  }
}

function inspectHardTextRequirement(body: Record<string, unknown>, prompt: string): HardTextInspection | null {
  const seen = new Set<string>()
  const expected: string[] = []
  collectStructuredHardText(body.poster_text, expected, seen)
  const promptText = [
    prompt,
    typeof body.prompt === 'string' ? body.prompt : '',
    typeof body.description === 'string' ? body.description : '',
    typeof body.image_prompt === 'string' ? body.image_prompt : '',
  ].filter(Boolean).join('\n')
  collectPromptHardText(promptText, expected, seen)

  if (!expected.length && !hasHardTextRequirement(promptText, body.poster_text)) return null
  const preview = expected.slice(0, 3).join('、')
  const suffix = expected.length > 3 ? `等 ${expected.length} 项` : ''
  return {
    status: 'pending_ocr',
    expected,
    message: preview ? `投放前请核对文字:${preview}${suffix}` : '投放前请核对海报文字。',
  }
}

function hardTextInspectionFields(inspection: HardTextInspection): Record<string, unknown> {
  return {
    hard_text_required: true,
    hard_text_expected: inspection.expected,
    text_quality_status: inspection.status,
    text_quality_warning: true,
    text_quality_warning_message: inspection.message,
  }
}

function isWesternDominant(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  let cjk = 0
  let letters = 0
  for (const ch of trimmed) {
    if (/[\u4e00-\u9fff]/u.test(ch)) cjk += 1
    else if (/^[A-Za-z]$/.test(ch)) letters += 1
  }
  const total = cjk + letters
  return total > 0 && cjk / total < 0.3
}

function inferImageEditType(prompt: string | undefined, editType: unknown): 'text_fix' | 'content' {
  const explicit = stringFrom(editType)?.toLowerCase()
  if (explicit === 'text_fix' || explicit === 'text' || explicit === '文字') return 'text_fix'
  if (explicit === 'content' || explicit === '内容') return 'content'
  return containsAny(prompt ?? '', EDIT_TEXT_FIX_KEYWORDS) ? 'text_fix' : 'content'
}

function imageRouteFields(config: DirectImageConfig): Record<string, unknown> {
  // 白标:出口只给"能力档"代称(写实生图/创意生图),不回显真实 provider/model、
  // 不回显 route.reason 原文(含 seedream/openai)、不回显 requested_image_model(原样带真实名)。
  return {
    image_engine: publicImageEngineLabel({
      provider: config.provider,
      model: config.model,
      reason: config.route.reason,
    }),
    ...(config.route.warning ? { image_engine_warning: scrubProviderIdentifiers(config.route.warning) } : {}),
  }
}

function sanitizeMediaError(err: unknown): string {
  // 白标:除清 Bearer/api-key 外,再过 scrubProviderIdentifiers 清掉真实模型名/供应商/endpoint。
  return scrubProviderIdentifiers(
    (err instanceof Error ? err.message : String(err))
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [redacted]')
      .replace(/(api[_-]?key["'\s:=]+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'),
  ).slice(0, 500)
}

function clampCount(value: unknown): number {
  const n = numberFrom(value, 1)
  return Math.max(1, Math.min(4, n))
}

function ratioSize(ratio: unknown): { ratio: string; width: number; height: number } {
  const r = typeof ratio === 'string' ? ratio : ''
  if (r === '1:1') return { ratio: r, width: 1024, height: 1024 }
  if (r === '9:16') return { ratio: r, width: 1152, height: 2048 }
  if (r === '16:9') return { ratio: r, width: 2048, height: 1152 }
  if (r === '2:5') return { ratio: r, width: 1216, height: 3040 }
  if (r === '5:2') return { ratio: r, width: 3040, height: 1216 }
  return { ratio: '3:4', width: 1152, height: 1536 }
}

// 火山 Seedream 出图尺寸像素下限(≈1920²)。低于此火山报 InvalidParameter: image size must be at least
// 3686400 pixels。默认 3:4(1152×1536=1,769,472)/1:1/9:16/16:9 全部低于下限,不放大则默认生图必失败。
const SEEDREAM_MIN_PIXELS = 3_686_400

function ceilTo16(n: number): number {
  return Math.max(16, Math.ceil(n / 16) * 16)
}

/** 把尺寸等比放大到 Seedream 像素下限、各边取 16 的倍数(对齐老 Python _normalize_seedream_size)。
 *  已达标的也 ceilTo16(向上取整不会掉回下限以下)。 */
function normalizeSeedreamSize(width: number, height: number): { width: number; height: number } {
  const pixels = width * height
  if (pixels >= SEEDREAM_MIN_PIXELS) return { width: ceilTo16(width), height: ceilTo16(height) }
  const scale = Math.sqrt(SEEDREAM_MIN_PIXELS / pixels)
  return { width: ceilTo16(width * scale), height: ceilTo16(height * scale) }
}

function imageSizeForProvider(model: string, ratio: unknown): { ratio: string; width: number; height: number; size: string } {
  const base = ratioSize(ratio)
  if (/gpt|openai/i.test(model)) {
    if (base.ratio === '1:1') return { ...base, width: 1024, height: 1024, size: '1024x1024' }
    if (base.width > base.height) return { ...base, width: 1536, height: 1024, size: '1536x1024' }
    return { ...base, width: 1024, height: 1536, size: '1024x1536' }
  }
  // Seedream(火山方舟):必须放大到像素下限,否则火山 400。
  const s = normalizeSeedreamSize(base.width, base.height)
  return { ...base, width: s.width, height: s.height, size: `${s.width}x${s.height}` }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function shortText(value: unknown, fallback: string): string {
  const text = typeof value === 'string' && value.trim() ? value.trim() : fallback
  return text.length > 88 ? `${text.slice(0, 88)}...` : text
}

function contentTypeFor(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.svg') return 'image/svg+xml; charset=utf-8'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function imageExtFromContentType(contentType: string | null | undefined): 'png' | 'jpg' | 'webp' {
  const c = (contentType ?? '').toLowerCase()
  if (c.includes('jpeg') || c.includes('jpg')) return 'jpg'
  if (c.includes('webp')) return 'webp'
  return 'png'
}

function imageExtFromUrl(url: string): 'png' | 'jpg' | 'webp' {
  const clean = url.split('?')[0]?.toLowerCase() ?? ''
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'jpg'
  if (clean.endsWith('.webp')) return 'webp'
  return 'png'
}

function joinImageEndpoint(baseUrl: string, endpointPath: DirectImageConfig['endpointPath']): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/(?:v\d+|api\/v\d+)$/i.test(base)) return `${base}${endpointPath}`
  return `${base}/v1${endpointPath}`
}

function joinOpenAiImageEditEndpoint(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/(?:v\d+|api\/v\d+)$/i.test(base)) return `${base}/images/edits`
  return `${base}/v1/images/edits`
}

/** 通用图片子路径拼接(异步任务端点 /images/tasks 用):补齐 /v1 前缀。 */
function joinImagePath(baseUrl: string, subPath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (/\/(?:v\d+|api\/v\d+)$/i.test(base)) return `${base}${subPath}`
  return `${base}/v1${subPath}`
}

function ensureProjectName(value: unknown): string {
  const raw = typeof value === 'string' ? basename(value).replace(/[^A-Za-z0-9_-]/g, '') : ''
  return raw || crypto.randomUUID().replaceAll('-', '').slice(0, 10)
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function dataUriFor(contentType: string, bytes: Buffer): string {
  return `data:${contentType.split(';')[0]};base64,${bytes.toString('base64')}`
}

function parseDataUri(value: string): { contentType: string; bytes: Buffer } | null {
  const match = value.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
  if (!match) return null
  const contentType = match[1] || 'application/octet-stream'
  const raw = match[3] || ''
  try {
    const bytes = match[2] ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw), 'utf8')
    return { contentType, bytes }
  } catch {
    return null
  }
}

function imageDimensions(bytes: Buffer): { width: number; height: number; format: string } | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), format: 'png' }
  }
  if (bytes.length >= 10 && bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/)) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), format: 'gif' }
  }
  if (bytes.length >= 26 && bytes.subarray(0, 2).toString('ascii') === 'BM') {
    return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)), format: 'bmp' }
  }
  const jpeg = jpegDimensions(bytes)
  if (jpeg) return jpeg
  const webp = webpDimensions(bytes)
  if (webp) return webp
  return null
}

function decodePrintQrContentFromBytes(bytes: Buffer): PrintQrDecodeResult {
  const dimensions = imageDimensions(bytes)
  if (!dimensions) {
    return { content: null, warning: '二维码图片格式暂不支持视觉解码，已退回原图叠层。' }
  }
  if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > MAX_PRINT_QR_DECODE_PIXELS) {
    return { content: null, warning: `二维码图片尺寸过大(${dimensions.width}x${dimensions.height})，已退回原图叠层。` }
  }
  try {
    if (dimensions.format === 'png') {
      const png = PNG.sync.read(bytes, { checkCRC: false })
      return decodePrintQrContentFromRgba(png.data, png.width, png.height)
    }
    if (dimensions.format === 'jpeg') {
      const jpeg = decodeJpeg(bytes, {
        useTArray: true,
        formatAsRGBA: true,
        tolerantDecoding: true,
        maxResolutionInMP: Math.ceil(MAX_PRINT_QR_DECODE_PIXELS / 1_000_000),
        maxMemoryUsageInMB: 128,
      })
      return decodePrintQrContentFromRgba(jpeg.data, jpeg.width, jpeg.height)
    }
    return { content: null, warning: `二维码图片格式 ${dimensions.format} 暂不支持视觉解码，已退回原图叠层。` }
  } catch (err) {
    return { content: null, warning: `二维码图片视觉解码失败，已退回原图叠层。原因:${sanitizeMediaError(err)}` }
  }
}

function decodePrintQrContentFromRgba(data: Uint8Array, width: number, height: number): PrintQrDecodeResult {
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    return { content: null, warning: '二维码图片像素数据不完整，已退回原图叠层。' }
  }
  const decoded = jsQR(new Uint8ClampedArray(data), width, height, { inversionAttempts: 'attemptBoth' })
  const content = decoded?.data?.trim()
  if (!content) return { content: null, warning: '二维码图片未能识别出有效内容，已退回原图叠层。' }
  return { content }
}

function jpegDimensions(bytes: Buffer): { width: number; height: number; format: string } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = bytes[offset + 1]
    if (marker === undefined) return null
    offset += 2
    if (marker === 0xd8 || marker === 0xd9) continue
    if (offset + 2 > bytes.length) return null
    const length = bytes.readUInt16BE(offset)
    if (length < 2 || offset + length > bytes.length) return null
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 7) return null
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3), format: 'jpeg' }
    }
    offset += length
  }
  return null
}

function webpDimensions(bytes: Buffer): { width: number; height: number; format: string } | null {
  if (bytes.length < 30 || bytes.subarray(0, 4).toString('ascii') !== 'RIFF' || bytes.subarray(8, 12).toString('ascii') !== 'WEBP') return null
  const chunk = bytes.subarray(12, 16).toString('ascii')
  if (chunk === 'VP8X' && bytes.length >= 30) {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
      format: 'webp',
    }
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
      format: 'webp',
    }
  }
  if (chunk === 'VP8L' && bytes.length >= 25) {
    const b0 = bytes[21]!
    const b1 = bytes[22]!
    const b2 = bytes[23]!
    const b3 = bytes[24]!
    return {
      width: 1 + (((b1 & 0x3f) << 8) | b0),
      height: 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 6)),
      format: 'webp',
    }
  }
  return null
}

function printQrInspectionFields(inspection: PrintQrInspection): Record<string, unknown> {
  return {
    print_qr_source_quality: inspection.status,
    print_qr_source_warnings: inspection.warnings,
    ...(inspection.width ? { print_qr_source_width: inspection.width } : {}),
    ...(inspection.height ? { print_qr_source_height: inspection.height } : {}),
  }
}

function printQrRegenerationFields(
  status: PrintQrRegenerationStatus | null | undefined,
  warning?: string,
  source?: PrintQrRegenerationSource,
): Record<string, unknown> {
  if (!status) return {}
  return {
    print_qr_regeneration: status,
    ...(source ? { print_qr_regeneration_source: source } : {}),
    ...(warning ? { print_qr_regeneration_warning: warning } : {}),
  }
}

function stringArrayFrom(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map(item => item.trim())
    : []
}

export class MediaJobService {
  private readonly backendUrl?: string
  private readonly env: Record<string, string | undefined>
  private readonly uploadsRoot: string
  private readonly fetchImpl: FetchLike
  private readonly pollIntervalMs: number
  private readonly gptImageAsync: boolean
  private qcModelCache: Model | null | undefined

  constructor(private readonly opts: MediaJobServiceOptions) {
    this.backendUrl = normalizeBackendUrl(opts.backendUrl)
    this.env = opts.env ?? process.env
    this.uploadsRoot = join(opts.stateRoot, 'uploads')
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS
    // GPT 生图异步 submit/poll(根治大陆↔美国跨境长连接 60s 被掐:图生成了扣了费却传不回来)。
    // **默认开**(2026-07-11:网关+美国 relay 两台已部署验证全链路,不开等于把根治方案晾着继续白扣钱);
    // 显式 QF_GPT_IMAGE_ASYNC=0/false 可退回同步路径(快请求调试/未部署 relay 的自建环境用)。
    const asyncRaw = stringFrom(this.env.QF_GPT_IMAGE_ASYNC) ?? ''
    this.gptImageAsync = asyncRaw === '' ? true : /^(1|true|yes|on)$/i.test(asyncRaw)
  }

  get hasBackend(): boolean {
    return !!this.backendUrl
  }

  /** 人像质检/OCR 的网关 VLM:显式注入优先(测试),否则按 env 懒构造并缓存;缺配置=null(降级)。 */
  private qcModel(): Model | null {
    if (this.opts.qcModel !== undefined) return this.opts.qcModel
    if (this.qcModelCache === undefined) this.qcModelCache = buildQcModelFromEnv(this.env)
    return this.qcModelCache
  }

  async status(id: string): Promise<MediaJobStatus | null> {
    const task = await this.opts.tasks.get(id)
    return task ? this.statusFromMeta(task) : null
  }

  async startJob(input: StartMediaJobInput): Promise<MediaJobStartResult> {
    const task = await this.opts.tasks.create({
      title: input.title,
      kind: input.kind,
      conversationId: input.conversationId,
      workspaceRoot: input.workspaceRoot,
      params: { ...input.body, ...(input.project ? { project: input.project } : {}) },
    })
    this.opts.tasks.start(task.id, async ctx => {
      if (input.preflight) {
        const outcome = await input.preflight(ctx)
        if (outcome.blocked) return outcome.result
      }
      let result: Record<string, unknown>
      if (this.backendUrl && input.proxyPath) {
        result = await this.runProxyJob(ctx, input.proxyPath, input.body)
      } else if (input.fallback) {
        result = await input.fallback(ctx, task)
      } else {
        throw new Error('媒体后端未配置:请设置 MEDIA_BACKEND_URL 或 PYTHON_BACKEND_URL 后再生成。')
      }
      return input.postprocess ? await input.postprocess(ctx, result) : result
    })
    return { job_id: task.id, ...(input.project ? { project: input.project } : {}) }
  }

  async startStudioGenerate(body: Record<string, unknown>, opts: { conversationId?: string; workspaceRoot?: string } = {}): Promise<MediaJobStartResult> {
    const prepared = await this.prepareImageBody(body, 'generate')
    const normalized = {
      ...prepared,
      _image_mode: 'generate',
      count: clampCount(prepared.count),
      conversation_id: stringFrom(prepared.conversation_id) ?? opts.conversationId,
    }
    const shared: PortraitShared = {}
    return this.startJob({
      kind: 'generate',
      title: `生图:${shortText(body.prompt ?? body.description, '图片')}`,
      body: normalized,
      conversationId: stringFrom(normalized.conversation_id),
      workspaceRoot: opts.workspaceRoot,
      proxyPath: '/api/v1/studio/generate',
      preflight: ctx => this.portraitPreflight(ctx, normalized, 'generate', shared),
      postprocess: (ctx, result) => this.imageResultPostprocess(ctx, result, shared),
      fallback: ctx => this.directOrLocalImageFallback(ctx, normalized, 'generate'),
    })
  }

  async startStudioEdit(body: Record<string, unknown>, opts: { conversationId?: string; workspaceRoot?: string } = {}): Promise<MediaJobStartResult> {
    const prepared = await this.prepareImageBody(body, 'edit')
    const normalized = {
      ...prepared,
      _image_mode: 'edit',
      count: clampCount(prepared.count),
      conversation_id: stringFrom(prepared.conversation_id) ?? opts.conversationId,
    }
    const shared: PortraitShared = {}
    return this.startJob({
      kind: 'edit',
      title: `改图:${shortText(body.prompt, '图片调整')}`,
      body: normalized,
      conversationId: stringFrom(normalized.conversation_id),
      workspaceRoot: opts.workspaceRoot,
      proxyPath: '/api/v1/studio/edit',
      preflight: ctx => this.portraitPreflight(ctx, normalized, 'edit', shared),
      postprocess: (ctx, result) => this.imageResultPostprocess(ctx, result, shared),
      fallback: ctx => this.directOrLocalImageFallback(ctx, normalized, 'edit'),
    })
  }

  startVideoJob(kind: MediaJobKind, proxyPath: string, body: Record<string, unknown>, opts: { conversationId?: string; workspaceRoot?: string; project?: string; title?: string } = {}): Promise<MediaJobStartResult> {
    const project = opts.project ?? ensureProjectName(body.project)
    const normalized = { ...body, project, conversation_id: stringFrom(body.conversation_id) ?? opts.conversationId }
    return this.startJob({
      kind,
      title: opts.title ?? `视频任务:${project}`,
      body: normalized,
      conversationId: stringFrom(normalized.conversation_id),
      workspaceRoot: opts.workspaceRoot,
      proxyPath,
      project,
      fallback: ctx => this.localVideoJobFallback(ctx, kind, normalized, project),
    })
  }

  async proxyJson(path: string, body?: Record<string, unknown>, method = 'POST'): Promise<Record<string, unknown>> {
    if (!this.backendUrl) throw new Error('媒体后端未配置')
    const res = await this.fetchImpl(`${this.backendUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    })
    return await this.readJson(res, path)
  }

  serveUpload(pathname: string): Response | null {
    if (!pathname.startsWith('/uploads/')) return null
    const rel = pathname.slice('/uploads/'.length)
    if (!rel || rel.includes('\0')) return new Response('Not found', { status: 404 })
    const abs = resolve(this.uploadsRoot, rel)
    const root = resolve(this.uploadsRoot)
    if (abs !== root && !abs.startsWith(`${root}/`)) return new Response('Not found', { status: 404 })
    if (!existsSync(abs)) return new Response('Not found', { status: 404 })
    return new Response(Bun.file(abs), { headers: { 'Content-Type': contentTypeFor(abs) } })
  }

  localGeneration(generationId: string): Record<string, unknown> | null {
    const found = this.posterUploadForGenerationId(generationId)
    if (!found) return null
    return {
      url: found.url,
      ratio: null,
      is_video: false,
      local_preview: found.localPreview,
    }
  }

  private statusFromMeta(task: TaskMeta): MediaJobStatus {
    return {
      id: task.id,
      kind: task.kind ?? 'task',
      status: statusFromTask(task.status),
      progress: Math.max(0, Math.min(100, numberFrom(task.progress, task.status === 'completed' ? 100 : 0))),
      stage: task.stage ?? null,
      result: asRecord(task.result),
      error: task.error ?? (task.status === 'cancelled' ? '任务已取消' : null),
    }
  }

  private async readJson(res: Response, label: string): Promise<Record<string, unknown>> {
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : {}
    } catch {
      parsed = { detail: text }
    }
    if (!res.ok) {
      const detail = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? String((parsed as Record<string, unknown>).detail ?? (parsed as Record<string, unknown>).error ?? text)
        : text
      throw new Error(`${label} failed ${res.status}:${detail.slice(0, 500)}`)
    }
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  }

  private async runProxyJob(ctx: TaskRunnerContext, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    await ctx.progress(3, '已收到媒体任务，正在提交给生成服务。')
    const started = await this.proxyJson(path, body)
    const upstreamId = stringFrom(started.job_id)
    if (!upstreamId) return started
    await ctx.progress(8, '媒体任务已提交，正在排队处理。')
    let lastProgress = -1
    let lastStage = ''
    for (let i = 0; i < POLL_LIMIT; i++) {
      if (ctx.signal.aborted) throw new Error('任务已取消')
      const status = upstreamStatusFrom(await this.proxyJson(`/api/v1/agent/media-jobs/${encodeURIComponent(upstreamId)}`, undefined, 'GET'))
      const progress = numberFrom(status.progress, lastProgress < 0 ? 8 : lastProgress)
      const stage = typeof status.stage === 'string' ? status.stage : ''
      if (progress !== lastProgress || (stage && stage !== lastStage)) {
        lastProgress = progress
        lastStage = stage
        await ctx.progress(progress, stage || '媒体任务处理中。')
      }
      if (status.status === 'done') return status.result ?? {}
      if (status.status === 'error') throw new Error(status.error || '媒体任务失败')
      await delay(this.pollIntervalMs)
    }
    throw new Error('媒体任务超时')
  }

  private directImageConfig(body: Record<string, unknown>): DirectImageConfig | null {
    const route = this.routeImageModel(body)
    const wantsSeedream = isSeedreamImageModel(route.model) ||
      route.providerHint.includes('seedream') ||
      route.providerHint.includes('ark')
    if (wantsSeedream) {
      const seedream = this.seedreamImageConfig(route.model, route.route)
      if (seedream) return seedream
      if (!route.route.explicit) {
        const openai = this.openAiImageConfig(route.fallbackOpenAiModel, {
          ...route.route,
          reason: `${route.route.reason}_openai_fallback`,
          warning: '已自动选用备用生图引擎兜底。',
        })
        if (openai) return openai
      }
      return null
    }
    return this.openAiImageConfig(route.model, route.route)
  }

  private seedreamImageConfig(model: string, route: ImageModelRoute): DirectImageConfig | null {
    const baseUrl = normalizeBackendUrl(this.env.QF_GATEWAY_URL)
    const token = stringFrom(this.env.QF_GATEWAY_TOKEN) ?? stringFrom(this.env.ARK_API_KEY)
    if (!baseUrl || !token) return null
    return { baseUrl, token, model, endpointPath: '/ark/images/generations', provider: 'seedream-gateway', route }
  }

  private openAiImageConfig(model: string, route: ImageModelRoute): DirectImageConfig | null {
    const baseUrl = normalizeBackendUrl(this.env.OPENAI_BASE_URL ?? this.env.QF_GATEWAY_URL)
    const token = stringFrom(this.env.OPENAI_API_KEY) ?? stringFrom(this.env.QF_GATEWAY_TOKEN)
    if (!baseUrl || !token) return null
    return { baseUrl, token, model, endpointPath: '/images/generations', provider: 'openai-compatible', route }
  }

  private routeImageModel(body: Record<string, unknown>): {
    model: string
    fallbackOpenAiModel: string
    providerHint: string
    route: ImageModelRoute
  } {
    const explicitModel = stringFrom(body.image_model) ?? stringFrom(body.model)
    const envModel = stringFrom(this.env.IMAGE_MODEL_NAME)
    const seedreamModel = seedreamImageModelFrom(this.env, envModel)
    const openAiModel = openAiImageModelFrom(this.env, envModel)
    const explicitProvider = normalizeProvider(body.image_provider)
    const providerHint = explicitProvider
    const prompt = String(body.image_prompt ?? body.prompt ?? body.description ?? '')

    let model: string
    let reason: string
    let explicit = false
    if (explicitModel) {
      model = explicitModel
      reason = 'explicit_model'
      explicit = true
    } else if (explicitProvider.includes('seedream') || explicitProvider.includes('ark')) {
      model = seedreamModel
      reason = 'explicit_provider_seedream'
      explicit = true
    } else if (explicitProvider.includes('openai') || explicitProvider.includes('gpt')) {
      model = openAiModel
      reason = 'explicit_provider_openai'
      explicit = true
    } else if (body._image_mode === 'edit' || stringFrom(body.source_generation_id)) {
      const editType = inferImageEditType(prompt, body.edit_type)
      model = editType === 'text_fix' ? seedreamModel : openAiModel
      reason = editType === 'text_fix' ? 'edit_text_fix_seedream' : 'edit_content_openai'
    } else if (hasHardTextRequirement(prompt, body.poster_text)) {
      model = seedreamModel
      reason = 'hard_text_seedream'
    } else if (containsAny(prompt, COMPLEX_CREATIVE_KEYWORDS)) {
      model = openAiModel
      reason = 'complex_creative_openai'
    } else if (isWesternDominant(prompt)) {
      model = openAiModel
      reason = 'western_dominant_openai'
    } else {
      model = seedreamModel
      reason = 'default_seedream'
    }

    const requestedModel = explicitModel
    if (SEEDREAM_ONLY_RATIOS.has(String(body.ratio ?? '')) && !isSeedreamImageModel(model)) {
      model = seedreamModel
      reason = 'seedream_only_ratio'
      explicit = false
    }

    return {
      model,
      fallbackOpenAiModel: openAiModel,
      providerHint,
      route: { reason, explicit, requestedModel },
    }
  }

  private async prepareImageBody(body: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    if (this.backendUrl) return body
    if (!this.opts.prepareImageBody) return body
    return await this.opts.prepareImageBody(body, mode)
  }

  private async directOrLocalImageFallback(ctx: TaskRunnerContext, body: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    const config = this.directImageConfig(body)
    if (config) {
      try {
        return await this.directImageGeneration(ctx, body, config, mode)
      } catch (err) {
        const fallback = this.seedreamFallbackAfterOpenAiFailure(config, err)
        if (!fallback) throw err
        await ctx.progress(18, PUBLIC_IMAGE_FALLBACK_NOTE)
        return await this.directImageGeneration(ctx, body, fallback, mode)
      }
    }
    return await this.localImageFallback(ctx, body, mode)
  }

  private seedreamFallbackAfterOpenAiFailure(config: DirectImageConfig, err: unknown): DirectImageConfig | null {
    if (config.provider !== 'openai-compatible') return null
    if (config.route.explicit) return null
    const envModel = stringFrom(this.env.IMAGE_MODEL_NAME)
    const model = seedreamImageModelFrom(this.env, envModel)
    return this.seedreamImageConfig(model, {
      reason: 'openai_failed_seedream_fallback',
      explicit: false,
      requestedModel: config.model,
      warning: `生图引擎失败，已自动切换备用引擎。原因:${sanitizeMediaError(err)}`,
    })
  }

  private async directImageGeneration(ctx: TaskRunnerContext, body: Record<string, unknown>, config: DirectImageConfig, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    const prompt = String(body.image_prompt ?? body.prompt ?? body.description ?? '').trim()
    if (!prompt) throw new Error('生图需要 prompt 或 description')
    const count = clampCount(body.count)
    const sized = imageSizeForProvider(config.model, body.ratio)
    const hardTextInspection = inspectHardTextRequirement(body, prompt)
    const refs = await this.collectImageReferences(body, mode)
    const printLogoPath = this.resolvePrintLogoPath(body)
    const printQrPath = this.resolvePrintQrPath(body)
    const printQrContent = this.resolvePrintQrContent(body)
    const printQrInspection = printQrPath ? await this.inspectPrintQrAsset(printQrPath) : null
    const printQrRegenerationInput: { content: string | null; source?: PrintQrRegenerationSource; warning?: string } = body.print_mode === true
      ? await this.resolvePrintQrRegenerationInput(printQrContent, printQrPath)
      : { content: null as string | null }
    const regeneratedPrintQr = body.print_mode === true
      ? await this.tryRegeneratePrintQrAsset(printQrRegenerationInput.content, printQrRegenerationInput.source, printQrRegenerationInput.warning)
      : { status: 'none' as const }
    const printQrOverlayPath = regeneratedPrintQr.path ?? printQrPath
    const printQrRegenerationStatus: PrintQrRegenerationStatus = regeneratedPrintQr.status === 'generated'
      ? 'generated'
      : regeneratedPrintQr.status === 'failed'
        ? 'failed'
        : printQrPath ? 'source_only' : 'none'
    if (mode === 'edit' && refs.length === 0) throw new Error('改图需要可读取的 source_generation_id 底图')
    await ctx.progress(12, refs.length ? '正在提交到图片编辑网关。' : '正在提交到图片生成网关。')
    let parsed: Record<string, unknown>
    if (config.provider === 'openai-compatible' && this.gptImageAsync) {
      // 根治:GPT 生图走美国 relay 异步任务(submit/poll),慢调用在美国本地跑,避免大陆↔美国跨境长连接 60s 被掐。
      parsed = await this.submitOpenAiImageTask(ctx, prompt, sized, count, body, config, refs, refs.length ? 'edit' : 'generate')
    } else if (config.provider === 'openai-compatible' && refs.length) {
      const form = new FormData()
      form.set('model', config.model)
      form.set('prompt', prompt)
      form.set('n', String(count))
      form.set('size', stringFrom(body.size) ?? sized.size)
      // input_fidelity 只对非 gpt-image-2 的 gpt-image 系列生效;gpt-image-2 恒最高保真、传了会 400(对齐老 Python)。
      if (/^gpt-image/i.test(config.model) && !/^gpt-image-2/i.test(config.model)) {
        form.set('input_fidelity', mode === 'edit' ? 'high' : 'low')
      }
      for (const ref of refs) {
        if (!ref.bytes) continue
        const file = new File([ref.bytes], ref.filename ?? `${ref.role || 'image'}.png`, { type: ref.contentType ?? 'image/png' })
        form.append('image', file)
      }
      const mask = await this.resolveImageReference(stringFrom(body.mask_path), 'mask', this.trustedImagePaths(body))
      if (mask?.bytes) {
        form.set('mask', new File([mask.bytes], mask.filename ?? 'mask.png', { type: mask.contentType ?? 'image/png' }))
      }
      if (form.getAll('image').length === 0) throw new Error('图片编辑网关需要本机可读取的底图或参考图')
      const response = await this.fetchImpl(joinOpenAiImageEditEndpoint(config.baseUrl), {
        method: 'POST',
        headers: { 'authorization': `Bearer ${config.token}` },
        body: form,
      })
      parsed = await this.readJson(response, '/images/edits')
    } else {
      parsed = await this.submitImageGenerationJson(prompt, sized, count, body, config, refs)
    }
    try {
      return await this.persistImageGenerationResult(ctx, parsed, sized, config, refs.length > 0 ? mode : 'generate', {
        printMode: body.print_mode === true,
        printLogoPath,
        printQrPath: printQrOverlayPath,
        printQrInspection,
        printQrRegenerationStatus,
        printQrRegenerationWarning: regeneratedPrintQr.warning,
        printQrRegenerationSource: regeneratedPrintQr.source,
        hardTextInspection,
      })
    } finally {
      if (regeneratedPrintQr.path) await rm(regeneratedPrintQr.path, { force: true }).catch(() => undefined)
    }
  }

  private async submitImageGenerationJson(
    prompt: string,
    sized: { ratio: string; width: number; height: number; size: string },
    count: number,
    body: Record<string, unknown>,
    config: DirectImageConfig,
    refs: ResolvedImageReference[],
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      model: config.model,
      prompt,
      n: count,
      size: stringFrom(body.size) ?? sized.size,
    }
    const responseFormat = stringFrom(body.response_format)
    if (config.provider === 'seedream-gateway') {
      payload.response_format = responseFormat ?? 'url'
      payload.watermark = body.watermark === true ? true : false
      if (refs.length) {
        const images = refs.map(ref => ref.url).slice(0, 14)
        payload.image = images.length === 1 ? images[0] : images
        payload.input_images = images
        payload.sequential_image_generation = 'disabled'
      }
    } else if (responseFormat) {
      payload.response_format = responseFormat
    }
    const endpoint = joinImageEndpoint(config.baseUrl, config.endpointPath)
    const init: RequestInit = {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${config.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    }
    if (config.provider === 'seedream-gateway') {
      return await this.submitSeedreamImageJsonWithRetry(endpoint, init, config.endpointPath)
    }
    const response = await this.fetchImpl(endpoint, init)
    return await this.readJson(response, config.endpointPath)
  }

  /** GPT 生图异步任务:提交(短)→轮询(短),慢调用在美国 relay 本地跑,彻底绕开大陆↔美国跨境长连接 60s 被掐。
   *  契约:POST {base}/v1/images/tasks {mode,model,prompt,n,size,response_format?,images?,mask?,input_fidelity?} → {task_id};
   *        GET  {base}/v1/images/tasks/{id} → {status:queued|running|succeeded|failed, data?:[{b64_json|url}], error?}。
   *  返回 OpenAI 形状 {data:[...]} 以复用 persistImageGenerationResult。 */
  private async submitOpenAiImageTask(
    ctx: TaskRunnerContext,
    prompt: string,
    sized: { size: string },
    count: number,
    body: Record<string, unknown>,
    config: DirectImageConfig,
    refs: ResolvedImageReference[],
    mode: 'generate' | 'edit',
  ): Promise<Record<string, unknown>> {
    const taskBody: Record<string, unknown> = {
      mode,
      model: config.model,
      prompt,
      n: count,
      size: stringFrom(body.size) ?? sized.size,
    }
    const responseFormat = stringFrom(body.response_format)
    if (responseFormat) taskBody.response_format = responseFormat
    // input_fidelity 只对非 gpt-image-2 的 gpt-image 系列设(gpt-image-2 恒最高保真、传了 400)。
    if (/^gpt-image/i.test(config.model) && !/^gpt-image-2/i.test(config.model)) {
      taskBody.input_fidelity = mode === 'edit' ? 'high' : 'low'
    }
    if (mode === 'edit') {
      const images = refs.map(ref => ref.url).filter(Boolean).slice(0, 16)
      if (images.length === 0) throw new Error('改图需要本机可读取的底图或参考图')
      taskBody.images = images
      const mask = await this.resolveImageReference(stringFrom(body.mask_path), 'mask', this.trustedImagePaths(body))
      if (mask?.url) taskBody.mask = mask.url
    }
    const submitted = await this.readJson(await this.fetchImpl(joinImagePath(config.baseUrl, '/images/tasks'), {
      method: 'POST',
      headers: { 'authorization': `Bearer ${config.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(taskBody),
    }), '/images/tasks')
    const taskId = stringFrom(submitted.task_id)
    if (!taskId) throw new Error('图片任务提交未返回 task_id')
    await ctx.progress(15, '图片任务已提交，正在美国节点生成。')
    const pollEndpoint = joinImagePath(config.baseUrl, `/images/tasks/${encodeURIComponent(taskId)}`)
    for (let i = 0; i < POLL_LIMIT; i++) {
      if (ctx.signal.aborted) throw new Error('任务已取消')
      await delay(this.pollIntervalMs)
      const status = await this.readJson(await this.fetchImpl(pollEndpoint, {
        method: 'GET',
        headers: { 'authorization': `Bearer ${config.token}` },
      }), '/images/tasks/{id}')
      const state = stringFrom(status.status)
      if (state === 'succeeded') return { data: Array.isArray(status.data) ? status.data : [] }
      if (state === 'failed') throw new Error(sanitizeMediaError(status.error ?? '图片任务失败'))
      await ctx.progress(Math.min(85, 20 + i), '图片仍在生成中…')
    }
    throw new Error('图片任务超时')
  }

  private async submitSeedreamImageJsonWithRetry(endpoint: string, init: RequestInit, label: string): Promise<Record<string, unknown>> {
    const maxRetries = Math.max(0, Math.min(5, numberFrom(this.env.SEEDREAM_IMAGE_RETRIES ?? this.env.DESKTOP_IMAGE_429_RETRIES, DEFAULT_SEEDREAM_IMAGE_RETRIES)))
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const response = await this.fetchImpl(endpoint, init)
      const retryable = response.status === 429 || response.status >= 500
      if (retryable && attempt < maxRetries) {
        await delay(Math.min(1_500, Math.max(10, this.pollIntervalMs) * (attempt + 1)))
        continue
      }
      return await this.readJson(response, label)
    }
    throw new Error(`${label} failed`)
  }

  private async persistImageGenerationResult(
    ctx: TaskRunnerContext,
    parsed: Record<string, unknown>,
    sized: { ratio: string; width: number; height: number; size: string },
    config: DirectImageConfig,
    mode: 'generate' | 'edit',
    opts: {
      printMode?: boolean
      printLogoPath?: string | null
      printQrPath?: string | null
      printQrInspection?: PrintQrInspection | null
      printQrRegenerationStatus?: PrintQrRegenerationStatus
      printQrRegenerationWarning?: string
      printQrRegenerationSource?: PrintQrRegenerationSource
      hardTextInspection?: HardTextInspection | null
    } = {},
  ): Promise<Record<string, unknown>> {
    const data = Array.isArray(parsed.data)
      ? parsed.data
      : Array.isArray(parsed.images)
        ? parsed.images
        : []
    if (data.length === 0) throw new Error('图片生成网关没有返回图片数据')

    await ctx.progress(70, '图片已生成，正在保存到本机作品库。')
    const dir = join(this.uploadsRoot, 'posters')
    await mkdir(dir, { recursive: true })
    const images: Record<string, unknown>[] = []
    for (let i = 0; i < data.length; i++) {
      const item = asRecord(data[i]) ?? {}
      const b64 = stringFrom(item.b64_json) ?? stringFrom(item.b64)
      const remoteUrl = stringFrom(item.url) ?? stringFrom(item.poster_url)
      const stem = `image_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${i + 1}`
      let posterUrl = remoteUrl
      let sourceUrl: string | undefined
      let posterPath: string | undefined
      if (b64) {
        const filename = `${stem}.png`
        posterPath = join(dir, filename)
        await writeFile(posterPath, Buffer.from(b64, 'base64'))
        posterUrl = `/uploads/posters/${filename}`
      } else if (remoteUrl) {
        sourceUrl = remoteUrl
        const saved = await this.tryPersistRemoteImage(remoteUrl, dir, stem)
        if (saved) {
          posterUrl = saved
          posterPath = this.uploadPathForUrl(saved) ?? undefined
        }
      }
      if (!posterUrl) throw new Error('图片生成网关返回了不可识别的图片结果')
      const printLogoOverlay = opts.printMode && opts.printLogoPath && posterPath
        ? await this.tryApplyPrintLogoOverlay(posterPath, opts.printLogoPath)
        : false
      const printQrOverlay = opts.printMode && opts.printQrPath && posterPath
        ? await this.tryApplyPrintQrOverlay(posterPath, opts.printQrPath)
        : false
      images.push({
        generation_id: stringFrom(item.generation_id) ?? stringFrom(item.id) ?? `direct-${stem}`,
        poster_url: posterUrl,
        source_url: sourceUrl,
        revised_prompt: stringFrom(item.revised_prompt),
        width: sized.width,
        height: sized.height,
        ratio: sized.ratio,
        // 白标:不外露真实 provider('seedream-gateway'/'openai-compatible')与 model,只给能力档代称。
        ...imageRouteFields(config),
        local_preview: false,
          ...(opts.printMode ? {
            print_mode: true,
            print_logo_overlay: printLogoOverlay ? 'ffmpeg' : opts.printLogoPath ? 'skipped' : 'none',
            print_qr_overlay: printQrOverlay ? 'ffmpeg' : opts.printQrPath ? 'skipped' : 'none',
            ...(opts.printQrInspection ? printQrInspectionFields(opts.printQrInspection) : {}),
            ...printQrRegenerationFields(opts.printQrRegenerationStatus, opts.printQrRegenerationWarning, opts.printQrRegenerationSource),
          } : {}),
          ...(opts.hardTextInspection ? hardTextInspectionFields(opts.hardTextInspection) : {}),
        })
      }
    await ctx.progress(100, '图片已生成并保存。')
    const urls = images.map(img => img.poster_url as string)
    const generationIds = images.map(img => img.generation_id as string)
    return {
      urls,
      generation_ids: generationIds,
      images,
      count: images.length,
      ratio: sized.ratio,
      local_preview: false,
      // 白标:不外露真实 provider/model,只给能力档代称。
      ...imageRouteFields(config),
      mode,
      ...(opts.printMode ? {
        print_mode: true,
        print_logo_overlay: images.some(img => img.print_logo_overlay === 'ffmpeg')
          ? 'ffmpeg'
          : opts.printLogoPath ? 'skipped' : 'none',
        print_qr_overlay: images.some(img => img.print_qr_overlay === 'ffmpeg')
          ? 'ffmpeg'
          : opts.printQrPath ? 'skipped' : 'none',
        ...(opts.printQrInspection ? printQrInspectionFields(opts.printQrInspection) : {}),
        ...printQrRegenerationFields(opts.printQrRegenerationStatus, opts.printQrRegenerationWarning, opts.printQrRegenerationSource),
      } : {}),
      ...(opts.hardTextInspection ? hardTextInspectionFields(opts.hardTextInspection) : {}),
    }
  }

  private async tryPersistRemoteImage(remoteUrl: string, dir: string, stem: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(remoteUrl, { method: 'GET' })
      if (!res.ok) return null
      const contentType = res.headers.get('content-type')
      const ext = contentType?.toLowerCase().startsWith('image/')
        ? imageExtFromContentType(contentType)
        : imageExtFromUrl(remoteUrl)
      const filename = `${stem}.${ext}`
      await writeFile(join(dir, filename), Buffer.from(await res.arrayBuffer()))
      return `/uploads/posters/${filename}`
    } catch {
      return null
    }
  }

  private uploadPathForUrl(url: string): string | null {
    if (!url.startsWith('/uploads/')) return null
    const rel = url.slice('/uploads/'.length)
    if (!rel || rel.includes('\0') || rel.includes('..')) return null
    const abs = resolve(this.uploadsRoot, rel)
    const root = resolve(this.uploadsRoot)
    if (abs !== root && !abs.startsWith(`${root}/`) && !abs.startsWith(`${root}\\`)) return null
    return abs
  }

  private resolvePrintLogoPath(body: Record<string, unknown>): string | null {
    if (body.print_mode !== true) return null
    const value = stringFrom(body._print_logo_path) ?? stringFrom(body.logo_path)
    if (!value) return null
    const abs = this.resolveLocalImagePath(value, this.trustedImagePaths(body))
    if (!abs || !contentTypeFor(abs).startsWith('image/')) return null
    return abs
  }

  private resolvePrintQrPath(body: Record<string, unknown>): string | null {
    if (body.print_mode !== true) return null
    const value = stringFrom(body._print_qr_path) ?? stringFrom(body.qr_path)
    if (!value) return null
    const abs = this.resolveLocalImagePath(value, this.trustedImagePaths(body))
    if (!abs || !contentTypeFor(abs).startsWith('image/')) return null
    return abs
  }

  private resolvePrintQrContent(body: Record<string, unknown>): string | null {
    if (body.print_mode !== true) return null
    const value = stringFrom(body._print_qr_content) ??
      stringFrom(body.qrcode_text) ??
      stringFrom(body.qrcode_content) ??
      stringFrom(body.qr_content)
    return value ?? null
  }

  private async resolvePrintQrRegenerationInput(
    declaredContent: string | null,
    qrPath: string | null,
  ): Promise<{ content: string | null; source?: PrintQrRegenerationSource; warning?: string }> {
    if (declaredContent) return { content: declaredContent, source: 'declared' }
    if (!qrPath) return { content: null }
    const decoded = await this.tryDecodePrintQrContent(qrPath)
    if (decoded.content) return { content: decoded.content, source: 'decoded_image' }
    return { content: null, warning: decoded.warning }
  }

  private async tryDecodePrintQrContent(qrPath: string): Promise<PrintQrDecodeResult> {
    try {
      return decodePrintQrContentFromBytes(await readFile(qrPath))
    } catch {
      return { content: null, warning: '无法读取二维码图片，已退回原图叠层。' }
    }
  }

  private async inspectPrintQrAsset(qrPath: string): Promise<PrintQrInspection> {
    try {
      const dimensions = imageDimensions(await readFile(qrPath))
      if (!dimensions) {
        return { status: 'unknown', warnings: ['无法读取二维码图片尺寸，已按原图叠加。'] }
      }
      const warnings: string[] = []
      const minSide = Math.min(dimensions.width, dimensions.height)
      const maxSide = Math.max(dimensions.width, dimensions.height)
      if (minSide < MIN_PRINT_QR_SOURCE_PX) {
        warnings.push(`二维码源图较小(${dimensions.width}x${dimensions.height})，印刷投放建议上传至少 ${MIN_PRINT_QR_SOURCE_PX}px 以上的清晰方图。`)
      }
      if (minSide > 0 && maxSide / minSide > 1.08) {
        warnings.push(`二维码源图不是标准方形(${dimensions.width}x${dimensions.height})，可能影响扫码识别。`)
      }
      return {
        status: warnings.length ? 'warning' : 'ok',
        width: dimensions.width,
        height: dimensions.height,
        warnings,
      }
    } catch {
      return { status: 'unknown', warnings: ['无法读取二维码图片，已尝试按原图叠加。'] }
    }
  }

  private async tryRegeneratePrintQrAsset(
    content: string | null,
    source?: PrintQrRegenerationSource,
    noContentWarning?: string,
  ): Promise<PrintQrRegeneration> {
    if (!content) return { status: 'none', warning: noContentWarning }
    if (content.length > MAX_PRINT_QR_CONTENT_LENGTH) {
      return {
        status: 'failed',
        source,
        warning: `二维码内容过长(${content.length} 字符)，已退回原图叠层。`,
      }
    }
    const dir = join(this.uploadsRoot, 'tmp')
    const path = join(dir, `print-qr-${crypto.randomUUID().slice(0, 8)}.png`)
    try {
      await mkdir(dir, { recursive: true })
      const png = await QRCode.toBuffer(content, {
        type: 'png',
        errorCorrectionLevel: 'H',
        margin: 4,
        width: 1024,
        color: { dark: '#000000ff', light: '#ffffffff' },
      })
      await writeFile(path, png)
      return { status: 'generated', path, source }
    } catch (err) {
      await rm(path, { force: true }).catch(() => undefined)
      return {
        status: 'failed',
        source,
        warning: `二维码内容重建失败，已退回原图叠层。原因:${sanitizeMediaError(err)}`,
      }
    }
  }

  private async tryApplyPrintLogoOverlay(posterPath: string, logoPath: string): Promise<boolean> {
    const ext = extname(posterPath) || '.png'
    const outputPath = `${posterPath}.logo-${crypto.randomUUID().slice(0, 8)}${ext}`
    const command = ffmpegBinFrom(this.env)
    const filter = [
      '[1:v][0:v]scale2ref=w=main_w*0.20:h=-1[logo][base]',
      '[logo]format=rgba,pad=ceil(iw*1.18):ceil(ih*1.18):(ow-iw)/2:(oh-ih)/2:white[logop]',
      '[base][logop]overlay=x=W*0.04:y=W*0.04:format=auto',
    ].join(';')
    try {
      const proc = Bun.spawn([
        command,
        '-y',
        '-loglevel',
        'error',
        '-i',
        posterPath,
        '-i',
        logoPath,
        '-filter_complex',
        filter,
        '-frames:v',
        '1',
        outputPath,
      ], { stdout: 'ignore', stderr: 'ignore' })
      const code = await Promise.race([
        proc.exited,
        delay(30_000).then(() => {
          proc.kill()
          return -1
        }),
      ])
      if (code !== 0 || !existsSync(outputPath)) {
        await rm(outputPath, { force: true }).catch(() => undefined)
        return false
      }
      await rename(outputPath, posterPath)
      return true
    } catch {
      await rm(outputPath, { force: true }).catch(() => undefined)
      return false
    }
  }

  private async tryApplyPrintQrOverlay(posterPath: string, qrPath: string): Promise<boolean> {
    const ext = extname(posterPath) || '.png'
    const outputPath = `${posterPath}.qr-${crypto.randomUUID().slice(0, 8)}${ext}`
    const command = ffmpegBinFrom(this.env)
    const filter = [
      '[1:v][0:v]scale2ref=w=main_w*0.18:h=main_w*0.18:flags=neighbor[qr][base]',
      '[qr]format=rgba,pad=ceil(iw*1.16):ceil(ih*1.16):(ow-iw)/2:(oh-ih)/2:white[qrp]',
      '[base][qrp]overlay=x=W-w-W*0.04:y=H-h-W*0.04:format=auto',
    ].join(';')
    try {
      const proc = Bun.spawn([
        command,
        '-y',
        '-loglevel',
        'error',
        '-i',
        posterPath,
        '-i',
        qrPath,
        '-filter_complex',
        filter,
        '-frames:v',
        '1',
        outputPath,
      ], { stdout: 'ignore', stderr: 'ignore' })
      const code = await Promise.race([
        proc.exited,
        delay(30_000).then(() => {
          proc.kill()
          return -1
        }),
      ])
      if (code !== 0 || !existsSync(outputPath)) {
        await rm(outputPath, { force: true }).catch(() => undefined)
        return false
      }
      await rename(outputPath, posterPath)
      return true
    } catch {
      await rm(outputPath, { force: true }).catch(() => undefined)
      return false
    }
  }

  private posterUploadForGenerationId(generationId: string): { path: string; url: string; localPreview: boolean } | null {
    const id = generationId.trim()
    const localPreview = id.startsWith('local-')
    const stem = id.startsWith('local-')
      ? id.slice('local-'.length)
      : id.startsWith('direct-')
        ? id.slice('direct-'.length)
        : id
    if (!stem || /[\\/]/.test(stem) || stem.includes('..') || !/^[A-Za-z0-9_.-]+$/.test(stem)) return null
    const postersRoot = resolve(this.uploadsRoot, 'posters')
    const candidates = extname(stem)
      ? [stem]
      : ['png', 'jpg', 'jpeg', 'webp', 'svg'].map(ext => `${stem}.${ext}`)
    for (const name of candidates) {
      const posterPath = resolve(postersRoot, name)
      if (posterPath !== postersRoot && !posterPath.startsWith(`${postersRoot}/`) && !posterPath.startsWith(`${postersRoot}\\`)) continue
      if (existsSync(posterPath)) return { path: posterPath, url: `/uploads/posters/${name}`, localPreview }
    }
    return null
  }

  /**
   * 生成前的人像合规/质检闸(对齐方案文档流程 [2]输入质检 → [3]肖像授权):
   * 只在**存在真人照片输入**且判定为人像优化时触发;先拦低质输入,再卡肖像授权。
   * 判人脸/质检走网关 VLM,网关缺位则只有尺寸自动档并优雅降级(不假装质检、不误拦)。
   * 与"生图默认不弹花钱审批"共存:这是**人像合规闸**,不是 spend 审批,不涉及花钱确认。
   */
  private async portraitPreflight(
    ctx: TaskRunnerContext,
    body: Record<string, unknown>,
    mode: 'generate' | 'edit',
    shared: PortraitShared,
  ): Promise<PortraitPreflightOutcome> {
    const prompt = String(body.image_prompt ?? body.prompt ?? body.description ?? '')
    const explicitFlag = portraitFlagged(body)
    const refs = await this.collectImageReferences(body, mode)
    const hasInputImage = refs.length > 0
    // 无真人照片输入(纯文字生成)→ 无"这张人像"可授权,不触发授权闸,直接放行。
    if (!hasInputImage) {
      shared.intent = detectPortraitIntent({ prompt, hasInputImage: false, explicitFlag })
      return { blocked: false }
    }
    const inspection = await inspectInputImage(this.qcImagesFromRefs(refs), { model: this.qcModel(), signal: ctx.signal })
    shared.inputInspection = inspection
    const intent = detectPortraitIntent({ prompt, hasInputImage: true, inputFaceDetected: inspection.hasFace, explicitFlag })
    shared.intent = intent
    if (!intent.isPortrait) return { blocked: false }
    if (inspection.blockReason) {
      return { blocked: true, result: inputQualityBlockedResult({ warnings: inspection.warnings, blockReason: inspection.blockReason }) }
    }
    if (!portraitConsentGranted(body)) {
      return { blocked: true, result: portraitConsentRequiredResult(intent) }
    }
    return { blocked: false }
  }

  /** 生成后加工:并入输入质检软提示 + 人像结果质检 + 硬文字 OCR 校对。 */
  private async imageResultPostprocess(
    ctx: TaskRunnerContext,
    result: Record<string, unknown>,
    shared: PortraitShared,
  ): Promise<Record<string, unknown>> {
    if (result.blocked === true) return result
    const extra: Record<string, unknown> = {}

    const inputWarnings = shared.inputInspection?.warnings ?? []
    if (inputWarnings.length) {
      extra.input_qc_status = shared.inputInspection?.autoChecked ? 'warning' : 'partial'
      extra.input_qc_warnings = inputWarnings
    }

    const isLocalPreview = result.local_preview === true
    const wantPortraitQc = shared.intent?.isPortrait === true && !isLocalPreview
    const model = this.qcModel()
    const expected = Array.isArray(result.hard_text_expected)
      ? result.hard_text_expected.filter((x): x is string => typeof x === 'string')
      : []
    const wantOcr = result.hard_text_required === true && !isLocalPreview && !!model && expected.length > 0

    let qcImages: QcImage[] = []
    if (wantPortraitQc || wantOcr) qcImages = await this.qcImagesFromResult(result)

    if (wantPortraitQc) {
      const inspection = await inspectPortraitResult(qcImages, { model, signal: ctx.signal })
      extra.portrait_consent_confirmed = true
      extra.portrait_qc_status = inspection.status
      extra.portrait_qc_auto_checked = inspection.autoChecked
      extra.portrait_qc_warnings = inspection.warnings
      extra.portrait_qc_message = inspection.message
      // 商用总闸:授权已确认 + 结果质检自动通过才标可商用;未质检/有风险都不标(R13/3.3)。
      extra.commercial_ready = inspection.status === 'passed'
    }

    if (wantOcr) {
      const ocr = await proofreadHardText(qcImages, expected, { model, signal: ctx.signal })
      // VLM 缺位/读不出会回 pending_ocr:保持 persist 阶段已有的人工核对提示,不覆盖。
      if (ocr.status !== 'pending_ocr') {
        extra.text_quality_status = ocr.status
        extra.text_quality_warning = ocr.status !== 'ocr_matched'
        extra.text_quality_warning_message = ocr.message
        if (ocr.missing.length) extra.text_quality_missing = ocr.missing
      }
    }

    return Object.keys(extra).length ? { ...result, ...extra } : result
  }

  /** 参考图/底图字节 → QC 输入(读尺寸,归一 media_type)。仅含本机可读字节的图。 */
  private qcImagesFromRefs(refs: ResolvedImageReference[]): QcImage[] {
    const out: QcImage[] = []
    for (const ref of refs) {
      if (!ref.bytes) continue
      const dims = imageDimensions(ref.bytes)
      out.push({
        base64: ref.bytes.toString('base64'),
        mediaType: normalizeImageMediaType(ref.contentType),
        width: dims?.width,
        height: dims?.height,
      })
    }
    return out
  }

  /** 从生成结果里把本机落盘的成图读回字节(供结果质检/OCR);跳过占位 svg 与远程图,最多 4 张。 */
  private async qcImagesFromResult(result: Record<string, unknown>): Promise<QcImage[]> {
    const urls: string[] = []
    for (const img of Array.isArray(result.images) ? result.images : []) {
      const rec = asRecord(img)
      const url = rec ? stringFrom(rec.poster_url) : undefined
      if (url) urls.push(url)
    }
    if (urls.length === 0) {
      for (const u of Array.isArray(result.urls) ? result.urls : []) {
        if (typeof u === 'string') urls.push(u)
      }
    }
    const out: QcImage[] = []
    for (const url of urls.slice(0, 4)) {
      const abs = this.uploadPathForUrl(url)
      if (!abs || extname(abs).toLowerCase() === '.svg') continue
      try {
        const bytes = await readFile(abs)
        const dims = imageDimensions(bytes)
        out.push({
          base64: bytes.toString('base64'),
          mediaType: normalizeImageMediaType(contentTypeFor(abs)),
          width: dims?.width,
          height: dims?.height,
        })
      } catch {
        // 读不到就跳过这张,不影响其余质检。
      }
    }
    return out
  }

  private trustedImagePaths(body: Record<string, unknown>): Set<string> {
    const values = stringArrayFrom(body._trusted_image_paths)
    return new Set(values.map(value => resolve(value)))
  }

  private async collectImageReferences(body: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<ResolvedImageReference[]> {
    const trusted = this.trustedImagePaths(body)
    const refs: ResolvedImageReference[] = []
    const addGeneration = async (id: string, role: string) => {
      const upload = this.posterUploadForGenerationId(id)
      if (!upload) return
      const ref = await this.resolveImageReference(upload.url, role, trusted)
      if (ref) refs.push(ref)
    }

    const sourceId = stringFrom(body.source_generation_id)
    if (mode === 'edit' && sourceId) await addGeneration(sourceId, 'source')

    for (const id of stringArrayFrom(body.reference_generation_ids).slice(0, 8)) {
      await addGeneration(id, 'reference')
    }
    for (const path of stringArrayFrom(body.reference_image_paths).slice(0, 8)) {
      const ref = await this.resolveImageReference(path, 'reference', trusted)
      if (ref) refs.push(ref)
    }
    return refs.slice(0, 14)
  }

  private async resolveImageReference(value: string | undefined, role: string, trustedPaths: Set<string>): Promise<ResolvedImageReference | null> {
    if (!value) return null
    if (/^data:/i.test(value)) {
      const parsed = parseDataUri(value)
      if (!parsed || !parsed.contentType.startsWith('image/')) return null
      return { role, url: dataUriFor(parsed.contentType, parsed.bytes), contentType: parsed.contentType, bytes: parsed.bytes, filename: `${role}.png` }
    }
    if (/^https?:/i.test(value)) return { role, url: value }
    if (/^(ms|stepfile):\/\//i.test(value)) return { role, url: value }

    const abs = this.resolveLocalImagePath(value, trustedPaths)
    if (!abs) return null
    const contentType = contentTypeFor(abs)
    if (!contentType.startsWith('image/')) return null
    const bytes = await readFile(abs)
    return {
      role,
      url: dataUriFor(contentType, bytes),
      contentType: contentType.split(';')[0],
      bytes,
      filename: basename(abs) || `${role}.png`,
    }
  }

  private resolveLocalImagePath(value: string, trustedPaths: Set<string>): string | null {
    const raw = value.trim()
    if (!raw || raw.includes('\0')) return null
    if (raw.startsWith('/uploads/')) {
      const rel = raw.slice('/uploads/'.length)
      if (!rel || rel.includes('..')) return null
      const abs = resolve(this.uploadsRoot, rel)
      const root = resolve(this.uploadsRoot)
      if (abs !== root && !abs.startsWith(`${root}/`) && !abs.startsWith(`${root}\\`)) return null
      return existsSync(abs) ? abs : null
    }
    if (!isAbsolute(raw)) return null
    const abs = resolve(raw)
    if (!trustedPaths.has(abs)) return null
    return existsSync(abs) ? abs : null
  }

  private async localVideoJobFallback(ctx: TaskRunnerContext, kind: MediaJobKind, body: Record<string, unknown>, project: string): Promise<Record<string, unknown>> {
    // 功能门(反逻辑保护):本地剪辑/出片依赖 ffmpeg+ffprobe;组件还没下好时任务正常完成、
    // 返回"正在准备组件 x%"结构化结果(照 portraitGate 模式),并已触发按需下载——绝不静默失败。
    const assetGate = gateMediaAssets(this.env, ['ffmpeg', 'ffprobe'])
    if (assetGate) {
      await ctx.progress(5, String(assetGate.message ?? '所需组件正在后台准备。'))
      return assetGate
    }
    const store = new VideoEditProjectStore(this.opts.stateRoot)
    if (kind === 'video_inventory' || kind === 'video_auto_plan') {
      return await store.createLocalPlan(body, {
        env: this.env,
        signal: ctx.signal,
        onProgress: (progress, stage) => ctx.progress(progress, stage),
      })
    }
    if (kind === 'video_render') {
      return await store.renderProject(project, body, {
        env: this.env,
        signal: ctx.signal,
        onProgress: (progress, stage) => ctx.progress(progress, stage),
      })
    }
    return await this.unavailableFallback(ctx, '视频剪辑需要媒体后端。')
  }

  private async localImageFallback(ctx: TaskRunnerContext, body: Record<string, unknown>, mode: 'generate' | 'edit'): Promise<Record<string, unknown>> {
    await ctx.progress(10, '媒体后端未配置，先生成本地预览占位图。')
    const { ratio, width, height } = ratioSize(body.ratio)
    const count = clampCount(body.count)
    const prompt = String(body.image_prompt ?? body.prompt ?? body.description ?? '图片预览')
    const hardTextInspection = inspectHardTextRequirement(body, prompt)
    const dir = join(this.uploadsRoot, 'posters')
    await mkdir(dir, { recursive: true })
    const images: Record<string, unknown>[] = []
    for (let i = 0; i < count; i++) {
      const filename = `preview_${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${i + 1}.svg`
      const path = join(dir, filename)
      const subtitle = mode === 'edit' ? 'TS edit preview' : 'TS image preview'
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#f5f7f2"/>
  <rect x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.06)}" width="${Math.round(width * 0.88)}" height="${Math.round(height * 0.88)}" rx="24" fill="#ffffff" stroke="#1f7a57" stroke-width="8"/>
  <text x="50%" y="42%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(34, Math.round(width / 24))}" fill="#0f5132">${xmlEscape(subtitle)}</text>
  <text x="50%" y="51%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(24, Math.round(width / 36))}" fill="#234236">${xmlEscape(shortText(prompt, 'preview'))}</text>
  <text x="50%" y="59%" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.max(20, Math.round(width / 48))}" fill="#5f6f68">ratio ${xmlEscape(ratio)} · backend not configured</text>
</svg>
`
      await writeFile(path, svg, 'utf8')
      images.push({
        generation_id: `local-${filename.replace(/\.svg$/, '')}`,
        poster_url: `/uploads/posters/${filename}`,
        width,
        height,
        ratio,
        local_preview: true,
        ...(hardTextInspection ? hardTextInspectionFields(hardTextInspection) : {}),
      })
    }
    await ctx.progress(100, '本地预览占位图已生成；配置媒体后端后会调用真实生图模型。')
    const urls = images.map(img => img.poster_url as string)
    const generationIds = images.map(img => img.generation_id as string)
    return {
      urls,
      generation_ids: generationIds,
      images,
      count: images.length,
      ratio,
      local_preview: true,
      message: '媒体后端未配置，当前结果是占位预览，不是模型生成图。',
      ...(hardTextInspection ? hardTextInspectionFields(hardTextInspection) : {}),
    }
  }

  private async unavailableFallback(ctx: TaskRunnerContext, message: string): Promise<Record<string, unknown>> {
    await ctx.progress(5, message)
    throw new Error(message)
  }
}
