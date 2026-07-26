import { describe, expect, it } from 'vitest'
import { createVideoTimelineState, videoTimelineReducer } from './videoTimelineState'

const clips = [
  { id: 'clip_aaaaaaaa', source_id: 'src_aaaaaaaaa', in_ms: 0, out_ms: 5000 },
  { id: 'clip_bbbbbbbb', source_id: 'src_bbbbbbbbb', in_ms: 1000, out_ms: 4000 },
]

describe('videoTimelineReducer', () => {
  it('keeps gestures mutually exclusive and commits a drag', () => {
    let state = createVideoTimelineState(clips)
    state = videoTimelineReducer(state, { type: 'begin_drag', clip_id: clips[0]!.id, locked: false })
    expect(state.mode).toBe('dragging')
    expect(videoTimelineReducer(state, { type: 'begin_scrub' })).toBe(state)
    state = videoTimelineReducer(state, { type: 'drag_to', index: 1 })
    state = videoTimelineReducer(state, { type: 'commit' })
    expect(state.mode).toBe('idle')
    expect(state.clips.map(clip => clip.id)).toEqual([clips[1]!.id, clips[0]!.id])
  })

  it('restores the gesture snapshot on cancel', () => {
    let state = createVideoTimelineState(clips)
    state = videoTimelineReducer(state, { type: 'begin_trim', clip_id: clips[0]!.id, edge: 'out', locked: false })
    state = videoTimelineReducer(state, { type: 'trim_to', milliseconds: 3000, source_duration_ms: 5000 })
    expect(state.clips[0]!.out_ms).toBe(3000)
    state = videoTimelineReducer(state, { type: 'cancel' })
    expect(state.clips).toEqual(clips)
  })

  it('refuses locked edits and clamps trim and scrub bounds', () => {
    let state = createVideoTimelineState(clips)
    expect(videoTimelineReducer(state, { type: 'begin_drag', clip_id: clips[0]!.id, locked: true })).toBe(state)
    state = videoTimelineReducer(state, { type: 'begin_trim', clip_id: clips[0]!.id, edge: 'in', locked: false })
    state = videoTimelineReducer(state, { type: 'trim_to', milliseconds: 9000, source_duration_ms: 5000 })
    expect(state.clips[0]!.in_ms).toBe(4999)
    state = videoTimelineReducer(state, { type: 'commit' })
    state = videoTimelineReducer(state, { type: 'begin_scrub' })
    state = videoTimelineReducer(state, { type: 'scrub_to', milliseconds: 12000, duration_ms: 8000 })
    expect(state.playhead_ms).toBe(8000)
  })
})
