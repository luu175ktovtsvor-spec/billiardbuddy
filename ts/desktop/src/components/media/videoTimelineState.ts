import type { VideoStudioProject } from '../../api/videoWorkbench'

export type TimelineClip = VideoStudioProject['timeline'][number]

type IdleState = {
  mode: 'idle'
  clips: TimelineClip[]
  playhead_ms: number
}

type GestureState = {
  mode: 'dragging' | 'trimming' | 'scrubbing'
  clips: TimelineClip[]
  playhead_ms: number
  snapshot: { clips: TimelineClip[]; playhead_ms: number }
  clip_id?: string
  edge?: 'in' | 'out'
}

export type VideoTimelineState = IdleState | GestureState

export type VideoTimelineEvent =
  | { type: 'replace'; clips: TimelineClip[] }
  | { type: 'begin_drag'; clip_id: string; locked: boolean }
  | { type: 'drag_to'; index: number }
  | { type: 'begin_trim'; clip_id: string; edge: 'in' | 'out'; locked: boolean }
  | { type: 'trim_to'; milliseconds: number; source_duration_ms: number }
  | { type: 'begin_scrub' }
  | { type: 'scrub_to'; milliseconds: number; duration_ms: number }
  | { type: 'playhead_to'; milliseconds: number; duration_ms: number }
  | { type: 'commit' }
  | { type: 'cancel' }

export function createVideoTimelineState(clips: TimelineClip[]): VideoTimelineState {
  return { mode: 'idle', clips, playhead_ms: 0 }
}

function snapshot(state: VideoTimelineState) {
  return { clips: state.clips, playhead_ms: state.playhead_ms }
}

export function videoTimelineReducer(
  state: VideoTimelineState,
  event: VideoTimelineEvent,
): VideoTimelineState {
  if (event.type === 'replace') {
    return state.mode === 'idle' ? { ...state, clips: event.clips } : state
  }
  if (event.type === 'cancel') {
    return state.mode === 'idle'
      ? state
      : { mode: 'idle', clips: state.snapshot.clips, playhead_ms: state.snapshot.playhead_ms }
  }
  if (event.type === 'commit') {
    return state.mode === 'idle'
      ? state
      : { mode: 'idle', clips: state.clips, playhead_ms: state.playhead_ms }
  }
  if (event.type === 'begin_drag') {
    if (state.mode !== 'idle' || event.locked || !state.clips.some(clip => clip.id === event.clip_id)) return state
    return { ...state, mode: 'dragging', snapshot: snapshot(state), clip_id: event.clip_id }
  }
  if (event.type === 'drag_to') {
    if (state.mode !== 'dragging' || !state.clip_id) return state
    const from = state.clips.findIndex(clip => clip.id === state.clip_id)
    const to = Math.max(0, Math.min(event.index, state.clips.length - 1))
    if (from < 0 || from === to) return state
    const clips = [...state.clips]
    const [clip] = clips.splice(from, 1)
    clips.splice(to, 0, clip!)
    return { ...state, clips }
  }
  if (event.type === 'begin_trim') {
    if (state.mode !== 'idle' || event.locked || !state.clips.some(clip => clip.id === event.clip_id)) return state
    return {
      ...state,
      mode: 'trimming',
      snapshot: snapshot(state),
      clip_id: event.clip_id,
      edge: event.edge,
    }
  }
  if (event.type === 'trim_to') {
    if (state.mode !== 'trimming' || !state.clip_id || !state.edge) return state
    return {
      ...state,
      clips: state.clips.map(clip => {
        if (clip.id !== state.clip_id) return clip
        if (state.edge === 'in') {
          return { ...clip, in_ms: Math.max(0, Math.min(event.milliseconds, clip.out_ms - 1)) }
        }
        return {
          ...clip,
          out_ms: Math.max(clip.in_ms + 1, Math.min(event.milliseconds, event.source_duration_ms)),
        }
      }),
    }
  }
  if (event.type === 'begin_scrub') {
    if (state.mode !== 'idle') return state
    return { ...state, mode: 'scrubbing', snapshot: snapshot(state) }
  }
  if (event.type === 'scrub_to') {
    if (state.mode !== 'scrubbing') return state
    return { ...state, playhead_ms: Math.max(0, Math.min(event.milliseconds, event.duration_ms)) }
  }
  if (event.type === 'playhead_to') {
    if (state.mode !== 'idle') return state
    return { ...state, playhead_ms: Math.max(0, Math.min(event.milliseconds, event.duration_ms)) }
  }
  return state
}
