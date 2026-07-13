import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { videoSceneSchema } from '../../../shared/contracts/video-edit'
import { compileVideoBrief } from './briefCompiler'
import { VideoProjectError, VideoProjectStore } from './projectStore'

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'video-v2-store-'))
  const source = join(root, 'source.mp4')
  writeFileSync(source, 'deterministic-video-bytes')
  return { root, source, store: new VideoProjectStore(root) }
}

function draftScene(sourceId: string) {
  const range = { source_id: sourceId, in_ms: 0, out_ms: 3000 }
  return videoSceneSchema.parse({
    id: 'scene-1', order: 0, story_role: 'hook', edit_clock: 'dialogue', visual_role: 'talking_head',
    source_ranges: [range], output_range: { start_ms: 0, end_ms: 3000 },
    dialogue: { original_text: '原始识别', semantic_text: '原始识别', display_text: '原始识别' },
    video_layers: [{ id: 'layer-1', role: 'primary', source_range: range }],
    audio_layers: [{ id: 'audio-1', role: 'speech', owner: true }],
    attention_owner: 'person', rationale: '保留完整表达',
  })
}

function writeLegacyProject(root: string, source: string, id = 'legacy-project') {
  const dir = join(root, 'uploads', 'edits', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'timeline.json'), JSON.stringify({
    version: 1, width: 1080, height: 1920, fps: 30,
    media: { m1: { src: source, duration: 5, kind: 'video', has_audio: true } },
    tracks: { v1: { kind: 'video', order: 0 }, sub: { kind: 'caption', order: 1 } },
    clips: {
      c1: { track: 'v1', order: 0, media: 'm1', src_in: 0, src_out: 5 },
      cap1: { track: 'sub', order: 0, text: '旧字幕', start: 0, end: 5 },
    },
  }))
  return dir
}

test('project store atomically creates v2 project, persists brief and supports revisioned undo/redo', async () => {
  const { store, source } = setup()
  let project = await store.create({ video_paths: [source], goal: 'talking', ratio: '9:16' })
  expect(project.schema_version).toBe(2)
  expect(project.sources).toHaveLength(1)
  const compiled = compileVideoBrief({ user_request: '讲清楚这件事', preferred_view: 'talking' }, project.sources)
  project = await store.saveBrief(project.project_id, compiled.brief)
  project = await store.replaceDrafts(project.project_id, [draftScene(project.sources[0]!.id)], [])

  const beforeEdit = project.revision
  const edited = await store.apply(project.project_id, beforeEdit, [{ type: 'dialogue.set_display', scene_id: 'scene-1', display_text: '修正后的字幕' }])
  expect(edited.project.scenes[0]?.dialogue?.display_text).toBe('修正后的字幕')
  const undone = await store.undo(project.project_id, edited.project.revision)
  expect(undone.scenes[0]?.dialogue?.display_text).toBe('原始识别')
  const redone = await store.redo(project.project_id, undone.revision)
  expect(redone.scenes[0]?.dialogue?.display_text).toBe('修正后的字幕')
})

test('revision conflict returns replayable operations and never overwrites newer state', async () => {
  const { store, source } = setup()
  let project = await store.create({ video_paths: [source] })
  project = await store.replaceDrafts(project.project_id, [draftScene(project.sources[0]!.id)], [])
  await store.apply(project.project_id, project.revision, [{ type: 'project.set_view', goal: 'talking' }])
  try {
    await store.apply(project.project_id, project.revision, [{ type: 'project.set_view', goal: 'ambient' }])
    throw new Error('expected conflict')
  } catch (error) {
    expect(error).toBeInstanceOf(VideoProjectError)
    expect((error as VideoProjectError).code).toBe('revision_conflict')
    expect((error as VideoProjectError).detail.replayable_operations).toHaveLength(1)
  }
})

test('two concurrent writes from the same revision serialize and only one commits', async () => {
  const { store, source } = setup()
  let project = await store.create({ video_paths: [source] })
  project = await store.replaceDrafts(project.project_id, [draftScene(project.sources[0]!.id)], [])
  const results = await Promise.allSettled([
    store.apply(project.project_id, project.revision, [{ type: 'project.set_view', goal: 'talking' }]),
    store.apply(project.project_id, project.revision, [{ type: 'project.set_view', goal: 'ambient' }]),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  const rejected = results.find(result => result.status === 'rejected')
  expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'revision_conflict' })
  expect((await store.load(project.project_id)).revision).toBe(project.revision + 1)
})

test('legacy timeline migrates once to project.json and keeps a read-only backup without dual writes', async () => {
  const { root, source, store } = setup()
  const id = 'legacy-project'
  const dir = writeLegacyProject(root, source, id)
  const migrated = await store.load(id)
  expect(migrated.schema_version).toBe(2)
  expect(migrated.migrated_from_v1).toBe(true)
  expect(migrated.scenes[0]?.dialogue?.display_text).toBe('旧字幕')
  expect(existsSync(join(dir, 'timeline.v1.readonly.json'))).toBe(true)
  const legacyBefore = readFileSync(join(dir, 'timeline.json'), 'utf8')
  await store.apply(id, migrated.revision, [{ type: 'project.set_view', goal: 'talking' }])
  expect(readFileSync(join(dir, 'timeline.json'), 'utf8')).toBe(legacyBefore)
})

test('project list discovers legacy timelines and migrates them into the v2 list response', async () => {
  const { root, source, store } = setup()
  const dir = writeLegacyProject(root, source, 'legacy-visible')
  const projects = await store.list()
  expect(projects).toEqual([expect.objectContaining({ project_id: 'legacy-visible', schema_version: 2, migrated_from_v1: true })])
  expect(existsSync(join(dir, 'project.json'))).toBe(true)
  expect(existsSync(join(dir, 'timeline.v1.readonly.json'))).toBe(true)
})

test('a corrupt v2 project never falls back to and overwrites its older v1 timeline', async () => {
  const { root, source, store } = setup()
  const dir = writeLegacyProject(root, source, 'corrupt-v2')
  const corrupt = '{"schema_version":2,"broken":true}\n'
  const legacyBefore = readFileSync(join(dir, 'timeline.json'), 'utf8')
  writeFileSync(join(dir, 'project.json'), corrupt)

  await expect(store.load('corrupt-v2')).rejects.toMatchObject({ code: 'project_corrupt' })
  expect(readFileSync(join(dir, 'project.json'), 'utf8')).toBe(corrupt)
  expect(readFileSync(join(dir, 'timeline.json'), 'utf8')).toBe(legacyBefore)
  expect(existsSync(join(dir, 'timeline.v1.readonly.json'))).toBe(false)
})

test('a malformed v1 migration leaves the original file untouched and creates no v2 project', async () => {
  const { root, store } = setup()
  const dir = join(root, 'uploads', 'edits', 'malformed-v1')
  mkdirSync(dir, { recursive: true })
  const malformed = '{"version":1,"media":'
  writeFileSync(join(dir, 'timeline.json'), malformed)

  await expect(store.load('malformed-v1')).rejects.toMatchObject({ code: 'legacy_migration_failed' })
  expect(readFileSync(join(dir, 'timeline.json'), 'utf8')).toBe(malformed)
  expect(existsSync(join(dir, 'project.json'))).toBe(false)
  expect(existsSync(join(dir, 'timeline.v1.readonly.json'))).toBe(false)
  expect(await store.list()).toEqual([])
})

test('legacy discovery and direct migration refuse symlinked project directories', async () => {
  if (process.platform === 'win32') return
  const { root, source, store } = setup()
  const external = join(root, 'external-project')
  mkdirSync(external, { recursive: true })
  writeFileSync(join(external, 'timeline.json'), JSON.stringify({
    version: 1,
    media: { m1: { src: source, duration: 1, kind: 'video' } },
    tracks: { v1: { kind: 'video', order: 0 } },
    clips: { c1: { track: 'v1', order: 0, media: 'm1', src_in: 0, src_out: 1 } },
  }))
  const editsRoot = join(root, 'uploads', 'edits')
  mkdirSync(editsRoot, { recursive: true })
  symlinkSync(external, join(editsRoot, 'linked-project'))

  expect(await store.list()).toEqual([])
  await expect(store.load('linked-project')).rejects.toMatchObject({ code: 'unsafe_project_path' })
  expect(existsSync(join(external, 'project.json'))).toBe(false)
  expect(existsSync(join(external, 'timeline.v1.readonly.json'))).toBe(false)
})

test('concurrent legacy opens share one migration and one history record', async () => {
  const { root, source, store } = setup()
  const dir = writeLegacyProject(root, source, 'legacy-concurrent')
  const [first, second] = await Promise.all([store.load('legacy-concurrent'), store.load('legacy-concurrent')])
  expect(first).toEqual(second)
  const history = readFileSync(join(dir, 'operations.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  expect(history).toHaveLength(1)
  expect(JSON.parse(history[0]!).kind).toBe('migration')
})

test('source relocation rejects a same-name file with a different fingerprint', async () => {
  const { root, source, store } = setup()
  const project = await store.create({ video_paths: [source] })
  const replacement = join(root, 'replacement.mp4')
  writeFileSync(replacement, 'different-video-bytes')
  await expect(store.apply(project.project_id, project.revision, [{
    type: 'source.relocate', source_id: project.sources[0]!.id, file_uri: replacement,
  }])).rejects.toMatchObject({ code: 'fingerprint_mismatch' })
})

test('project load exposes a source moved after import and relocation clears the offline state', async () => {
  const { root, source, store } = setup()
  let project = await store.create({ video_paths: [source] })
  const relocated = join(root, 'relocated.mp4')
  renameSync(source, relocated)

  project = await store.load(project.project_id)
  expect(project.sources[0]).toMatchObject({ missing: true })
  expect(project.sources[0]?.warnings.join(' ')).toContain('重新定位')

  project = (await store.apply(project.project_id, project.revision, [{
    type: 'source.relocate', source_id: project.sources[0]!.id, file_uri: relocated,
  }])).project
  expect(project.sources[0]).toMatchObject({ file_uri: relocated, missing: false })
  expect(project.sources[0]?.warnings.join(' ')).not.toContain('原素材已离线')
})

test('environment narration binds a real speech range and remains removable without deleting the Scene', async () => {
  const { store, source } = setup()
  let project = await store.create({ video_paths: [source], source_roles: { [source]: 'space_wide' } })
  project.sources[0]!.duration_ms = 3000
  project.sources[0]!.has_audio = true
  project = await store.replaceAnalysis(project.project_id, { sources: project.sources, evidence: [], status: project.status })
  const sourceId = project.sources[0]!.id
  const range = { source_id: sourceId, in_ms: 0, out_ms: 3000 }
  project = await store.replaceDrafts(project.project_id, [videoSceneSchema.parse({
    id: 'ambient-1', order: 0, story_role: 'atmosphere', edit_clock: 'action', visual_role: 'wide',
    source_ranges: [range], output_range: { start_ms: 0, end_ms: 3000 },
    video_layers: [{ id: 'visual-1', role: 'primary', source_range: range }],
    audio_layers: [{ id: 'ambience-1', role: 'ambience', source_range: range, owner: true }],
    attention_owner: 'space', rationale: '展示真实空间',
  })], [])

  project = (await store.apply(project.project_id, project.revision, [{
    type: 'scene.add_narration', scene_id: 'ambient-1', text: '这是现场旁白', source_range: range,
  }])).project
  expect(project.scenes[0]?.dialogue).toMatchObject({ origin: 'narration', display_text: '这是现场旁白' })
  expect(project.scenes[0]?.audio_layers.filter(layer => layer.owner)).toEqual([expect.objectContaining({ role: 'speech' })])

  project = (await store.apply(project.project_id, project.revision, [{ type: 'scene.remove_narration', scene_id: 'ambient-1' }])).project
  expect(project.scenes[0]?.dialogue).toBeUndefined()
  expect(project.scenes[0]?.deleted).toBe(false)
  expect(project.scenes[0]?.audio_layers.filter(layer => layer.owner)).toEqual([expect.objectContaining({ role: 'ambience' })])
})

test('music and Logo paths are validated server-side and music gets a stable fingerprint', async () => {
  const { root, store, source } = setup()
  let project = await store.create({ video_paths: [source] })
  const music = join(root, 'music.wav')
  writeFileSync(music, 'same-music-bytes')
  project = (await store.apply(project.project_id, project.revision, [{
    type: 'project.set_music', music: { path: music, license_id: 'owner-library-7', enabled: true, energy: 'lively' },
  }])).project
  expect(project.music).toMatchObject({ path: music, license_id: 'owner-library-7', enabled: true })
  expect(project.music.fingerprint).toMatch(/^[a-f0-9]{64}$/)

  const invalidLogo = join(root, 'logo.txt')
  writeFileSync(invalidLogo, 'not-an-image')
  await expect(store.apply(project.project_id, project.revision, [{
    type: 'project.set_brand', brand: { preset: 'neutral', logo_path: invalidLogo },
  }])).rejects.toMatchObject({ code: 'unsupported_logo' })
})

test('formal export usage warns when another project reuses the same music fingerprint', async () => {
  const { root, store, source } = setup()
  const music = join(root, 'shared.wav')
  writeFileSync(music, 'shared-authorized-music')
  let first = await store.create({ video_paths: [source] })
  first = (await store.apply(first.project_id, first.revision, [{
    type: 'project.set_music', music: { path: music, license_id: 'library-shared-1', enabled: true, energy: 'natural' },
  }])).project
  await store.recordExportUsage(first)

  let second = await store.create({ video_paths: [source] })
  second = (await store.apply(second.project_id, second.revision, [{
    type: 'project.set_music', music: { path: music, license_id: 'library-shared-1', enabled: true, energy: 'natural' },
  }])).project
  expect(second.status.warnings.join(' ')).toContain('近期已在其他成片中使用')
})

test('v2 projects written before the audio-owner invariant remain readable', async () => {
  const { root, store, source } = setup()
  let project = await store.create({ video_paths: [source], source_roles: { [source]: 'space_wide' } })
  const range = { source_id: project.sources[0]!.id, in_ms: 0, out_ms: 1000 }
  const raw = {
    ...project,
    scenes: [{
      id: 'legacy-owner-scene', order: 0, story_role: 'atmosphere', edit_clock: 'music', visual_role: 'wide',
      source_ranges: [range], output_range: { start_ms: 0, end_ms: 1000 },
      video_layers: [{ id: 'visual', role: 'primary', source_range: range }],
      audio_layers: [{ id: 'ambience', role: 'ambience', owner: true }, { id: 'music', role: 'music', owner: true }],
      attention_owner: 'space', rationale: '旧版本草稿',
    }],
  }
  writeFileSync(join(root, 'uploads', 'edits', project.project_id, 'project.json'), JSON.stringify(raw))
  project = await store.load(project.project_id)
  expect(project.scenes[0]?.audio_layers.filter(layer => layer.owner)).toEqual([expect.objectContaining({ role: 'music' })])
  expect(project.status.warnings.join(' ')).toContain('兼容修正')
})
