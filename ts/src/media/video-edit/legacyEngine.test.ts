import { test, expect } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseWhisperSegments,
  groupIntoPhrases,
  phrasesToCaptions,
  renderTakesPacked,
  resolveTranscribeAvailability,
  transcribeVideoWordLevel,
  TranscribeUnavailableError,
  type VideoTranscript,
} from '../transcribe'
import { classifyRoute, parseVoicedRatio, classifyContent } from './evidence/contentRouter'
import { VideoEditProjectStore, buildBgmMixArgs, normalizeTimelineDoc } from './legacyTimeline'
import { parseSceneCuts, buildShots } from './evidence/shotDetection'
import { parseSignalstats, summarizeMetrics, scoreShot, isBlackShot, isFrozenShot, selectAndRankShots, type CandidateShot } from './evidence/shotQuality'
import { estimateTempo, snapToBeats, planBeatDurations, beatPeriodFromBeats, onsetEnvelope } from './evidence/beatAnalysis'
import { parseVlmPlan, heuristicPlan, faceGuardActive, buildTagMessages, buildVlmModel, tagShots, type ShotForTag } from './evidence/visualTagger'
import type { Model } from '../../types/model'

const NO_BINARIES = {
  PATH: '/nonexistent/bin',
  QF_BINARIES_DIR: '/nonexistent/binaries',
  WHISPER_CLI: '',
  WHISPER_CPP_BIN: '',
  FFMPEG_BIN: '/nonexistent/ffmpeg',
  FFPROBE_BIN: '/nonexistent/ffprobe',
}

// ── 口播路:whisper JSON 解析 + phrases 按静音≥0.5s 分组 ──────────────────────

test('parseWhisperSegments: 段级 offsets(毫秒)→ 秒,过滤空/非法段', () => {
  const words = parseWhisperSegments({
    transcription: [
      { offsets: { from: 0, to: 1000 }, text: ' 你好' },
      { offsets: { from: 1200, to: 2000 }, text: '世界' },
      { offsets: { from: 2000, to: 2000 }, text: '空段' }, // to<=from,丢
      { offsets: { from: 3000, to: 4000 }, text: '再见' },
    ],
  })
  expect(words.map(w => [w.start, w.end, w.text])).toEqual([
    [0, 1, '你好'],
    [1.2, 2, '世界'],
    [3, 4, '再见'],
  ])
})

test('groupIntoPhrases: 静音≥0.5s 断句,gap<0.5 合并', () => {
  const words = [
    { start: 0, end: 1, text: '你好' },
    { start: 1.2, end: 2, text: '世界' }, // gap 0.2 → 同一 phrase
    { start: 3, end: 4, text: '再见' }, // gap 1.0 → 新 phrase
  ]
  const phrases = groupIntoPhrases(words, 0.5)
  expect(phrases.length).toBe(2)
  expect(phrases[0]).toMatchObject({ start: 0, end: 2, text: '你好世界' })
  expect(phrases[1]).toMatchObject({ start: 3, end: 4, text: '再见' })
})

test('groupIntoPhrases: 换说话人也断句', () => {
  const words = [
    { start: 0, end: 1, text: 'A', speaker: 'speaker_0' },
    { start: 1.1, end: 2, text: 'B', speaker: 'speaker_1' },
  ]
  expect(groupIntoPhrases(words, 0.5).length).toBe(2)
})

test('phrasesToCaptions: 只取镜头覆盖区间、映射到成片时间线', () => {
  const phrases = [
    { start: 0, end: 2, text: 'A' },
    { start: 3, end: 5, text: 'B' },
    { start: 8, end: 9, text: '越界' }, // 在 [srcIn,srcOut]=[0,4] 之外,丢
  ]
  const caps = phrasesToCaptions(phrases, 0, 4, 10)
  expect(caps).toEqual([
    { start: 10, end: 12, text: 'A' },
    { start: 13, end: 14, text: 'B' }, // end 被 srcOut=4 裁到 → 时间线 14
  ])
})

test('renderTakesPacked: 生成 phrase 级 markdown', () => {
  const t: VideoTranscript = {
    source: 'C0103.mp4',
    language: 'zh',
    duration: 4,
    words: [],
    phrases: [{ start: 2.52, end: 5.36, text: '开场白' }],
  }
  const md = renderTakesPacked([t])
  expect(md).toContain('## C0103.mp4')
  expect(md).toContain('[002.52-005.36] 开场白')
})

// ── 转写降级:二进制/权重未打包时优雅回退(不崩、给清晰提示)──────────────────

test('resolveTranscribeAvailability: 缺二进制/权重 → available=false + 清晰提示', () => {
  const a = resolveTranscribeAvailability(NO_BINARIES)
  expect(a.available).toBe(false)
  expect(a.reason).toBe('语音识别服务器未配置')
})

test('resolveTranscribeAvailability: 只有显式本地模式才检查离线引擎', () => {
  const a = resolveTranscribeAvailability({ ...NO_BINARIES, QF_TRANSCRIBE_MODE: 'local' })
  expect(a.available).toBe(false)
  expect(a.reason).toContain('本地离线引擎')
})

test('resolveTranscribeAvailability: 配置网关时优先远程且不要求本地权重', () => {
  const a = resolveTranscribeAvailability({
    ...NO_BINARIES,
    QF_GATEWAY_URL: 'https://gateway.example/gw',
    QF_GATEWAY_TOKEN: 'app-token',
  })
  expect(a).toMatchObject({ available: true, mode: 'remote', whisperBin: null, model: null })
})

test('transcribeVideoWordLevel: 缺二进制/权重抛 TranscribeUnavailableError(上层据此回退占位)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-t-'))
  const src = join(dir, 'a.mp4')
  writeFileSync(src, 'x')
  await expect(transcribeVideoWordLevel(src, dir, { env: NO_BINARIES })).rejects.toBeInstanceOf(TranscribeUnavailableError)
})

test.skipIf(process.platform === 'win32')('transcribeVideoWordLevel: 远程模式只上传抽取音轨并缓存时间戳结果', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-remote-transcribe-'))
  const src = join(dir, 'take.mp4')
  const ffmpeg = join(dir, 'fake-ffmpeg.sh')
  writeFileSync(src, 'video-bytes')
  writeFileSync(ffmpeg, '#!/bin/sh\nfor arg in "$@"; do out="$arg"; done\nprintf "flac-audio" > "$out"\n')
  chmodSync(ffmpeg, 0o755)
  let uploadedName = ''
  const transcript = await transcribeVideoWordLevel(src, dir, {
    env: {
      PATH: process.env.PATH,
      FFMPEG_BIN: ffmpeg,
      QF_GATEWAY_URL: 'https://gateway.example/gw',
      QF_GATEWAY_TOKEN: 'app-token',
    },
    fetchImpl: async (_input, init) => {
      const form = init?.body as FormData
      const file = form.get('file') as File
      uploadedName = file.name
      return Response.json({
        text: '检查球桌卫生', language: 'zh', duration: 2.5,
        segments: [
          { id: 0, start: 0, end: 1, text: '检查球桌' },
          { id: 1, start: 1.6, end: 2.5, text: '卫生' },
        ],
      })
    },
  })
  expect(uploadedName).toBe('audio.flac')
  expect(transcript).toMatchObject({
    source: 'take.mp4',
    phrases: [{ start: 0, end: 1, text: '检查球桌' }, { start: 1.6, end: 2.5, text: '卫生' }],
  })
  expect(existsSync(join(dir, 'transcripts', 'take.json'))).toBe(true)
})

// ── 内容分流器(VAD 三级判定)─────────────────────────────────────────────

test('classifyRoute L0: 无音轨 → broll', () => {
  expect(classifyRoute({ hasAudioAny: false })).toMatchObject({ route: 'broll', level: 'L0' })
})

test('classifyRoute L1: 有声比 < 0.15 → broll', () => {
  expect(classifyRoute({ hasAudioAny: true, voicedRatio: 0.1 })).toMatchObject({ route: 'broll', level: 'L1' })
})

test('classifyRoute L2: 探针字密度达标且多窗有文本 → speech', () => {
  expect(classifyRoute({ hasAudioAny: true, voicedRatio: 0.8, probeAvailable: true, probeCharsPerSec: 1.2, probeWindowsWithText: 2, probeTotalWindows: 3 }))
    .toMatchObject({ route: 'speech', level: 'L2' })
})

test('classifyRoute L2: 有声但探针空/字密度低 → broll(疑为音乐/环境音)', () => {
  expect(classifyRoute({ hasAudioAny: true, voicedRatio: 0.8, probeAvailable: true, probeCharsPerSec: 0.1, probeWindowsWithText: 0, probeTotalWindows: 3 }))
    .toMatchObject({ route: 'broll', level: 'L2' })
})

test('classifyRoute: 有声但探针未打包 → 保守回退 broll(门店主路)', () => {
  expect(classifyRoute({ hasAudioAny: true, voicedRatio: 0.8, probeAvailable: false }).route).toBe('broll')
})

test('parseVoicedRatio: 两段静音 → 有声比', () => {
  const stderr = [
    '[silencedetect @ x] silence_start: 0',
    '[silencedetect @ x] silence_end: 2 | silence_duration: 2',
    '[silencedetect @ x] silence_start: 8',
    '[silencedetect @ x] silence_end: 10 | silence_duration: 2',
  ].join('\n')
  expect(parseVoicedRatio(stderr, 10)).toBeCloseTo(0.6, 5)
})

test('parseVoicedRatio: 片尾停在静音(无 silence_end)也补到片尾', () => {
  const stderr = '[silencedetect @ x] silence_start: 9'
  expect(parseVoicedRatio(stderr, 10)).toBeCloseTo(0.9, 5)
})

test('classifyContent: 整批无音轨 → L0 broll(不 spawn 任何二进制)', async () => {
  const result = await classifyContent([{ src: 'a.mp4', has_audio: false, duration: 5 }], { disableWhisperProbe: true })
  expect(result).toMatchObject({ route: 'broll', level: 'L0' })
  expect(result.perSource[0]).toMatchObject({ has_audio: false })
})

// ── 占位回填:createLocalPlan 分流 + 优雅降级 ───────────────────────────────

function newStore(): { store: VideoEditProjectStore; stateRoot: string } {
  const stateRoot = mkdtempSync(join(tmpdir(), 'qf-store-'))
  return { store: new VideoEditProjectStore(stateRoot), stateRoot }
}

function dummyVideo(stateRoot: string, name: string): string {
  const dir = join(stateRoot, 'src')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, 'x')
  return p
}

test('createLocalPlan: 无音轨自动判 broll,phrases 空、占位「门店高光」、used_vlm=false', async () => {
  const { store, stateRoot } = newStore()
  const src = dummyVideo(stateRoot, 'env.mp4')
  const res = await store.createLocalPlan({ project: 'p1', video_paths: [src] }, { env: NO_BINARIES }) as Record<string, any>
  expect(res.route).toBe('broll')
  expect(res.used_vlm).toBe(false)
  expect(res.has_speech).toBe(false)
  expect(res.candidates[0].phrases).toEqual([])
  expect(res.captions[0]).toContain('门店高光')
  expect(String(res.report)).toContain('B-Roll')
})

test('createLocalPlan: 显式 speech 但转写不可用 → 占位「口播片段」、不崩', async () => {
  const { store, stateRoot } = newStore()
  const src = dummyVideo(stateRoot, 'talk.mp4')
  const res = await store.createLocalPlan({ project: 'p2', video_paths: [src], mode: 'speech' }, { env: NO_BINARIES }) as Record<string, any>
  expect(res.route).toBe('speech')
  expect(res.transcribed).toBe(false)
  expect(res.captions[0]).toContain('口播片段')
})

test('planEdit: broll 五步只吐原子操作、走 applyOperations 落时间线(缺 ffmpeg/网关优雅降级)', async () => {
  const { store, stateRoot } = newStore()
  const src = dummyVideo(stateRoot, 'clip.mp4')
  // NO_BINARIES:ffmpeg 缺 → 切镜头降级整段一镜、打分中性、无关键帧;网关缺 → VLM 降级启发式。
  const res = await store.planEdit({ project: 'p3', video_paths: [src] }, { env: NO_BINARIES }) as Record<string, any>
  expect(res.applied).toBe(true)
  expect(res.errors).toEqual([])
  expect(res.route).toBe('broll')
  expect(res.broll).toBe(true)
  expect(res.used_vlm).toBe(false) // 网关未配置 → 启发式
  expect(Array.isArray(res.broll_notes)).toBe(true)
  expect(String(res.report)).toContain('B-Roll')
  // 收敛自 createLocalPlan 的素材健康报告:两条 plan 路都给店主同一套字段(接线不丢口径)。
  expect(res.footage_health?.m1).toBeDefined()
  expect(res.health_summary?.total).toBe(1)
  expect(Array.isArray(res.warnings)).toBe(true)
  // 没有用户提供文字时只落真实视频片段，不再自动补门店卖点字卡。
  const project = await store.getProject('p3')
  expect(project.doc.clips.length).toBeGreaterThanOrEqual(1)
  expect(project.doc.captions).toHaveLength(0)
  const clip = project.doc.clips[0]!
  expect(clip.src_out).toBeGreaterThan(clip.src_in)
})

test('autoCaption: 转写不可用回退占位「镜头 N」,message 说明需打包', async () => {
  const { store, stateRoot } = newStore()
  const src = dummyVideo(stateRoot, 'x.mp4')
  await store.planEdit({ project: 'p4', video_paths: [src] }, { env: NO_BINARIES })
  // planEdit 已生成占位字幕,清掉字幕轨再测 autoCaption 从零补。
  const doc = normalizeTimelineDoc(JSON.parse(readFileSync(join(stateRoot, 'uploads', 'edits', 'p4', 'timeline.json'), 'utf8')))
  for (const [id, clip] of Object.entries(doc.clips)) if (doc.tracks[clip.track]?.kind === 'caption') delete doc.clips[id]
  writeFileSync(join(stateRoot, 'uploads', 'edits', 'p4', 'timeline.json'), JSON.stringify(doc))
  const res = await store.autoCaption('p4', 'sub', { env: NO_BINARIES })
  expect(res.ok).toBe(true)
  expect(res.doc.captions[0]?.text).toContain('镜头')
})

// ── BGM 混音渲染修复 ───────────────────────────────────────────────────────

test('buildBgmMixArgs: 口播路(base 有音轨)→ 含 BGM 输入 + amix + volume(duck)', () => {
  const args = buildBgmMixArgs({ basePath: '/tmp/base.mp4', musicPath: '/tmp/bgm.mp3', outputPath: '/tmp/out.mp4', baseHasAudio: true, musicVolume: 0.25, loudnessFilter: 'loudnorm=I=-16:TP=-1.5:LRA=11' })
  const line = args.join(' ')
  expect(args).toContain('/tmp/bgm.mp3')
  expect(line).toContain('amix')
  expect(line).toContain('volume=0.25')
  expect(line).toContain('loudnorm')
  expect(line).toContain('-stream_loop -1')
})

test('buildBgmMixArgs: B-Roll 路(base 无音轨)→ BGM 为主音、不 amix', () => {
  const args = buildBgmMixArgs({ basePath: '/tmp/base.mp4', musicPath: '/tmp/bgm.mp3', outputPath: '/tmp/out.mp4', baseHasAudio: false, musicVolume: 0.9 })
  const line = args.join(' ')
  expect(line).toContain('volume=0.9')
  expect(line).not.toContain('amix')
  expect(line).toContain('-map [bgm]')
})

test('renderProject: 有 doc.music 时会读 music 并混 BGM(mock ffmpeg 断言含 amix + BGM 输入)', async () => {
  const { store, stateRoot } = newStore()
  const src = dummyVideo(stateRoot, 'v.mp4')
  const bgm = dummyVideo(stateRoot, 'bgm.mp3')
  const editDir = join(stateRoot, 'uploads', 'edits', 'r1')
  mkdirSync(editDir, { recursive: true })
  const doc = {
    version: 1, fps: 30, width: 1080, height: 1920,
    media: {
      m1: { src, duration: 5, kind: 'video', has_audio: true },
      bgm: { src: bgm, duration: 30, kind: 'audio', has_audio: true },
    },
    tracks: { v1: { kind: 'video', order: 0 }, sub: { kind: 'caption', order: 1 } },
    clips: { c1: { track: 'v1', order: 0, media: 'm1', src_in: 0, src_out: 3, text: null, start: null, end: null, style: null, gain: null, effects: [] } },
    grade: null,
    music: 'bgm',
  }
  writeFileSync(join(editDir, 'timeline.json'), JSON.stringify(doc))

  // 假 ffmpeg:把每次调用参数记进 log,创建输出文件后退出 0(不真跑)。
  const log = join(stateRoot, 'ffmpeg.log')
  const fake = join(stateRoot, 'fake-ffmpeg.sh')
  writeFileSync(fake, ['#!/bin/sh', `printf '%s\\n' "$@" >> "${log}"`, "printf '=====CALL=====\\n' >> \"" + log + '"', 'for last in "$@"; do :; done', ': > "$last" 2>/dev/null || true', 'exit 0'].join('\n'))
  const { chmodSync } = await import('node:fs')
  chmodSync(fake, 0o755)

  const res = await store.renderProject('r1', {}, { env: { FFMPEG_BIN: fake, FFPROBE_BIN: fake } }) as Record<string, any>
  expect(res.bgm_mixed).toBe(true)
  expect(res.music).toBe('bgm')
  expect(res.music_volume).toBe(0.25) // base 有音轨 → duck
  const logText = readFileSync(log, 'utf8')
  expect(logText).toContain('amix')
  expect(logText).toContain(bgm) // BGM 作为输入进了 ffmpeg
  expect(existsSync(join(stateRoot, 'uploads', 'videos'))).toBe(true)
})

// ── B-Roll 步1:镜头切分(scene 分数解析 + 最小镜头长合并)────────────────────

test('parseSceneCuts: 从 showinfo stderr 抽 pts_time 切点(排序、去 0)', () => {
  const stderr = [
    '[Parsed_showinfo_1 @ 0x] n:0 pts:150000 pts_time:5 pos:1',
    '[Parsed_showinfo_1 @ 0x] n:1 pts:75000 pts_time:2.5 pos:2',
    '[Parsed_showinfo_1 @ 0x] n:2 pts:0 pts_time:0 pos:0', // t=0 丢
  ].join('\n')
  expect(parseSceneCuts(stderr)).toEqual([2.5, 5])
})

test('buildShots: 切点 + 时长 → 连续镜头区间', () => {
  expect(buildShots([2.5, 5], 8, 0.5)).toEqual([
    { start: 0, end: 2.5 },
    { start: 2.5, end: 5 },
    { start: 5, end: 8 },
  ])
})

test('buildShots: 无切点 → 整段一个镜头(降级)', () => {
  expect(buildShots([], 6, 0.5)).toEqual([{ start: 0, end: 6 }])
})

test('buildShots: 过短碎片并入相邻镜头(min_scene_len)', () => {
  // 0.2s 首镜头 < 0.5 → 并入下一镜头。
  expect(buildShots([0.2, 3], 5, 0.5)).toEqual([
    { start: 0, end: 3 },
    { start: 3, end: 5 },
  ])
})

// ── B-Roll 步2:启发式打分/选段排序(signalstats 解析 + 黑场/冻结淘汰)──────────

test('parseSignalstats + summarizeMetrics: 抽 YAVG/YDIF 求均值', () => {
  const stderr = [
    '[Parsed_metadata_3 @ 0x] lavfi.signalstats.YAVG=100',
    '[Parsed_metadata_3 @ 0x] lavfi.signalstats.YDIF=4',
    '[Parsed_metadata_3 @ 0x] lavfi.signalstats.YAVG=140',
    '[Parsed_metadata_3 @ 0x] lavfi.signalstats.YDIF=6',
  ].join('\n')
  const stats = parseSignalstats(stderr)
  expect(stats.yavg).toEqual([100, 140])
  const m = summarizeMetrics(stats)
  expect(m.avgLuma).toBe(120)
  expect(m.avgMotion).toBe(5)
})

test('scoreShot: 曝光/运动都在理想区 → 高分;无指标 → 中性 0.6', () => {
  expect(scoreShot({ avgLuma: 120, avgMotion: 5, frames: 5 })).toBe(1)
  expect(scoreShot(undefined)).toBe(0.6)
})

test('isBlackShot / isFrozenShot: 黑场与冻结判定', () => {
  expect(isBlackShot({ avgLuma: 8, avgMotion: 3, frames: 5 })).toBe(true)
  expect(isBlackShot({ avgLuma: 120, avgMotion: 3, frames: 5 })).toBe(false)
  expect(isFrozenShot({ avgLuma: 120, avgMotion: 0.05, frames: 5 })).toBe(true)
  expect(isFrozenShot({ avgLuma: 120, avgMotion: 3, frames: 5 })).toBe(false)
})

test('selectAndRankShots: 黑场/冻结淘汰,好镜头按分降序保留,超 maxShots 截掉', () => {
  const shots: CandidateShot[] = [
    { id: 'm1#0', mediaId: 'm1', start: 0, end: 2, index: 0, metrics: { avgLuma: 120, avgMotion: 5, frames: 5 } }, // 好,分高
    { id: 'm1#1', mediaId: 'm1', start: 2, end: 4, index: 1, metrics: { avgLuma: 8, avgMotion: 5, frames: 5 } }, // 黑场淘汰
    { id: 'm1#2', mediaId: 'm1', start: 4, end: 6, index: 2, metrics: { avgLuma: 120, avgMotion: 0.05, frames: 5 } }, // 冻结淘汰
    { id: 'm1#3', mediaId: 'm1', start: 6, end: 8, index: 3, metrics: { avgLuma: 30, avgMotion: 5, frames: 5 } }, // 偏暗,分较低但保留
  ]
  const ranked = selectAndRankShots(shots, { maxShots: 1 })
  const kept = ranked.filter(s => s.keep)
  expect(kept.length).toBe(1)
  expect(kept[0]!.index).toBe(0) // 最高分
  const black = ranked.find(s => s.index === 1)!
  expect(black.keep).toBe(false)
  expect(black.reason).toContain('黑场')
})

// ── B-Roll 步3:节拍卡点(手写 Ellis,无 package.json 变更)────────────────────

test('estimateTempo: 周期性 onset 包络 → 正确 BPM(120)', () => {
  const fps = 100
  const env = new Array(2000).fill(0).map((_, i) => (i % 50 === 0 ? 1 : 0)) // 每 50 帧一拍 → 120BPM
  const bpm = estimateTempo(env, fps)
  expect(Math.abs(bpm - 120)).toBeLessThan(4)
})

test('onsetEnvelope: 能量上升处才有正向包络值', () => {
  const sr = 1000
  const samples = new Float32Array(2048)
  for (let i = 1024; i < 1536; i++) samples[i] = 0.9 // 后半段来能量
  const { env, fps } = onsetEnvelope(samples, sr, 512)
  expect(fps).toBeCloseTo(sr / 512, 5)
  expect(env.some(v => v > 0)).toBe(true)
})

test('snapToBeats: 切点吸附到最近鼓点(超窗不动)', () => {
  expect(snapToBeats([1.02, 2.5], [1.0, 1.5, 2.0], 0.12)).toEqual([1.0, 2.5]) // 2.5 距最近拍 0.5>窗,不动
})

test('planBeatDurations: 有节拍 → 整数拍时长;无节拍 → 等分', () => {
  expect(planBeatDurations(3, 1.0, { beatsPerShot: 2 })).toEqual([2, 2, 2])
  expect(planBeatDurations(4, 0, { targetDuration: 12 })).toEqual([3, 3, 3, 3])
})

test('beatPeriodFromBeats: 拍点间隔中位数', () => {
  expect(beatPeriodFromBeats([0, 0.5, 1.0, 1.5])).toBe(0.5)
})

// ── B-Roll 步4:VLM 打标签/排序 + 降级 ─────────────────────────────────────

const twoShots: ShotForTag[] = [
  { index: 0, mediaId: 'm1', start: 0, end: 2, durationSec: 2, avgLuma: 150, avgMotion: 2, thumbBase64: 'AAA' },
  { index: 1, mediaId: 'm1', start: 2, end: 4, durationSec: 2, avgLuma: 90, avgMotion: 8, thumbBase64: 'BBB' },
]

function fakeModel(text: string): Model {
  return { step: async () => ({ kind: 'final', text }) }
}

test('buildTagMessages: 组多模态 prompt(文字 + 每镜头 image block)', () => {
  const msgs = buildTagMessages(twoShots)
  expect(msgs.length).toBe(1)
  const imgs = msgs[0]!.content.filter(b => b.type === 'image')
  expect(imgs.length).toBe(2)
  const prompt = JSON.stringify(msgs)
  expect(prompt).not.toMatch(/台球|球房|门店卖点|营销叙事|PPT/u)
  expect(prompt).toContain('实际可见证据')
})

test('video VLM uses the configured MiMo provider only when image content is enabled', () => {
  const base = {
    TEXT_MODEL_NAME: 'mimo-v2.5',
    OPENAI_BASE_URL: 'https://gateway.example/v1',
    OPENAI_API_KEY: 'app-token',
  }
  expect(buildVlmModel(base)).not.toBeNull()
  expect(buildVlmModel({ ...base, OPENAI_CHAT_IMAGE_MODE: 'text_only' })).toBeNull()
})

test('video VLM never revives the removed ARK/Doubao visual provider', () => {
  expect(buildVlmModel({
    VLM_MODEL_DOUBAO: 'doubao-seed-1-6-250615',
    VIDEO_VLM_MODEL: 'doubao-seed-1-6-250615',
    ARK_BASE_URL: 'https://ark.example/api/v3',
    ARK_API_KEY: 'ark-secret',
    QF_GATEWAY_URL: 'https://gateway.example/v1',
    QF_GATEWAY_TOKEN: 'app-token',
  })).toBeNull()
})

test('parseVlmPlan: 解析 order/tags/captions/drop,补齐漏排、剔除 drop', () => {
  const text = '```json\n{"shots":[{"index":2,"tag":"门头招牌","caption":"门头亮眼"}],"order":[2],"drop":[1],"grade":"warm"}\n```'
  const plan = parseVlmPlan(text, [0, 1, 2])
  expect(plan).not.toBeNull()
  expect(plan!.order).toEqual([2, 0]) // 2 来自 order,0 补齐,1 被 drop 剔除
  expect(plan!.drop).toEqual([1])
  expect(plan!.tags[2]).toBe('门头招牌')
  expect(plan!.grade).toBe('warm')
})

test('parseVlmPlan: 非 JSON → null(上层退启发式)', () => {
  expect(parseVlmPlan('抱歉我看不懂', [0, 1])).toBeNull()
})

test('faceGuardActive + heuristicPlan: 含人脸走启发式', () => {
  expect(faceGuardActive([{ index: 0, mediaId: 'm1', start: 0, end: 1, durationSec: 1, hasFace: true }])).toBe(true)
  const plan = heuristicPlan(twoShots)
  expect(plan.usedVlm).toBe(false)
  expect(plan.order.length).toBe(2)
  expect(plan.captions).toEqual({})
})

test('tagShots: 网关模型返回 JSON → usedVlm=true,只采用证据标签和排序', async () => {
  const plan = await tagShots(twoShots, {
    model: fakeModel('{"shots":[{"index":0,"tag":"门头","caption":"门头亮眼"},{"index":1,"tag":"台面","caption":"台面干净"}],"order":[1,0],"grade":"warm"}'),
  })
  expect(plan.usedVlm).toBe(true)
  expect(plan.order).toEqual([1, 0])
  expect(plan.captions).toEqual({})
  expect(plan.grade).toBe('warm')
})

test('tagShots: 无网关模型 → 降级启发式(usedVlm=false)', async () => {
  const plan = await tagShots(twoShots, { model: null })
  expect(plan.usedVlm).toBe(false)
  expect(plan.reason).toContain('启发式')
})

test('tagShots: 模型报错 → 降级启发式、不崩', async () => {
  const throwing: Model = { step: async () => { throw new Error('gateway down') } }
  const plan = await tagShots(twoShots, { model: throwing })
  expect(plan.usedVlm).toBe(false)
  expect(plan.order.length).toBe(2)
})

test('tagShots: 含人脸即便有模型也走启发式(隐私护栏,不外传人脸)', async () => {
  let called = false
  const spy: Model = { step: async () => { called = true; return { kind: 'final', text: '{}' } } }
  const withFace: ShotForTag[] = [{ index: 0, mediaId: 'm1', start: 0, end: 2, durationSec: 2, hasFace: true, thumbBase64: 'AAA' }]
  const plan = await tagShots(withFace, { model: spy })
  expect(called).toBe(false) // 没调网关
  expect(plan.usedVlm).toBe(false)
  expect(plan.reason).toContain('人脸')
})

test('planEdit(mode=ambient): 显式环境模式也走 broll 五步、落合法时间线', async () => {
  const { store, stateRoot } = newStore()
  const src = dummyVideo(stateRoot, 'amb.mp4')
  const res = await store.planEdit({ project: 'pb', video_paths: [src], mode: 'ambient' }, { env: NO_BINARIES }) as Record<string, any>
  expect(res.route).toBe('broll')
  expect(res.applied).toBe(true)
  expect(res.broll).toBe(true)
  const project = await store.getProject('pb')
  expect(project.doc.clips.length).toBeGreaterThanOrEqual(1)
})
