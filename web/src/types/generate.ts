export type WorkbenchRole =
  | "boss"
  | "manager"
  | "assistant_manager"
  | "coach"
  | "frontdesk"
  | "operator";

export type TargetCustomerType =
  | "groupbuy"
  | "new"
  | "old"
  | "competition"
  | "assistant"
  | "light_competition"
  | "vip"
  | "all";

export type OutputPackageItem =
  | "moments"
  | "group_notice"
  | "private_chat"
  | "poster_copy"
  | "short_video"
  | "execution_tips"
  | "daily_report"
  | "activity_plan"
  | "sop_checklist"
  | "pk_plan";

export interface GenerateWorkbenchRequest {
  user_intent: string;
  role: WorkbenchRole;
  target_customer_type?: TargetCustomerType;
  output_package?: OutputPackageItem[];
  extra_note?: string;
  prompt_key?: string;
  model?: string;
  conversation_id?: string;
  /** 精简档：只出一条，不堆多个方案/版本 */
  concise?: boolean;
}

export type OperationScenario =
  | "groupbuy_to_private"
  | "assistant_promo"
  | "assistant_outreach"
  | "partner_match"
  | "tournament"
  | "old_customer_recall"
  | "frontdesk_sop"
  | "game_recommend"
  | "vip_maintenance"
  | "complaint_handling"
  | "daily_report"
  | "short_video"
  | "opening_event"
  | "group_content"
  | "performance_template"
  | "diagnosis_tool"
  | "review_meeting";

export interface GenerateOperationRequest {
  scenario: OperationScenario;
  tone: string;
  target?: string;
  extra_note?: string;
}

export interface GenerateOutreachRequest {
  customer_name: string;
  customer_type: string;
  relationship?: string;
  style?: string;
  extra_note?: string;
}

export interface GenerateSOPRequest {
  role: string;
  scenario: string;
  customer_type?: string;
}

export interface GenerateGamesRequest {
  customer_count: number;
  skill_level: string;
  time_available: string;
}

export interface GeneratePerformanceRequest {
  role: string;
  period?: string;
}

export interface GenerateDiagnosisRequest {
  problem_area: string;
  current_situation: string;
}

export interface GenerateCopywritingRequest {
  sub_type: "moments" | "group_notice";
  tone: string;
  scenario: string;
  extra_note?: string;
}

export interface GenerateActivityRequest {
  activity_goal: string;
  target_customer?: string;
  budget_level?: string;
  duration?: string;
  extra_note?: string;
}

export interface ProfileSuggestion {
  module: string;
  level: string;
  title: string;
  message: string;
  action_label: string;
}

export interface GenerationResponse {
  generation_id: string;
  type: "copywriting" | "activity" | "operation" | "workbench" | "outreach" | "sop" | "games" | "performance" | "diagnosis";
  sub_type: string;
  content: string;
  created_at: string;
  profile_suggestions?: ProfileSuggestion[] | null;
}
