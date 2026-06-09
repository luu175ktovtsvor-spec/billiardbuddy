from pydantic import BaseModel


class FeedbackRequest(BaseModel):
    rating: str  # "good" / "bad"
    note: str | None = None
