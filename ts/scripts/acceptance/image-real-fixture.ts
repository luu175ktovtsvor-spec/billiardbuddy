import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { MediaProjectService } from '../../src/server/services/mediaProjectService.js'

type ProcessResult = { exitCode: number; stderr: string }

async function run(command: string[]): Promise<ProcessResult> {
  const process = Bun.spawn(command, { stdout: 'ignore', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stderr }
}

async function requireSuccess(command: string[]): Promise<void> {
  const result = await run(command)
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `${command[0]} exited ${result.exitCode}`)
}

async function waitForImageTask(service: MediaProjectService, taskId: string, timeoutMs = 10 * 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastStatus = ''
  while (Date.now() < deadline) {
    const task = await service.getTask(taskId, true)
    if (task.status !== lastStatus) {
      process.stdout.write(`image-real-fixture: ${task.stage} (${task.status})\n`)
      lastStatus = task.status
    }
    if (['succeeded', 'failed', 'cancelled', 'unknown'].includes(task.status)) return task
    await Bun.sleep(Math.max(1_000, Math.min(10_000, (task.poll_after_seconds ?? 2) * 1_000)))
  }
  throw new Error(`IMAGE_FIXTURE_TIMEOUT:${taskId}`)
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function extension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return '.jpg'
  if (mimeType === 'image/webp') return '.webp'
  return '.png'
}

async function main(): Promise<void> {
  const gatewayUrl = process.env.BB_GATEWAY_URL?.trim()
  const gatewayToken = process.env.BB_GATEWAY_TOKEN?.trim()
  if (!gatewayUrl || !gatewayToken) throw new Error('IMAGE_FIXTURE_GATEWAY_NOT_CONFIGURED')

  const binaries = process.env.BB_MEDIA_BIN_DIR?.trim()
    ?? path.resolve(import.meta.dir, '../../desktop/runtime-assets/binaries')
  const suffix = process.platform === 'win32' ? '.exe' : ''
  const ffmpeg = path.join(binaries, `ffmpeg${suffix}`)
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-real-image-'))
  try {
    const referencePath = path.join(root, 'reference.png')
    await requireSuccess([
      ffmpeg, '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x1f6feb:s=256x256:d=0.1',
      '-frames:v', '1', referencePath,
    ])
    const referenceBytes = await fs.readFile(referencePath)
    const referenceDataUrl = `data:image/png;base64,${referenceBytes.toString('base64')}`
    const stateRoot = path.join(root, 'state')
    const mediaEnv = { ...process.env, BB_MEDIA_BIN_DIR: binaries }
    const service = new MediaProjectService({ root: stateRoot, env: mediaEnv })

    const created = await service.createImageProject({
      title: '真实图片验收',
      user_request: '保留参考图的蓝色主体，创作一张干净的方形台球主题视觉，背景使用柔和浅灰，不绘制任何可读文字。',
      size: '1024x1024',
      reference_images: [referenceDataUrl],
      reference_roles: ['subject'],
    })
    if (created.references.length !== 1 || created.reference_image_count !== 1 || !created.brief) {
      throw new Error('IMAGE_FIXTURE_DRAFT_INVALID')
    }
    const drafted = await service.updateImageProject(created.id, {
      revision: created.revision,
      user_request: '保留参考图的蓝色主体，创作一张干净的方形台球主题视觉，背景使用柔和浅灰并留出充足呼吸感，不绘制任何可读文字。',
      size: created.size,
      references: created.references,
      brief_overrides: { may_change: ['背景、构图和光线可以调整'] },
    })
    if (drafted.brief?.may_change[0] !== '背景、构图和光线可以调整') throw new Error('IMAGE_FIXTURE_BRIEF_EDIT_INVALID')

    const generationTask = await service.submitImageProject(drafted.id)
    const generatedTask = await waitForImageTask(service, generationTask.id)
    if (generatedTask.status !== 'succeeded') throw new Error(`IMAGE_FIXTURE_GENERATION_${generatedTask.status}`)
    const generated = await service.getProject(drafted.id)
    if (generated.kind !== 'image') throw new Error('IMAGE_FIXTURE_GENERATED_KIND_INVALID')
    if (generated.state !== 'ready') throw new Error(`IMAGE_FIXTURE_GENERATED_STATE_${generated.state}`)
    if (generated.outputs.length !== 3) {
      throw new Error(`IMAGE_FIXTURE_GENERATED_OUTPUT_COUNT_${generated.outputs.length}`)
    }
    if (generated.versions.length < 3) {
      throw new Error(`IMAGE_FIXTURE_GENERATED_VERSION_COUNT_${generated.versions.length}`)
    }
    if (generated.current_version_id) throw new Error('IMAGE_FIXTURE_CANDIDATE_PRESELECTED')
    const nonlocalOutputs = generated.outputs.filter(output => !output.asset_path)
    if (nonlocalOutputs.length > 0) {
      throw new Error(`IMAGE_FIXTURE_NONLOCAL_OUTPUT_COUNT_${nonlocalOutputs.length}`)
    }
    const unassessedOutputs = generated.outputs.filter(output => !output.quality_assessment)
    if (unassessedOutputs.length > 0) {
      throw new Error(`IMAGE_FIXTURE_UNASSESSED_OUTPUT_COUNT_${unassessedOutputs.length}`)
    }
    const candidateVersionId = generated.outputs[0]?.version_id
    if (!candidateVersionId) throw new Error('IMAGE_FIXTURE_CANDIDATE_VERSION_MISSING')
    const selected = await service.selectImageVersion(generated.id, {
      revision: generated.revision,
      version_id: candidateVersionId,
    })
    if (selected.kind !== 'image' || selected.current_version_id !== candidateVersionId) {
      throw new Error('IMAGE_FIXTURE_CANDIDATE_SELECTION_INVALID')
    }
    const generatedVersionId = candidateVersionId

    const editTask = await service.startImageOperation(selected.id, {
      revision: selected.revision,
      base_version_id: generatedVersionId,
      kind: 'edit',
      instruction: '保持蓝色主体的形状和位置，只把背景调整为更柔和的浅灰色，并保持画面没有可读文字。',
    })
    const editedTask = await waitForImageTask(service, editTask.id)
    if (editedTask.status !== 'succeeded') throw new Error(`IMAGE_FIXTURE_EDIT_${editedTask.status}`)
    const edited = await service.getProject(selected.id)
    if (edited.kind !== 'image' || !edited.current_version_id || edited.current_version_id === generatedVersionId) {
      throw new Error('IMAGE_FIXTURE_EDIT_VERSION_INVALID')
    }
    const editedVersionId = edited.current_version_id
    const editedVersion = edited.versions.find(version => version.id === editedVersionId)
    const editedOutput = edited.outputs.find(output => output.version_id === editedVersionId)
    if (
      editedVersion?.parent_version_id !== generatedVersionId
      || editedVersion.kind !== 'edit'
      || !editedOutput?.asset_path
      || !editedOutput.quality_assessment
    ) throw new Error('IMAGE_FIXTURE_EDIT_LINEAGE_INVALID')

    const exportPath = path.join(root, `export${extension(editedOutput.mime_type)}`)
    await service.saveImageOutput(edited.id, { version_id: editedVersionId, output_path: exportPath })
    const exportedBytes = await fs.readFile(exportPath)
    const editedAsset = edited.assets.find(asset => asset.id === editedOutput.id)
    if (!editedAsset?.content_hash || sha256(exportedBytes) !== editedAsset.content_hash) {
      throw new Error('IMAGE_FIXTURE_EXPORT_HASH_MISMATCH')
    }

    const restarted = new MediaProjectService({ root: stateRoot, env: mediaEnv })
    const restored = await restarted.getProject(edited.id)
    const restoredTask = await restarted.getTask(editTask.id, false)
    if (
      restored.kind !== 'image'
      || restored.current_version_id !== editedVersionId
      || restoredTask.status !== 'succeeded'
      || !restored.outputs.some(output => output.version_id === editedVersionId)
    ) throw new Error('IMAGE_FIXTURE_RESTART_INVALID')
    const rolledBack = await restarted.selectImageVersion(restored.id, {
      revision: restored.revision,
      version_id: generatedVersionId,
    })
    const redone = await restarted.selectImageVersion(rolledBack.id, {
      revision: rolledBack.revision,
      version_id: editedVersionId,
    })
    if (redone.current_version_id !== editedVersionId) throw new Error('IMAGE_FIXTURE_VERSION_REDO_INVALID')

    process.stdout.write(`image-real-fixture: PASS ${editedAsset.content_hash} ${exportedBytes.length} bytes\n`)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

await main()
