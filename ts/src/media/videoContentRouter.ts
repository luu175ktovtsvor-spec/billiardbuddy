// 内容分流器(VAD 三级)——先判"有没有口播",再选路。
//
// L0 无音轨直判 → B-Roll(has_audio=false)。
// L1 ffmpeg silencedetect 有声比 < 0.15 → B-Roll(几乎全静音/无连续人声)。
// L2 拿不准时,用已 bundled 的 whisper.cpp 只转采样窗,按字密度判 → speech / broll。
//
// 全部复用现成能力,零新依赖(has_audio 现成、silencedetect 是 ffmpeg 自带、whisper 是口播路已 bundled)。
// 产出 route: 'speech' | 'broll'。本轮(地基)按整批占比选主路;逐片分流留 P1。

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveTranscribeAvailability, transcribeWavText } from './transcribe'
import { ffmpegBinFrom } from './mediaBinaries'

export type EditRoute = 'speech' | 'broll'
export type RouteLevel = 'L0' | 'L1' | 'L2'

export const VOICED_RATIO_MIN = 0.15 // 有声比低于此 → B-Roll
export const CHAR_DENSITY_MIN = 0.5 // whisper 探针字密度(字/秒)达此且多窗有文本 → 口播

export interface RouteSignals {
  hasAudioAny: boolean
  voicedRatio?: number
  probeAvailable?: boolean
  probeCharsPerSec?: number
  probeWindowsWithText?: number
  probeTotalWindows?: number
}

export interface RouteDecision {
  route: EditRoute
  level: RouteLevel
  reason: string
}

/**
 * 三级判定的纯决策函数(可单测,锁边界):
 *  L0 无音轨 → broll;L1 有声比 < 0.15 → broll;
 *  L2 whisper 探针:字密度达标且多窗有文本 → speech,否则 broll;
 *  探针不可用(权重/二进制没打包)→ 保守走门店主路 broll,并提示需打包转写模型。
 */
export function classifyRoute(signals: RouteSignals): RouteDecision {
  if (!signals.hasAudioAny) {
    return { route: 'broll', level: 'L0', reason: '无音轨,直接走 B-Roll 视觉路' }
  }
  if (signals.voicedRatio !== undefined && signals.voicedRatio < VOICED_RATIO_MIN) {
    const pct = Math.round(signals.voicedRatio * 100)
    return { route: 'broll', level: 'L1', reason: `有声比 ${pct}% < ${Math.round(VOICED_RATIO_MIN * 100)}%,几乎无连续人声,走 B-Roll` }
  }
  if (signals.probeAvailable) {
    const density = signals.probeCharsPerSec ?? 0
    const windowsWithText = signals.probeWindowsWithText ?? 0
    const need = Math.min(2, Math.max(1, signals.probeTotalWindows ?? 1))
    if (density >= CHAR_DENSITY_MIN && windowsWithText >= need) {
      return { route: 'speech', level: 'L2', reason: `采样窗字密度 ${density.toFixed(2)} 字/秒,判为口播,走转写路` }
    }
    return { route: 'broll', level: 'L2', reason: '采样窗未见连贯口播(疑为音乐/环境音),走 B-Roll' }
  }
  // 有声但转写探针不可用:无法确认口播,保守走门店主路 B-Roll。
  return { route: 'broll', level: 'L1', reason: '有声但本地转写探针未打包,无法确认口播,暂走 B-Roll(打包转写模型后可自动识别口播)' }
}

/**
 * 解析 ffmpeg silencedetect 的 stderr,算有声比 =(总时长-静音总时长)/总时长。纯函数,可单测。
 */
export function parseVoicedRatio(stderr: string, totalDuration: number): number | undefined {
  if (!(totalDuration > 0)) return undefined
  let silence = 0
  let openStart: number | null = null
  for (const line of stderr.split(/\r?\n/)) {
    const dur = line.match(/silence_duration:\s*([0-9.]+)/)
    if (dur) {
      silence += Number.parseFloat(dur[1]!)
      openStart = null
      continue
    }
    const start = line.match(/silence_start:\s*(-?[0-9.]+)/)
    if (start) {
      openStart = Math.max(0, Number.parseFloat(start[1]!))
      continue
    }
  }
  // 文件结尾停在静音里、没有对应 silence_end:补到片尾。
  if (openStart !== null && openStart < totalDuration) silence += totalDuration - openStart
  silence = Math.min(silence, totalDuration)
  const voiced = (totalDuration - silence) / totalDuration
  return Math.max(0, Math.min(1, voiced))
}

export interface RouteSourceInput {
  src: string
  has_audio: boolean
  duration: number
}

export interface PerSourceRoute {
  src: string
  has_audio: boolean
  voiced_ratio?: number
}

export interface ClassifyResult extends RouteDecision {
  perSource: PerSourceRoute[]
  signals: RouteSignals
}

export interface ClassifyOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  /** 关掉 L2 whisper 探针(测试/快速模式)。 */
  disableWhisperProbe?: boolean
}

function ffmpegBin(env: Record<string, string | undefined>): string {
  return ffmpegBinFrom(env)
}

function runFfmpeg(bin: string, args: string[], opts: { cwd?: string; signal?: AbortSignal; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (opts.signal?.aborted) return Promise.reject(new Error('任务已取消'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const onAbort = () => child.kill('SIGTERM')
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('ffmpeg 探测超时'))
    }, opts.timeoutMs)
    child.stdout?.on('data', c => out.push(Buffer.from(c)))
    child.stderr?.on('data', c => err.push(Buffer.from(c)))
    child.on('error', e => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(e)
    })
    child.on('close', code => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolvePromise({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), code })
    })
  })
}

/** L1:对一个音频源跑 silencedetect,拿有声比。失败(缺 ffmpeg 等)返回 undefined。 */
async function voicedRatioOf(src: string, duration: number, opts: ClassifyOptions): Promise<number | undefined> {
  const env = opts.env ?? process.env
  try {
    const res = await runFfmpeg(ffmpegBin(env), ['-hide_banner', '-nostats', '-i', src, '-af', 'silencedetect=noise=-30dB:d=0.5', '-f', 'null', '-'], {
      signal: opts.signal,
      timeoutMs: 3 * 60_000,
    })
    return parseVoicedRatio(res.stderr, duration)
  } catch {
    return undefined
  }
}

/** CJK/连续文字字符数(去空白)。 */
function textCharCount(text: string): number {
  return text.replace(/\s+/g, '').length
}

/** 采样窗:短片取整段,长片取首/中/尾各 ~25s。 */
function sampleWindows(duration: number): Array<{ start: number; len: number }> {
  const d = Math.max(0, duration)
  if (d <= 35) return [{ start: 0, len: d || 25 }]
  const len = 25
  return [
    { start: 0, len },
    { start: Math.max(0, d / 2 - len / 2), len },
    { start: Math.max(0, d - len), len },
  ]
}

interface WhisperProbe {
  available: boolean
  charsPerSec?: number
  windowsWithText?: number
  totalWindows?: number
}

/** L2:对一个源片抽采样窗、跑 whisper,统计字密度。二进制/权重缺 → available:false。 */
async function whisperProbe(src: string, duration: number, opts: ClassifyOptions): Promise<WhisperProbe> {
  const env = opts.env ?? process.env
  if (opts.disableWhisperProbe) return { available: false }
  if (!resolveTranscribeAvailability(env).available) return { available: false }
  const windows = sampleWindows(duration)
  const workDir = await mkdtemp(join(tmpdir(), 'qf-vad-'))
  let totalChars = 0
  let totalSeconds = 0
  let windowsWithText = 0
  try {
    for (let i = 0; i < windows.length; i++) {
      if (opts.signal?.aborted) break
      const w = windows[i]!
      const wav = join(workDir, `w${i}.wav`)
      try {
        await runFfmpeg(ffmpegBin(env), ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(w.start), '-t', String(w.len), '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], {
          cwd: workDir,
          signal: opts.signal,
          timeoutMs: 60_000,
        })
        if (!existsSync(wav)) continue
        const text = await transcribeWavText(wav, { env, signal: opts.signal, timeoutMs: 5 * 60_000 })
        const chars = textCharCount(text)
        totalSeconds += w.len
        if (chars > 0) {
          totalChars += chars
          windowsWithText += 1
        }
      } catch {
        // 单窗失败不致命,继续下一窗。
      }
    }
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
  if (totalSeconds <= 0) return { available: true, charsPerSec: 0, windowsWithText: 0, totalWindows: windows.length }
  return {
    available: true,
    charsPerSec: totalChars / totalSeconds,
    windowsWithText,
    totalWindows: windows.length,
  }
}

/**
 * 内容分流器主入口:整批素材判 route。
 * 本轮按整批占比走主路(混合素材逐片分流留 P1)。
 */
export async function classifyContent(sources: RouteSourceInput[], opts: ClassifyOptions = {}): Promise<ClassifyResult> {
  const perSource: PerSourceRoute[] = sources.map(s => ({ src: basename(s.src), has_audio: s.has_audio }))
  const hasAudioAny = sources.some(s => s.has_audio)
  if (!hasAudioAny) {
    const decision = classifyRoute({ hasAudioAny: false })
    return { ...decision, perSource, signals: { hasAudioAny: false } }
  }

  // L1:对有音轨的源算有声比,按时长加权聚合。
  const audioSources = sources.filter(s => s.has_audio && s.duration > 0)
  let weighted = 0
  let weight = 0
  for (let i = 0; i < audioSources.length; i++) {
    const s = audioSources[i]!
    const ratio = await voicedRatioOf(s.src, s.duration, opts)
    if (ratio !== undefined) {
      weighted += ratio * s.duration
      weight += s.duration
      const entry = perSource.find(p => p.src === basename(s.src))
      if (entry) entry.voiced_ratio = Math.round(ratio * 1000) / 1000
    }
  }
  const voicedRatio = weight > 0 ? weighted / weight : undefined

  if (voicedRatio !== undefined && voicedRatio < VOICED_RATIO_MIN) {
    const decision = classifyRoute({ hasAudioAny, voicedRatio })
    return { ...decision, perSource, signals: { hasAudioAny, voicedRatio } }
  }

  // L2:选时长最长的有音轨源做 whisper 探针。
  const probeTarget = audioSources.slice().sort((a, b) => b.duration - a.duration)[0]
  const probe = probeTarget ? await whisperProbe(probeTarget.src, probeTarget.duration, opts) : { available: false as const }
  const signals: RouteSignals = {
    hasAudioAny,
    ...(voicedRatio !== undefined ? { voicedRatio } : {}),
    probeAvailable: probe.available,
    ...(probe.charsPerSec !== undefined ? { probeCharsPerSec: probe.charsPerSec } : {}),
    ...(probe.windowsWithText !== undefined ? { probeWindowsWithText: probe.windowsWithText } : {}),
    ...(probe.totalWindows !== undefined ? { probeTotalWindows: probe.totalWindows } : {}),
  }
  const decision = classifyRoute(signals)
  return { ...decision, perSource, signals }
}
