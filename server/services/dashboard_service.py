import uuid
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, Integer
from sqlalchemy.ext.asyncio import AsyncSession

from models.generation import Generation
from models.store import Store
from schemas.dashboard import (
    DashboardSummary,
    DashboardRecommendation,
    DashboardTodayResponse,
)
from services.store_service import calculate_completeness

BUSINESS_TZ = ZoneInfo("Asia/Shanghai")

WEEKDAY_NAMES = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
]

WEEKDAY_CN = {
    "Monday": "周一",
    "Tuesday": "周二",
    "Wednesday": "周三",
    "Thursday": "周四",
    "Friday": "周五",
    "Saturday": "周六",
    "Sunday": "周日",
}


async def get_today_dashboard(
    db: AsyncSession,
    store: Store,
) -> DashboardTodayResponse:
    now = datetime.now(BUSINESS_TZ)
    today_start_local = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today_end_local = today_start_local + timedelta(days=1)
    today_start = today_start_local.astimezone(timezone.utc)
    today_end = today_end_local.astimezone(timezone.utc)

    # 一次查询获取所有统计数据
    total_count, today_count, favorite_count, good_count, latest = await _get_generation_stats(
        db, store.id, today_start, today_end
    )

    completeness = calculate_completeness(store)
    weekday = WEEKDAY_NAMES[now.weekday()]

    recommendations, greeting, tips = await _build_rules(
        db=db,
        store=store,
        completeness=completeness,
        today_count=today_count,
        total_count=total_count,
        weekday=weekday,
    )

    return DashboardTodayResponse(
        date=now.strftime("%Y-%m-%d"),
        weekday=weekday,
        greeting=greeting,
        store_completeness=completeness,
        summary=DashboardSummary(
            total_generations=total_count,
            today_generations=today_count,
            favorite_count=favorite_count,
            good_count=good_count,
            latest_generation_at=latest,
        ),
        recommendations=recommendations,
        tips=tips,
    )


async def _get_generation_stats(
    db: AsyncSession,
    store_id: uuid.UUID,
    today_start: datetime,
    today_end: datetime,
) -> tuple[int, int, datetime | None]:
    """一次查询获取：总数、今日数、最新时间。

    Returns
    -------
    tuple[int, int, datetime | None]
        (total_count, today_count, latest_created_at)
    """
    # 使用 CASE WHEN 在一次查询中计算多个 count
    stmt = select(
        func.count().label("total"),
        func.sum(
            func.cast(
                (Generation.created_at >= today_start) & (Generation.created_at < today_end),
                Integer
            )
        ).label("today"),
        func.sum(func.cast(Generation.is_favorite == True, Integer)).label("favorites"),
        func.sum(func.cast(Generation.effect_rating == "good", Integer)).label("good"),
    ).where(Generation.store_id == store_id, Generation.is_deleted == False)

    result = await db.execute(stmt)
    row = result.one()

    total_count = row.total or 0
    today_count = row.today or 0
    favorite_count = row.favorites or 0
    good_count = row.good or 0

    # 单独查询最新时间（因为需要排序，无法与 count 高效合并）
    latest = await _get_latest_generation(db, store_id)

    return total_count, today_count, favorite_count, good_count, latest


async def _get_latest_generation(
    db: AsyncSession,
    store_id: uuid.UUID,
) -> datetime | None:
    stmt = (
        select(Generation.created_at)
        .where(Generation.store_id == store_id, Generation.is_deleted == False)
        .order_by(Generation.created_at.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    row = result.scalar_one_or_none()
    return row


async def _build_rules(
    db: AsyncSession,
    store: Store,
    completeness: int,
    today_count: int,
    total_count: int,
    weekday: str,
) -> tuple[list[DashboardRecommendation], str, list[str]]:
    recs: list[DashboardRecommendation] = []
    tips: list[str] = []

    # Rule 1: 资料不完整优先提醒
    if completeness < 70:
        recs.append(
            DashboardRecommendation(
                id="incomplete_profile",
                title="完善门店资料",
                description="门店资料越完整，AI 生成的文案和海报越准确。",
                action_label="去完善资料",
                action_url="/dashboard/store-settings",
                action_type="edit_store",
                priority="high",
            )
        )
        tips.append("门店资料越完整，AI 生成的内容越准确。")

    # Rule 2: 缺少 Logo / 二维码
    if not store.logo_url or not store.qrcode_url:
        missing_parts = []
        if not store.logo_url:
            missing_parts.append("Logo")
        if not store.qrcode_url:
            missing_parts.append("二维码")
        recs.append(
            DashboardRecommendation(
                id="missing_assets",
                title=f"上传{'和'.join(missing_parts)}",
                description="上传 Logo 和二维码后，生成海报会自动带上门店品牌和联系方式。",
                action_label="去上传",
                action_url="/dashboard/store-settings",
                action_type="edit_store",
                priority="high",
            )
        )

    # Rule 6: 今天还没有生成内容
    if today_count == 0 and total_count > 0:
        recs.append(
            DashboardRecommendation(
                id="no_generation_today",
                title="今天还没生成运营内容",
                description="先生成一条朋友圈或群公告，开始今天的运营。",
                action_label="去生成内容",
                action_url="/dashboard/workbench",
                action_type="generate_copywriting",
                priority="high",
                suggested_payload={
                    "sub_type": "moments",
                    "tone": "friendly",
                    "scenario": "daily",
                },
            )
        )

    # Rules 3/4/5: 星期推荐
    if weekday == "Friday":
        greeting = "周五到了，适合做一波周末客流预热！"
        recs.extend(_friday_recs())
        recs.append(
            DashboardRecommendation(
                id="friday_operation",
                title="运营场景：周末赛事/搭子局预热",
                description="用经营场景一键生成周末赛事报名通知和搭子局邀约。",
                action_label="去生成运营内容",
                action_url="/dashboard/workbench",
                action_type="generate_operation",
                priority="high",
                suggested_payload={
                    "scenario": "tournament",
                },
            )
        )
    elif weekday in ("Saturday", "Sunday"):
        greeting = "周末好时机，提醒顾客到店打球！"
        recs.extend(_weekend_recs(weekday))
    elif weekday == "Monday":
        greeting = "新的一周，适合做日常引流和老客轻提醒。"
        recs.extend(_weekday_recs("Monday"))
    else:
        greeting = "工作日适合提醒顾客下班后来放松。"
        recs.extend(_weekday_recs("weekday"))

    # Rule 7: 今天已经生成很多内容
    if today_count >= 5:
        tips.append("今天已生成了多条内容，可以优先挑选最合适的一条发布。")

    # Rule 8: 上次标记了"效果好"的内容推荐
    good_gen = await _get_last_good_generation(db, store.id)
    if good_gen:
        type_labels = {
            "copywriting": "文案", "activity": "活动方案", "operation": "经营内容",
            "workbench": "内容", "poster": "海报", "diagnosis": "经营诊断",
            "sop": "话术", "outreach": "约客话术", "batch": "批量内容",
        }
        type_label = type_labels.get(good_gen.type, "内容")
        params = good_gen.input_params or {}
        payload: dict = {
            "user_intent": params.get("user_intent") or "基于上次效果好的内容，写一条类似的",
        }
        # 带上 prompt_key：前端可据此直达原任务卡片，一键复刻
        if params.get("prompt_key"):
            payload["prompt_key"] = params["prompt_key"]
        recs.append(
            DashboardRecommendation(
                id="repeat_good",
                title=f"上次的{type_label}效果不错，再来一条？",
                description="基于上次效果好的内容，生成类似的。",
                action_label="一键复刻",
                action_url="/dashboard/workbench",
                action_type="generate_workbench",
                priority="medium",
                suggested_payload=payload,
            )
        )

    # Rule 9: 距上次活动策划 > 7 天
    days_since_activity = await _days_since_last_activity(db, store.id)
    if days_since_activity and days_since_activity > 7:
        recs.append(
            DashboardRecommendation(
                id="activity_reminder",
                title="距上次活动已超过一周",
                description="定期做活动能保持顾客活跃度。",
                action_label="策划新活动",
                action_url="/dashboard/workbench",
                action_type="generate_activity",
                priority="medium",
            )
        )

    # 兜底：如果没有任何推荐（极端情况）
    if not recs:
        recs.append(
            DashboardRecommendation(
                id="default_generate",
                title="生成运营内容",
                description="前往 AI 生成页面，制作今日的运营内容。",
                action_label="去生成",
                action_url="/dashboard/workbench",
                action_type="generate_copywriting",
                priority="medium",
            )
        )

    return recs, greeting, tips


async def _get_last_good_generation(db: AsyncSession, store_id: uuid.UUID) -> Generation | None:
    """获取上次标记为"效果好"的生成记录。"""
    stmt = (
        select(Generation)
        .where(Generation.store_id == store_id, Generation.effect_rating == "good", Generation.is_deleted == False)
        .order_by(Generation.rated_at.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    return result.scalar_one_or_none()


async def _days_since_last_activity(db: AsyncSession, store_id: uuid.UUID) -> int | None:
    """计算距上次活动策划的天数。"""
    stmt = (
        select(Generation.created_at)
        .where(
            Generation.store_id == store_id,
            Generation.type == "activity",
            Generation.is_deleted == False,
        )
        .order_by(Generation.created_at.desc())
        .limit(1)
    )
    result = await db.execute(stmt)
    last_activity = result.scalar_one_or_none()
    if not last_activity:
        return None
    now = datetime.now(timezone.utc)
    delta = now - last_activity
    return delta.days


def _weekday_recs(label: str) -> list[DashboardRecommendation]:
    extra = "周一开工，" if label == "Monday" else ""
    return [
        DashboardRecommendation(
            id="weekday_moments",
            title="发一条朋友圈文案",
            description=f"{extra}工作日适合提醒附近顾客下班后来打几局。",
            action_label="去生成朋友圈",
            action_url="/dashboard/workbench",
            action_type="generate_copywriting",
            priority="high",
            suggested_payload={
                "sub_type": "moments",
                "tone": "friendly",
                "scenario": "daily",
                "extra_note": "工作日，下班后适合约朋友来打球",
            },
        ),
        DashboardRecommendation(
            id="weekday_group_notice",
            title="发一条微信群公告",
            description="在会员群发起约球接龙，活跃群氛围。",
            action_label="去生成群公告",
            action_url="/dashboard/workbench",
            action_type="generate_copywriting",
            priority="medium",
            suggested_payload={
                "sub_type": "group_notice",
                "scenario": "daily",
                "extra_note": "发起约球接龙",
            },
        ),
        DashboardRecommendation(
            id="weekday_activity",
            title="策划一个轻活动",
            description="下午场/晚场优惠，带动非高峰时段客流。",
            action_label="去生成活动",
            action_url="/dashboard/workbench",
            action_type="generate_activity",
            priority="medium",
            suggested_payload={
                "activity_goal": "traffic",
                "budget_level": "light",
                "extra_note": "下午场或晚场轻活动",
            },
        ),
    ]


def _friday_recs() -> list[DashboardRecommendation]:
    return [
        DashboardRecommendation(
            id="friday_moments",
            title="发一条周末预热朋友圈",
            description="周五是推周末活动的最佳时机，提醒顾客提前约局。",
            action_label="去生成朋友圈",
            action_url="/dashboard/workbench",
            action_type="generate_copywriting",
            priority="high",
            suggested_payload={
                "sub_type": "moments",
                "tone": "lively",
                "scenario": "evening",
                "extra_note": "周五，周末预热，吸引顾客约球",
            },
        ),
        DashboardRecommendation(
            id="friday_group_notice",
            title="发一条周末活动群公告",
            description="在微信群预告周末活动和优惠。",
            action_label="去生成群公告",
            action_url="/dashboard/workbench",
            action_type="generate_copywriting",
            priority="high",
            suggested_payload={
                "sub_type": "group_notice",
                "scenario": "daily",
                "extra_note": "预告周末活动",
            },
        ),
        DashboardRecommendation(
            id="friday_poster",
            title="生成一张周末宣传海报",
            description="用海报吸引眼球，周末活动效果更好。",
            action_label="去生成海报",
            action_url="/dashboard/posters",
            action_type="generate_poster",
            priority="high",
        ),
    ]


def _weekend_recs(weekday: str) -> list[DashboardRecommendation]:
    return [
        DashboardRecommendation(
            id="weekend_checkin",
            title="发一条今日到店提醒",
            description="提醒老顾客今天到店打球，带动周末客流。",
            action_label="去生成朋友圈",
            action_url="/dashboard/workbench",
            action_type="generate_copywriting",
            priority="high",
            suggested_payload={
                "sub_type": "moments",
                "tone": "lively",
                "scenario": "daily",
                "extra_note": f"{WEEKDAY_CN.get(weekday, '周末')}到店提醒",
            },
        ),
        DashboardRecommendation(
            id="weekend_poster",
            title="生成一张活动海报",
            description="周末比赛或活动宣传，用海报吸引客流。",
            action_label="去生成海报",
            action_url="/dashboard/posters",
            action_type="generate_poster",
            priority="high",
        ),
        DashboardRecommendation(
            id="weekend_member",
            title="发一条会员卡/储值活动文案",
            description="周末客流多，适合推广会员卡和储值活动。",
            action_label="去生成",
            action_url="/dashboard/workbench",
            action_type="generate_activity",
            priority="medium",
            suggested_payload={
                "activity_goal": "membership",
                "budget_level": "medium",
                "extra_note": "会员卡或储值活动推广",
            },
        ),
    ]
