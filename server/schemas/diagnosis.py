from datetime import datetime

from pydantic import BaseModel, Field


class DiagnosisRequest(BaseModel):
    problem_area: str = Field(..., description="问题领域：traffic/revenue/customer_loss/staff/competition/activity_effect")
    current_situation: str = Field(..., description="当前情况描述", min_length=10, max_length=1000)


class DiagnosisResponse(BaseModel):
    generation_id: str
    type: str
    sub_type: str
    content: str
    created_at: datetime
