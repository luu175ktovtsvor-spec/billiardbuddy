// B-Roll 五步之一:镜头切分(scene detect)。
//
// 复刻 PySceneDetect ContentDetector 思路,但不带 Python/onnx——用 bundled ffmpeg 的
// `scene` 分数(帧间差,和 HSV 差同源)。命令:
//   ffmpeg -i <src> -filter:v "select='gt(scene,T)',showinfo" -an -f null -
// 解析 stderr 里每个命中帧的 pts_time 得切点;TS 侧后处理复刻两个保护:
//   ① 最小镜头长(合并过近切点,= min_scene_len);② 落回整段(切不出就当一个镜头)。
// 起始阈值 T=0.35(对应 PySceneDetect 27.0/255≈0.3~0.4),min_scene_len 0.5s。

import { existsSync } from 'node:fs'
import { ffmpegBinFrom, runFfmpegText } from './brollFfmpeg'

export const SCENE_THRESHOLD = 0.35
export const MIN_SCENE_LEN = 0.5

export interface Shot {
  start: number
  end: number
}

export interface SceneDetectOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  threshold?: number
  minSceneLen?: number
  timeoutMs?: number
}

/** 解析 showinfo 的 stderr,抽出每个命中帧的 pts_time(秒)。纯函数,可单测。 */
export function parseSceneCuts(stderr: string): number[] {
  const cuts: number[] = []
  for (const line of stderr.split(/\r?\n/)) {
    const m = line.match(/pts_time:\s*([0-9]+(?:\.[0-9]+)?)/)
    if (m) {
      const t = Number.parseFloat(m[1]!)
      if (Number.isFinite(t) && t > 0) cuts.push(Math.round(t * 1000) / 1000)
    }
  }
  return cuts.sort((a, b) => a - b)
}

/**
 * 把切点(每个是"新镜头起点")+ 总时长 → 连续镜头区间,并合并 < minSceneLen 的碎片。纯函数。
 * 切不出任何切点 → 返回整段一个镜头。
 */
export function buildShots(cutTimes: number[], duration: number, minSceneLen = MIN_SCENE_LEN): Shot[] {
  const dur = Math.max(0, Math.round(duration * 1000) / 1000)
  if (!(dur > 0)) return []
  // 边界 = [0, ...去重过滤后的切点, dur]。
  const bounds = [0]
  for (const t of cutTimes) {
    if (t > (bounds[bounds.length - 1] ?? 0) + 1e-3 && t < dur - 1e-3) bounds.push(Math.round(t * 1000) / 1000)
  }
  bounds.push(dur)
  const shots: Shot[] = []
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = bounds[i]!
    const end = bounds[i + 1]!
    if (end - start < minSceneLen && shots.length) {
      // 碎片合并进上一镜头。
      shots[shots.length - 1]!.end = end
    } else {
      shots.push({ start, end })
    }
  }
  // 若首镜头自身过短且后面还有镜头,把它并入下一镜头。
  if (shots.length >= 2 && shots[0]!.end - shots[0]!.start < minSceneLen) {
    shots[1]!.start = shots[0]!.start
    shots.shift()
  }
  return shots.length ? shots : [{ start: 0, end: dur }]
}

/**
 * 对一个源片跑 scene detect,得到镜头区间。缺 ffmpeg / 失败 / 切不出 → 优雅降级为整段一个镜头。
 */
export async function detectScenes(src: string, duration: number, opts: SceneDetectOptions = {}): Promise<Shot[]> {
  const fallback: Shot[] = duration > 0 ? [{ start: 0, end: Math.round(duration * 1000) / 1000 }] : []
  if (!/^https?:/i.test(src) && !existsSync(src)) return fallback
  const threshold = opts.threshold ?? SCENE_THRESHOLD
  const minSceneLen = opts.minSceneLen ?? MIN_SCENE_LEN
  try {
    const res = await runFfmpegText(ffmpegBinFrom(opts.env), [
      '-hide_banner', '-nostats',
      '-i', src,
      '-filter:v', `select='gt(scene,${threshold})',showinfo`,
      '-an', '-f', 'null', '-',
    ], { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 5 * 60_000 })
    const cuts = parseSceneCuts(res.stderr)
    const shots = buildShots(cuts, duration, minSceneLen)
    return shots.length ? shots : fallback
  } catch {
    return fallback
  }
}
