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
    render_knowledge_bodies,
    run_generation,
)
from services.dashboard_service import get_today_dashboard
from services.diagnosis_service import analyze_diagnosis
from services.games_service import recommend_games as _recommend_games
from services.outreach_service import generate_outreach

logger = logging.getLogger(__name__)

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def _memory_candidate_from_report_summary(summary: str) -> str:
    """把报表摘要压成一条待确认记忆；不把整张表或完整诊断长期保存。"""
    lines: list[str] = []
    for raw in (summary or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("【"):
            continue
        if line.startswith("- "):
            lines.append(line[2:])
        if len(lines) >= 5:
            break
    if not lines:
        return ""
    return "从报表提取的待确认经营资料：" + "；".join(lines)

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
    description="查台球行业知识库（真实运营知识：获客/客户运营/助教/店长/数据诊断/红线合规…，含硬数字）。"
                "**拿不准某个运营做法该不该做、是不是踩红线、有没有更专业的打法、或要某个行业硬数字"
                "（美团金牌线/充值档位/助教薪资PK系数/抢一大战奖金/人员配置等）时，用它查再判断**——"
                "比凭空想靠谱。给个 topic（你拿不准的那件事，原话即可），返回最相关几条的名字 + 一句索引 + 钉死的硬数字。"
                "⚠️【台球行业的硬数字/做法以本知识库为准，别上网搜】：要确数先用这个查，查到的【硬数字】直接照用；"
                "查不到具体数字时用对应工具(写文案/诊断会带出全文)或如实说不确定让老板提供，"
                "**别用 web_search 去搜台球行业数字、也别拿网搜结果覆盖知识库口径**（网上的不一定对、还可能编）。"
                "要据某条深入写内容时，对应场景模板走 find_scenario。",
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
        # C.2：带上 key，模型据此用 read_knowledge 读整篇正文（要细则/话术时）。
        head = f"【{h['name']}】(key: {h.get('key', '')})"
        line = f"{head} {desc}" if desc else head
        facts = h.get("key_facts") or []
        if facts:
            # 钉死的硬数字直接带回——这就是准数，照用，别再上网搜。
            line += "\n  ▸ 硬数字(以此为准)：" + "；".join(facts)
        lines.append(line)
    return ("行业知识【目录】（判断该不该做/是不是红线/有没有更专业打法；带【硬数字】的直接照用、别上网搜覆盖）：\n"
            + "\n".join(lines)
            + "\n\n要某条的具体细则/话术/步骤时，用 read_knowledge(keys=[上面的 key]) 读它整篇正文，据读到的内容写，别凭空编。")


@tool(
    name="read_knowledge",
    read_only=True,
    max_result_chars=14000,  # 单条最大~5641字、读2条最坏~11k，留足余量防被截
    description="读一条/两条台球行业知识的【整篇正文】（细则、话术、步骤、完整硬数字）。"
                "配合 look_up_knowledge 用：先用 look_up_knowledge 查目录拿到要的 key，再用本工具按 key 读整篇——"
                "要写具体内容/给确切做法/引用细节时必须先 read 再写，**只引用读到的内容，没读到的别编**。"
                "一次最多读 2 条（挑最相关的）。",
    parameters={
        "type": "object",
        "properties": {
            "keys": {"type": "array", "items": {"type": "string"},
                     "description": "要读整篇的知识 key（取自 look_up_knowledge 目录里的 key），1-2 个"},
        },
        "required": ["keys"],
    },
)
async def read_knowledge(args: dict, ctx) -> str:
    raw = args.get("keys")
    keys = raw if isinstance(raw, list) else ([raw] if raw else [])
    keys = [str(k) for k in keys][:2]  # 一次最多读 2 条，护住 token
    if not keys:
        return "没给要读的知识 key。先用 look_up_knowledge 查目录，挑中后把它的 key 传进来。"
    return render_knowledge_bodies(keys, getattr(ctx, "store", None))


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
            from services.memory_service import add_pending_memory_candidate
            safe = _resolve(report_path, ctx)  # 沙箱：内容库 + 当场选定文件，越界拒
            _ind, summary = extract_report_indicators(str(safe))
            if summary:
                situation = f"{summary}\n\n老板补充：{situation}"
            if _ind:
                candidate = _memory_candidate_from_report_summary(summary)
                if candidate:
                    await add_pending_memory_candidate(ctx.db, ctx.store.id, candidate, "operational")
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
_SUPPORTED_IMAGE_RATIOS = {"1:1", "3:4", "9:16", "16:9"}


def _normalize_image_request(description: str, ratio: str | None) -> tuple[str, str, str | None]:
    """把真实用户说法收敛成当前生图工具能执行的比例；不支持的物料直接返回提示。

    这层只管硬边界：明确比例必须执行；平台/场景有默认映射；公众号头图、A4/A3、
    展架、易拉宝等当前不完整支持的尺寸不能静默冒充成 3:4。
    """
    text = (description or "").strip()
    compact = text.replace(" ", "")
    raw_ratio = (ratio or "").strip()

    unsupported: list[str] = []
    if any(k in compact for k in ("公众号头图", "公众号封面", "公众号首图")):
        unsupported.append("公众号头图通常是约 2.35:1，本版本还没有这个专门尺寸")
    if any(k in compact for k in ("A4", "A3", "打印", "贴门口", "门口张贴", "桌牌", "台卡", "展架", "易拉宝", "价目表")):
        unsupported.append("打印/线下物料需要高清尺寸、出血和二维码扫码距离，本版本还不是完整打印模板")
    if unsupported:
        return text, raw_ratio if raw_ratio in _SUPPORTED_IMAGE_RATIOS else "3:4", (
            "这个需求现在不适合直接用普通海报生图来冒充完成："
            + "；".join(unsupported)
            + "。我可以先帮你做一版线上预览图，或等你确认后按后续打印/专门尺寸流程处理。"
        )

    ratio_value = raw_ratio if raw_ratio in _SUPPORTED_IMAGE_RATIOS else ""
    for candidate in ("9:16", "16:9", "3:4", "1:1"):
        if candidate in compact:
            ratio_value = candidate
            break
    if not ratio_value:
        if any(k in compact for k in ("抖音", "视频号", "快手", "竖屏", "手机全屏", "手机竖版", "同城视频", "短视频封面")):
            ratio_value = "9:16"
        elif any(k in compact for k in ("店内电视", "店里电视", "电视上", "电视屏", "大屏", "投屏", "横版")):
            ratio_value = "16:9"
        elif any(k in compact for k in ("九宫格", "方图", "头像")):
            ratio_value = "1:1"
        elif any(k in compact for k in ("朋友圈", "微信群", "客户群", "小红书", "活动海报", "周赛海报", "招聘海报")):
            ratio_value = "3:4"
        else:
            ratio_value = "3:4"

    scene_notes = {
        "9:16": "构图按手机竖屏 9:16，主体和标题放中间安全区，底部预留平台按钮/转发区，不要贴边。",
        "16:9": "构图按横版 16:9，适合店内电视/大屏，文字更大、远距离可读。",
        "1:1": "构图按方图 1:1，信息少而集中，主体居中。",
        "3:4": "构图按竖版 3:4，适合朋友圈/微信群活动海报，标题和福利一眼看懂。",
    }[ratio_value]
    if scene_notes not in text:
        text = f"{text}。{scene_notes}"
    return text, ratio_value, None


@tool(
    name="make_poster",
    deliverable=True,
    description=(
        "给门店做海报（AI 生图）。当用户要『做张海报/出张图/弄个海报』时调用。"
        "**做海报前，若老板没明确指定风格，先用 ask_user_question 问他想走哪种风格**"
        f"（常用：{style_labels_hint()}；也让他可以『自己说』）。"
        "**最关键：你要当『提示词扩写师』——把老板的大白话需求 + 选的风格/感觉，"
        "扩写成一段丰富、具体的【中文】画面描述：写清主体/场景、色调、光线、构图、氛围、质感**，"
        "别只丢一句活动名（那样出图很烂）。风格不是固定模板——老板说啥你就往那个感觉扩写。"
        "需求很明确就直接做、不必多问——风格定了就直接出图，出好的海报会原样展示给老板。\n\n"
        "**图片角色判定**：老板选了图片时，根据他的话判断每张图的角色——\n"
        "- 说『这是我 logo / 加上我的店标』→ 填 logo_path（系统会用 PIL 像素级贴到右上角，清晰不糊）\n"
        "- 说『加个二维码 / 扫码关注』→ 填 qr_path\n"
        "- 说『用这张图做底图改一下 / 在这张上改』→ 填 store_photo_path\n"
        "- 说『参考这几张的感觉 / 照这个风格来』或没明说角色 → 不填角色参数，图自动当风格参考\n"
        "别在 description 里描述 logo/二维码——系统会单独处理。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "你扩写好的海报【详细中文画面描述】：主体/场景/色调/光线/构图/氛围/质感都写清，越具体出图越好；别只写活动名一句话。若有 logo/二维码，别在这里描述——系统单独处理"},
            "style": {"type": "string", "description": "海报风格(可选)：老板从 ask_user_question 选的那个风格 label，或他自己说的风格"},
            "ratio": {"type": "string", "description": "比例(可选)：1:1 / 3:4 / 9:16 / 16:9，默认 3:4"},
            "logo_path": {"type": "string", "description": "门店 logo 图片路径(可选)：老板说『这是我 logo / 加上店标』时填，系统会用 PIL 精确贴到右上角"},
            "qr_path": {"type": "string", "description": "二维码图片路径(可选)：老板说『加个二维码 / 扫码关注』时填"},
            "store_photo_path": {"type": "string", "description": "底图路径(可选)：老板说『用这张做底图改一下』时填，会以这张为底做修改而非从零生成"},
            "count": {"type": "integer", "description": "出几张(可选)：默认 1，老板明确要多张时填(上限 4)"},
        },
        "required": ["description"],
    },
)
async def make_poster(args: dict, ctx) -> str:
    """循环里直接执行出图、当成品返回（不弹确认）。沿用 poster_service 的配额/并发护栏，
    额外补『每用户单张在跑』锁 + 质量固定 medium（成本可控）。"""
    from services import poster_service

    desc = (args.get("description") or "").strip()
    if not desc:
        return "缺少海报描述，没法生成。"
    desc, ratio, unsupported_msg = _normalize_image_request(desc, args.get("ratio"))
    if unsupported_msg:
        return unsupported_msg
    style = (args.get("style") or "").strip()
    if style:
        frag = resolve_style_prompt(style) or style
        desc = f"{desc}。整体风格：{frag}"

    logo_path = (args.get("logo_path") or "").strip() or None
    qr_path = (args.get("qr_path") or "").strip() or None
    store_photo_path = (args.get("store_photo_path") or "").strip() or None
    background_mode = "store_photo" if store_photo_path else "ai_generate"

    from services.agent.multimodal import is_image
    _sel_imgs = [p for p in (getattr(ctx, "allowed_paths", None) or []) if is_image(p)]
    _assigned = {p for p in (logo_path, qr_path, store_photo_path) if p}
    _refs = [p for p in _sel_imgs if p not in _assigned] or None

    count = max(1, min(int(args.get("count", 1) or 1), 4))
    _done = getattr(ctx, "_images_generated_this_run", 0)
    _remaining = 4 - _done
    if _remaining <= 0:
        return "本轮已生成 4 张图，到上限了。"
    count = min(count, _remaining)

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
            image_model=None,
            ratio=ratio,
            quality="medium",
            count=count,
            image_prompt=desc,
            background_mode=background_mode,
            logo_path=logo_path,
            qr_path=qr_path,
            store_photo_path=store_photo_path,
            reference_image_paths=_refs,
            conversation_id=getattr(ctx, "conversation_id", None),
        )
        ctx._images_generated_this_run = _done + (result.get("count") or count)
    finally:
        if uid:
            _POSTER_GENERATING.discard(uid)

    images = result.get("images") or []
    if not images:
        return "海报这次没生成出来，稍后再试一下。"

    logo_applied = result.get("logo_applied", False)
    parts = []
    for i, img in enumerate(images):
        url = img.get("poster_url") if isinstance(img, dict) else getattr(img, "poster_url", None)
        if url:
            label = "门店海报" if len(images) == 1 else f"海报{i+1}"
            parts.append(f"![{label}]({url})")
            ratio = img.get("ratio") if isinstance(img, dict) else None
            width = img.get("width") if isinstance(img, dict) else None
            height = img.get("height") if isinstance(img, dict) else None
            if ratio or (width and height):
                meta = " · ".join(str(x) for x in (ratio, f"{width}x{height}" if width and height else "") if x)
                parts.append(f"尺寸：{meta}")
    if not parts:
        return "海报已生成（但没拿到图片链接，去生成历史看看）。"

    status = "做好啦！👇"
    if logo_path:
        status += "（你的 logo 已交给 AI 融进画面）"
    return f"{status}\n\n" + "\n\n".join(parts)


@tool(
    name="generate_image",
    deliverable=True,
    description=(
        "用接入的生图模型生成一张图片（海报/插画/示意图/配图/草图等都行——这是通用生图能力，不限题材）。"
        "当用户要『生成/画/做一张图』时调用。你要当『提示词扩写师』：把用户的大白话需求扩写成一段丰富、具体的"
        "【中文】画面描述——写清主体/场景、色调、光线、构图、氛围、质感，别只丢一句话（那样出图很烂）。"
        "需求明确就直接出图，出好的图会原样展示给用户。\n\n"
        "**图片角色判定**：用户选了图片时，根据用户的话判断每张图的角色——\n"
        "- 说『这是 logo / 加上标志』→ 填 logo_path\n"
        "- 说『加个二维码』→ 填 qr_path\n"
        "- 说『用这张做底图 / 在这上面改』→ 填 store_photo_path\n"
        "- 没明说角色 → 不填角色参数，图自动当风格参考\n"
        "别在 description 里描述 logo/二维码——系统会单独处理。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "你扩写好的【详细中文画面描述】：主体/场景/色调/光线/构图/氛围/质感都写清，越具体出图越好。若有 logo/二维码，别在这里描述——系统单独处理"},
            "ratio": {"type": "string", "description": "比例(可选)：1:1 / 3:4 / 9:16 / 16:9，默认 3:4"},
            "logo_path": {"type": "string", "description": "logo 图片路径(可选)：用户说加 logo 时填"},
            "qr_path": {"type": "string", "description": "二维码图片路径(可选)：用户说加二维码时填"},
            "store_photo_path": {"type": "string", "description": "底图路径(可选)：用户说在某张图上改时填"},
            "count": {"type": "integer", "description": "出几张(可选)：默认 1，用户明确要多张时填(上限 4)"},
        },
        "required": ["description"],
    },
)
async def generate_image(args: dict, ctx) -> str:
    """通用生图：把扩写好的画面描述交给生图模型出图、当成品返回（不弹确认）。
    复用 poster_service 的配额/并发护栏 + 每用户单张在跑锁。"""
    from services import poster_service

    desc = (args.get("description") or "").strip()
    if not desc:
        return "缺少图片描述，没法生成。说清你想要张什么样的图。"
    desc, ratio, unsupported_msg = _normalize_image_request(desc, args.get("ratio"))
    if unsupported_msg:
        return unsupported_msg

    logo_path = (args.get("logo_path") or "").strip() or None
    qr_path = (args.get("qr_path") or "").strip() or None
    store_photo_path = (args.get("store_photo_path") or "").strip() or None
    background_mode = "store_photo" if store_photo_path else "ai_generate"

    from services.agent.multimodal import is_image
    _sel_imgs = [p for p in (getattr(ctx, "allowed_paths", None) or []) if is_image(p)]
    _assigned = {p for p in (logo_path, qr_path, store_photo_path) if p}
    _refs = [p for p in _sel_imgs if p not in _assigned] or None

    count = max(1, min(int(args.get("count", 1) or 1), 4))
    _done = getattr(ctx, "_images_generated_this_run", 0)
    _remaining = 4 - _done
    if _remaining <= 0:
        return "本轮已生成 4 张图，到上限了。"
    count = min(count, _remaining)

    uid = str(getattr(ctx.user, "id", "") or "")
    if uid and uid in _POSTER_GENERATING:
        return "上一张图还在生成中，等它出完再来下一张～"
    if uid:
        _POSTER_GENERATING.add(uid)
    try:
        result = await poster_service.generate_images(
            db=ctx.db, store=ctx.store, user_id=ctx.user.id, prompt=desc,
            image_model=None, ratio=ratio,
            quality="medium", count=count, image_prompt=desc,
            background_mode=background_mode,
            logo_path=logo_path, qr_path=qr_path,
            store_photo_path=store_photo_path,
            reference_image_paths=_refs,
            conversation_id=getattr(ctx, "conversation_id", None),
        )
        ctx._images_generated_this_run = _done + (result.get("count") or count)
    finally:
        if uid:
            _POSTER_GENERATING.discard(uid)

    images = result.get("images") or []
    if not images:
        return "图片这次没生成出来，稍后再试一下。"

    logo_applied = result.get("logo_applied", False)
    parts = []
    for i, img in enumerate(images):
        url = img.get("poster_url") if isinstance(img, dict) else getattr(img, "poster_url", None)
        if url:
            label = "生成的图片" if len(images) == 1 else f"图片{i+1}"
            parts.append(f"![{label}]({url})")
            ratio = img.get("ratio") if isinstance(img, dict) else None
            width = img.get("width") if isinstance(img, dict) else None
            height = img.get("height") if isinstance(img, dict) else None
            if ratio or (width and height):
                meta = " · ".join(str(x) for x in (ratio, f"{width}x{height}" if width and height else "") if x)
                parts.append(f"尺寸：{meta}")
    if not parts:
        return "图片已生成（但没拿到链接，去生成历史看看）。"

    status = "做好啦！👇"
    if logo_path:
        status += "（你的 logo 已交给 AI 融进画面）"
    return f"{status}\n\n" + "\n\n".join(parts)


# ---- 生视频工具（文生视频 / 图生视频，火山方舟 Seedance 异步）----
# 与生图不同：视频慢(1-几分钟)且贵(单条比图贵一个量级) → 走审批闸 requires_approval（花钱前先弹确认让老板点头），
# 并发/重复护栏同生图：每用户单条在跑锁 + 每轮只出一个。
_VIDEO_GENERATING: set[str] = set()


def _normalize_video_ratio(args: dict) -> str:
    """视频默认社交媒体竖屏 9:16（抖音/视频号/快手/小红书/朋友圈）；
    只有用户/模型明确要横版、大屏、电视、电脑、16:9 才给 16:9；明确方形给 1:1。
    总表口径：视频是发社交媒体账号的营销内容，默认 9:16，不是店内大屏物料。"""
    a = args or {}
    raw = str(a.get("ratio") or "").strip()
    if raw in ("9:16", "16:9", "1:1"):
        return raw
    blob = str(a.get("description") or "")
    if any(k in blob for k in ("横版", "横屏", "横向", "大屏", "电视", "投屏", "电脑", "宽屏", "16:9")):
        return "16:9"
    if any(k in blob for k in ("方形", "方图", "1:1")):
        return "1:1"
    return "9:16"


def _video_approval_reason(args: dict, ctx) -> dict:
    ratio = _normalize_video_ratio(args)
    duration = int((args or {}).get("duration") or 5)
    first_frame = str((args or {}).get("first_frame") or "").strip()
    mode = "图生视频" if first_frame else "文生视频"
    return {
        "what": f"生成一条{duration}秒左右的{ratio}短视频（{mode}），用于抖音/视频号/快手/小红书这类社交媒体营销。",
        "why": "视频生成比图片慢、成本更高，确认后才会真正提交到视频模型。",
        "impact": "确认后会消耗视频额度，通常需要等待 1-8 分钟；生成结果会保存到最近作品里，可回来继续查看。",
    }


@tool(
    name="generate_video",
    deliverable=True,
    requires_approval=True,   # 视频贵+不可逆产出 → 花钱前弹确认（生图便宜不弹、视频弹，符合防盗刷/控成本）
    approval_class="spend",
    force_confirm=True,
    approval_reason=_video_approval_reason,
    timeout=1860.0,           # 异步轮询波动大(实测达13.5分钟)，外层兜底设31分钟(略大于 video_timeout 30分钟)，别被默认短超时掐了
    description=(
        "生成一段短视频（AI 文生视频 / 图生视频）。当用户要『做个视频 / 生成视频 / 让这张图动起来』时调用。"
        "你要当『提示词扩写师』：把用户的大白话需求扩写成一段【中文】画面+运镜描述——写清主体动作、"
        "镜头运动(推/拉/摇/移/环绕)、场景、节奏、氛围，别只丢一句话（那样出片很烂）。"
        "**图生视频**：把上一步 generate_image/make_poster 产出的图片地址（markdown 里的 /uploads/... 路径或 http 链接），"
        "或老板当场选定的图片，填进 first_frame，视频就会从这张图开始动起来。"
        "视频生成较慢（约 1-几分钟）且要花钱，会先弹确认让老板点头后才真正生成。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "description": {"type": "string", "description": "你扩写好的【中文】画面+运镜描述：主体动作 / 镜头运动(推拉摇移环绕) / 场景 / 节奏 / 氛围，越具体出片越好"},
            "first_frame": {"type": "string", "description": "首帧图片地址(可选)：上一步生成图片的 /uploads/... 路径或 http 链接；填了就做『图生视频』(从这张图动起来)，不填就纯文生视频"},
            "ratio": {"type": "string", "description": "画面比例(可选)：9:16(默认·竖屏，发抖音/视频号/快手/小红书/朋友圈) / 16:9(横版·店内大屏/电视/电脑) / 1:1。不填默认 9:16；只有用户明确要横版大屏才用 16:9"},
            "duration": {"type": "integer", "description": "时长秒数(可选)：默认 5"},
        },
        "required": ["description"],
    },
)
async def generate_video(args: dict, ctx) -> str:
    """文生视频/图生视频：审批通过后由 /agent/execute 执行（提交→轮询，几分钟）。
    每轮只出一个视频 + 每用户单条在跑锁（护成本，与生图同款）。"""
    from services import video_service  # 延迟导入，避免 import 期重负载/循环依赖

    desc = (args.get("description") or "").strip()
    if not desc:
        return "缺少视频描述，没法生成。说清你想要个什么样的视频（画面 + 运镜）。"

    from services.ai.factory import ProviderFactory
    api_key, _base, _model = ProviderFactory.get_video_config_for_store(ctx.store)
    if not api_key:
        return "还没配好视频模型：请在「模型设置」里填写火山方舟（ARK）的 API Key 并开通 Seedance 模型，配好了再来生成视频。"

    # 首帧图：模型显式给的优先；没给则回退老板当场选定的第一张图（"选了张图说让它动起来"）。
    from services.agent.multimodal import is_image
    sel_imgs = [p for p in (getattr(ctx, "allowed_paths", None) or []) if is_image(p)]
    first_frame = (args.get("first_frame") or "").strip() or (sel_imgs[0] if sel_imgs else None)

    if getattr(ctx, "_video_generated_this_run", False):
        return "本轮已生成过一个视频，一轮只出一个；除非老板明确要多个，别再调用生视频工具。"
    uid = str(getattr(ctx.user, "id", "") or "")
    if uid and uid in _VIDEO_GENERATING:
        return "你上一个视频还在生成中，等它出完再来下一个～"
    if uid:
        _VIDEO_GENERATING.add(uid)
    try:
        result = await video_service.generate_video(
            db=ctx.db, store=ctx.store, user_id=ctx.user.id,
            prompt=desc, ratio=_normalize_video_ratio(args),
            duration=int(args.get("duration", 5) or 5),
            first_frame=first_frame,
            allow_paths=set(getattr(ctx, "allowed_paths", None) or []),
            conversation_id=getattr(ctx, "conversation_id", None),
        )
        ctx._video_generated_this_run = True
    except Exception as e:  # 失败给人话、别把异常栈丢给模型
        return f"视频没生成出来：{e}"
    finally:
        if uid:
            _VIDEO_GENERATING.discard(uid)

    url = result.get("video_url")
    if not url:
        return "视频已生成（但没拿到链接，去生成历史看看）。"
    # 前端 VIDEO_TOOLS 分支据此抓出 url 渲染成 <video>；markdown 链接同时作可点击兜底。
    return f"做好啦！👇\n\n[点击查看视频]({url})"


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
