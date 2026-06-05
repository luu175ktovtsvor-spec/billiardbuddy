from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class DashboardSummary(BaseModel):
    total_generations: int
    today_generations: int
    latest_generation_at: datetime | None = None


class DashboardRecommendation(BaseModel):
    id: str
    title: str
    description: str
    action_label: str
    action_url: str
    action_type: str
    priority: Literal["high", "medium", "low"]
    suggested_payload: dict | None = None


class DashboardTodayResponse(BaseModel):
    date: str
    weekday: str
    greeting: str
    store_completeness: int
    summary: DashboardSummary
    recommendations: list[DashboardRecommendation]
    tips: list[str]
