import { expect, test } from 'bun:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { videoSceneSchema } from '../../../../shared/contracts/video-edit'
import { VideoProjectStore } from '../projectStore'
import { inspectRenderedVideo, renderAssDocument, VideoRenderer } from './renderer'

test('renderer locks revision, reads original sources and writes a deterministic export manifest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-render-v2-'))
  const source = join(root, 'source.mp4')
  writeFileSync(source, 'source-video')
  const store = new VideoProjectStore(root)
  let project = await store.create({ video_paths: [source], ratio: '9:16' })
  project.sources[0]!.duration_ms = 3000
  project.sources[0]!.has_audio = true
  await store.replaceAnalysis(project.project_id, { sources: project.sources, evidence: [], status: project.status })
  project = await store.load(project.project_id)
  const range = { source_id: project.sources[0]!.id, in_ms: 0, out_ms: 3000 }
  const scene = videoSceneSchema.parse({
    id: 'scene-1', order: 0, story_role: 'hook', edit_clock: 'dialogue', visual_role: 'talking_head',
    source_ranges: [range], output_range: { start_ms: 0, end_ms: 3000 },
    dialogue: { original_text: '原文', semantic_text: '原文', display_text: '显示字幕' },
    video_layers: [{ id: 'layer-1', role: 'primary', source_range: range, speed: 1.5, crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.6, fit: 'cover' } }],
    audio_layers: [{ id: 'audio-1', role: 'speech', source_range: range, owner: true, gain_envelope: [{ at_ms: 0, gain: 0.7 }, { at_ms: 2000, gain: 1 }] }],
    attention_owner: 'person', rationale: '完整表达',
  })
  project = await store.replaceDrafts(project.project_id, [scene], [])
  const log = join(root, 'ffmpeg.log')
  const fake = join(root, 'fake-ffmpeg.sh')
  writeFileSync(fake, [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> "${log}"`,
    'for last in "$@"; do :; done',
    'mkdir -p "$(dirname "$last")"',
    ': > "$last"',
    'exit 0',
  ].join('\n'))
  chmodSync(fake, 0o755)
  const result = await new VideoRenderer({
    stateRoot: root,
    env: { FFMPEG_BIN: fake, PATH: process.env.PATH },
    qualityCheck: async () => ({ passed: true, duration_ms: 2980, width: 1080, height: 1920, has_video: true, has_audio: true, decode_verified: true, warnings: [] }),
  }).render(project, { revision: project.revision, preview: false, include_subtitles: true, include_music: true })
  expect(result.revision).toBe(project.revision)
  expect(result.video_url).toContain('/exports/')
  const manifestPath = join(root, 'uploads', 'edits', project.project_id, 'exports', result.manifest_url.split('/').at(-1)!)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  expect(manifest.source_fingerprints[0].fingerprint).toBe(project.sources[0]!.fingerprint)
  expect(manifest.scene_ids).toEqual(['scene-1'])
  expect(manifest.visual_semantics[0].layers[0]).toMatchObject({ speed: 1.5, crop: { fit: 'cover' } })
  expect(manifest.music_semantics.enabled).toBe(false)
  expect(manifest.brand_semantics.preset).toBe('neutral')
  const ffmpegLog = readFileSync(log, 'utf8')
  expect(ffmpegLog).toContain(source)
  expect(ffmpegLog).toContain('crop=iw*0.8:ih*0.6:iw*0.1:ih*0.2')
  expect(ffmpegLog).toContain('setpts=PTS/1.5')
  expect(ffmpegLog).toContain('atempo=1.5')
  expect(ffmpegLog).toContain('if(lt(t,2),0.7+(t-0)*(1-0.7)/2,1)')
  expect(ffmpegLog).toContain('loudnorm=I=-16:TP=-1.5:LRA=11')
  expect(manifest.loudness_target).toEqual({ integrated_lufs: -16, true_peak_db: -1.5, loudness_range: 11 })
  expect(manifest.quality_checks).toMatchObject({ passed: true, decode_verified: true, has_video: true, has_audio: true })
  const withCta = { ...project, brand: { ...project.brand, cta_text: '用户确认的片尾行动信息' } }
  expect(renderAssDocument(withCta, withCta.scenes, {}, true)).toContain('用户确认的片尾行动信息')
  await expect(new VideoRenderer({ stateRoot: root, env: { FFMPEG_BIN: fake } }).render(project, { revision: project.revision - 1 })).rejects.toThrow('锁定 revision')
})

test('render quality inspection validates streams and reports sustained black or frozen footage', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-render-qc-'))
  const output = join(root, 'output.mp4')
  writeFileSync(output, 'rendered-video')
  const ffprobe = join(root, 'ffprobe.sh')
  const ffmpeg = join(root, 'ffmpeg.sh')
  writeFileSync(ffprobe, [
    '#!/bin/sh',
    'printf %s \'{"format":{"duration":"3.02"},"streams":[{"codec_type":"video","width":360,"height":640},{"codec_type":"audio"}]}\'',
  ].join('\n'))
  writeFileSync(ffmpeg, [
    '#!/bin/sh',
    'printf "%s\\n" "[blackdetect] black_start:0 black_end:1.2 black_duration:1.2" "[freezedetect] lavfi.freezedetect.freeze_duration:2.4" >&2',
    'exit 0',
  ].join('\n'))
  chmodSync(ffprobe, 0o755)
  chmodSync(ffmpeg, 0o755)
  const report = await inspectRenderedVideo(output, {
    expectedDurationMs: 3000,
    expectedWidth: 360,
    expectedHeight: 640,
    preview: false,
  }, { FFMPEG_BIN: ffmpeg, FFPROBE_BIN: ffprobe })
  expect(report).toMatchObject({ passed: true, duration_ms: 3020, width: 360, height: 640, has_video: true, has_audio: true, decode_verified: true })
  expect(report.warnings.join(' ')).toContain('持续黑场')
  expect(report.warnings.join(' ')).toContain('画面冻结')
})

test('render quality inspection fails closed when the exported file is missing an audio stream', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-render-qc-audio-'))
  const output = join(root, 'output.mp4')
  writeFileSync(output, 'rendered-video')
  const ffprobe = join(root, 'ffprobe.sh')
  writeFileSync(ffprobe, [
    '#!/bin/sh',
    'printf %s \'{"format":{"duration":"3"},"streams":[{"codec_type":"video","width":360,"height":640}]}\'',
  ].join('\n'))
  chmodSync(ffprobe, 0o755)
  await expect(inspectRenderedVideo(output, {
    expectedDurationMs: 3000,
    expectedWidth: 360,
    expectedHeight: 640,
    preview: true,
  }, { FFPROBE_BIN: ffprobe })).rejects.toThrow('没有音频轨')
})
