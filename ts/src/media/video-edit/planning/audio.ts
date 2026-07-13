import type { VideoAudioLayer, VideoScene, VideoSourceRange } from '../../../../shared/contracts/video-edit'

export function applyAudioClock(layers: VideoAudioLayer[], clock: VideoScene['edit_clock']): VideoAudioLayer[] {
  let assigned = false
  return layers.map(layer => {
    const matches = clock === 'dialogue'
      ? layer.role === 'speech'
      : clock === 'music'
        ? layer.role === 'music'
        : layer.role === 'ambience' || layer.role === 'sfx'
    const owner = layer.enabled && matches && !assigned
    if (owner) assigned = true
    return { ...layer, owner }
  })
}

export function audioLayersForScene(scene: Pick<VideoScene, 'edit_clock'>, primary: VideoSourceRange): VideoAudioLayer[] {
  const duration = primary.out_ms - primary.in_ms
  const role = scene.edit_clock === 'dialogue' ? 'speech' : 'ambience'
  const sourceGain = scene.edit_clock === 'music' ? 0.32 : 1
  const layers: VideoAudioLayer[] = [{
    id: `audio-${crypto.randomUUID().slice(0, 8)}`,
    role,
    source_range: primary,
    owner: scene.edit_clock !== 'music',
    gain_envelope: [{ at_ms: 0, gain: sourceGain }, { at_ms: duration, gain: sourceGain }],
    fade_in_ms: Math.min(120, Math.round(duration / 8)),
    fade_out_ms: Math.min(120, Math.round(duration / 8)),
    enabled: true,
  }]
  layers.push({
    id: `music-${crypto.randomUUID().slice(0, 8)}`,
    role: 'music',
    owner: scene.edit_clock === 'music',
    gain_envelope: scene.edit_clock === 'dialogue'
      ? [{ at_ms: 0, gain: 0.18 }, { at_ms: duration, gain: 0.18 }]
      : scene.edit_clock === 'action'
        ? [{ at_ms: 0, gain: 0.25 }, { at_ms: duration, gain: 0.4 }]
        : [{ at_ms: 0, gain: 0.55 }, { at_ms: duration, gain: 0.55 }],
    fade_in_ms: 200,
    fade_out_ms: 200,
    enabled: true,
  })
  return layers
}
