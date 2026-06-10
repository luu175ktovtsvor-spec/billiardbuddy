from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class GenerationListItem(BaseModel):
    id: UUID
    type: str
    sub_type: str | None
    input_params: dict | None
    content: str | None
    result: str | None = None
    model_used: str | None
    tokens_used: int | None
    is_favorite: bool = False
    effect_rating: str | None = None
    created_at: datetime


class GenerationDetailResponse(BaseModel):
    id: UUID
    type: str
    sub_type: str | None
    input_params: dict | None
    content: str | None
    result: str | None = None
    model_used: str | None
    tokens_used: int | None
    is_favorite: bool = False
    effect_rating: str | None = None
    created_at: datetime


class GenerationListResponse(BaseModel):
    items: list[GenerationListItem]
    total: int
    page: int
    page_size: int
