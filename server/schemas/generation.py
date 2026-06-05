from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class GenerationListItem(BaseModel):
    id: UUID
    type: str
    sub_type: str | None
    input_params: dict | None
    content: str | None
    model_used: str | None
    tokens_used: int | None
    is_favorite: bool = False
    created_at: datetime


class GenerationDetailResponse(BaseModel):
    id: UUID
    type: str
    sub_type: str | None
    input_params: dict | None
    content: str | None
    model_used: str | None
    tokens_used: int | None
    is_favorite: bool = False
    created_at: datetime


class GenerationListResponse(BaseModel):
    items: list[GenerationListItem]
    total: int
    page: int
    page_size: int


class FavoriteResponse(BaseModel):
    is_favorite: bool