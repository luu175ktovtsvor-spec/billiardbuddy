"""内置 Agent 工具：把现有运营能力暴露给 Agent 调用。

导入本模块即把工具登记进 default_registry。
- 感知类（只读）：查日期、查今日推荐
- 生成类（走现有管道，自带配额/落库/店脑/合规过滤）：写运营内容、助教约客、经营诊断、玩法推荐

⚠️ 门店画像 + 店脑记忆由 agent 端点注入 system prompt（见 api/v1/agent.py），始终在上下文里，
   故不再做成单独工具（避免 agent 多绕一轮去"查"它本就知道的东西）。
"""
import logging

from core.timezone import business_today
from services.agent.registry import default_registry, tool
from services.agent.poster_styles import resolve_style_prompt, style_labels_hint
from services.agent.scenario_catalog import format_catalog_for_model, get_catalog, pick_best_prompt_key
from services.content_service import (
    _append_guardrails,
    generate_activity,
    generate_workbench,
    rank_knowledge_for_topic,
    run_generation,
)
from services.dashboard_service import get_today_dashboard
from services.diagnosis_service import analyze_diagnosis
from services.games_service import recommend_games as _recommend_games
from services.outreach_service import generate_outreach

logger = logging.getLogger(__name__)

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 交付类工具（成品）= 在各 @tool 上标 deliverable=True；本模块底部据注册表自动汇总成 DELIVERABLE_TOOLS。
# 落库时把成品并进会话 result，才能①历史里看到真内容 ②下一轮"把刚才那条改一下"大脑读得到自己上轮写了啥。
# 感知类(查日期/今日推荐/找场景/查知识) 不标 deliverable。make_poster 已是 deliverable(成品卡显示海报)。
# ⚠️ 单一来源即工具自身的 deliverable 标记——不再手抄白名单（旧手抄常量漏登 write_batch 致批量产出不落库）。
#    前端 chat/page.tsx 另有一份同名常量（跨代码库无法共享）——加新成品工具时记得同步那边。


# ---- 感知（只读） ------------------------------------------------------------

@tool(
    name="get_current_date",
    read_only=True,
    description="获取今天的日期（北京时间）和星期几。仅当用户直接问日期/星期，或你确实要据此判断时才调用；"
                "写具体运营内容（朋友圈/活动/海报等）时系统已自动注入当天日期，不必为此单独查。",
    parameters={"type": "object", "properties": {}},
)
async def get_current_date(args: dict, ctx) -> str:
    d = business_today()
    return f"今天是 {d.isoformat()}（{_WEEKDAYS[d.weekday()]}）"


@tool(
    name="get_today_recommendation",
    read_only=True,
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
    name="find_scenario",
    read_only=True,
    description="查台球房有没有现成的『精修场景模板』可用。当老板要写某个具体运营场景的内容"
                "（如强一比赛主持/赛事报名/助教推广/团购转私域/老客回流/开业活动/投诉应对/学生优惠局…）时，"
                "**先调我**列出可用模板，挑一个最贴切的，再把它的 key 作为 write_operation_content 的 prompt_key 写——"
                "比从零写效果好得多（这些模板是按行业真实做法校准过的）。需求很普通、清单里没贴切的，就别用、直接写。",
    parameters={
        "type": "object",
        "properties": {
            "need": {"type": "string", "description": "老板想写的内容/场景，原话即可，用于把相关模板排前面"},
        },
        "required": ["need"],
    },
)
async def find_scenario(args: dict, ctx) -> str:
    return format_catalog_for_model(args.get("need", "") or "")


@tool(
    name="look_up_knowledge",
    read_only=True,
    description="查台球行业知识库（55 条真实运营知识：获客/客户运营/助教/店长/数据诊断/红线合规…）。"
                "**拿不准某个运营做法该不该做、是不是踩红线、有没有更专业的打法时，用它查行业知识再判断**——"
                "比凭空想靠谱。给个 topic（你拿不准的那件事，原话即可），返回最相关的几条知识的"
                "名字 + 一句索引（不是整篇正文，省 token）；要据某条深入写内容时，对应场景模板走 find_scenario。",
    parameters={
        "type": "object",
        "properties": {
            "topic": {"type": "string",
                      "description": "你拿不准/想查证的运营做法或话题，原话即可，如'助教能不能发擦边朋友圈''淡季白天怎么拉人''能不能涨价'"},
        },
        "required": ["topic"],
    },
)
async def look_up_knowledge(args: dict, ctx) -> str:
    topic = (args.get("topic") or "").strip()
    hits = rank_knowledge_for_topic(topic, top=5)
    if not hits:
        return "（暂时没查到相关的行业知识，按你的常识判断即可。）"
    lines = []
    for h in hits:
        desc = h.get("description") or ""
        lines.append(f"【{h['name']}】{desc}" if desc else f"【{h['name']}】")
    return "行业知识参考（拿这些判断该不该做/是不是红线/有没有更专业打法）：\n" + "\n".join(lines)


@tool(
    name="ask_user_question",
    description="当你需要老板在几个方案/方向里先做个选择才能往下做时（如海报走哪种风格、活动主打什么方向、面向哪类客户、"
                "价位高还是低），用这个把 2-4 个选项摆给他点选，**别自己替他定**。每个选项给一个简短标签 + 一句说明。"
                "问完就停下等他点选，他选了会作为下一句消息发回来，你再接着做。需求很明确、没有歧义时别用它（直接做）。",
    parameters={
        "type": "object",
        "properties": {
            "question": {"type": "string", "description": "要问老板的问题，一句话说清楚"},
            "options": {
                "type": "array",
                "description": "2-4 个选项",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "选项标签，简短（如『暖色温馨』）"},
                        "description": {"type": "string", "description": "这个选项的一句话说明（可选）"},
                    },
                    "required": ["label"],
                },
            },
            "allow_multiple": {"type": "boolean", "description": "是否允许多选，默认否"},
        },
        "required": ["question", "options"],
    },
    is_question=True,
)
async def ask_user_question(args: dict, ctx) -> str:
    return ""  # 由 agent 循环拦截、不实际执行（吐 ask_question 事件让前端渲染选项卡片）


@tool(
    name="write_operation_content",
    deliverable=True,
    description="按老板的一句话需求，写一段【发在自己渠道】的通用运营文字（朋友圈/群公告/活动文案/日报叙事）。"
                "会自动带上门店画像、岗位规则、行业知识。"
                "【何时别用·避免选错工具】要发【抖音/小红书/快手/视频号】→用 make_platform_content；"
                "要写【美团/抖音团购套餐】→用 make_groupbuy_content；要一整套【成体系活动方案】(玩法+优惠+时间+落地步骤)而非一段文字→用 plan_activity；问经营诊断→用 diagnose_operation。"
                "若先用 find_scenario 找到贴切的精修模板，把它的 key 传进 prompt_key，会用那套校准模板来写。",
    parameters={
        "type": "object",
        "properties": {
            "need": {"type": "string", "description": "用户想写什么，原话即可，如'写条周末双人优惠的朋友圈'"},
            "customer_type": {"type": "string", "description": "面向哪类客户(可选)：new/old/vip/competition/groupbuy/all"},
            "outputs": {"type": "array", "items": {"type": "string"},
                        "description": "想要的内容形式(可选)：moments(朋友圈)/group_notice(群公告)/private_chat(私聊)/poster_copy(海报文案)"},
            "note": {"type": "string", "description": "补充说明(可选)"},
            "prompt_key": {"type": "string",
                           "description": "可选。来自 find_scenario 的精修模板 key（如 operation.qiangyi_battle）。"
                                          "传了就用那套校准模板写；不传则走通用写法。"},
        },
        "required": ["need"],
    },
)
async def write_operation_content(args: dict, ctx) -> str:
    role = getattr(ctx.user, "my_role", None) or "manager"
    need = args.get("need", "") or ""
    # 模型主动传的 prompt_key 优先；但要确认它是【目录里真实存在】的精修模板才算有效——
    # 模型偶尔会编一个不存在的 key，那就当没传，走兜底。
    raw_key = (args.get("prompt_key") or "").strip() or None
    catalog = get_catalog()
    valid_keys = {e["key"] for e in catalog}
    if raw_key and raw_key in valid_keys:
        prompt_key = raw_key
    else:
        # A-5/C-3 确定性兜底：模型没传/传了无效 key 时，按需求确定性挑一个最贴切的精修模板，
        # 别直接走泛化 free_intent 漏掉精修；找不到够贴切的（分太低）才返回 None、退回泛化写法。
        prompt_key = pick_best_prompt_key(need, catalog=catalog)
    note = args.get("note", "") or ""
    # 精修模板路径靠 extra_note 把老板的具体需求带进模板的 {extra_note} 槽；没单独 note 就用 need。
    if prompt_key and not note:
        note = need
    gen = await generate_workbench(
        ctx.db, ctx.store, ctx.user,
        user_intent=need,
        role=role,
        target_customer_type=args.get("customer_type"),
        output_package=args.get("outputs"),
        extra_note=note,
        prompt_key=prompt_key,
        concise=True,
    )
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


@tool(
    name="write_batch",
    deliverable=True,
    description="一次写【一批】同类内容（多条不重样），省得一条条来。当老板说"
                "『写一周的朋友圈 / 给我5条群公告 / 一次多来几条不一样的 / 这周每天发一条』时调用。"
                "默认写朋友圈；也可写群公告/活动点子。每条角度或主题都不同，老板挑着用。",
    parameters={
        "type": "object",
        "properties": {
            "need": {"type": "string", "description": "围绕什么写，原话即可，如'周末双人活动'或'日常引流'"},
            "count": {"type": "integer", "description": "要几条(1-7)，默认5"},
            "kind": {"type": "string", "description": "类型(可选)：moments(朋友圈,默认)/group_notice(群公告)/activity(活动)"},
        },
        "required": ["need"],
    },
)
async def write_batch(args: dict, ctx) -> str:
    try:
        count = min(max(int(args.get("count") or 5), 1), 7)
    except (TypeError, ValueError):
        count = 5  # 大脑偶尔把 count 传成"五条"这类非数字，兜底 5
    kind = (args.get("kind") or "moments").strip()
    need = (args.get("need") or "").strip()
    if not need:
        return "想批量写点啥？给个主题（比如'周末活动'或'日常引流'）+ 要几条，我一次给你一批。"
    label = {"moments": "朋友圈文案", "group_notice": "微信群公告", "activity": "活动点子"}.get(kind, "朋友圈文案")
    prompt = (
        f"围绕「{need}」，写 {count} 条**各不相同**的{label}：角度/主题/开头钩子都别雷同，每条都能直接拿去用。"
        f"用『1、』『2、』… 给每条编号，每条之间空一行，不要写额外的解说或总结。"
    )
    prompt, knowledge_names = _append_guardrails(prompt, ctx.store, role=getattr(ctx.user, "my_role", None) or "manager", intent_text=need)
    gen = await run_generation(
        ctx.db, ctx.store, ctx.user,
        prompt=prompt, gen_type="batch", sub_type=kind,
        input_params={"kind": kind, "count": count, "need": need, "knowledge_used": knowledge_names},
        user_input=need, max_tokens=2800,
    )
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


@tool(
    name="plan_activity",
    deliverable=True,
    description="策划一套**成体系的台球房活动方案**（玩法机制/优惠力度/时间安排/传播话术/落地步骤），比单写一段文案更系统。"
                "当老板要『策划/搞个活动、办会员日、做比赛、节日营销(春节/中秋等)、包场团建、老客回流专场、学生场、搭子主题局』时调用。"
                "区分：只要一段现成文字(朋友圈/群公告)用 write_operation_content；要一整套能落地执行的活动方案用本工具。",
    parameters={
        "type": "object",
        "properties": {
            "need": {"type": "string", "description": "老板的具体要求原话，如'周末双人主题之夜''中秋节搞个活动''会员日冲一波充值'"},
            "goal": {"type": "string",
                     "description": "活动主要目的(可选)：traffic(拉人气)/membership(卖会员卡)/tournament(做比赛)/comeback(老客回流)/student(学生优惠)/community(搭子群活跃)/team_building(团建包场)/holiday(节日营销)/coaching(陪练推广)"},
            "target": {"type": "string", "description": "面向哪类客群(可选)，如'附近上班族''学生''情侣闺蜜'"},
            "budget": {"type": "string", "description": "优惠力度(可选)：light(轻度)/medium(中度)/heavy(大力)"},
            "duration": {"type": "string", "description": "活动持续多久(可选)，如'周末两天''整个7月'"},
        },
        "required": ["need"],
    },
)
async def plan_activity(args: dict, ctx) -> str:
    gen = await generate_activity(
        ctx.db, ctx.store, ctx.user,
        activity_goal=args.get("goal") or "traffic",
        target_customer=args.get("target"),
        budget_level=args.get("budget"),
        duration=args.get("duration"),
        extra_note=args.get("need", "") or "",
    )
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


@tool(
    name="assistant_outreach",
    deliverable=True,
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
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


@tool(
    name="diagnose_operation",
    deliverable=True,
    description="针对经营问题给诊断和改进建议。当老板描述'生意冷清/营业额上不去/客户流失/员工问题/活动没效果'等经营困扰时调用。"
                "**老板说『照报表/照数据诊断』、且当场用文件选择器选了 Excel 报表文件时，把 report_path 设成那个文件的绝对路径**——"
                "系统会自动读出真实数字、算好团购占比/台费占比/翻台率等指标喂进诊断决策树，不用老板逐项打字报数。",
    parameters={
        "type": "object",
        "properties": {
            "situation": {"type": "string", "description": "老板描述的现状/困扰，原话即可"},
            "problem_area": {"type": "string",
                             "description": "问题领域(可选)：traffic(客流)/revenue(营收)/customer_loss(老客流失)/staff(团队)/competition(竞争)/activity_effect(活动效果)/off_season(淡季·工作日白天或某时段空台)"},
            "report_path": {"type": "string",
                            "description": "可选。老板要『照报表/照数据』诊断且当场选了 Excel 报表时，传该文件的绝对路径——"
                                           "系统读数字+算指标喂决策树。文件须在老板当场选定的文件或内容库内（沙箱）。"},
        },
        "required": ["situation"],
    },
)
async def diagnose_operation(args: dict, ctx) -> str:
    situation = args["situation"]
    report_path = (args.get("report_path") or "").strip()
    if report_path:
        # 读报表失败（文件不在/格式怪/越界）一律 try/except 降级回纯文字诊断 + 提示，绝不带崩。
        try:
            from services.agent.local_tools import _resolve  # 复用沙箱校验：越界即 ValueError
            from services.report_reader import extract_report_indicators
            safe = _resolve(report_path, ctx)  # 沙箱：内容库 + 当场选定文件，越界拒
            _ind, summary = extract_report_indicators(str(safe))
            if summary:
                situation = f"{summary}\n\n老板补充：{situation}"
        except ValueError as e:  # 越界
            situation = f"（你选的报表不在我能读的范围里：{e}。这次按你说的情况诊断。）\n\n{situation}"
        except Exception as e:  # noqa: BLE001 — 任何读表异常都降级，不崩
            logger.warning("照报表诊断读表失败，降级纯文字：%s", e)
            situation = f"（这份报表没能自动读出来，按你说的情况诊断。）\n\n{situation}"
    gen = await analyze_diagnosis(
        ctx.db, ctx.store, ctx.user,
        problem_area=args.get("problem_area", "revenue"),
        current_situation=situation,
    )
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


@tool(
    name="recommend_games",
    deliverable=True,
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
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


# ---- 生图工具（deliverable 成品，直接执行出图——纯 BYOK 老板自带 key、本就花自己的钱，不弹确认） ----

# 每用户同一时刻只允许一张 agent 生图在跑（护住每分钟出图限额 + 防误触多次重复出图）。
# 进程内即可：真正的全局并发由 poster_service 的信号量兜底；这里只防同一用户连点。
_POSTER_GENERATING: set[str] = set()


@tool(
    name="make_poster",
    deliverable=True,
    description=(
        "给门店做一张活动/宣传海报（AI 生图）。当用户要『做张海报/出张图/弄个海报』时调用。"
        "**做海报前，若老板没明确指定风格，先用 ask_user_question 问他想走哪种风格**"
        f"（常用：{style_labels_hint()}；也让他可以『自己说』）。"
        "**最关键：你要当『提示词扩写师』（像豆包/即梦那样）——把老板的大白话需求 + 选的风格/感觉，"
        "扩写成一段丰富、具体的【中文】画面描述：写清主体/场景、色调、光线、构图、氛围、质感**，"
        "别只丢一句活动名（那样出图很烂）。风格不是固定模板——老板说啥你就往那个感觉扩写，预设只是常用起点、不是全部。"
        "需求很明确就直接做、不必多问——风格定了就直接出图，出好的海报会原样展示给老板。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "你扩写好的海报【详细中文画面描述】：主体/场景/色调/光线/构图/氛围/质感都写清，越具体出图越好；别只写活动名一句话。若老板选了 logo/店标图，别在这段里描述或重画它——系统会单独把真 logo 精确贴到角上，你只写背景/主体/氛围"},
            "style": {"type": "string", "description": "海报风格(可选)：老板从 ask_user_question 选的那个风格 label，或他自己说的风格；会把对应的丰富视觉关键词拼进提示词"},
            "ratio": {"type": "string", "description": "比例(可选)：1:1 / 3:4 / 9:16 / 16:9，默认 1:1"},
        },
        "required": ["description"],
    },
)
async def make_poster(args: dict, ctx) -> str:
    """循环里直接执行出图、当成品返回（不弹确认）。沿用 poster_service 的配额/并发护栏，
    额外补『每用户单张在跑』锁 + 强制 count=1 + 质量固定 medium（成本可控）。"""
    from services import poster_service  # 延迟导入，避免 import 期重负载/循环依赖

    desc = (args.get("description") or "").strip()
    if not desc:
        return "缺少海报描述，没法生成。"
    # 风格预设链路（解决"点了风格模型收不到=死模板"）：把选定风格的丰富视觉提示词真正拼进描述、喂给模型。
    style = (args.get("style") or "").strip()
    if style:
        frag = resolve_style_prompt(style) or style  # 解析不到就原样拼（支持老板"自己说"任意风格）
        desc = f"{desc}。整体风格：{frag}"

    # 老板当场选定的图片（典型是门店 logo）→ 传给生图：第一张当 logo（poster_service has_logo 指令会让模型
    # "把它干净地融进设计、不变形"），其余当风格参考图。解决"门店上传 Logo 做海报"这条之前走不通的链路。
    from services.agent.multimodal import is_image
    _sel_imgs = [p for p in (getattr(ctx, "allowed_paths", None) or []) if is_image(p)]
    _logo_path = _sel_imgs[0] if _sel_imgs else None
    _refs = _sel_imgs[1:] or None

    # 每轮只出一张：模型有时一次请求里连出多张（不同比例）→ 重复烧店主额度。挡住第二张起。
    if getattr(ctx, "_image_generated_this_run", False):
        return "本轮已生成过一张图，一轮只出一张；除非老板明确要多张，否则别再调用生图工具。"
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
            image_model=None,  # 不写死；门店 BYOK model 优先，无则 provider 兜底 gpt-image-2（单点收口）
            ratio=args.get("ratio", "1:1"),
            quality="medium",  # 固定 medium：high 贵 30-40 倍，agent 默认走性价比；要高清去生图页
            count=1,            # 一次只出 1 张，护 IPM
            image_prompt=desc,
            background_mode="ai_generate",
            logo_path=_logo_path,              # 老板选的 logo → 融进海报（万一门店要上传 Logo）
            reference_image_paths=_refs,       # 其余选定图 → 风格参考
        )
        ctx._image_generated_this_run = True  # 本轮已出图 → 后续重复生成被上面护栏挡下
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


@tool(
    name="generate_image",
    deliverable=True,
    description=(
        "用接入的生图模型生成一张图片（海报/插画/示意图/配图/草图等都行——这是通用生图能力，不限题材）。"
        "当用户要『生成/画/做一张图』时调用。你要当『提示词扩写师』：把用户的大白话需求扩写成一段丰富、具体的"
        "【中文】画面描述——写清主体/场景、色调、光线、构图、氛围、质感，别只丢一句话（那样出图很烂）。"
        "需求明确就直接出图，出好的图会原样展示给用户。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "你扩写好的【详细中文画面描述】：主体/场景/色调/光线/构图/氛围/质感都写清，越具体出图越好。若老板选了 logo/店标图，别在这段里描述或重画它——系统会单独把真 logo 精确贴到角上，你只写背景/主体/氛围"},
            "ratio": {"type": "string", "description": "比例(可选)：1:1 / 3:4 / 9:16 / 16:9，默认 1:1"},
        },
        "required": ["description"],
    },
)
async def generate_image(args: dict, ctx) -> str:
    """通用生图：把扩写好的画面描述交给门店自带的生图模型(BYOK)出图、当成品返回（不弹确认）。
    复用 poster_service 的配额/并发护栏 + 每用户单张在跑锁；固定 count=1、quality=medium 控成本。"""
    from services import poster_service  # 延迟导入，避免 import 期重负载/循环依赖

    desc = (args.get("description") or "").strip()
    if not desc:
        return "缺少图片描述，没法生成。说清你想要张什么样的图。"
    # 老板选定的图片（如门店 logo）→ 第一张当 logo 传给生图（融进画面、尽量不变形），其余当风格参考图。
    from services.agent.multimodal import is_image
    _sel_imgs = [p for p in (getattr(ctx, "allowed_paths", None) or []) if is_image(p)]
    _logo_path = _sel_imgs[0] if _sel_imgs else None
    _refs = _sel_imgs[1:] or None
    if getattr(ctx, "_image_generated_this_run", False):
        return "本轮已生成过一张图，一轮只出一张；除非老板明确要多张，否则别再调用生图工具。"
    uid = str(getattr(ctx.user, "id", "") or "")
    if uid and uid in _POSTER_GENERATING:
        return "上一张图还在生成中，等它出完再来下一张～"
    if uid:
        _POSTER_GENERATING.add(uid)
    try:
        result = await poster_service.generate_images(
            db=ctx.db, store=ctx.store, user_id=ctx.user.id, prompt=desc,
            image_model=None, ratio=args.get("ratio", "1:1"),  # 不写死；BYOK model 优先、无则 provider 兜底
            quality="medium", count=1, image_prompt=desc, background_mode="ai_generate",
            logo_path=_logo_path, reference_image_paths=_refs,
        )
        ctx._image_generated_this_run = True  # 本轮已出图 → 后续重复生成被上面护栏挡下
    finally:
        if uid:
            _POSTER_GENERATING.discard(uid)
    images = result.get("images") or []
    if not images:
        return "图片这次没生成出来，稍后再试一下。"
    first = images[0]
    url = first.get("poster_url") if isinstance(first, dict) else getattr(first, "poster_url", None)
    if not url:
        return "图片已生成（但没拿到链接，去生成历史看看）。"
    return f"做好啦！👇\n\n![生成的图片]({url})"


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
    deliverable=True,
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
    loc = "".join(x for x in [getattr(ctx.store, "city", "") or "", getattr(ctx.store, "district", "") or ""] if x)
    loc_line = f"\n【门店所在城市】{loc}（需要同城/城市标签时只用这个真实地点，绝不编造其它城市）" if loc else ""
    prompt = f"{instruction}\n{_PLATFORM_REDLINE}{loc_line}\n\n【要发的内容/需求】\n{need}"
    prompt, knowledge_names = _append_guardrails(prompt, ctx.store, role=role, intent_text=need)
    gen = await run_generation(
        ctx.db, ctx.store, ctx.user,
        prompt=prompt,
        gen_type="platform_content",
        sub_type=p,
        input_params={"platform": p, "need": need, "knowledge_used": knowledge_names},
        user_input=need,
        max_tokens=1500,
    )
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


# ---- 团购套餐文案(美团/抖音来客)：内容生成 + 引导后台上架，不接服务商 API、不自动上架、不碰核销 ----

_GROUPBUY_PLATFORM = {
    "meituan": "meituan", "美团": "meituan", "点评": "meituan", "大众点评": "meituan",
    "douyin": "douyin", "抖音": "douyin", "抖音团购": "douyin", "抖音来客": "douyin",
}


@tool(
    name="make_groupbuy_content",
    deliverable=True,
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
    loc = "".join(x for x in [getattr(ctx.store, "city", "") or "", getattr(ctx.store, "district", "") or ""] if x)
    loc_line = f"\n【门店所在城市】{loc}（如需写到地点只用这个真实地点，别编造）" if loc else ""
    prompt = f"{instruction}{loc_line}\n\n【团购需求】\n{need}"
    prompt, knowledge_names = _append_guardrails(prompt, ctx.store, role=role, intent_text=need)
    gen = await run_generation(
        ctx.db, ctx.store, ctx.user,
        prompt=prompt,
        gen_type="groupbuy",
        sub_type=platform or "general",
        input_params={"need": need, "platform": platform or "general", "knowledge_used": knowledge_names},
        user_input=need,
        max_tokens=2000,
    )
    ctx.last_knowledge_used = (gen.input_params or {}).get("knowledge_used") or []  # B-2 依据可见
    return gen.result


# 桌面全本地版：导入本地文件操作工具（模块内按 DESKTOP_LOCAL 条件自注册；云端 web 版不设该 env → 不暴露文件操作）。
from services.agent import local_tools  # noqa: E402,F401

# 成品白名单的单一来源：据各工具自带的 deliverable 标记自动汇总。
# 必须在所有内置工具 + local_tools 都注册进 default_registry 之后再求值（故置于本模块末尾）。
DELIVERABLE_TOOLS = frozenset(default_registry.deliverable_names())
