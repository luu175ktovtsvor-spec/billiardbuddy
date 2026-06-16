"""内置 Agent 工具：把现有运营能力暴露给 Agent 调用。

导入本模块即把工具登记进 default_registry。
- 感知类（只读）：查日期、查今日推荐
- 生成类（走现有管道，自带配额/落库/店脑/合规过滤）：写运营内容、助教约客、经营诊断、玩法推荐

⚠️ 门店画像 + 店脑记忆由 agent 端点注入 system prompt（见 api/v1/agent.py），始终在上下文里，
   故不再做成单独工具（避免 agent 多绕一轮去"查"它本就知道的东西）。
"""
import logging

from core.timezone import business_today
from services.agent.registry import tool
from services.content_service import generate_workbench
from services.dashboard_service import get_today_dashboard
from services.diagnosis_service import analyze_diagnosis
from services.games_service import recommend_games as _recommend_games
from services.outreach_service import generate_outreach

logger = logging.getLogger(__name__)

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


# ---- 感知（只读） ------------------------------------------------------------

@tool(
    name="get_current_date",
    description="获取今天的日期（北京时间）和星期几。当需要判断'今天/今晚/本周末/几号/是工作日还是周末'时调用。",
    parameters={"type": "object", "properties": {}},
)
async def get_current_date(args: dict, ctx) -> str:
    d = business_today()
    return f"今天是 {d.isoformat()}（{_WEEKDAYS[d.weekday()]}）"


@tool(
    name="get_today_recommendation",
    description="查这家店今天的运营推荐（综合日期/节日/门店画像/成长阶段算出来的）。"
                "当老板问'今天/这几天该做点啥''有什么建议'，或你需要结合门店当下情况给主意时调用。",
    parameters={"type": "object", "properties": {}},
)
async def get_today_recommendation(args: dict, ctx) -> str:
    resp = await get_today_dashboard(ctx.db, ctx.store)
    lines = [f"今天{resp.weekday}。{resp.greeting}"]
    for r in resp.recommendations:
        lines.append(f"- [{r.category}] {r.title}：{r.description}")
    if resp.tips:
        lines.append("提示：" + "；".join(resp.tips))
    return "\n".join(lines)


# ---- 生成（走现有管道，自带配额/落库/店脑/合规过滤） ----------------------------

@tool(
    name="write_operation_content",
    description="按老板的一句话需求，写一段台球房运营内容（朋友圈/群公告/活动文案/日报叙事等通用文字）。"
                "这是最常用的写文案工具，会自动带上门店画像、岗位规则、行业知识。需要写任何运营文字时优先用它。",
    parameters={
        "type": "object",
        "properties": {
            "need": {"type": "string", "description": "用户想写什么，原话即可，如'写条周末双人优惠的朋友圈'"},
            "customer_type": {"type": "string", "description": "面向哪类客户(可选)：new/old/vip/competition/groupbuy/all"},
            "outputs": {"type": "array", "items": {"type": "string"},
                        "description": "想要的内容形式(可选)：moments(朋友圈)/group_notice(群公告)/private_chat(私聊)/poster_copy(海报文案)"},
            "note": {"type": "string", "description": "补充说明(可选)"},
        },
        "required": ["need"],
    },
)
async def write_operation_content(args: dict, ctx) -> str:
    role = getattr(ctx.user, "my_role", None) or "manager"
    gen = await generate_workbench(
        ctx.db, ctx.store, ctx.user,
        user_intent=args["need"],
        role=role,
        target_customer_type=args.get("customer_type"),
        output_package=args.get("outputs"),
        extra_note=args.get("note", "") or "",
        concise=True,
    )
    return gen.result


@tool(
    name="assistant_outreach",
    description="生成助教/前台主动联系某位客户的约客话术。当需要'给某个客户发消息约他来打球/邀约/维护'时调用。",
    parameters={
        "type": "object",
        "properties": {
            "customer_name": {"type": "string", "description": "客户称呼"},
            "customer_type": {"type": "string", "description": "客户类型(可选)：new/old/vip/groupbuy/competition/assistant"},
            "relationship": {"type": "string", "description": "和客户的关系(可选)，如'熟客''只来过一次'"},
            "style": {"type": "string", "description": "语气(可选)：friendly/professional/lively/warm"},
            "note": {"type": "string", "description": "补充(可选)，如最近有什么活动可提"},
        },
        "required": ["customer_name"],
    },
)
async def assistant_outreach(args: dict, ctx) -> str:
    gen = await generate_outreach(
        ctx.db, ctx.store, ctx.user,
        customer_name=args["customer_name"],
        customer_type=args.get("customer_type", "old"),
        relationship=args.get("relationship", "熟客"),
        style=args.get("style", "friendly"),
        extra_note=args.get("note", "") or "",
    )
    return gen.result


@tool(
    name="diagnose_operation",
    description="针对经营问题给诊断和改进建议。当老板描述'生意冷清/营业额上不去/客户流失/员工问题/活动没效果'等经营困扰时调用。",
    parameters={
        "type": "object",
        "properties": {
            "situation": {"type": "string", "description": "老板描述的现状/困扰，原话即可"},
            "problem_area": {"type": "string",
                             "description": "问题领域(可选)：traffic/revenue/customer_loss/staff/competition/activity_effect"},
        },
        "required": ["situation"],
    },
)
async def diagnose_operation(args: dict, ctx) -> str:
    gen = await analyze_diagnosis(
        ctx.db, ctx.store, ctx.user,
        problem_area=args.get("problem_area", "revenue"),
        current_situation=args["situation"],
    )
    return gen.result


@tool(
    name="recommend_games",
    description="根据人数/水平/时长推荐台球小游戏玩法。当需要'搞点互动游戏/活动玩法/暖场点子'时调用。",
    parameters={
        "type": "object",
        "properties": {
            "count": {"type": "integer", "description": "参与人数"},
            "skill_level": {"type": "string", "description": "水平(可选)：beginner/intermediate/advanced/mixed"},
            "time": {"type": "string", "description": "可用时长(可选)，如'30分钟'"},
        },
        "required": ["count"],
    },
)
async def recommend_games(args: dict, ctx) -> str:
    gen = await _recommend_games(
        ctx.db, ctx.store, ctx.user,
        customer_count=int(args.get("count", 4)),
        skill_level=args.get("skill_level", "mixed"),
        time_available=args.get("time", "30分钟"),
    )
    return gen.result


# ---- 受审批工具（花钱/对外，requires_approval=True，循环里不执行，确认后经 /agent/execute 跑） ----

# 每用户同一时刻只允许一张 agent 生图在跑（护住 OpenAI 每分钟出图限额 + 防误触多次扣费）。
# 进程内即可：真正的全局并发由 poster_service 的信号量兜底；这里只防同一用户连点。
_POSTER_GENERATING: set[str] = set()


@tool(
    name="make_poster",
    description="给门店做一张活动/宣传海报（AI 生图）。当用户要『做张海报/出张图/弄个海报』时调用。"
                "⚠️ 生图要花钱：这个工具会先把方案讲给用户、等他确认后才真正生成，不会自动出图。",
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "海报要画成什么样的完整描述（主题/风格/元素/氛围/想突出的卖点），越具体越好"},
            "ratio": {"type": "string", "description": "比例(可选)：1:1 / 3:4 / 9:16 / 16:9，默认 1:1"},
        },
        "required": ["description"],
    },
    requires_approval=True,
)
async def make_poster(args: dict, ctx) -> str:
    """确认后才会被调用（经 /agent/execute）。沿用 poster_service 的配额/并发/计费护栏，
    额外补『每用户单张在跑』锁 + 强制 count=1 + 质量固定 medium（成本可控）。"""
    from services import poster_service  # 延迟导入，避免 import 期重负载/循环依赖

    desc = (args.get("description") or "").strip()
    if not desc:
        return "缺少海报描述，没法生成。"

    uid = str(getattr(ctx.user, "id", "") or "")
    if uid and uid in _POSTER_GENERATING:
        return "你上一张海报还在生成中，等它出完再来下一张～"
    if uid:
        _POSTER_GENERATING.add(uid)
    try:
        result = await poster_service.generate_images(
            db=ctx.db,
            store=ctx.store,
            user_id=ctx.user.id,
            prompt=desc,
            image_model="gpt-image-2",
            ratio=args.get("ratio", "1:1"),
            quality="medium",  # 固定 medium：high 贵 30-40 倍，agent 默认走性价比；要高清去生图页
            count=1,            # 一次只出 1 张，护 IPM
            image_prompt=desc,
            background_mode="ai_generate",
        )
    finally:
        if uid:
            _POSTER_GENERATING.discard(uid)

    images = result.get("images") or []
    if not images:
        return "海报这次没生成出来，稍后再试一下。"
    first = images[0]
    url = first.get("poster_url") if isinstance(first, dict) else getattr(first, "poster_url", None)
    if not url:
        return "海报已生成（但没拿到图片链接，去生成历史看看）。"
    # 返回 markdown 图片：前端用现成 ReactMarkdown 直接渲染出图
    return f"做好啦！👇\n\n![门店海报]({url})"
