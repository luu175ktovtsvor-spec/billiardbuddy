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
from services.content_service import _append_guardrails, generate_workbench, run_generation
from services.dashboard_service import get_today_dashboard
from services.diagnosis_service import analyze_diagnosis
from services.games_service import recommend_games as _recommend_games
from services.outreach_service import generate_outreach

logger = logging.getLogger(__name__)

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


# ---- 感知（只读） ------------------------------------------------------------

@tool(
    name="get_current_date",
    description="获取今天的日期（北京时间）和星期几。仅当用户直接问日期/星期，或你确实要据此判断时才调用；"
                "写具体运营内容（朋友圈/活动/海报等）时系统已自动注入当天日期，不必为此单独查。",
    parameters={"type": "object", "properties": {}},
)
async def get_current_date(args: dict, ctx) -> str:
    d = business_today()
    return f"今天是 {d.isoformat()}（{_WEEKDAYS[d.weekday()]}）"


@tool(
    name="get_today_recommendation",
    description="查这家店今天的运营推荐（综合日期/节日/门店画像/成长阶段算出来的）。"
                "仅当老板开口问『今天/这几天该做点啥』『有没有什么建议/主意』这类开放求建议时才调用；"
                "用户已经明确要做某件具体事（写文案/做海报/发平台/约客/诊断等）时，别调它，直接用对应工具。",
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
    description="给门店做一张活动/宣传海报（AI 生图）。当用户要『做张海报/出张图/弄个海报』时，"
                "把你构思好的海报画面描述填进 description，**直接调用本工具**。"
                "不用先用文字问用户『行不行』——系统会自动弹出确认卡片让他点，确认后才真正生成、才花钱。",
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


# ---- 平台定制内容(抖音/小红书/快手/视频号)：内容生成 + 复制 handoff，不自动发 ----
# 平台 prompt 只设"格式/调性"，行业知识/门店画像/合规由 run_generation 管道自动注入。

_PLATFORM_ALIAS = {
    "douyin": "douyin", "抖音": "douyin",
    "xiaohongshu": "xiaohongshu", "小红书": "xiaohongshu", "xhs": "xiaohongshu", "red": "xiaohongshu",
    "kuaishou": "kuaishou", "快手": "kuaishou",
    "shipinhao": "shipinhao", "视频号": "shipinhao", "channels": "shipinhao",
}

# 跨平台共享红线(台球行业真实大坑:网上爆款多打"美女助教/陪"擦边,我们反向走正路)
_PLATFORM_REDLINE = (
    "红线:绝不打「美女助教/陪练/陪玩」等擦边或暗示性卖点,也不写「终身免费/免费畅打」这类无底线让利;"
    "靠球技、氛围、社交、实惠这些正路。"
)

# 平台 prompt 已按真实做法校准(2026-06-17,据台球+同类休闲娱乐行业调研)
_PLATFORM_CONTENT_PROMPTS = {
    "douyin": "把需求写成一条**抖音短视频脚本**:\n"
              "· 开头 3 秒强钩子(从 悬念/揭秘/知识速递/反常识 里选一个,如「台球房老板绝不告诉你的省钱玩法」)\n"
              "· 正文按 3-5 个镜头写,每镜头一句口播 + 一个画面提示,短句有节奏、5 秒内必有信息增量\n"
              "· 突出 1 个核心卖点 + 结尾行动号召\n"
              "· 末尾 3-5 个话题标签,**必含 1 个城市/同城标签**(如 #本地台球 #同城探店)\n"
              "· 内容走 炫技高光/教学技巧/约球搭子/赛事/环境/优惠 这些正路,口语有网感",
    "xiaohongshu": "把需求写成一条**小红书笔记**:\n"
                   "· 标题 ≤20 字,从「数字+效果 / 人群+痛点 / 场景代入 / 揭秘对比」选一个套路,最好带数字\n"
                   "· 正文用 emoji 做段落分隔(清单用 1️⃣2️⃣3️⃣、对比用 ✅❌),像真人分享、真诚不硬广\n"
                   "· 角度优先:环境出片 / 女生友好 / 约会闺蜜局 / 约球搭子 / 新手不踩雷 / 探店\n"
                   "· 结尾引导互动(评论/收藏);末尾 5-8 个标签(品类+同城+场景+人群)",
    "kuaishou": "把需求写成一条**快手短视频脚本**:开头直接抛钩子;用词接地气、有「老铁/家人们」感;\n"
                "**突出真实可信**(真实客户、随时退/免预约的安心感)和实惠,不只是便宜;老板真人出镜唠嗑口吻;\n"
                "结尾喊话行动;末尾 3-5 个含同城的话题标签",
    "shipinhao": "把需求写成一条**微信视频号短视频脚本**:熟人/本地/正能量调性;\n"
                 "可用**本地对标**(同小区/同商圈的真实客户案例)+ 提示加门店地理位置标签;\n"
                 "标题清楚、口播自然亲切、突出门店特色和邻里感;结尾引导到店或**转发到朋友圈/群**",
}


@tool(
    name="make_platform_content",
    description="给指定平台写一条平台定制内容、交给用户复制去发：抖音短视频脚本 / 小红书笔记 / 快手 / 视频号。"
                "当用户要『发抖音 / 做个抖音视频 / 写条小红书 / 发笔记 / 发快手 / 发视频号』时调用。"
                "按各平台的格式和调性写好，用户复制后到对应 App 自己发（我们不替他自动发）。",
    parameters={
        "type": "object",
        "properties": {
            "platform": {"type": "string", "description": "目标平台：douyin(抖音) / xiaohongshu(小红书) / kuaishou(快手) / shipinhao(视频号)"},
            "need": {"type": "string", "description": "要发什么内容，原话即可，如'周末双人半价活动'"},
        },
        "required": ["platform", "need"],
    },
)
async def make_platform_content(args: dict, ctx) -> str:
    p = _PLATFORM_ALIAS.get((args.get("platform") or "").strip().lower(), (args.get("platform") or "").strip().lower())
    need = (args.get("need") or "").strip()
    instruction = _PLATFORM_CONTENT_PROMPTS.get(p)
    if not instruction or not need:
        return "告诉我发哪个平台(抖音/小红书/快手/视频号)和要发什么内容，我来写。"

    role = getattr(ctx.user, "my_role", None) or "manager"
    prompt = f"{instruction}\n{_PLATFORM_REDLINE}\n\n【要发的内容/需求】\n{need}"
    prompt = _append_guardrails(prompt, ctx.store, role=role, intent_text=need)
    gen = await run_generation(
        ctx.db, ctx.store, ctx.user,
        prompt=prompt,
        gen_type="platform_content",
        sub_type=p,
        input_params={"platform": p, "need": need},
        user_input=need,
        max_tokens=1500,
    )
    return gen.result


# ---- 团购套餐文案(美团/抖音来客)：内容生成 + 引导后台上架，不接服务商 API、不自动上架、不碰核销 ----

_GROUPBUY_PLATFORM = {
    "meituan": "meituan", "美团": "meituan", "点评": "meituan", "大众点评": "meituan",
    "douyin": "douyin", "抖音": "douyin", "抖音团购": "douyin", "抖音来客": "douyin",
}


@tool(
    name="make_groupbuy_content",
    description="给美团/抖音团购写一套可直接上架的团购套餐文案(套餐标题/卖点/包含内容/使用规则)+ 一条引流钩子。"
                "当用户要『做个团购 / 上个套餐 / 写团购 / 搞个引流低价』时调用。写好后引导老板去商家后台"
                "(美团开店宝 / 抖音来客)自己上架——我们不替他上架、不碰核销。",
    parameters={
        "type": "object",
        "properties": {
            "need": {"type": "string", "description": "想做什么团购，如'周末双人台费套餐''9.9 新人引流低价''4 人欢乐时光'"},
            "platform": {"type": "string", "description": "平台(可选)：meituan(美团) / douyin(抖音团购)"},
        },
        "required": ["need"],
    },
)
async def make_groupbuy_content(args: dict, ctx) -> str:
    need = (args.get("need") or "").strip()
    if not need:
        return "告诉我想做个什么团购(如'周末双人套餐''9.9 新人引流'),我来写。"
    platform = _GROUPBUY_PLATFORM.get((args.get("platform") or "").strip().lower(), "")
    plat_hint = {"douyin": "(发抖音来客)", "meituan": "(发美团)"}.get(platform, "")

    role = getattr(ctx.user, "my_role", None) or "manager"
    instruction = (
        f"把下面的需求写成一套**可直接上架**的台球房团购套餐文案{plat_hint}，包含：\n"
        "① 套餐标题(≤15 字、必带数字[时长/人数/价格感]、突出划算;可加时段标签如【工作日】【夜场】【欢乐时光闲时】)\n"
        "② 卖点(点名目标人群+场景:情侣约会/朋友开黑/家庭周末/新人尝鲜,说清为什么值)\n"
        "③ 包含内容(逐项列清单、缺项写「无」:台费时长 / 适用人数 / 是否含助教 / 饮品小食 / 赠品)\n"
        "④ 使用规则(有效期 / 适用时段[说清是「X 点前开台」还是「X 点前结束」] / 是否需预约 / 限几人用·不可拆分 / 超时按门市价补 / 不与其他优惠叠加 / 到店核销)\n"
        "最后附一条引流到这个团购的短视频或朋友圈钩子。要具体、能直接拿去后台上架;"
        "价格只用门店真实价格,没有就留占位让老板填,别自己编。"
    )
    if platform == "douyin":
        instruction += "\n抖音版:标题更要数字+紧迫感、卖点一句话能拍进视频;抖音核销率偏低,**结尾强化「尽快到店/提前预约留台」**。"
    elif platform == "meituan":
        instruction += "\n美团版:信息写全、强调体验口碑、打消顾虑(人找店、重决策复购)。"
    prompt = f"{instruction}\n\n【团购需求】\n{need}"
    prompt = _append_guardrails(prompt, ctx.store, role=role, intent_text=need)
    gen = await run_generation(
        ctx.db, ctx.store, ctx.user,
        prompt=prompt,
        gen_type="groupbuy",
        sub_type=platform or "general",
        input_params={"need": need, "platform": platform or "general"},
        user_input=need,
        max_tokens=2000,
    )
    return gen.result
