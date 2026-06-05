"""配额查询 API"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api.deps import get_db, get_current_store
from services.quota_service import get_or_create_quota

router = APIRouter()


class QuotaResponse(BaseModel):
    monthly_generation_limit: int
    monthly_generations_used: int
    monthly_tokens_limit: int
    monthly_tokens_used: int
    remaining: int

    model_config = {"from_attributes": True}


@router.get("/", response_model=QuotaResponse)
async def get_quota(
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    quota = await get_or_create_quota(db, str(store.id))
    return QuotaResponse(
        monthly_generation_limit=quota.monthly_generation_limit,
        monthly_generations_used=quota.monthly_generations_used,
        monthly_tokens_limit=quota.monthly_tokens_limit,
        monthly_tokens_used=quota.monthly_tokens_used,
        remaining=max(0, quota.monthly_generation_limit - quota.monthly_generations_used),
    )
