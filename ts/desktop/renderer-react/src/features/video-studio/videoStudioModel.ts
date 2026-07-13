import type { VideoContentType, VideoScene, VideoSourceRole } from '../../api/video'

export const VIDEO_CONTENT_TYPES: Array<{ value: VideoContentType; label: string }> = [
  { value: 'freeform', label: '自由创作' },
  { value: 'venue_atmosphere', label: '空间与氛围' },
  { value: 'event_highlight', label: '赛事与高光' },
  { value: 'assistant_daily', label: '人物与日常' },
  { value: 'coach_tutorial', label: '教学与器材' },
  { value: 'offer_conversion', label: '优惠与活动' },
  { value: 'customer_experience', label: '顾客体验' },
  { value: 'recruitment_team', label: '招聘与团队' },
  { value: 'knowledge_live_clip', label: '知识与直播切片' },
]

export const VIDEO_SOURCE_ROLES: Array<{ value: VideoSourceRole; label: string }> = [
  { value: 'unclassified', label: '让系统判断' },
  { value: 'talking_take', label: '对镜讲解' },
  { value: 'live_longform', label: '长讲解或直播' },
  { value: 'venue_entry', label: '地点或场地开场' },
  { value: 'space_wide', label: '空间全景' },
  { value: 'people_interaction', label: '人物互动' },
  { value: 'play_action', label: '动作画面' },
  { value: 'event_moment', label: '活动或高光' },
  { value: 'detail_product', label: '细节或产品' },
  { value: 'service_process', label: '服务过程' },
  { value: 'brand_end', label: '片尾或品牌画面' },
]

export const STORY_ROLE_LABELS: Record<VideoScene['story_role'], string> = {
  hook: '开场',
  explain: '说明',
  proof: '支撑',
  atmosphere: '氛围',
  offer: '信息',
  cta: '收束',
}

export const CLOCK_LABELS: Record<VideoScene['edit_clock'], string> = {
  dialogue: '人声',
  music: '音乐',
  action: '动作/同期声',
}

const COVERAGE_LABELS: Record<string, string> = {
  opening: '开场', development: '内容展开', ending: '收束', establishing: '地点或空间建立镜头', people_or_activity: '人物或现场活动', detail: '细节镜头', action: '完整动作', brand_or_ending: '品牌或收束镜头', result_or_ending: '结果或收束', peak: '真实高潮', person_context: '人物出现的真实语境', real_activity: '人物真实活动', topic: '明确主题', explanation: '完整讲解', demonstration: '对应示范', summary: '总结', offer_fact: '已确认的活动事实', proof: '真实证明画面', time_or_condition: '时间或适用条件', cta: '已确认行动信息', context: '场景上下文', real_interaction: '真实互动', service_or_activity: '服务或活动过程', people_role: '人物角色', process: '过程', cta_or_ending: '行动信息或收束', hook: '开头观点', complete_point: '完整观点', support: '支撑内容',
}

export function coverageLabel(value: string): string {
  return COVERAGE_LABELS[value] ?? value
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function sceneDuration(scene: VideoScene): number {
  return Math.max(0, scene.output_range.end_ms - scene.output_range.start_ms)
}

export function sourceRoleLabel(role: VideoSourceRole): string {
  return VIDEO_SOURCE_ROLES.find(item => item.value === role)?.label ?? role
}

export function terminalVideoJob(status: string): boolean {
  return ['done', 'done_with_warnings', 'cancelled', 'interrupted', 'error'].includes(status)
}

export function friendlyVideoText(value: string): string {
  return value
    .replace(/\bScenes\b/gi, '片段')
    .replace(/\bScene\b/gi, '片段')
    .replace(/\bASR\b/gi, '语音识别')
    .replace(/\bTake\b/gi, '口播素材')
    .replace(/\bCTA\b/gi, '行动提示')
    .replace(/\brevision\b/gi, '版本')
    .replace(/本地语音转写组件/g, '语音识别功能')
    .replace(/稍后重试转写/g, '稍后再试')
    .replace(/音轨/g, '声音')
}
