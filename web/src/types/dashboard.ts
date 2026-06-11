export interface DashboardSummary {
  total_generations: number
  today_generations: number
  favorite_count: number
  good_count: number
  latest_generation_at: string | null
}

export interface DashboardRecommendation {
  id: string
  title: string
  description: string
  action_label: string
  action_url: string
  action_type: string
  priority: "high" | "medium" | "low"
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
