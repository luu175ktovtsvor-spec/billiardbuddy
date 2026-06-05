from datetime import datetime

from pydantic import BaseModel, Field


class PerformanceRequest(BaseModel):
    role: str = Field(..., description="岗位角色：coach/frontdesk/assistant_manager/manager/operator")
    period: str = Field("monthly", description="考核周期：weekly/monthly/quarterly")


class PerformanceResponse(BaseModel):
    generation_id: str
    type: str
    sub_type: str
    content: str
    created_at: datetime
