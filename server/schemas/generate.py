from datetime import datetime
from enum import Enum

from pydantic import BaseModel, Field


class CopywritingSubType(str, Enum):
    moments = "moments"
    group_notice = "group_notice"


class Tone(str, Enum):
    lively = "lively"
    professional = "professional"
    friendly = "friendly"
    humorous = "humorous"


class Scenario(str, Enum):
    daily = "daily"
    promotion = "promotion"
    tournament = "tournament"
    holiday = "holiday"
    evening = "evening"
    student = "student"
    rainy = "rainy"


class ActivityGoal(str, Enum):
    traffic = "traffic"
    membership = "membership"
    tournament = "tournament"
    comeback = "comeback"
    student = "student"
    community = "community"
    team_building = "team_building"
    holiday = "holiday"
    coaching = "coaching"


class BudgetLevel(str, Enum):
    light = "light"
    medium = "medium"
    heavy = "heavy"


class OperationScenario(str, Enum):
    groupbuy_to_private = "groupbuy_to_private"
    assistant_promo = "assistant_promo"
    assistant_outreach = "assistant_outreach"
    partner_match = "partner_match"
    tournament = "tournament"
    old_customer_recall = "old_customer_recall"
    frontdesk_sop = "frontdesk_sop"
    game_recommend = "game_recommend"
    vip_maintenance = "vip_maintenance"
    complaint_handling = "complaint_handling"
    daily_report = "daily_report"
    short_video = "short_video"
    group_content = "group_content"
    performance_template = "performance_template"
    diagnosis_tool = "diagnosis_tool"
    review_meeting = "review_meeting"


class OperationRequest(BaseModel):
    scenario: OperationScenario = Field(..., description="经营场景类型")
    tone: Tone = Field(Tone.friendly, description="语气风格")
    target: str | None = Field(None, description="目标客户补充")
    extra_note: str = Field("", description="补充说明", max_length=200)


class WorkbenchRole(str, Enum):
    boss = "boss"
    manager = "manager"
    assistant_manager = "assistant_manager"
    coach = "coach"
    frontdesk = "frontdesk"
    operator = "operator"


class TargetCustomerType(str, Enum):
    groupbuy = "groupbuy"
    new = "new"
    old = "old"
    competition = "competition"
    assistant = "assistant"
    light_competition = "light_competition"
    vip = "vip"
    all = "all"


class OutputPackageItem(str, Enum):
    moments = "moments"
    group_notice = "group_notice"
    private_chat = "private_chat"
    poster_copy = "poster_copy"
    short_video = "short_video"
    execution_tips = "execution_tips"
    daily_report = "daily_report"
    activity_plan = "activity_plan"
    sop_checklist = "sop_checklist"
    pk_plan = "pk_plan"


class WorkbenchRequest(BaseModel):
    user_intent: str = Field(..., description="用户自然语言需求描述", min_length=1, max_length=500)
    role: WorkbenchRole = Field(..., description="用户当前使用的岗位身份")
    target_customer_type: TargetCustomerType | None = Field(TargetCustomerType.all, description="目标客户类型")
    output_package: list[OutputPackageItem] | None = Field(None, description="期望输出的成品类型，为空则由 AI 自行判断")
    extra_note: str = Field("", description="补充说明", max_length=200)
    prompt_key: str | None = Field(None, description="后端场景模板 key，如 operation.qiangyi_battle。有 promptKey 时优先使用该模板，否则 fallback 到 workbench.free_intent")
    model: str | None = Field(None, description="指定文本模型 ID（当前仅支持 deepseek-v4-flash）")
    conversation_id: str | None = Field(None, description="对话 ID，用于多轮对话上下文")
    concise: bool = Field(False, description="精简档：只出一条，不堆多个方案/版本")


class CopywritingRequest(BaseModel):
    sub_type: CopywritingSubType = Field(..., description="文案类型：moments 朋友圈 / group_notice 群公告")
    tone: Tone = Field(Tone.lively, description="语气风格")
    scenario: str = Field("daily", description="适用场景。朋友圈用 daily/promotion/tournament/holiday/evening/student/rainy；群公告用 activity_notice/matchmaking/group_rule/newcomer_welcome/benefit_notice")
    extra_note: str = Field("", description="补充说明，最多 200 字", max_length=200)


class ActivityRequest(BaseModel):
    activity_goal: ActivityGoal = Field(..., description="活动目标")
    target_customer: str | None = Field(None, description="目标客群")
    budget_level: BudgetLevel | None = Field(None, description="优惠力度：轻度/中度/大力")
    duration: str | None = Field(None, description="活动时长，如 3天/1周/周末两天")
    extra_note: str = Field("", description="补充说明", max_length=200)


class GenerationResponse(BaseModel):
    generation_id: str
    type: str
    sub_type: str
    content: str
    created_at: datetime
    profile_suggestions: list[dict] | None = None
