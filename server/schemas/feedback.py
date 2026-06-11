from pydantic import BaseModel, Field


class FeedbackRequest(BaseModel):
    rating: str = Field(..., pattern="^(good|bad)$")
    # 限长：DB 列 String(500)，超长会落库报错
    note: str | None = Field(default=None, max_length=400)
