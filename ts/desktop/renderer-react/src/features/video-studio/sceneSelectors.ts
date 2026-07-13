import type { VideoScene } from '../../api/video'

export function selectedVisualLayer(scene: VideoScene | undefined) {
  if (!scene) return undefined
  return [...scene.video_layers].reverse().find(layer => layer.enabled && layer.role === 'broll')
    ?? scene.video_layers.find(layer => layer.enabled && layer.role === 'primary')
    ?? scene.video_layers[0]
}

export function selectedVisualRange(scene: VideoScene | undefined) {
  return selectedVisualLayer(scene)?.source_range ?? scene?.source_ranges[0]
}
