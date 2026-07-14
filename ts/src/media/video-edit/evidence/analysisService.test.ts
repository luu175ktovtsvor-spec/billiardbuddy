import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
