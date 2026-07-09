// 视频口播转写(口播路 · 全本地 whisper.cpp)。
//
// 端到端:ffmpeg 抽 16k 单声道 wav → spawn whisper-cli(-oj 段级 / -ojf --dtw 词级)
// → 解析 JSON → 按静音≥0.5s 分 phrases → 缓存 edits/<项目>/transcripts/<源>.json。
//
// 硬约束:whisper-cli 是外部二进制(child_process.spawn),不进 package.json、不 require .node
// (避开 ts/CLAUDE.md §8 Bun+Windows 段错误)。二进制/权重若未打包 → 优雅降级(抛
// TranscribeUnavailableError,由上层回退占位),绝不崩、不假装转写成功。
//
// 与 voiceTranscription.ts(语音输入)同一条 whisper.cpp 路子,这里为视频转写复刻其
// 二进制/模型解析,不改动 voiceTranscription(保持其测试边界不受影响)。

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import {
  ffmpegBinFrom,
  resolveWhisperCliPath,
  resolveWhisperModelPath,
  transcribeAssetsPreparingReason,
} from './mediaBinaries'

export interface TranscriptWord {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface TranscriptPhrase {
  start: number
  end: number
  text: string
  speaker?: string
}

export interface VideoTranscript {
  source: string // 源片文件名(basename)
  language: string
  duration: number
  words: TranscriptWord[]
  phrases: TranscriptPhrase[]
}

export interface TranscribeOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  language?: string
  wordLevel?: boolean
  timeoutMs?: number
  onProgress?: (progress: number, stage?: string) => Promise<void> | void
}

/** 转写引擎不可用(二进制/权重未打包等)——上层据此优雅回退占位,不崩。 */
export class TranscribeUnavailableError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'TranscribeUnavailableError'
  }
}

export const PHRASE_SILENCE_THRESHOLD = 0.5 // 静音≥0.5s 断句(对齐 video-use pack_transcripts)

const CJK_RE = /[㐀-鿿豈-﫿]/

function toEnv(env: Record<string, string | undefined> | undefined): Record<string, string | undefined> {
  return env ?? process.env
}

/** 二进制/权重解析统一走 mediaBinaries(env 显式 → 资产管理器 → 内置 → PATH)。 */
export function resolveWhisperCli(env: Record<string, string | undefined>): string | null {
  return resolveWhisperCliPath(env)
}

/** 权重默认优先 large-v3-turbo(§二·补 复评定),再退 large-v3 / medium / small。 */
export function resolveWhisperModel(env: Record<string, string | undefined>): string {
  return resolveWhisperModelPath(env)
}

export interface TranscribeAvailability {
  available: boolean
  reason: string
  whisperBin: string | null
  model: string | null
}

/**
 * 探测口播转写是否可用。不可用时:接了资产管理器 → 触发按需下载并给"正在后台准备(x%)"
 * (功能门,绝不静默失败);没接(单测/纯开发)→ 给清晰的"需打包什么"提示。
 */
export function resolveTranscribeAvailability(env?: Record<string, string | undefined>): TranscribeAvailability {
  const e = toEnv(env)
  const whisperBin = resolveWhisperCli(e)
  const model = resolveWhisperModel(e)
  if (whisperBin && model) return { available: true, reason: '', whisperBin, model }
  const preparing = transcribeAssetsPreparingReason(e)
  if (preparing) return { available: false, reason: preparing, whisperBin, model: model || null }
  if (!whisperBin && !model) {
    return { available: false, reason: '需打包转写二进制 whisper-cli 与权重 ggml-large-v3-turbo', whisperBin, model: model || null }
  }
  if (!whisperBin) return { available: false, reason: '需打包转写二进制 whisper-cli(desktop/binaries)', whisperBin, model: model || null }
  return { available: false, reason: '需打包转写权重 ggml-large-v3-turbo(desktop/binaries/models)', whisperBin, model: null }
}

function ffmpegBin(env: Record<string, string | undefined>): string {
  return ffmpegBinFrom(env)
}

interface ProcResult {
  stdout: string
  stderr: string
  code: number | null
}

function runProc(bin: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; timeoutMs: number }): Promise<ProcResult> {
  if (opts.signal?.aborted) return Promise.reject(new Error('任务已取消'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const onAbort = () => child.kill('SIGTERM')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${basename(bin)} 转写超时`))
    }, opts.timeoutMs)
    child.stdout?.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr?.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', err => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (opts.signal?.aborted) return reject(new Error('任务已取消'))
      resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), code })
    })
  })
}

/** DTW 预设(词级时间戳)从模型名推导。 */
function dtwPreset(modelPath: string): string {
  const name = basename(modelPath).toLowerCase()
  if (name.includes('large-v3-turbo')) return 'large.v3.turbo'
  if (name.includes('large-v3')) return 'large.v3'
  if (name.includes('large-v2')) return 'large.v2'
  if (name.includes('large')) return 'large.v1'
  if (name.includes('medium')) return 'medium'
  if (name.includes('small')) return 'small'
  if (name.includes('base')) return 'base'
  return 'medium'
}

/**
 * 解析 whisper.cpp -oj / -ojf 的 JSON → 段级 words(中文一段≈一个 phrase 基元)。
 * offsets 是毫秒。纯函数,可单测。
 */
export function parseWhisperSegments(json: unknown): TranscriptWord[] {
  const root = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
  const list = Array.isArray(root.transcription) ? root.transcription : []
  const words: TranscriptWord[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const seg = raw as Record<string, unknown>
    const offsets = seg.offsets && typeof seg.offsets === 'object' ? (seg.offsets as Record<string, unknown>) : {}
    const fromMs = Number(offsets.from)
    const toMs = Number(offsets.to)
    const text = typeof seg.text === 'string' ? seg.text.trim() : ''
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) continue
    if (!text) continue
    const speaker = typeof seg.speaker === 'string' ? seg.speaker : undefined
    words.push({ start: fromMs / 1000, end: toMs / 1000, text, ...(speaker ? { speaker } : {}) })
  }
  return words
}

function joinPhraseText(parts: string[]): string {
  const joined = parts.map(p => p.trim()).filter(Boolean).join(' ')
  return joined
    // 去掉中文字符之间被 join 塞入的空格
    .replace(new RegExp(`(${CJK_RE.source})\\s+(?=${CJK_RE.source})`, 'g'), '$1')
    .replace(/\s+([,，。！？、；：)】」』])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * words → phrases:遇静音≥threshold 或换说话人就断句。抄 pack_transcripts.group_into_phrases。
 * 纯函数,可单测。
 */
export function groupIntoPhrases(words: TranscriptWord[], threshold = PHRASE_SILENCE_THRESHOLD): TranscriptPhrase[] {
  const phrases: TranscriptPhrase[] = []
  let cur: TranscriptWord[] = []
  const flush = () => {
    if (!cur.length) return
    const start = cur[0]!.start
    const end = cur[cur.length - 1]!.end
    const text = joinPhraseText(cur.map(w => w.text))
    const speaker = cur[0]!.speaker
    if (text) phrases.push({ start, end, text, ...(speaker ? { speaker } : {}) })
    cur = []
  }
  let prevEnd: number | null = null
  let prevSpeaker: string | undefined
  for (const w of words) {
    const gap = prevEnd === null ? 0 : w.start - prevEnd
    const speakerChanged = prevSpeaker !== undefined && w.speaker !== undefined && w.speaker !== prevSpeaker
    if (prevEnd !== null && (gap >= threshold || speakerChanged)) flush()
    cur.push(w)
    prevEnd = w.end
    prevSpeaker = w.speaker
  }
  flush()
  return phrases
}

/**
 * 把某镜头覆盖区间 [srcIn, srcOut] 内的 phrases 映射成时间线上的字幕条。
 * timelineStart = 该镜头在成片时间线的起点。纯函数,可单测。
 */
export function phrasesToCaptions(
  phrases: TranscriptPhrase[],
  srcIn: number,
  srcOut: number,
  timelineStart: number,
): Array<{ start: number; end: number; text: string }> {
  const out: Array<{ start: number; end: number; text: string }> = []
  for (const p of phrases) {
    const s = Math.max(p.start, srcIn)
    const e = Math.min(p.end, srcOut)
    if (e <= s) continue
    const text = p.text.trim()
    if (!text) continue
    out.push({
      start: Math.round((timelineStart + (s - srcIn)) * 1000) / 1000,
      end: Math.round((timelineStart + (e - srcIn)) * 1000) / 1000,
      text,
    })
  }
  return out
}

/** takes_packed.md 一个源片块(抄 pack_transcripts.render_markdown,中文行无 speaker 标)。 */
export function renderTakesPackedBlock(transcript: VideoTranscript): string {
  const lines: string[] = []
  const dur = transcript.duration.toFixed(1)
  lines.push(`## ${transcript.source}  (duration: ${dur}s, ${transcript.phrases.length} phrases)`)
  for (const p of transcript.phrases) {
    const start = p.start.toFixed(2).padStart(6, '0')
    const end = p.end.toFixed(2).padStart(6, '0')
    const spk = p.speaker ? ` ${p.speaker.replace(/^speaker_/, 'S')}` : ''
    lines.push(`  [${start}-${end}]${spk} ${p.text}`)
  }
  return lines.join('\n')
}

export function renderTakesPacked(transcripts: VideoTranscript[]): string {
  return `${transcripts.map(renderTakesPackedBlock).join('\n\n')}\n`
}

/**
 * 直接转写一段 wav,返回拼接文本(不缓存)。给内容分流器 L2 采样窗探针用。
 * 二进制/权重缺失 → 抛 TranscribeUnavailableError。
 */
export async function transcribeWavText(wavPath: string, opts: TranscribeOptions = {}): Promise<string> {
  const env = toEnv(opts.env)
  const language = opts.language || env.WHISPER_LANGUAGE || 'zh'
  const availability = resolveTranscribeAvailability(env)
  if (!availability.available) {
    throw new TranscribeUnavailableError(`本地口播转写不可用:${availability.reason}`, availability.reason)
  }
  const workDir = await mkdtemp(join(tmpdir(), 'qf-probe-'))
  try {
    const outputBase = join(workDir, 'probe')
    const result = await runProc(availability.whisperBin!, ['-m', availability.model!, '-f', wavPath, '-l', language, '-oj', '-of', outputBase], {
      cwd: workDir,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    })
    if (result.code !== 0) throw new Error(result.stderr.trim().slice(-500) || `whisper-cli 退出码 ${result.code}`)
    const jsonPath = `${outputBase}.json`
    if (!existsSync(jsonPath)) return ''
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as unknown
    return parseWhisperSegments(parsed).map(w => w.text).join('')
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

interface CacheShape extends VideoTranscript {
  _cache?: { sourceMtimeMs: number }
}

async function readCache(cachePath: string, sourceMtimeMs: number): Promise<VideoTranscript | null> {
  if (!existsSync(cachePath)) return null
  try {
    const parsed = JSON.parse(await readFile(cachePath, 'utf8')) as CacheShape
    if (parsed?._cache?.sourceMtimeMs === sourceMtimeMs && Array.isArray(parsed.phrases)) {
      const { _cache, ...transcript } = parsed
      void _cache
      return transcript
    }
  } catch {
    // 缓存损坏就当没有,重转。
  }
  return null
}

/**
 * 转写一个视频源片,产出词/段级 + phrases,并 per-source 缓存。
 * 二进制/权重缺失 → 抛 TranscribeUnavailableError(上层回退占位)。
 * whisper 失败/空 → 抛普通 Error(上层同样回退占位)。
 */
export async function transcribeVideoWordLevel(
  videoPath: string,
  editDir: string,
  opts: TranscribeOptions = {},
): Promise<VideoTranscript> {
  const env = toEnv(opts.env)
  const language = opts.language || env.WHISPER_LANGUAGE || 'zh'
  const stem = basename(videoPath, extname(videoPath))
  const source = basename(videoPath)

  const availability = resolveTranscribeAvailability(env)
  if (!availability.available) {
    throw new TranscribeUnavailableError(`本地口播转写不可用:${availability.reason}`, availability.reason)
  }

  const transcriptsDir = join(editDir, 'transcripts')
  await mkdir(transcriptsDir, { recursive: true })
  const cachePath = join(transcriptsDir, `${stem}.json`)

  let sourceMtimeMs = 0
  try {
    sourceMtimeMs = (await stat(videoPath)).mtimeMs
  } catch {
    sourceMtimeMs = 0
  }
  const cached = await readCache(cachePath, sourceMtimeMs)
  if (cached) return cached

  const ffmpeg = ffmpegBin(env)
  const workDir = await mkdtemp(join(tmpdir(), 'qf-transcribe-'))
  try {
    await opts.onProgress?.(0, '正在抽取音频。')
    const wav = join(workDir, 'audio.wav')
    // 单声道 16kHz PCM(对齐 video-use / voiceTranscription)。
    await runProc(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
      cwd: workDir,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 5 * 60_000,
    })
    if (!existsSync(wav)) throw new Error('音频抽取失败')

    await opts.onProgress?.(30, '正在本地转写口播。')
    const outputBase = join(workDir, 'transcript')
    const args = ['-m', availability.model!, '-f', wav, '-l', language, '-of', outputBase]
    if (opts.wordLevel) {
      // P1:词/token 级 —— -ojf + DTW(中文别用 --max-len 1,会乱码,issue #761)。
      args.push('-ojf', '--dtw', dtwPreset(availability.model!))
    } else {
      args.push('-oj') // P0:段级 JSON(中文最稳基线)。
    }
    const result = await runProc(availability.whisperBin!, args, {
      cwd: workDir,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs ?? 30 * 60_000,
    })
    if (result.code !== 0) throw new Error(result.stderr.trim().slice(-500) || `whisper-cli 退出码 ${result.code}`)

    const jsonPath = `${outputBase}.json`
    if (!existsSync(jsonPath)) throw new Error('whisper 未产出 JSON')
    const parsed = JSON.parse(await readFile(jsonPath, 'utf8')) as unknown
    const words = parseWhisperSegments(parsed)
    if (!words.length) throw new Error('转写结果为空')
    const phrases = groupIntoPhrases(words)
    const duration = Math.round((words[words.length - 1]!.end) * 1000) / 1000
    const transcript: VideoTranscript = { source, language, duration, words, phrases }

    await mkdir(transcriptsDir, { recursive: true })
    const cacheOut: CacheShape = { ...transcript, _cache: { sourceMtimeMs } }
    await writeFile(cachePath, `${JSON.stringify(cacheOut)}\n`, 'utf8')
    await opts.onProgress?.(100, '口播转写完成。')
    return transcript
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}
