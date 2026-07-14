import { expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { compileVideoBrief } from '../briefCompiler'
import { VideoEvidenceService } from '../evidence/analysisService'
import { VideoDraftPlanner } from '../planning/planner'
import { VideoProjectStore } from '../projectStore'
import { VideoRenderer } from './renderer'

const ffmpeg = process.env.FFMPEG_BIN ?? ''
const ffprobe = process.env.FFPROBE_BIN ?? ''
const realToolsAvailable = Boolean(process.env.VIDEO_REAL_FFMPEG_TEST === '1' && existsSync(ffmpeg) && existsSync(ffprobe))

test.skipIf(!realToolsAvailable)('real FFmpeg renders a playable H.264/AAC project and ffprobe verifies the locked semantics', async () => {
  const root = mkdtempSync(join(tmpdir(), 'video-real-render-'))
  try {
    const source = join(root, 'venue.mp4')
    const fixture = join(import.meta.dir, 'fixtures/video-source.mp4.b64')
    writeFileSync(source, Buffer.from(readFileSync(fixture, 'utf8').trim(), 'base64'))
    const env = { ...process.env, FFMPEG_BIN: ffmpeg, FFPROBE_BIN: ffprobe, WHISPER_CLI: '/missing', WHISPER_MODEL_PATH: '/missing' }
    const store = new VideoProjectStore(root)
    let project = await store.create({ video_paths: [source], source_roles: { [source]: 'space_wide' }, ratio: '9:16' })
    const evidence = new VideoEvidenceService(store, { env })
    project = await evidence.analyze(project.project_id)
    const compiled = compileVideoBrief({ user_request: '只用真实素材展示空间，片尾显示到店体验', preferred_view: 'ambient', exact_copy: ['到店体验'] }, project.sources)
    project = await store.saveBrief(project.project_id, compiled.brief, project.revision)
    const planned = await new VideoDraftPlanner(evidence).plan(project)
    project = await store.replaceDrafts(project.project_id, planned.scenes, planned.alternatives, planned.missingCoverage, project.revision)
    project.canvas = { ...project.canvas, width: 360, height: 640 }

    const result = await new VideoRenderer({ stateRoot: root, env }).render(project, {
      revision: project.revision,
      preview: false,
      include_music: true,
      include_subtitles: true,
    })
    const exportDir = join(root, 'uploads', 'edits', project.project_id, 'exports')
    const output = join(exportDir, basename(result.video_url))
    const manifestPath = join(exportDir, basename(result.manifest_url))
    expect(existsSync(output)).toBe(true)
    expect(existsSync(manifestPath)).toBe(true)

    const probe = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output], { encoding: 'utf8' })) as {
      streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; pix_fmt?: string }>
      format: { duration: string }
    }
    const video = probe.streams.find(stream => stream.codec_type === 'video')
    const audio = probe.streams.find(stream => stream.codec_type === 'audio')
    expect(video).toMatchObject({ codec_name: 'h264', width: 360, height: 640, pix_fmt: 'yuv420p' })
    expect(audio?.codec_name).toBe('aac')
    expect(Number(probe.format.duration)).toBeGreaterThan(0)

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { revision: number; visual_semantics: unknown[]; audio_semantics: unknown[] }
    expect(manifest.revision).toBe(project.revision)
    expect(manifest.visual_semantics).toHaveLength(project.scenes.length)
    expect(manifest.audio_semantics).toHaveLength(project.scenes.length)
    expect(readdirSync(exportDir).some(name => name.endsWith('.tmp.mp4'))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
