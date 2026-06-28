import uuid
from datetime import datetime, timezone, timedelta, date
from typing import NamedTuple
from urllib.parse import quote

from sqlalchemy import func, select, Integer
from sqlalchemy.ext.asyncio import AsyncSession
from borax.calendars.festivals2 import LunarFestival, SolarFestival

from core.timezone import BUSINESS_TZ
from models.generation import Generation
from models.store import Store
from schemas.dashboard import (
    DashboardSummary,
    DashboardRecommendation,
    DashboardTodayResponse,
)
from services.store_service import calculate_completeness
from services.behavior_service import BehaviorSnapshot, get_behavior_snapshot
from services.ai.prompt_engine import get_prompt_engine
from services.memory_service import Memory, load_store_memory

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
    snap = await get_behavior_snapshot(db, store.id)

    # 店脑：读这家店的长期记忆，让今日推荐"认得这家店"（主打学生/会员/助教…就顶相关建议）。
    # 直接喂全量记忆给 _memory_recs（它只做关键词子串匹配、不需要语义排序）：
    #   ① 省掉每次开 app 的"按 intent 重嵌入"——桌面只展示一条推荐，不值当为它跑嵌入（>15 条才触发）；
    #   ② 避免语义 cap(15) 把含关键词的记忆挤掉而漏判这家店的客群/打法（召回反而更全）。
    # 故障安全：读失败 → 空记忆，不影响其它推荐。
    memories: list[Memory] = []
    try:
        memories = await load_store_memory(db, store.id)
    except Exception:
        memories = []

    recommendations, greeting, tips = await _build_rules(
        db=db,
        store=store,
        completeness=completeness,
        today_count=today_count,
        total_count=total_count,
        weekday=weekday,
        snap=snap,
        memories=memories,
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


async def get_card_signals(db: AsyncSession, store: Store) -> dict:
    """工作台卡片动态排序用的行为信号（跨设备）：
    各 prompt_key 使用次数 + 标过"效果好"的 prompt_key + 门店成长阶段。"""
    snap = await get_behavior_snapshot(db, store.id)
    return {
        "prompt_key_counts": dict(snap.prompt_key_counts),
        "good_prompt_keys": list(snap.good_prompt_keys),
        "stage": _growth_stage(store, snap.recent_total),
    }


async def _get_generation_stats(
    db: AsyncSession,
    store_id: uuid.UUID,
    today_start: datetime,
    today_end: datetime,
) -> tuple[int, int, int, int, datetime | None]:
    """一次查询获取：总数、今日数、收藏数、效果好数、最新时间。

    Returns
    -------
    tuple[int, int, int, int, datetime | None]
        (total_count, today_count, favorite_count, good_count, latest_created_at)
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


# 节日营销日历——公历用 SolarFestival、农历(春节/端午/中秋)用 LunarFestival，
# 由 borax 每年自动换算公历日期(覆盖 1900-2100，不再硬编码、不会过期)。
# 每项：(borax节日对象, 名称, 提前提示天数, 海报视觉主题)。
# 海报主题=深链预填生图的 prompt：只描述氛围/色调/元素，不含中文文字(符合"不主动往生图prompt塞中文字"的规则)。
# 选定节日(用户确认)：传统农历 春节/端午/中秋 + 全民大假 元旦/劳动节/国庆 + 娱乐场所常做 情人节/圣诞。
_FESTIVAL_DEFS = [
    (LunarFestival(month=1, day=1), "春节", 15, "中式台球俱乐部室内场景，红金喜庆氛围，灯笼与中国结点缀，暖光，高端温馨"),
    (LunarFestival(month=5, day=5), "端午节", 10, "台球俱乐部室内场景，端午氛围，粽叶与艾草绿色点缀，清爽，传统节日感"),
    (LunarFestival(month=8, day=15), "中秋节", 10, "台球俱乐部室内场景，中秋氛围，圆月与暖黄灯光，团圆温馨，高端质感"),
    (SolarFestival(month=1, day=1), "元旦", 7, "台球俱乐部室内场景，跨年氛围，烟花与彩带点缀，蓝金色调，热闹喜庆"),
    (SolarFestival(month=2, day=14), "情人节", 7, "台球俱乐部室内场景，情人节氛围，玫瑰与暖粉色调，浪漫双人，温馨格调"),
    (SolarFestival(month=5, day=1), "劳动节", 10, "台球俱乐部室内场景，五一假期氛围，明亮活力，欢聚热闹，假日感"),
    (SolarFestival(month=10, day=1), "国庆节", 10, "台球俱乐部室内场景，国庆氛围，红色喜庆，节日热闹，假日聚会感"),
    (SolarFestival(month=12, day=25), "圣诞节", 7, "台球俱乐部室内场景，圣诞氛围，圣诞树与暖光，红绿色调，温馨派对感"),
]


class UpcomingFestival(NamedTuple):
    name: str
    days: int          # 距今天数（0 = 就是今天）
    poster_theme: str  # 海报视觉主题（深链预填生图）


def _upcoming_festival(now: datetime):
    """返回最近一个进入提示窗口的节日 UpcomingFestival；无则 None。
    农历日期由 borax 每年自动换算（1900-2100），不再硬编码、不会过期。"""
    today = now.date()
    best = None
    for fes, name, lead, theme in _FESTIVAL_DEFS:
        wd = fes.list_days(start_date=today, count=1)[0]  # 今天起的下一次该节日
        delta = (wd.solar - today).days
        if 0 <= delta <= lead and (best is None or delta < best.days):
            best = UpcomingFestival(name, delta, theme)
    return best


def _festival_recs(store: Store, now: datetime) -> list[DashboardRecommendation]:
    """节日临近的推荐：文案恒出 + 海报。
    海报走生图模型（花钱、占生成额度），故只在节日且用户主动点击时触发，绝不自动出图；
    且需 Logo/二维码才完整——有则直达生图、缺则引导先上传，不推一个用不了的功能。"""
    fest = _upcoming_festival(now)
    if not fest:
        return []
    when = "就是今天" if fest.days == 0 else f"还有 {fest.days} 天"
    recs = [
        DashboardRecommendation(
            id="festival",
            category="festival",
            title=f"{fest.name}{when}，提前备好节日文案",
            description=f"{fest.name}临近，提前生成节日朋友圈/活动，抢占客户注意力。",
            action_url="/dashboard/workbench",
            priority="high",
            suggested_payload={
                "prompt_key": "copywriting.moments",
                "user_intent": f"写一条{fest.name}主题的朋友圈，结合门店活动和氛围",
            },
        )
    ]
    has_assets = bool(getattr(store, "logo_url", None)) and bool(getattr(store, "qrcode_url", None))
    if has_assets:
        recs.append(
            DashboardRecommendation(
                id="festival_poster",
                category="festival",
                title=f"做一张{fest.name}海报",
                description=f"{fest.name}临近，生成一张节日海报，自动带上门店 Logo 和二维码。",
                action_url=f"/dashboard/posters/new?prompt={quote(fest.poster_theme)}",
                priority="high",
            )
        )
    else:
        recs.append(
            DashboardRecommendation(
                id="festival_poster_setup",
                category="festival",
                title=f"补个 Logo，{fest.name}海报一键出",
                description="上传门店 Logo 和二维码后，就能生成带品牌的节日海报。",
                action_url="/dashboard/store-settings/branding",
                priority="high",
            )
        )
    return recs


def _profile_flag(store: Store, *path: str) -> bool:
    """安全读取 operation_profile 里的布尔标志（路径不存在则 False）。"""
    cur = store.operation_profile if isinstance(store.operation_profile, dict) else {}
    for key in path:
        if not isinstance(cur, dict):
            return False
        cur = cur.get(key)
    return bool(cur)


def _daily_focus(store: Store, weekday: str) -> tuple[str, str, str] | None:
    """按星期 + 门店画像给出"今天最该做的一条内容"(标题, 描述, 生成意图)。
    画像里没有的能力(助教/周赛/社群)不推，保证每家店看到的都贴合自己。
    这并入了原"内容日历"的按星期内容价值，但改成动态、按画像过滤。"""
    has_assistant = _profile_flag(store, "assistant_system", "has_assistant") or bool(store.has_coaching)
    has_weekly = _profile_flag(store, "events", "has_weekly_match")
    has_group = (
        _profile_flag(store, "private_domain_groups", "member_group", "enabled")
        or _profile_flag(store, "private_domain_groups", "competition_group", "enabled")
    )
    if weekday == "Monday":
        return ("发条朋友圈激励老客回归", "新的一周，提醒老顾客本周来打几局。", "写一条新的一周激励老客户回归的朋友圈")
    if weekday == "Tuesday":
        if has_assistant:
            return ("推一波助教服务", "发助教到店推广，带动上钟转化。", "写一条助教到店推广的内容")
        return ("撮合散客组局", "发条搭子局通知，把散客约起来。", "写一条搭子局组局通知")
    if weekday == "Wednesday":
        if has_group:
            return ("维护一下社群", "群里发条约球/约局内容保持活跃。", "写一条会员群约球的群公告")
        return ("发条工作日朋友圈", "提醒附近顾客下班后来放松一局。", "写一条工作日下班后约球的朋友圈")
    if weekday == "Thursday":
        if has_weekly:
            return ("预热周末周赛", "提前放出周赛信息，攒报名人数。", "写一条周末周赛预热通知")
        return ("回访沉睡老客", "联系半个月没来的老客户，发条关怀。", "写一条联系半个月没来的老客户的私聊话术")
    if weekday == "Friday":
        return ("发周末预热内容", "周五是推周末活动的最佳时机，提醒提前约局。", "写一条周末预热朋友圈")
    if weekday in ("Saturday", "Sunday"):
        if has_weekly:
            return ("发到店提醒 + 赛后战报", "周末客流高峰，提醒到店并发周赛战报。", "写一条周末到店提醒朋友圈")
        return ("发周末到店提醒", "提醒老顾客今天到店打球，带动客流。", "写一条周末到店提醒朋友圈")
    return None


def _frequency_rec(snap: BehaviorSnapshot) -> DashboardRecommendation | None:
    """你常用：把最高频的任务卡顶出来一键再做（L4：优先顶"既常做又标过效果好"的）。
    取代原前端"常用任务"板块——改服务端统计，跨设备、按真实生成次数。"""
    pk = snap.top_prompt_key(min_count=2, prefer_good=True)
    if not pk:
        return None
    name = get_prompt_engine().template_name(pk) or "你常用的内容"
    is_good = pk in snap.good_prompt_keys
    return DashboardRecommendation(
        id="frequent",
        category="frequent",
        title=f"再做一次「{name}」" + ("（你标过效果好）" if is_good else ""),
        description="你常做、还标过效果好，再来一条。" if is_good else "这是你最近最常做的，一键打开继续。",
        action_url="/dashboard/workbench",
        priority="medium",
        suggested_payload={"prompt_key": pk},
    )


def _gap_recs(snap: BehaviorSnapshot) -> list[DashboardRecommendation]:
    """补缺口/深度：揪出"只做某几样"的单一化，按使用深度推没碰过的能力，避免越用越窄。"""
    recs: list[DashboardRecommendation] = []
    n = snap.recent_total
    if n < 3:
        return recs  # 用得太少，先别催着补，免得打扰新用户
    # L4 启发式：用了很多还从没碰某个"习惯类"能力 → 判定有意不做，停止唠叨
    nag_variety = n <= 15
    did_group = snap.sub_type_counts.get("group_notice", 0) > 0 or any(
        "group" in pk for pk in snap.prompt_key_counts
    )
    if not did_group and nag_variety:
        recs.append(DashboardRecommendation(
            id="gap_group", category="gap",
            title="顺手发条群公告", description="最近都在发朋友圈，群里也热乎下，约球接龙更直接。",
            action_url="/dashboard/workbench",
            priority="medium",
            suggested_payload={"prompt_key": "copywriting.group_notice", "user_intent": "写一条会员群约球的群公告"},
        ))
    made_text = snap.sub_type_counts.get("moments", 0) > 0 or snap.type_counts.get("copywriting", 0) > 0
    if made_text and snap.type_counts.get("poster", 0) == 0 and nag_variety:
        recs.append(DashboardRecommendation(
            id="gap_poster", category="gap",
            title="给文案配张海报", description="你最近发了文案还没配过海报——图文一起发，转化更好。",
            action_url="/dashboard/posters",
            priority="medium",
        ))
    if n >= 5 and snap.type_counts.get("activity", 0) == 0:
        recs.append(DashboardRecommendation(
            id="gap_activity", category="gap",
            title="该策划个活动了", description="光发内容不够，办场活动能直接带客流。",
            action_url="/dashboard/workbench",
            priority="medium",
            suggested_payload={"activity_goal": "traffic", "budget_level": "light"},
        ))
    if n >= 8 and snap.type_counts.get("diagnosis", 0) == 0:
        recs.append(DashboardRecommendation(
            id="gap_diagnosis", category="gap",
            title="让 AI 给你做次经营诊断", description="你已经很活跃了，试试更深的——看哪块还能再提升。",
            action_url="/dashboard/workbench",
            priority="medium",
            suggested_payload={"prompt_key": "operation.diagnosis_tool", "user_intent": "帮我诊断一下门店经营，哪里能提升"},
        ))
    return recs[:2]  # 最多 2 条，别刷屏


def _rec(rid: str, category: str, title: str, desc: str, *,
         action_url: str = "/dashboard/workbench",
         priority: str = "high", prompt_key: str | None = None,
         intent: str | None = None, payload: dict | None = None) -> DashboardRecommendation:
    """简洁构造一条推荐（给阶段/缺口等新规则用，省掉重复样板）。
    action_url 保留：主动出击(proactive.py)用它把"海报/生图类"推荐挑出来跳过（只备文字草稿）。"""
    sp: dict = dict(payload) if payload else {}
    if prompt_key:
        sp["prompt_key"] = prompt_key
    if intent:
        sp["user_intent"] = intent
    return DashboardRecommendation(
        id=rid, category=category, title=title, description=desc,
        action_url=action_url, priority=priority, suggested_payload=sp or None,
    )


def _growth_stage(store: Store, total_count: int) -> str:
    """门店成长阶段：preopen 筹备 | newopen 新店 | ramp 爬坡 | mature 成熟 | "" 未知(走现状)。
    优先用"开业阶段"字段，没填则用累计产出量兜底——没填且用得久当成熟店推深度。"""
    profile = store.operation_profile if isinstance(store.operation_profile, dict) else {}
    basic = profile.get("basic") if isinstance(profile.get("basic"), dict) else {}
    opening = basic.get("opening_days", "") if isinstance(basic, dict) else ""
    mapping = {"not_opened": "preopen", "within_30": "newopen", "30_90": "ramp", "over_90": "mature"}
    if opening in mapping:
        return mapping[opening]
    if total_count >= 40:
        return "mature"
    return ""


def _stage_recs(stage: str) -> list[DashboardRecommendation]:
    """阶段重点：筹备/新店推冷启动，成熟店推深度复购。"""
    if stage == "preopen":
        return [
            _rec("stage_preopen_invite", "stage", "邀约储备客户到店",
                 "开业前 7 天最关键——把攒的客户一个个约到店，开业当天就有人气。",
                 intent="写一条邀约储备客户来新店体验的私聊话术"),
            _rec("stage_preopen_warmup", "stage", "做开业预热内容",
                 "开业前发预热朋友圈/海报，把声势造起来。",
                 prompt_key="copywriting.moments", intent="写一条新店开业预热朋友圈"),
        ]
    if stage == "newopen":
        return [
            _rec("stage_newopen_group", "stage", "把到店客户拉进群",
                 "新店蜜月期，趁热把第一批客户沉淀到私域，别让他们只来一次。",
                 prompt_key="copywriting.group_notice", intent="写一条邀请新客进群的话术"),
        ]
    if stage == "mature":
        return [
            _rec("stage_mature_recall", "stage", "唤醒一批沉睡老客",
                 "成熟店增长靠复购——挑一批好久没来的老客，发条召回。",
                 priority="medium",
                 prompt_key="operation.old_customer_recall", intent="写一条召回沉睡老客户的私聊话术"),
        ]
    return []


def _dynamic_tips(snap: BehaviorSnapshot) -> list[str]:
    """基于行为快照生成"AI 在学你"的实时反馈，替代写死的提示。"""
    tips: list[str] = []
    if snap.recent_total == 0:
        return tips
    moments = snap.sub_type_counts.get("moments", 0)
    if moments >= 3 and snap.type_counts.get("activity", 0) == 0:
        tips.append(f"这阵子你发了 {moments} 条朋友圈，还没做过活动方案——办场活动更能直接带客流。")
    if snap.good_prompt_keys:
        name = get_prompt_engine().template_name(next(iter(snap.good_prompt_keys))) or "你常做的内容"
        tips.append(f"你标过「{name}」效果好，AI 正在往这个风格学。")
    return tips


# 店脑→今日推荐的"店情专属"映射：记忆里命中某类客群/打法 → 顶一条最贴这家店的建议。
# 轻量关键词匹配（不调模型、不建表）：每项 (命中词组, rec 构造参数)。命中即生成一条 category="store" 的高优先推荐。
# 顺序即优先级——靠前的更具体（学生/会员 > 泛化）；只取第一条命中，避免刷屏。
_MEMORY_REC_RULES: list[tuple[tuple[str, ...], dict]] = [
    (("学生", "大学生", "高校", "学校"),
     {"id": "store_student", "title": "给学生客群来一条",
      "desc": "记得你家主打学生——发条戳学生的内容（拼场便宜、组队开黑），把这拨人约起来。",
      "intent": "写一条面向学生客群的朋友圈，突出学生拼场优惠和组队氛围"}),
    (("会员", "储值", "充值卡", "一卡通", "锁客"),
     {"id": "store_member", "title": "盘一盘会员/储值",
      "desc": "你家重会员运营——发条储值/会员权益提醒，把老客的复购攥住。",
      "intent": "写一条会员储值权益提醒，突出复购和锁客，赠送仅限台费、力度合理"}),
    (("助教", "教练", "陪打", "上钟"),
     {"id": "store_assistant", "title": "推一波助教/陪打",
      "desc": "你家有助教服务——发条助教到店、陪打体验的内容，带动上钟转化。",
      "intent": "写一条助教到店陪打推广内容，带职业分寸、不写性暗示"}),
    (("亲子", "家庭", "儿童", "小孩"),
     {"id": "store_family", "title": "招呼一下亲子家庭",
      "desc": "你家做亲子/家庭客——发条周末家庭时光的内容，把这类客人请进来。",
      "intent": "写一条面向亲子家庭客群的周末到店朋友圈"}),
    (("比赛", "赛事", "周赛", "排位"),
     {"id": "store_match", "title": "预热一下赛事",
      "desc": "你家常办比赛——提前放出赛事/排位信息，攒报名、聚人气。",
      "intent": "写一条门店赛事预热通知，攒报名人数（正规赛事·报名费做奖池）"}),
]


def _memory_recs(memories: list[Memory]) -> list[DashboardRecommendation]:
    """店脑→"店情专属"推荐：从记忆内容里识别这家店的客群/打法，顶一条最贴它的建议（最多一条，不刷屏）。
    轻量关键词匹配，不调模型、不建表；无相关记忆或无命中则返回空（不打扰）。"""
    if not memories:
        return []
    blob = " ".join((m.content or "") for m in memories)
    for keywords, spec in _MEMORY_REC_RULES:
        if any(k in blob for k in keywords):
            return [
                _rec(spec["id"], "store", spec["title"], spec["desc"],
                     intent=spec["intent"]),
            ]
    return []


async def _report_written_today(db: AsyncSession, store_id, now: datetime) -> bool:
    """今天是否已提交过日报（按 input_params['date'] 比，避开时区双基准坑）。"""
    today = now.strftime("%Y-%m-%d")
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.type == "report",
            Generation.is_deleted == False,  # noqa: E712
        )
        .order_by(Generation.created_at.desc())
        .limit(10)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return any(str((r.input_params or {}).get("date", "")) == today for r in rows)


async def _build_rules(
    db: AsyncSession,
    store: Store,
    completeness: int,
    today_count: int,
    total_count: int,
    weekday: str,
    snap: BehaviorSnapshot,
    memories: list[Memory] | None = None,
) -> tuple[list[DashboardRecommendation], str, list[str]]:
    recs: list[DashboardRecommendation] = []
    tips: list[str] = []

    # Rule 0.0: 店情专属——读店脑长期记忆，识别这家店的客群/打法，顶一条最贴它的建议（让推荐认得这家店）。
    recs.extend(_memory_recs(memories or []))

    # Rule 0: 节日临近——文案恒出 + 海报(按 Logo 门控)。时效性强，是"今日工作台"实时感的来源。
    recs.extend(_festival_recs(store, datetime.now(BUSINESS_TZ)))

    # Rule 0.4: 成长阶段——筹备/新店推冷启动，成熟店推深度（阶段重点）
    stage = _growth_stage(store, total_count)
    recs.extend(_stage_recs(stage))

    # Rule 0.5: 今日运营重点——按星期 + 门店画像给一条最贴合的内容
    # （并入原"内容日历"的按星期价值，但改为动态、按画像过滤；筹备店还没开业不推到店类）
    focus = _daily_focus(store, weekday)
    if focus and stage != "preopen":
        f_title, f_desc, f_intent = focus
        recs.append(
            DashboardRecommendation(
                id="daily_focus",
                category="focus",
                title=f_title,
                description=f_desc,
                action_url="/dashboard/workbench",
                priority="high",
                suggested_payload={
                    "prompt_key": "copywriting.moments",
                    "user_intent": f_intent,
                },
            )
        )

    # Rule 0.55: 今天还没写日报就提醒（非筹备店）—— 直接在对话里写,别指向已删的报告页/Excel 导出(那是空承诺)。
    # description 点"帮我写"时作为用户 prompt 发给 agent,agent 真能写总结 → 真能接的指令,不是假提醒。
    if stage != "preopen" and not await _report_written_today(db, store.id, datetime.now(BUSINESS_TZ)):
        recs.append(
            DashboardRecommendation(
                id="report_due",
                category="report",
                title="今天的日报还没写",
                description="帮我写一条今天的日报小结，来客、台费、活动我报给你。",
                action_url="/dashboard/chat",
                priority="high",
            )
        )

    # Rule 0.6: 行为信号——"你常用" + "补缺口"（实时跟进，越用越懂你）
    freq = _frequency_rec(snap)
    if freq:
        recs.append(freq)
    recs.extend(_gap_recs(snap))

    # Rule 1: 资料不完整优先提醒
    if completeness < 70:
        recs.append(
            DashboardRecommendation(
                id="incomplete_profile",
                category="setup",
                title="完善门店资料",
                description="门店资料越完整，AI 生成的文案和海报越准确。",
                action_url="/dashboard/store-settings",
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
                category="setup",
                title=f"上传{'和'.join(missing_parts)}",
                description="上传 Logo 和二维码后，生成海报会自动带上门店品牌和联系方式。",
                action_url="/dashboard/store-settings",
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
                action_url="/dashboard/workbench",
                priority="high",
                suggested_payload={
                    "sub_type": "moments",
                    "tone": "friendly",
                    "scenario": "daily",
                },
            )
        )

    # Rules 3/4/5: 星期推荐（筹备店还没开业 → 只给冷启动问候，不推"提醒到店"类）
    if stage == "preopen":
        greeting = "开业冲刺期，先把人攒起来、把声势造出来！"
    elif weekday == "Friday":
        greeting = "周五到了，适合做一波周末客流预热！"
        recs.extend(_friday_recs())
        recs.append(
            DashboardRecommendation(
                id="friday_operation",
                title="运营场景：周末赛事/搭子局预热",
                description="用经营场景一键生成周末赛事报名通知和搭子局邀约。",
                action_url="/dashboard/workbench",
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

    # Rule 7: 行为驱动的动态 tips（"AI 在学你"），替代写死的固定提示
    tips.extend(_dynamic_tips(snap))
    if today_count >= 5:
        tips.append("今天已生成了多条内容，可以优先挑选最合适的一条发布。")
    tips = tips[:3]  # 最多 3 条，别刷屏

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
                category="good",
                title=f"上次的{type_label}效果不错，再来一条？",
                description="基于上次效果好的内容，生成类似的。",
                action_url="/dashboard/workbench",
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
                category="gap",
                title="距上次活动已超过一周",
                description="定期做活动能保持顾客活跃度。",
                action_url="/dashboard/workbench",
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
                action_url="/dashboard/workbench",
                priority="medium",
            )
        )

    # 隐式反馈闭环：老板点过去做的推荐(source_rec_id)上浮，长期显示没动的下沉。
    recs = _rerank_by_adoption(recs, snap)

    return recs, greeting, tips


# 推荐排序优先级底分：先按业务优先级（high>medium>low），再在同档内按"被采纳"上浮。
_PRIORITY_SCORE = {"high": 100, "medium": 50, "low": 0}


def _rerank_by_adoption(
    recs: list[DashboardRecommendation], snap: BehaviorSnapshot
) -> list[DashboardRecommendation]:
    """隐式反馈排序：在不打乱"业务优先级"大盘的前提下，按隐式信号微调同档内顺序——
    老板点过去做的推荐(被采纳)上浮、长期一直显示却从没点的下沉。

    设计取舍：只在 priority 分档内重排（high 永远在 medium 前），避免一条低优先但常被点的把
    "完善资料/节日"这种刚需挤到后面。采纳次数封顶 +9，跳过(显示多次从没采纳)扣分但不致负出大档。
    稳定排序保留同分原有先后（既有规则的精心排序不被打乱）。"""
    if not snap.adopted_rec_ids and snap.recent_total < 8:
        return recs  # 还没攒到信号（没人点过推荐、用得也少）→ 不动，省得早期瞎排

    def score(idx_rec: tuple[int, DashboardRecommendation]) -> tuple[int, int]:
        idx, r = idx_rec
        base = _PRIORITY_SCORE.get(r.priority, 50)
        adopted = snap.adoption_rank(r.id)
        if adopted > 0:
            base += min(adopted * 3, 9)  # 采纳上浮（封顶，避免单条霸榜）
        elif snap.recent_total >= 12 and r.id not in snap.adopted_rec_ids:
            base -= 5  # 用得久了还从没点过这条 → 轻微下沉（仍留在档内，不消失）
        return (base, -idx)  # -idx：同分稳定保留原始先后

    ranked = sorted(enumerate(recs), key=score, reverse=True)
    return [r for _, r in ranked]


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
            action_url="/dashboard/workbench",
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
            action_url="/dashboard/workbench",
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
            action_url="/dashboard/workbench",
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
            action_url="/dashboard/workbench",
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
            action_url="/dashboard/workbench",
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
            action_url="/dashboard/posters",
            priority="high",
        ),
    ]


def _weekend_recs(weekday: str) -> list[DashboardRecommendation]:
    return [
        DashboardRecommendation(
            id="weekend_checkin",
            title="发一条今日到店提醒",
            description="提醒老顾客今天到店打球，带动周末客流。",
            action_url="/dashboard/workbench",
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
            action_url="/dashboard/posters",
            priority="high",
        ),
        DashboardRecommendation(
            id="weekend_member",
            title="发一条储值/一卡通活动文案",
            description="周末客流多，适合推广储值/一卡通锁客。",
            action_url="/dashboard/workbench",
            priority="medium",
            suggested_payload={
                "activity_goal": "membership",
                "budget_level": "medium",
                "extra_note": "储值/一卡通活动推广（小比例赠送，赠送仅限台费）",
            },
        ),
    ]
