from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends

from api.deps import get_current_user, get_current_store
from models.user import User
from models.store import Store

router = APIRouter()
BUSINESS_TZ = ZoneInfo("Asia/Shanghai")


@router.get("/week-plan")
async def get_week_plan(
    user: User = Depends(get_current_user),
    store: Store = Depends(get_current_store),
):
    """生成本周内容计划。"""
    now = datetime.now(BUSINESS_TZ)
    weekday = now.weekday()  # 0=周一

    # 基于行业知识的每周内容模板
    week_plan = [
        {"day": "周一", "type": "moments", "topic": "新的一周，日常引流", "suggestion": "发一条朋友圈，提醒顾客下班后来打球"},
        {"day": "周二", "type": "group_notice", "topic": "约球接龙", "suggestion": "在会员群发起约球接龙"},
        {"day": "周三", "type": "moments", "topic": "会员日/优惠", "suggestion": "发一条会员日优惠朋友圈"},
        {"day": "周四", "type": "activity", "topic": "周末活动预热", "suggestion": "策划周末活动"},
        {"day": "周五", "type": "moments", "topic": "周末预热", "suggestion": "发一条周末充值活动朋友圈"},
        {"day": "周六", "type": "moments", "topic": "今日到店", "suggestion": "发一条到店提醒"},
        {"day": "周日", "type": "moments", "topic": "本周总结", "suggestion": "发一条本周回顾"},
    ]

    # 标记今天和已完成的
    for i, plan in enumerate(week_plan):
        plan["is_today"] = i == weekday
        plan["is_past"] = i < weekday

    return {"week_plan": week_plan, "today": now.strftime("%Y-%m-%d")}
