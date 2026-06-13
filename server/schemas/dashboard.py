from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class DashboardSummary(BaseModel):
    total_generations: int
    today_generations: int
    favorite_count: int = 0
    good_count: int = 0
    latest_generation_at: datetime | None = None


class DashboardRecommendation(BaseModel):
    id: str
    title: str
    description: str
    action_label: str
    action_url: str
    action_type: str
    priority: Literal["high", "medium", "low"]
    # 推荐理由类目（前端打标签让老板知道"为什么推这个"）：
    # focus 今日重点 | frequent 你常用 | gap 补缺口 | good 复刻好评 | setup 完善资料 | festival 节日
    category: str = "focus"
    suggested_payload: dict | None = None


class CardSignalsResponse(BaseModel):
    """工作台卡片动态排序信号（跨设备，源自生成历史）。"""
    prompt_key_counts: dict[str, int] = {}
    good_prompt_keys: list[str] = []
    stage: str = ""


class DashboardTodayResponse(BaseModel):
    date: str
    weekday: str
    greeting: str
    store_completeness: int
    summary: DashboardSummary
    recommendations: list[DashboardRecommendation]
    tips: list[str]
