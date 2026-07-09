import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
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
} from './transcribe'
import { classifyRoute, parseVoicedRatio, classifyContent } from './videoContentRouter'
import { VideoEditProjectStore, buildBgmMixArgs, normalizeTimelineDoc } from './videoEditProjects'

const NO_BINARIES = { PATH: '', WHISPER_CLI: '', WHISPER_CPP_BIN: '', FFMPEG_BIN: '/nonexistent/ffmpeg', FFPROBE_BIN: '/nonexistent/ffprobe' }

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
  expect(a.reason).toContain('whisper-cli')
})

test('transcribeVideoWordLevel: 缺二进制/权重抛 TranscribeUnavailableError(上层据此回退占位)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qf-t-'))
  const src = join(dir, 'a.mp4')
  writeFileSync(src, 'x')
  await expect(transcribeVideoWordLevel(src, dir, { env: NO_BINARIES })).rejects.toBeInstanceOf(TranscribeUnavailableError)
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

test('planEdit: 统一入口只吐原子操作、走 applyOperations 落时间线', async () => {
  const { store, stateRoot } = newStore()
  const src = dummyVideo(stateRoot, 'clip.mp4')
  const res = await store.planEdit({ project: 'p3', video_paths: [src] }, { env: NO_BINARIES }) as Record<string, any>
  expect(res.applied).toBe(true)
  expect(res.errors).toEqual([])
  expect(res.route).toBe('broll')
  expect(res.broll_stub).toBe(true)
  // 落盘的时间线可再读回,含 1 个视频片段 + 占位字幕。
  const project = await store.getProject('p3')
  expect(project.doc.clips.length).toBe(1)
  expect(project.doc.captions.length).toBeGreaterThan(0)
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
