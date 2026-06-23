"""成本查询 API（桌面 BYOK：只保留成本看板；套餐/订阅查询是 SaaS 计费遗留，2026-06-23 已删）。"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select

from api.deps import get_db, get_current_store
from core.timezone import business_now
from models.generation import Generation

router = APIRouter()


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
