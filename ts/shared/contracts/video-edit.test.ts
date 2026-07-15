import { expect, test } from 'bun:test'
import {
  legacyTimelineV1Schema,
  videoJobSchema,
  videoOperationSchema,
  videoProjectSchema,
  videoSceneSchema,
} from './video-edit'

function scene() {
  return {
    id: 'scene-1',
    order: 0,
    story_role: 'hook',
    edit_clock: 'dialogue',
    visual_role: 'talking_head',
    source_ranges: [{ source_id: 'source-1', in_ms: 0, out_ms: 3000 }],
    output_range: { start_ms: 0, end_ms: 3000 },
    dialogue: { original_text: '原文', semantic_text: '原文', display_text: '显示字幕' },
    video_layers: [{ id: 'layer-1', role: 'primary', source_range: { source_id: 'source-1', in_ms: 0, out_ms: 3000 } }],
    audio_layers: [{ id: 'audio-1', role: 'speech', owner: true, gain_envelope: [{ at_ms: 0, gain: 1 }] }],
    graphics: [],
    transition_in: { kind: 'cut', duration_ms: 0 },
    attention_owner: 'person',
    evidence_refs: [],
    rationale: '保留完整开场表达',
    needs_review: [],
  }
}

test('Scene/Timeline v2 parses separate source and output time domains', () => {
  const project = videoProjectSchema.parse({
    schema_version: 2,
    project_id: 'video-1',
    name: '测试项目',
    conversation_id: 'conversation-1',
    working_dir: '/workspace/a',
    revision: 1,
    updated_at: new Date().toISOString(),
    goal: 'talking',
    canvas: {},
    sources: [{ id: 'source-1', file_uri: '/tmp/a.mp4', name: 'a.mp4', fingerprint: '12345678' }],
    scenes: [scene()],
    status: { phase: 'editing' },
  })
  expect(project.scenes[0]?.source_ranges[0]).toMatchObject({ in_ms: 0, out_ms: 3000 })
  expect(project.scenes[0]?.output_range).toEqual({ start_ms: 0, end_ms: 3000 })
  expect(project.brand.preset).toBe('neutral')
  expect(project).toMatchObject({ conversation_id: 'conversation-1', working_dir: '/workspace/a' })
})

test('invalid source range and non-cut transition without reason are rejected', () => {
  expect(videoSceneSchema.safeParse({ ...scene(), source_ranges: [{ source_id: 'source-1', in_ms: 3, out_ms: 3 }] }).success).toBe(false)
  expect(videoSceneSchema.safeParse({ ...scene(), transition_in: { kind: 'dissolve', duration_ms: 250 } }).success).toBe(false)
  expect(videoSceneSchema.safeParse({
    ...scene(),
    edit_clock: 'music',
    audio_layers: [
      { id: 'ambience', role: 'ambience', owner: true },
      { id: 'music', role: 'music', owner: true },
    ],
  }).success).toBe(false)
})

test('atomic operation union rejects whole-project replacement payloads', () => {
  expect(videoOperationSchema.parse({ type: 'dialogue.set_display', scene_id: 'scene-1', display_text: '修正字幕' })).toMatchObject({ type: 'dialogue.set_display' })
  expect(videoOperationSchema.safeParse({ type: 'project.replace', project: {} }).success).toBe(false)
})

test('editing union carries split, merge, semantic text and speed without accepting arbitrary fields', () => {
  expect(videoOperationSchema.parse({ type: 'scene.split', scene_id: 's1', at_source_ms: 1200 })).toMatchObject({ type: 'scene.split' })
  expect(videoOperationSchema.parse({ type: 'scene.merge', scene_id: 's1', next_scene_id: 's2' })).toMatchObject({ type: 'scene.merge' })
  expect(videoOperationSchema.parse({ type: 'dialogue.set_semantic', scene_id: 's1', semantic_text: '修正语义' })).toMatchObject({ semantic_text: '修正语义' })
  expect(videoOperationSchema.parse({ type: 'scene.set_speed', scene_id: 's1', layer_id: 'l1', speed: 1.25 })).toMatchObject({ speed: 1.25 })
  expect(videoOperationSchema.parse({ type: 'scene.add_narration', scene_id: 's1', text: '旁白', source_range: { source_id: 'voice', in_ms: 0, out_ms: 1200 } })).toMatchObject({ type: 'scene.add_narration' })
  expect(videoOperationSchema.parse({ type: 'scene.remove_narration', scene_id: 's1' })).toMatchObject({ type: 'scene.remove_narration' })
  expect(videoOperationSchema.safeParse({ type: 'scene.set_speed', scene_id: 's1', layer_id: 'l1', speed: 9 }).success).toBe(false)
})

test('video job keeps cancelled and interrupted distinct from error', () => {
  const base = {
    id: 'job-1', project_id: 'p1', kind: 'analyze', progress: 40, stage: '转录中',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
  expect(videoJobSchema.parse({ ...base, status: 'cancelled' }).status).toBe('cancelled')
  expect(videoJobSchema.parse({ ...base, status: 'interrupted', retryable: true }).status).toBe('interrupted')
})

test('legacy Timeline v1 contract accepts the existing persisted shape', () => {
  const legacy = legacyTimelineV1Schema.parse({
    version: 1,
    fps: 30,
    media: { m1: { src: '/tmp/a.mp4', duration: 5, kind: 'video', has_audio: true } },
    tracks: { v1: { kind: 'video', order: 0 } },
    clips: { c1: { track: 'v1', order: 0, media: 'm1', src_in: 0, src_out: 5 } },
  })
  expect(legacy.media.m1?.src).toBe('/tmp/a.mp4')
})
