import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { MediaProjectService } from '../../src/server/services/mediaProjectService.js'

type ProcessResult = { exitCode: number; stdout: string; stderr: string }

async function run(command: string[]): Promise<ProcessResult> {
  const process = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stdout, stderr }
}

async function requireSuccess(command: string[]): Promise<void> {
  const result = await run(command)
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${command[0]} exited ${result.exitCode}`)
}

async function waitForTask(service: MediaProjectService, taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const task = await service.getTask(taskId, false)
    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.status)) return task
    await Bun.sleep(25)
  }
  throw new Error(`MEDIA_FIXTURE_TIMEOUT:${taskId}`)
}

async function main(): Promise<void> {
  const binaries = process.env.BB_MEDIA_BIN_DIR?.trim()
    ?? path.resolve(import.meta.dir, '../../desktop/runtime-assets/binaries')
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const ffmpeg = path.join(binaries, `ffmpeg${suffix}`)
  const ffprobe = path.join(binaries, `ffprobe${suffix}`)
  await Promise.all([ffmpeg, ffprobe].map(async binary => {
    const stat = await fs.stat(binary).catch(() => null)
    if (!stat?.isFile()) throw new Error(`MEDIA_FIXTURE_TOOL_MISSING:${binary}`)
  }))

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-real-media-'))
  try {
    const source = path.join(root, 'source.mp4')
    const output = path.join(root, 'export.mp4')
    await requireSuccess([
      ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x320:rate=12',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
      '-t', '1.5', '-c:v', 'mpeg4', '-q:v', '5', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', source,
    ])

    const env = { FFMPEG_BIN: ffmpeg, FFPROBE_BIN: ffprobe, BB_FFMPEG_VIDEO_ENCODER: 'mpeg4' }
    const stateRoot = path.join(root, 'state')
    const service = new MediaProjectService({ root: stateRoot, env })
    const created = await service.createVideoProject({ title: '真实媒体验收', output: { width: 320, height: 320, fps: 12 } })
    const imported = await service.addVideoSource(created.id, { path: source })
    const sourceRecord = imported.project.sources[0]
    if (!sourceRecord?.has_audio || sourceRecord.width !== 320 || sourceRecord.height !== 320 || sourceRecord.duration_ms < 1_000) throw new Error('MEDIA_FIXTURE_PROBE_INVALID')
    const sourceBytes = await fs.readFile(source)
    const expectedSourceFingerprint = `sha256:${createHash('sha256').update(sourceBytes).digest('hex')}`
    if (sourceRecord.fingerprint !== expectedSourceFingerprint) throw new Error('MEDIA_FIXTURE_SOURCE_FINGERPRINT_INVALID')
    const importedVersionId = imported.project.current_timeline_version_id!
    const edited = await service.updateVideoTimeline(imported.project.id, {
      base_revision: imported.project.revision,
      base_timeline_version_id: imported.project.current_timeline_version_id,
      clips: [{ ...imported.project.timeline[0]!, in_ms: 100, out_ms: Math.min(1_300, sourceRecord.duration_ms) }],
    })
    const editedVersionId = edited.current_timeline_version_id!
    const restoredImport = await service.selectVideoTimelineVersion(edited.id, {
      revision: edited.revision,
      version_id: importedVersionId,
    })
    if (restoredImport.timeline[0]?.in_ms !== 0) throw new Error('MEDIA_FIXTURE_TIMELINE_ROLLBACK_INVALID')
    const restoredEdit = await service.selectVideoTimelineVersion(edited.id, {
      revision: restoredImport.revision,
      version_id: editedVersionId,
    })
    if (restoredEdit.timeline[0]?.in_ms !== 100) throw new Error('MEDIA_FIXTURE_TIMELINE_REDO_INVALID')
    const previewTask = await service.previewVideo(restoredEdit.id, {
      base_revision: restoredEdit.revision,
      timeline_version_id: restoredEdit.current_timeline_version_id!,
    })
    const preview = await waitForTask(service, previewTask.id)
    if (preview.status !== 'succeeded') throw new Error(`MEDIA_FIXTURE_PREVIEW_${preview.status}`)

    const previewed = await service.getProject(edited.id)
    if (previewed.kind !== 'video' || previewed.preview?.timeline_version_id !== previewed.current_timeline_version_id) throw new Error('MEDIA_FIXTURE_PREVIEW_NOT_COMMITTED')
    const previewRestart = new MediaProjectService({ root: stateRoot, env })
    const restoredPreview = await previewRestart.getProject(previewed.id)
    if (restoredPreview.kind !== 'video' || restoredPreview.preview?.content_hash !== previewed.preview.content_hash) throw new Error('MEDIA_FIXTURE_PREVIEW_RESTART_INVALID')
    const renderTask = await previewRestart.renderVideo(previewed.id, {
      base_revision: previewed.revision,
      timeline_version_id: previewed.current_timeline_version_id,
      output_path: output,
    })
    const rendered = await waitForTask(previewRestart, renderTask.id)
    if (rendered.status !== 'succeeded' || !rendered.result?.output_content_hash) throw new Error(`MEDIA_FIXTURE_RENDER_${rendered.status}`)
    const bytes = await fs.readFile(output)
    const expectedHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    if (rendered.result.output_content_hash !== expectedHash) throw new Error('MEDIA_FIXTURE_HASH_MISMATCH')
    const verification = rendered.result.output_verification
    if (
      !verification
      || verification.timeline_version_id !== previewed.current_timeline_version_id
      || verification.content_hash !== expectedHash
      || verification.byte_size !== bytes.length
      || verification.width !== 320
      || verification.height !== 320
      || verification.fps !== 12
      || verification.video_stream_count !== 1
      || verification.audio_stream_count !== 1
      || verification.duration_ms < 1_000
    ) throw new Error('MEDIA_FIXTURE_OUTPUT_VERIFICATION_INVALID')

    const restarted = new MediaProjectService({ root: stateRoot, env })
    const restoredProject = await restarted.getProject(previewed.id)
    const restoredTask = await restarted.getTask(renderTask.id, false)
    if (restoredProject.kind !== 'video' || restoredProject.output_content_hash !== expectedHash || restoredTask.status !== 'succeeded') throw new Error('MEDIA_FIXTURE_RESTART_INVALID')
    const ranged = await restarted.videoOutputResponse(previewed.id, new Request('http://localhost/video', { headers: { Range: 'bytes=0-31' } }))
    if (ranged.status !== 206 || (await ranged.arrayBuffer()).byteLength !== 32) throw new Error('MEDIA_FIXTURE_RANGE_INVALID')
    await fs.rm(output)
    const missingOutput = await restarted.getProject(previewed.id)
    if (missingOutput.kind !== 'video' || missingOutput.state !== 'failed' || missingOutput.error_code !== 'MEDIA_VIDEO_OUTPUT_UNAVAILABLE') {
      throw new Error('MEDIA_FIXTURE_OUTPUT_LOSS_RECOVERY_INVALID')
    }
    process.stdout.write(`media-real-fixture: PASS ${expectedHash} ${bytes.length} bytes\n`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

await main()
