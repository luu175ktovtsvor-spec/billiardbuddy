import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Model } from '../../../types/model'
import type { AsrAdapter } from './asr'
import { VideoEvidenceService } from './analysisService'
import { VideoProjectStore } from '../projectStore'

test('evidence analysis stores provider metadata and uses transcript only when adapter returned it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-evidence-'))
  const path = join(root, 'talk.mp4')
  writeFileSync(path, 'video')
  const store = new VideoProjectStore(root)
  const project = await store.create({ video_paths: [path] })
  const asr: AsrAdapter = {
    id: 'test-asr', version: '1',
    async transcribe(source) {
      return {
        provider: 'test-asr', providerVersion: '1',
        transcript: { source, language: 'zh', duration: 2, words: [], phrases: [{ start: 0, end: 2, text: '真实识别文本' }] },
      }
    },
  }
  const checkpoints: string[] = []
  const analyzed = await new VideoEvidenceService(store, { asr, env: { PATH: '', FFMPEG_BIN: '/missing', FFPROBE_BIN: '/missing' } }).analyze(project.project_id, undefined, {
    onCheckpoint(checkpoint) { checkpoints.push(String(checkpoint.phase)) },
  })
  expect(analyzed.evidence.some(item => item.kind === 'transcript' && item.provider === 'test-asr')).toBe(true)
  expect(new Set(analyzed.evidence.map(item => item.kind))).toEqual(new Set(['transcript', 'shot', 'visual', 'audio', 'source_role']))
  expect(analyzed.sources[0]?.role).toBe('talking_take')
  expect(checkpoints).toEqual(['source_started', 'source_done'])
  const read = await new VideoEvidenceService(store, { asr }).readEvidence(analyzed, 'transcript')
  expect(JSON.stringify(read[0]?.value)).toContain('真实识别文本')
})

test('authorized music gets fingerprint-bound local evidence and degrades without fake beat claims', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-music-evidence-'))
  const source = join(root, 'source.mp4')
  const music = join(root, 'music.wav')
  writeFileSync(source, 'video')
  writeFileSync(music, 'music')
  const store = new VideoProjectStore(root)
  let project = await store.create({ video_paths: [source] })
  project = (await store.apply(project.project_id, project.revision, [{
    type: 'project.set_music', music: { path: music, license_id: 'licensed-by-owner', energy: 'natural', enabled: true },
  }])).project
  const service = new VideoEvidenceService(store, { env: { PATH: '', FFMPEG_BIN: '/missing' } })
  project = await service.analyzeMusic(project.project_id)
  const ref = project.evidence.find(item => item.kind === 'music')
  expect(ref).toMatchObject({ provider: 'local-beat-analysis', source_fingerprint: project.music.fingerprint, status: 'warning' })
  const values = await service.readEvidence(project, 'music')
  expect(values[0]?.value).toMatchObject({ license_id: 'licensed-by-owner', fingerprint: project.music.fingerprint, beats_ms: [] })
  expect(project.status.warnings.join(' ')).toContain('不做机械卡点')
})

test('ambient analysis skips transcription and reports visible analysis stages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-ambient-evidence-'))
  const path = join(root, 'ambient.mp4')
  writeFileSync(path, 'video')
  const store = new VideoProjectStore(root)
  const project = await store.create({ video_paths: [path], goal: 'ambient' })
  let transcribeCalls = 0
  const asr: AsrAdapter = {
    id: 'test-asr', version: '1',
    async transcribe() {
      transcribeCalls += 1
      return { provider: 'test-asr', providerVersion: '1', transcript: null }
    },
  }
  const stages: string[] = []
  await new VideoEvidenceService(store, { asr, env: { PATH: '', FFMPEG_BIN: '/missing', FFPROBE_BIN: '/missing' } }).analyze(
    project.project_id,
    { signal: new AbortController().signal, emit: async () => ({ seq: 1, ts: '', event: { type: 'done' } }), progress: async (_progress, stage) => { if (stage) stages.push(stage) } },
    { transcription: 'skip' },
  )
  expect(transcribeCalls).toBe(0)
  expect(stages.some(stage => stage.includes('寻找可用画面'))).toBe(true)
  expect(stages.some(stage => stage.includes('识别口播'))).toBe(false)
})

test('auto analysis classifies speech before deciding whether to run the full transcript', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-auto-route-'))
  const path = join(root, 'ordinary-name.mp4')
  writeFileSync(path, 'video')
  const store = new VideoProjectStore(root)
  const project = await store.create({ video_paths: [path] })
  let transcribeCalls = 0
  let classifyCalls = 0
  const asr: AsrAdapter = {
    id: 'test-asr', version: '1',
    async transcribe(source) {
      transcribeCalls += 1
      return {
        provider: 'test-asr', providerVersion: '1',
        transcript: { source, language: 'zh', duration: 3, words: [], phrases: [{ start: 0, end: 3, text: '这是实际口播内容' }] },
      }
    },
  }
  const analyzed = await new VideoEvidenceService(store, {
    asr,
    env: { PATH: '', FFMPEG_BIN: '/missing', FFPROBE_BIN: '/missing' },
    classifyContent: async () => {
      classifyCalls += 1
      return {
        route: 'speech', level: 'L2', reason: '测试识别为口播',
        perSource: [{ src: 'ordinary-name.mp4', has_audio: true }],
        signals: { hasAudioAny: true, probeAvailable: true, probeCharsPerSec: 1, probeWindowsWithText: 1, probeTotalWindows: 1 },
      }
    },
  }).analyze(project.project_id, undefined, { transcription: 'auto' })
  expect(classifyCalls).toBe(1)
  expect(transcribeCalls).toBe(1)
  expect(analyzed.sources[0]?.role).toBe('talking_take')
  expect(analyzed.evidence.some(item => item.kind === 'transcript')).toBe(true)
})

test('auto analysis does not run a full transcript for a source classified as ambient footage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-auto-ambient-'))
  const path = join(root, 'clip.mp4')
  writeFileSync(path, 'video')
  const store = new VideoProjectStore(root)
  const project = await store.create({ video_paths: [path] })
  let transcribeCalls = 0
  const asr: AsrAdapter = {
    id: 'test-asr', version: '1',
    async transcribe() {
      transcribeCalls += 1
      return { provider: 'test-asr', providerVersion: '1', transcript: null }
    },
  }
  await new VideoEvidenceService(store, {
    asr,
    env: { PATH: '', FFMPEG_BIN: '/missing', FFPROBE_BIN: '/missing' },
    classifyContent: async () => ({
      route: 'broll', level: 'L1', reason: '测试识别为环境素材',
      perSource: [{ src: 'clip.mp4', has_audio: true }],
      signals: { hasAudioAny: true, voicedRatio: 0.05 },
    }),
  }).analyze(project.project_id, undefined, { transcription: 'auto' })
  expect(transcribeCalls).toBe(0)
})

test('visual evidence uses a bounded gateway VLM sample and promotes observed source roles', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-vlm-evidence-'))
  const path = join(root, 'clip.mp4')
  writeFileSync(path, 'video')
  const store = new VideoProjectStore(root)
  const project = await store.create({ video_paths: [path], goal: 'ambient' })
  let modelCalls = 0
  const model: Model = {
    async step() {
      modelCalls += 1
      return { kind: 'final', text: '{"shots":[{"index":0,"tag":"人物击球动作"}],"order":[0],"drop":[],"grade":"neutral"}' }
    },
  }
  const analyzed = await new VideoEvidenceService(store, {
    env: { PATH: '', FFMPEG_BIN: '/missing', FFPROBE_BIN: '/missing' },
    visualModel: model,
    extractKeyframe: async () => 'jpeg-base64',
  }).analyze(project.project_id, undefined, { transcription: 'skip' })
  expect(modelCalls).toBe(1)
  expect(analyzed.sources[0]?.role).toBe('play_action')
  const ref = analyzed.evidence.find(item => item.kind === 'visual')
  expect(ref).toMatchObject({ provider: 'gateway-vlm-visual-evidence' })
  const visual = await new VideoEvidenceService(store).readEvidence(analyzed, 'visual')
  expect(visual[0]?.value).toMatchObject({ local_only: false })
  expect(JSON.stringify(visual[0]?.value)).toContain('人物击球动作')
})
