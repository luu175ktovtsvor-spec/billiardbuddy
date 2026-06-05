from datetime import datetime

from pydantic import BaseModel, Field


class GamesRequest(BaseModel):
    customer_count: int = Field(..., description="参与人数", ge=2, le=20)
    skill_level: str = Field(..., description="技术水平：beginner/intermediate/advanced/mixed")
    time_available: str = Field(..., description="可用时间，如 1小时/2小时/半天")


class GamesResponse(BaseModel):
    generation_id: str
    type: str
    sub_type: str
    content: str
    created_at: datetime
