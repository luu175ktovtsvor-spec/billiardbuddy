export interface DashboardSummary {
  total_generations: number
  today_generations: number
  favorite_count: number
  good_count: number
  latest_generation_at: string | null
}

export interface CardSignals {
  /** 各 prompt_key 最近使用次数（跨设备，源自生成历史） */
  prompt_key_counts: Record<string, number>
  /** 标过"效果好"的 prompt_key */
  good_prompt_keys: string[]
  /** 门店成长阶段：preopen/newopen/ramp/mature/"" */
  stage: string
}

export interface DashboardRecommendation {
  // 单窗口化后桌面只读 title/description/id；action_label/action_type 已退役（死字段，无读取方）。
  // action_url + suggested_payload 后端主动出击(proactive)仍用，前端不消费。
  id: string
  title: string
  description: string
  action_url: string
  priority: "high" | "medium" | "low"
  /** 推荐理由类目：focus 今日重点 | frequent 你常用 | gap 补缺口 | good 复刻好评 | setup 完善资料 | festival 节日 | store 店情专属 */
  category?: string
  suggested_payload?: Record<string, unknown> | null
}

export interface DashboardTodayResponse {
  date: string
  weekday: string
  greeting: string
  store_completeness: number
  summary: DashboardSummary
  recommendations: DashboardRecommendation[]
  tips: string[]
}
