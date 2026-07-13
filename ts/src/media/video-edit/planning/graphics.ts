import type { VideoGraphic, VideoScene } from '../../../../shared/contracts/video-edit'

export function solveGraphics(scene: VideoScene, graphics: VideoGraphic[]): { graphics: VideoGraphic[]; warnings: string[] } {
  const warnings: string[] = []
  const sorted = structuredClone(graphics).sort((a, b) => b.priority - a.priority)
  const occupied = new Map<string, string>()
  let mainAnimation = false
  for (const graphic of sorted) {
    if (graphic.role === 'title' && graphic.anchor === 'center') {
      mainAnimation = true
      occupied.set('fullscreen', graphic.id)
      continue
    }
    if (mainAnimation && ['subtitle', 'lower_third', 'emphasis'].includes(graphic.role)) {
      graphic.hidden_reason = '全屏标题显示期间隐藏次要文字'
      warnings.push(`${graphic.role} 已避让全屏标题`)
      continue
    }
    const group = graphic.exclusive_group
    if (group && occupied.has(group)) {
      graphic.hidden_reason = `与更高优先级图形 ${occupied.get(group)} 冲突`
      warnings.push(`${graphic.role} 因版面冲突暂时隐藏`)
      continue
    }
    if (group) occupied.set(group, graphic.id)
    if (graphic.role === 'cta' && scene.attention_owner === 'person' && graphic.anchor === 'center') {
      graphic.anchor = 'top'
      warnings.push('CTA 已避让人物主体')
    }
  }
  return { graphics: sorted, warnings }
}
