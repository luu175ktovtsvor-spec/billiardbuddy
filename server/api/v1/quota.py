"""配额查询 API"""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select

from api.deps import get_db, get_current_store
from core.rbac import Permission, require_permission
from core.timezone import business_now
from models.generation import Generation
from models.plan import Plan, StoreSubscription
from services.quota_service import get_or_create_quota

router = APIRouter()


class QuotaResponse(BaseModel):
    monthly_generation_limit: int
    monthly_generations_used: int
    monthly_tokens_limit: int
    monthly_tokens_used: int
    remaining: int
    # 海报独立额度池（生图比文案贵，单独计数/限额）
    monthly_poster_limit: int
    monthly_posters_used: int
    posters_remaining: int
    plan_name: str | None = None  # 无有效订阅 = 试用版

    model_config = {"from_attributes": True}


@router.get("", response_model=QuotaResponse)  # 不带尾斜杠：与前端请求路径一致，避免 307 重定向剥离认证头
async def get_quota(
    _perm: None = Depends(require_permission(Permission.QUOTA_VIEW)),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    quota = await get_or_create_quota(db, str(store.id))

    # 当前有效套餐名（前端用于区分"试用版/正式套餐"展示）
    now = datetime.now(timezone.utc)
    plan_name = None
    sub = await db.scalar(
        select(StoreSubscription).where(
            StoreSubscription.store_id == store.id,
            StoreSubscription.status == "active",
            StoreSubscription.current_period_end > now,
        )
    )
    if sub:
        plan = await db.get(Plan, sub.plan_id)
        plan_name = plan.name if plan else None

    return QuotaResponse(
        monthly_generation_limit=quota.monthly_generation_limit,
        monthly_generations_used=quota.monthly_generations_used,
        monthly_tokens_limit=quota.monthly_tokens_limit,
        monthly_tokens_used=quota.monthly_tokens_used,
        remaining=max(0, quota.monthly_generation_limit - quota.monthly_generations_used),
        monthly_poster_limit=quota.monthly_poster_limit,
        monthly_posters_used=quota.monthly_posters_used,
        posters_remaining=max(0, quota.monthly_poster_limit - quota.monthly_posters_used),
        plan_name=plan_name,
    )


# BYOK 成本粗估费率(¥/百万 tokens)。按 DeepSeek 级别廉价模型混合均价粗估；老板实际成本以其供应商账单为准。
_COST_RATE_PER_M = 2.0

# 工具/类型 → 给老板看的中文名（gen_type 多为英文）
_FEATURE_LABELS = {
    "free_intent": "自由对话", "workbench_free": "工作台", "platform_content": "平台内容",
    "repurpose": "内容变体", "canvas_edit": "画布改写", "diagnosis": "经营诊断",
    "outreach": "约客话术", "games": "玩法推荐", "report": "运营日报", "groupbuy": "团购文案",
    "activity": "活动策划", "copywriting": "文案", "agent": "AI管家",
}


@router.get("/cost")
async def get_cost(
    _perm: None = Depends(require_permission(Permission.QUOTA_VIEW)),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """本月 AI 用量与粗估花费——给 BYOK 老板看自己的 key 这个月花了多少 token、约多少钱。
    token 数精确(库里逐条记的)；花费是粗估(按廉价模型均价)，实际以供应商账单为准。"""
    month_start = business_now().replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    rows = (
        await db.execute(
            select(
                Generation.type,
                func.coalesce(func.sum(Generation.tokens_used), 0),
                func.count(),
            )
            .where(
                Generation.store_id == store.id,
                Generation.created_at >= month_start,
                Generation.is_deleted == False,  # noqa: E712
            )
            .group_by(Generation.type)
        )
    ).all()
    by_feature = [
        {
            "feature": _FEATURE_LABELS.get(r[0], r[0] or "其他"),
            "tokens": int(r[1] or 0),
            "count": int(r[2] or 0),
        }
        for r in rows
    ]
    by_feature.sort(key=lambda x: x["tokens"], reverse=True)
    total_tokens = sum(f["tokens"] for f in by_feature)
    total_count = sum(f["count"] for f in by_feature)
    return {
        "month": month_start.strftime("%Y-%m"),
        "total_tokens": total_tokens,
        "total_count": total_count,
        "est_cost_yuan": round(total_tokens / 1_000_000 * _COST_RATE_PER_M, 2),
        "rate_per_m_tokens": _COST_RATE_PER_M,
        "by_feature": by_feature[:8],
    }
