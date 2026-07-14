import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileVideoBrief } from '../briefCompiler'
import type { VideoEvidenceService } from '../evidence/analysisService'
import { VideoProjectStore } from '../projectStore'
import { VideoDraftPlanner } from './planner'

async function projectWithSource(role: 'talking_take' | 'space_wide') {
  const root = mkdtempSync(join(tmpdir(), 'video-planner-'))
  const path = join(root, 'source.mp4')
  writeFileSync(path, 'video')
  const store = new VideoProjectStore(root)
  let project = await store.create({ video_paths: [path], source_roles: { [path]: role } })
  project.sources[0]!.duration_ms = 8_000
  await store.replaceAnalysis(project.project_id, { sources: project.sources, evidence: [], status: project.status })
  project = await store.load(project.project_id)
  return { store, project }
}

test('talking planner uses real transcript phrases and creates three explainable alternatives', async () => {
  const { store, project: initial } = await projectWithSource('talking_take')
  const compiled = compileVideoBrief({ user_request: '讲清楚一个技巧', preferred_view: 'talking' }, initial.sources)
  const project = await store.saveBrief(initial.project_id, compiled.brief)
  const evidence = {
    readEvidence: async (_project: unknown, kind: string) => kind === 'transcript' ? [{
      ref: { source_id: project.sources[0]!.id },
      value: {
        source: project.sources[0]!.file_uri, language: 'zh', duration: 8, words: [],
        phrases: [{ start: 0, end: 3, text: '先站稳' }, { start: 3.5, end: 7, text: '再完成出杆' }],
      },
    }] : [],
  } as unknown as VideoEvidenceService
  const result = await new VideoDraftPlanner(evidence).plan(project)
  expect(result.scenes.map(scene => scene.dialogue?.display_text)).toEqual(['先站稳', '再完成出杆'])
  expect(result.scenes.map(scene => scene.story_role)).toEqual(['hook', 'cta'])
  expect(result.alternatives.map(item => item.name)).toEqual(['表达更完整', '节奏更利落', '现场感更强'])
  expect(result.scenes.every(scene => scene.edit_clock === 'dialogue')).toBe(true)
})

test('planner never invents transcript and preserves user-locked scenes during replanning', async () => {
  const { store, project: initial } = await projectWithSource('talking_take')
  const compiled = compileVideoBrief({ user_request: '把原素材整理成自然口播', preferred_view: 'talking' }, initial.sources)
  let project = await store.saveBrief(initial.project_id, compiled.brief)
  const emptyEvidence = { readEvidence: async () => [] } as unknown as VideoEvidenceService
  const first = await new VideoDraftPlanner(emptyEvidence).plan(project)
  expect(first.scenes[0]?.dialogue).toBeUndefined()
  expect(first.scenes[0]?.needs_review.join(' ')).toContain('未生成假台词')
  first.scenes[0]!.locked_by_user = true
  project = await store.replaceDrafts(project.project_id, first.scenes, first.alternatives)
  const second = await new VideoDraftPlanner(emptyEvidence).plan(project)
  expect(second.scenes.some(scene => scene.id === first.scenes[0]!.id && scene.locked_by_user)).toBe(true)
})

test('ambient planner reports real coverage gaps instead of fabricating missing roles', async () => {
  const { store, project: initial } = await projectWithSource('space_wide')
  const compiled = compileVideoBrief({ user_request: '做一条比赛高光', content_type: 'event_highlight', preferred_view: 'ambient' }, initial.sources)
  const project = await store.saveBrief(initial.project_id, compiled.brief)
  const evidence = { readEvidence: async () => [] } as unknown as VideoEvidenceService
  const result = await new VideoDraftPlanner(evidence).plan(project)
  expect(result.missingCoverage).toEqual(expect.arrayContaining(['action', 'peak', 'result_or_ending']))
  expect(result.scenes).toHaveLength(1)
  expect(result.scenes[0]?.edit_clock).toBe('action')
  expect(result.scenes[0]?.audio_layers.filter(layer => layer.owner)).toEqual([
    expect.objectContaining({ role: 'ambience' }),
  ])
})

test('ambient planner clips an oversized first source to the requested target duration', async () => {
  const { store, project: initial } = await projectWithSource('space_wide')
  const compiled = compileVideoBrief({
    user_request: '剪成 3 秒竖屏短视频',
    preferred_view: 'ambient',
    target_duration_ms: 3_000,
  }, initial.sources)
  const project = await store.saveBrief(initial.project_id, compiled.brief)
  const evidence = { readEvidence: async () => [] } as unknown as VideoEvidenceService
  const result = await new VideoDraftPlanner(evidence).plan(project)

  expect(result.scenes).toHaveLength(1)
  expect(result.scenes[0]?.source_ranges[0]).toMatchObject({
    source_id: project.sources[0]!.id,
    in_ms: 0,
    out_ms: 3_000,
  })
})

test('ambient planner keeps real footage for user review when every technical shot is rejected', async () => {
  const { store, project: initial } = await projectWithSource('space_wide')
  const compiled = compileVideoBrief({ user_request: '展示真实空间', preferred_view: 'ambient' }, initial.sources)
  const project = await store.saveBrief(initial.project_id, compiled.brief)
  const evidence = {
    readEvidence: async (_project: unknown, kind: string) => kind === 'shot' ? [{
      ref: { id: 'shot-evidence-1', source_id: project.sources[0]!.id },
      value: { shots: [{ start_ms: 0, end_ms: 8000, keep: false, quality_score: 0.1 }] },
    }] : [],
  } as unknown as VideoEvidenceService
  const result = await new VideoDraftPlanner(evidence).plan(project)
  expect(result.scenes).toHaveLength(1)
  expect(result.scenes[0]?.source_ranges[0]).toMatchObject({ source_id: project.sources[0]!.id, in_ms: 0, out_ms: 8000 })
  expect(result.scenes[0]?.needs_review.join(' ')).toContain('请预览后决定')
})

test('ambient planner uses one music owner only when authorized music is enabled', async () => {
  const { store, project: initial } = await projectWithSource('space_wide')
  const music = join(store.projectDirectory(initial.project_id), 'music.wav')
  writeFileSync(music, 'authorized-music')
  let project = (await store.apply(initial.project_id, initial.revision, [{
    type: 'project.set_music',
    music: { path: music, license_id: 'license-1', enabled: true, energy: 'natural' },
  }])).project
  const compiled = compileVideoBrief({ user_request: '展示空间', preferred_view: 'ambient' }, project.sources)
  project = await store.saveBrief(project.project_id, compiled.brief)
  const evidence = { readEvidence: async () => [] } as unknown as VideoEvidenceService
  const result = await new VideoDraftPlanner(evidence).plan(project)
  expect(result.scenes[0]?.edit_clock).toBe('music')
  expect(result.scenes[0]?.audio_layers.filter(layer => layer.owner)).toEqual([
    expect.objectContaining({ role: 'music' }),
  ])
})
