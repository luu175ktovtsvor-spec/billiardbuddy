import {
  videoBriefCompileRequestSchema,
  videoCreativeBriefSchema,
  type VideoBriefCompileRequest,
  type VideoContentType,
  type VideoCreativeBrief,
  type VideoSource,
  type VideoSourceRole,
} from '../../../shared/contracts/video-edit'

export const VIDEO_BRIEF_COMPILER_VERSION = 'video-brief-v1'

const CONTENT_KEYWORDS: Array<[RegExp, VideoContentType]> = [
  [/比赛|赛事|竞技|高光|挑战|欢呼|颁奖/u, 'event_highlight'],
  [/教学|教程|球技|技巧|器材|课程|怎么打/u, 'coach_tutorial'],
  [/优惠|团购|套餐|活动转化|预约|到店|咨询/u, 'offer_conversion'],
  [/顾客|体验|互动|社交|组局|搭子|服务/u, 'customer_experience'],
  [/招聘|团队|开业|筹备|培训|员工日常/u, 'recruitment_team'],
  [/直播|长访谈|知识|观点|切片/u, 'knowledge_live_clip'],
  [/助教|人物日常|工作日常|随手拍/u, 'assistant_daily'],
  [/环境|氛围|空间|门店|场地|人气|探店/u, 'venue_atmosphere'],
]

const REQUIRED_SLOTS: Record<VideoContentType, string[]> = {
  freeform: ['opening', 'development', 'ending'],
  venue_atmosphere: ['establishing', 'people_or_activity', 'detail', 'action', 'brand_or_ending'],
  event_highlight: ['establishing', 'action', 'peak', 'result_or_ending'],
  assistant_daily: ['person_context', 'real_activity', 'ending'],
  coach_tutorial: ['topic', 'explanation', 'demonstration', 'summary'],
  offer_conversion: ['offer_fact', 'proof', 'time_or_condition', 'cta'],
  customer_experience: ['context', 'real_interaction', 'service_or_activity', 'ending'],
  recruitment_team: ['context', 'people_role', 'process', 'cta_or_ending'],
  knowledge_live_clip: ['hook', 'complete_point', 'support', 'summary'],
}

const SLOT_ROLES: Record<string, VideoSourceRole[]> = {
  establishing: ['venue_entry', 'space_wide'],
  people_or_activity: ['people_interaction', 'play_action', 'event_moment'],
  detail: ['detail_product', 'service_process'],
  action: ['play_action', 'event_moment'],
  brand_or_ending: ['brand_end', 'venue_entry'],
  result_or_ending: ['event_moment', 'brand_end'],
  peak: ['event_moment', 'play_action'],
  person_context: ['talking_take', 'people_interaction'],
  real_activity: ['people_interaction', 'play_action', 'service_process'],
  topic: ['talking_take', 'live_longform'],
  explanation: ['talking_take', 'live_longform'],
  demonstration: ['play_action', 'detail_product', 'service_process'],
  offer_fact: ['talking_take', 'brand_end'],
  proof: ['space_wide', 'people_interaction', 'play_action', 'detail_product', 'service_process', 'event_moment'],
  context: ['venue_entry', 'space_wide', 'talking_take'],
  real_interaction: ['people_interaction', 'service_process'],
  service_or_activity: ['service_process', 'play_action', 'people_interaction'],
  people_role: ['talking_take', 'people_interaction', 'service_process'],
  process: ['service_process', 'people_interaction'],
  hook: ['talking_take', 'live_longform'],
  complete_point: ['talking_take', 'live_longform'],
  support: ['talking_take', 'live_longform', 'detail_product', 'play_action'],
}

function inferContentType(text: string): VideoContentType {
  for (const [pattern, type] of CONTENT_KEYWORDS) if (pattern.test(text)) return type
  return 'freeform'
}

function inferStoryGoal(text: string): VideoCreativeBrief['story_goal'] {
  if (/招聘|招人|招募/u.test(text)) return 'recruitment'
  if (/教学|教程|讲清|知识|课程|技巧/u.test(text)) return 'education'
  if (/优惠|团购|购买|预约|到店|咨询|转化/u.test(text)) return 'conversion'
  if (/拉新|获客|引流/u.test(text)) return 'acquisition'
  if (/互动|评论|社交|参与/u.test(text)) return 'interaction'
  if (/曝光|宣传|展示|氛围|高光/u.test(text)) return 'exposure'
  return 'other'
}

function inferView(text: string, sources: VideoSource[]): VideoCreativeBrief['preferred_view'] {
  if (/口播|采访|讲清|解说|旁白|直播切片|说话/u.test(text)) return 'talking'
  if (/环境|氛围|高光|集锦|空间|卡点|现场/u.test(text)) return 'ambient'
  return sources.some(source => source.role === 'talking_take' || source.role === 'live_longform') ? 'talking' : 'ambient'
}

function sourceAssets(sources: VideoSource[], overrides?: Record<string, VideoSourceRole>) {
  return sources.map(source => ({
    source_id: source.id,
    role: overrides?.[source.id] ?? source.role,
    ...(source.role_confidence != null ? { confidence: source.role_confidence } : {}),
  }))
}

export function missingCoverageForBrief(brief: VideoCreativeBrief): string[] {
  const roles = new Set(brief.source_assets.map(asset => asset.role))
  return brief.required_story_slots.filter(slot => {
    const accepted = SLOT_ROLES[slot]
    return accepted ? !accepted.some(role => roles.has(role)) : false
  })
}

export function compileVideoBrief(
  raw: VideoBriefCompileRequest,
  sources: VideoSource[],
): { brief: VideoCreativeBrief; recommendationReason: string; missingFacts: string[]; missingCoverage: string[] } {
  const input = videoBriefCompileRequestSchema.parse(raw)
  const contentType = input.content_type ?? inferContentType(input.user_request)
  const preferredView = input.preferred_view ?? inferView(input.user_request, sources)
  const requiredSlots = REQUIRED_SLOTS[contentType]
  const brief = videoCreativeBriefSchema.parse({
    schema_version: 1,
    user_request: input.user_request.trim(),
    content_type: contentType,
    story_goal: input.story_goal ?? inferStoryGoal(input.user_request),
    output_channel: input.output_channel,
    preferred_view: preferredView,
    target_ratio: input.ratio ?? '9:16',
    target_duration_ms: input.target_duration_ms,
    source_assets: sourceAssets(sources, input.source_roles),
    exact_copy: input.exact_copy ?? [],
    must_preserve: input.must_preserve ?? [],
    must_avoid: input.must_avoid ?? [],
    required_story_slots: requiredSlots,
    understanding: `${preferredView === 'talking' ? '讲清一件事' : '展示环境与氛围'} / ${input.user_request.trim()} / ${sources.length} 段素材`,
    compiler_version: VIDEO_BRIEF_COMPILER_VERSION,
  })
  const missingCoverage = missingCoverageForBrief(brief)
  const missingFacts: string[] = []
  if (contentType === 'offer_conversion' && brief.exact_copy.length === 0) missingFacts.push('活动价格、权益、时间或 CTA 尚未由用户确认')
  const recommendationReason = preferredView === 'talking'
    ? '当前目标更依赖完整表达或旁白，建议先从文字稿视角开始；仍可随时切换环境视角。'
    : '当前目标更依赖镜头关系和现场体验，建议先从故事板视角开始；仍可随时切换口播视角。'
  return { brief, recommendationReason, missingFacts, missingCoverage }
}

export function requiredSlotsForContentType(type: VideoContentType): string[] {
  return [...REQUIRED_SLOTS[type]]
}
