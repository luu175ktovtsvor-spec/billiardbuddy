"""Agent 对话 SSE 端点。

把流式 ReAct 循环（services.agent.loop.run_agent_loop_stream）的事件以 SSE 推给前端：
token / tool_call / tool_result / final / done / error。

已接管道：
- system prompt 注入门店画像 + 店脑记忆（让 agent "懂这家店"）
- 输入注入检查 + 上游配额闸（check_quota）
- 后台从用户消息学习店脑（故障安全、不计配额）
- 计费：生成类工具内部各自走 run_generation/generate_workbench（自带配额/落库/合规过滤），
  因此端点不再重复计费/落库；纯对话（未调工具）开销极小，由上游 check_quota 把门。

TODO(后续)：agent 会话本身落库(type=agent) + 多轮 conversation_id 续接；审批闸（写/对外类工具）。
"""
import json
import logging
import os

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from starlette.background import BackgroundTask

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import AIServiceError
from core.rbac import Permission, require_permission
from core.security_guard import check_input_injection
from db.session import async_session
from models.user import User
from services.agent.context import AgentContext
from services.agent import denial_tracker
from services.agent.loop import _action_key, run_agent_loop, run_agent_loop_stream
from services.agent.proactive import generate_daily_drafts
from services.ai.factory import ProviderFactory
from services.ai.failover import build_resilient_text_provider  # BYOK 失败自动切备用配置档
from services.agent.registry import default_registry
from services.memory_service import format_memories_for_prompt, load_store_memory, remember
from services.quota_service import check_quota
from services.store_profile_service import render_operation_profile_context
import services.agent.tools  # noqa: F401  导入即把内置工具登记进 default_registry
import services.agent.web_tools  # noqa: F401  第二批：WebFetch/WebSearch/TodoWrite/run_subagent 登记进 default_registry

logger = logging.getLogger(__name__)
router = APIRouter()

_AGENT_BASE_PROMPT = (
    "你是台球房运营助手的 AI Agent。用大白话、简洁地帮台球房老板/店员完成日常运营工作。"
    "能用工具完成的就调工具（写文案、约客、经营诊断、做海报、写平台/团购内容等）。"
    "面向不懂技术的店员说话：少术语，给能直接拿去用的结果。"
    "【术语大白话约定】给老板/店员看的成品里，管理术语要用大白话——"
    "客单价＝一个人平均花多少、翻台＝一桌客人走了下一桌接上、环比＝比上个月、"
    "上座率/开台率＝有多少桌在打、扣卡率＝会员卡消费掉多少、空挂＝充了钱没怎么来打。"
    "诊断/决策类内容可以保留专业词，但要顺带一句大白话解释，别让老板看不懂。"
    "【直接动手，别绕弯】用户已经明确说要做什么（写朋友圈/群公告/活动、做海报、发抖音小红书快手视频号、写团购、约某个客户、诊断经营问题）时，"
    "就直接调用对应工具去做。不要习惯性地先调 get_current_date 或 get_today_recommendation——"
    "这两个只在用户真的问『今天几号/是不是周末』，或开口问『今天该做点啥、给点建议』时才用；写具体内容时系统会自动带上当天日期，不必单独查。"
    "【做东西就直接做，别反复请示】写文案、做海报/生图、写平台/团购内容这类『做出成品』的活儿，"
    "把方案想好后直接调用对应工具去做就行——正常做、正常出结果，不必先用文字问『行不行/要不要生成』，"
    "简短说一句你准备做什么即可。"
    "【真正发出去的事才需老板点头】只有『真的把内容发出去/对外触达』的动作（发布到抖音小红书等平台、群发或私信客户），"
    "才会弹一张确认卡让老板点一下——这是为了防止自动对外、防账号被封的安全确认，不是因为要花钱；"
    "做海报、写内容这些『只是做出来给老板看』的，都不算对外，直接做、不弹确认。"
    "【交付内容会原样展示，别复述】写文案/活动方案/约客话术/诊断/玩法/平台内容/团购套餐这些工具产出的成品，"
    "系统会原样、完整地展示给用户(可一键复制)，你绝不要在回复里再把整段内容抄一遍或改写精简——"
    "那既多余又会让校准过的内容失真。你只需用一句话说『写好啦，你看看，要改告诉我』这类简短引导即可。"
    "【红线·只有这两件事死活不碰】① 把助教服务直接卖成实际性交易（性服务/援交/陪睡/上门过夜/特殊服务这类）；"
    "② 门店自己当庄、定盘口、按局抽水组织赌球（开设赌场罪）。遇到这两类——"
    "**绝不调用任何工具，哪怕想写个『干净版』也不行**；先停下，一两句说清为什么不能这么搞、给走正路的替代。"
    "【老板亲定的店规矩/避免清单——拿来校准灰色地带】店脑里老板亲手定的『我的店规矩 / 避免清单』"
    "（比如：我们店不做大额充值赠送、不写某些词、不搞某类活动、不打某个价格战），是这家店自己的边界——"
    "对这些【灰色地带】的偏好，要严格尊重、照办，老板说不做的就不做、说不写的词就不写。"
    "但要分清：上面那【两条硬红线】（不营销实际性交易、不帮刑事级犯罪）是法律底线，"
    "**任何老板的店规矩都不能把硬红线放开**——哪怕老板亲口要求、写进了店规矩，遇到红线仍按红线停下，别照办。"
    "一句话：老板的规矩能收紧、能校准灰色地带，但永远松不开那两条硬红线。"
    "【这些都是球房真实生意，照帮、别当红线误杀】助教的美女人设/颜值形象/异性情绪价值、引导客人加微信、陪打、"
    "助教超休陪客人出去吃饭喝酒（这是真实存在的延伸服务，带职业分寸、不写性暗示就行）、"
    "客人之间你情我愿的追分较劲（门店只提供场地、还要帮着把金额控住别玩大）、学生放学后/周末/假期的正当优惠——"
    "这些都是这行真实的运营逻辑，正常调工具帮，最多写的时候把握点分寸，绝不能因为『听着擦边』就误当红线拒掉。"
    "【把方向带正】有些活儿能帮，但别顺着错的来，要把方向带正："
    "①客人给差评/投诉，是帮老板『专业体面地回应』而不是『怼客人/损客人』——写得真诚、有格局、让围观的人觉得店家大气，绝不写嘲讽、反击、贬低顾客的话；"
    "②面向学生/中学生的内容，只主打放学后、周末、寒暑假的正当休闲，绝不诱导逃课翘课，注意未成年的时段与分寸；"
    "③比赛带现金奖励时，定位成正规赛事（报名费做奖池 + 奖杯荣誉），绝不做成抽头/对赌/赌球；"
    "④涉及辞退、合同、劳动纠纷等法律文书，可以给参考模板，但要提醒『这属于法律文书，落地前请让 HR 或专业人士把关』；"
    "⑤老板想搞充值/优惠活动但开的条件太猛（充1万送1万、台费终身免费畅打、全城最低价这类无底线让利或绝对化广告词），"
    "别一口回绝、也别照搬——正常调用写文案/活动工具去做，但把力度收到合理（小比例赠送、用真实价格、不写『全城最低/终身免费』这种违规词），"
    "并顺口提醒老板你为什么这么调（力度太猛会亏、绝对化广告词违广告法）。"
)


def _today_line() -> str:
    """当天日期（北京时间）一句话，注入 system prompt 让大脑天然懂"今天/这周末"是哪天，
    不必为规划/写内容而反射性先调 get_current_date 多兜一轮（实测这是最常见的无谓工具调用）。"""
    try:
        from core.timezone import business_today
        d = business_today()
        wk = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"][d.weekday()]
        return (f"【今天】{d.isoformat()}（{wk}）。涉及『今天/明天/这周末/最近』等时间时直接据此推算并落到内容里，"
                "不必再调 get_current_date 查日期。")
    except Exception:
        return ""


_WEB_AGENT_TOOLS_HINT = (
    "【你还会上网查资料、列清单、拆子任务（对标专业 AI 助手的本事）】\n"
    "- web_search：要最新的、本地知识库里没有的外部信息（行业趋势、同行竞品在怎么做、某种新做法）就上网搜，"
    "返回前几条标题+链接+摘要；想看某条的全文，再用 web_fetch 抓它的链接。\n"
    "- web_fetch：给一个已知网址，抓回它的正文（读一篇文章、看某个竞品页写了什么）。\n"
    "- todo_write：遇到要分好几步才能做完的复杂任务，先用它把步骤列成清单、再逐项做、做完一步更新状态——"
    "不容易漏步，老板也看得到进度；一步到位的简单活儿不用列。\n"
    "- run_subagent：遇到那种『先把某一大块独立子任务彻底做完、再回来继续主线』的大任务，可以把这块交给子代理专心做完拿回结果"
    "（会多花一次完整模型调用，普通小事别用它）。\n"
    "原则：本地知识库/门店资料够用就别上网；只在确实需要外部最新信息时才搜。"
)

_DESKTOP_FILE_OPS_HINT = (
    "【你能直接操作老板本机的文件（桌面版）】你在老板自己的电脑上运行，有一组本地文件工具：\n"
    "- list_files 看内容库里有什么、read_file 读某个文件、write_file 存文件、edit_file 改文本某段、edit_excel 直接改 Excel 报表(改营业额/加列等)。\n"
    "- 老板说『把刚才那份存下来』『把报表里营业额改成 X』『给文案改个价』这类，就**真的去读、去改文件**，别只在对话里复述。\n"
    "- 改之前**先 read_file 看清内容/单元格坐标**再改；写/改会先弹给老板确认、自动备份原件、可回滚——放心动手。"
)

_DESKTOP_FULL_ACCESS_HINT = (
    "【老板已开启「完全访问模式」——你能自己找/搜文件、列任意目录、跑命令】此模式下你不再被限在内容库：\n"
    "- find_files：在任意目录下按文件名递归找（如在桌面找所有 *.xlsx、找 **/采购*），先找到再读。\n"
    "- search_in_files：在任意目录下按内容搜（哪个文件里写了某个词），返回 文件:行号:命中行。\n"
    "- list_files 带 path：列任意目录里有什么。\n"
    "- run_command：跑一条命令（ls/find/python 脚本/git status 等），**每条都会把命令原文弹给老板确认**才执行；"
    "禁止用 && | ; > < 等拼接，危险命令(删根/提权/格式化)会被直接拒。\n"
    "老板没开完全访问模式时，你只能动内容库和他当场选定的文件——这几个跨目录/命令能力会被拒，别硬试。"
)


_VALID_PERMISSION_MODES = {"ask", "auto_files", "full"}


def _resolve_permission(mode: str | None, full_disk: bool | None) -> tuple[str, bool]:
    """把请求里的权限/范围设置收敛成安全值。
    非桌面（云端 web 多租户）一律强制 ask + 无全盘——那里压根没注册本地文件工具，
    且绝不能让某租户的请求拿到任何文件自主权（防御性）。"""
    if os.environ.get("DESKTOP_LOCAL") != "1":
        return "ask", False
    m = mode if mode in _VALID_PERMISSION_MODES else "ask"
    return m, bool(full_disk)


def _model_ctx_window() -> int | None:
    """SH-6 autocompact 触发用的模型上下文窗口（token）。默认 None＝不启用（不同 BYOK 模型窗口大小不一，
    乱设会误触发/迟触发，故不默认开）。要在超长对话时启用自动瘦身，配 DESKTOP_MODEL_CTX_WINDOW＝如 64000。
    非法值按 None。"""
    try:
        v = int(os.environ.get("DESKTOP_MODEL_CTX_WINDOW", "") or 0)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _selected_files_note(paths: list[str] | None) -> str:
    """老板当场选定的文件 → 注入 system prompt，让大脑知道有这些文件、用完整路径直接读/改。"""
    if not paths:
        return ""
    lines = "\n".join(f"- {p}" for p in paths if p and p.strip())
    if not lines:
        return ""
    return (
        "【老板刚选了这些文件交给你处理（可直接读/改，调工具时用下面的完整路径）】\n" + lines +
        "\n改 Excel/文本前先 read_file 看清内容与单元格坐标；写/改会先弹给老板确认、自动备份原件、可回滚。"
    )


def compose_agent_system_prompt(profile_text: str, brain_text: str, full_disk: bool = False) -> str:
    """拼 agent 的 system prompt（让它"懂当下、懂这家店"）。

    顺序铁律（缓存稳定·借鉴 learn-claude-code s10）：先放对所有店/所有天【字节稳定】的静态段
    （基底指令 + 通用能力 hint + 桌面文件能力 hint），再放每天/每店/每句都会变的【动态尾段】
    （当天日期 + 门店画像 + 店脑记忆）。动态串绝不插进静态前缀中间——否则会顶掉它后面静态内容的
    服务端自动前缀缓存命中（DeepSeek/硅基流动等 OpenAI 兼容端点按请求前缀自动命中缓存，
    让前缀逐字节稳定＝省钱省延迟；它们不支持也不需要 Anthropic 式显式 cache_control）。
    full_disk=True（老板开了完全访问模式）时额外注入"可找/搜文件、列任意目录、跑命令"的 hint。"""
    # —— 静态前缀：身份/红线/工具用法 + 通用能力 + 桌面文件能力（与当天/门店无关，逐字节稳定，可被前缀缓存复用）——
    # 第二批通用能力（上网查资料/列清单/拆子任务）——桌面与云端 web 都注册了这四个工具，故都告诉大脑何时用。
    parts = [_AGENT_BASE_PROMPT, _WEB_AGENT_TOOLS_HINT]
    # 桌面全本地版：告诉大脑它能直接读写改本机文件，它才会主动用文件工具（云端 web 版不设 DESKTOP_LOCAL→不加）。
    if os.environ.get("DESKTOP_LOCAL") == "1":
        parts.append(_DESKTOP_FILE_OPS_HINT)
        # 完全访问模式：再告诉它能自己找/搜文件、列任意目录、跑命令（会弹卡确认）。
        if full_disk:
            parts.append(_DESKTOP_FULL_ACCESS_HINT)
    # —— 动态尾段：每天变的日期 → 每店变的画像 → 每句变的店脑记忆（越靠后越易变），一律排在静态前缀之后 ——
    today = _today_line()
    if today:
        parts.append(today)
    if profile_text and profile_text.strip():
        parts.append("【这家店的情况】\n" + profile_text.strip())
    if brain_text and brain_text.strip():
        # format_memories_for_prompt 自带"如与其他资料冲突以此为准"的前缀
        parts.append(brain_text.strip())
    return "\n\n".join(parts)


async def _learn_in_background(store_id: str, text: str) -> None:
    """对话后台学习：独立 session 从用户消息抽取门店记忆、整合进店脑。失败静默、不计配额。"""
    if not text or not text.strip():
        return
    try:
        async with async_session() as bg_db:
            await remember(bg_db, store_id, text)
    except Exception:
        logger.exception("agent 店脑后台学习失败 store_id=%s", store_id)


async def _persist_agent_chat(db, store, user, message: str, content: str, gen_id: str, conv_uuid, turns: int,
                              tokens_used: int = 0) -> None:
    """落库 agent 会话(type=agent)+conversation_id,供刷新续接/分析,并打点。故障安全:失败不阻断 SSE。
    SH-2：tokens_used 拿循环累加的真实编排消耗（喂 BYOK 成本看板），端点没返回时为粗估值。"""
    import uuid as _uuid
    try:
        from models.generation import Generation
        db.add(Generation(
            id=_uuid.UUID(gen_id), store_id=store.id, user_id=(user.id if user else None),
            type="agent", sub_type="chat", input_params={"message": message},
            prompt_used=message, result=(content or ""), model_used="agent",
            tokens_used=(tokens_used or 0),
            conversation_id=conv_uuid,
        ))
        await db.commit()
    except Exception:
        logger.warning("agent 会话落库失败,跳过", exc_info=True)
        try:
            await db.rollback()
        except Exception:
            pass
    try:
        from services.usage_event_service import log_event
        await log_event("agent_chat", store_id=str(store.id),
                        user_id=(str(user.id) if user else None),
                        props={"turns": turns, "has_output": bool(content)})
    except Exception:
        pass


_HIST_MAX_MSGS = 12      # 最多保留最近 12 条历史（约 6 轮 user+assistant），超出丢最旧的
_HIST_MAX_CHARS = 2000   # 每条历史内容截断上限


def _cap_history(history: list[dict] | None) -> list[dict] | None:
    """控住 context 体积：只留最近 _HIST_MAX_MSGS 条、每条截断 _HIST_MAX_CHARS 字。
    防长对话撑爆上下文窗口——尤其堵住"前端全量回传 history"那条没封顶的路径。"""
    if not history:
        return history
    out: list[dict] = []
    for m in history[-_HIST_MAX_MSGS:]:
        c = m.get("content") or ""
        out.append({**m, "content": c[:_HIST_MAX_CHARS]} if len(c) > _HIST_MAX_CHARS else m)
    return out


async def _load_agent_history(db, store, conversation_id: str | None) -> list[dict]:
    """按 conversation_id 从 DB 取本会话最近 5 轮历史（user/assistant 对），供续接。失败返回空。"""
    if not conversation_id:
        return []
    try:
        import uuid as _uuid
        from sqlalchemy import select
        from models.generation import Generation as _Gen
        rows = (await db.execute(
            select(_Gen).where(
                _Gen.store_id == store.id,
                _Gen.conversation_id == _uuid.UUID(conversation_id),
                _Gen.type == "agent",
                _Gen.is_deleted == False,  # noqa: E712
            ).order_by(_Gen.created_at)
        )).scalars().all()
        hist: list[dict] = []
        for g in rows[-5:]:
            uin = (g.input_params or {}).get("message")
            if not uin or not g.result:
                continue  # 只取完整一轮(user+assistant)，跳过半截记录，避免连续同角色消息
            hist.append({"role": "user", "content": uin})
            hist.append({"role": "assistant", "content": g.result[:2000]})
        return hist
    except Exception:
        logger.warning("agent 历史加载失败 conversation_id=%s", conversation_id, exc_info=True)
        return []


def _group_agent_conversations(rows) -> list[dict]:
    """把（按 created_at 倒序的）agent 生成记录按 conversation_id 分组成会话列表。
    标题=该会话最早一条的 user message（或 title）；last_at=最新时间；保序=最新会话在前；取前 40。"""
    convs: dict = {}
    for g in rows:
        cid = str(g.conversation_id)
        if cid not in convs:
            convs[cid] = {"conversation_id": cid,
                          "last_at": g.created_at.isoformat() if g.created_at else None,
                          "title": None}
        msg = (g.input_params or {}).get("message") if g.input_params else None
        title = g.title or msg  # 倒序遍历→最后一次赋值来自最早一条→标题=会话第一句
        if title:
            convs[cid]["title"] = str(title)[:30]
    return list(convs.values())[:40]


@router.get("/conversations")
async def list_agent_conversations(
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """列出本店的 agent 会话（标题/最近时间），供桌面侧栏回看与切换。"""
    from sqlalchemy import select
    from models.generation import Generation as _Gen
    rows = (await db.execute(
        select(_Gen).where(
            _Gen.store_id == store.id,
            _Gen.type == "agent",
            _Gen.is_deleted == False,  # noqa: E712
            _Gen.conversation_id.isnot(None),
        ).order_by(_Gen.created_at.desc()).limit(300)
    )).scalars().all()
    return {"conversations": _group_agent_conversations(rows)}


@router.get("/conversations/{conversation_id}")
async def get_agent_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """取某个 agent 会话的全部消息（user/assistant 文本对），供桌面端点开回看（不含步骤卡，仅文本）。"""
    import uuid as _uuid
    from sqlalchemy import select
    from models.generation import Generation as _Gen
    try:
        cid = _uuid.UUID(conversation_id)
    except (ValueError, TypeError):
        return {"conversation_id": conversation_id, "messages": []}
    rows = (await db.execute(
        select(_Gen).where(
            _Gen.store_id == store.id,
            _Gen.conversation_id == cid,
            _Gen.type == "agent",
            _Gen.is_deleted == False,  # noqa: E712
        ).order_by(_Gen.created_at)
    )).scalars().all()
    messages: list[dict] = []
    for g in rows:
        uin = (g.input_params or {}).get("message") if g.input_params else None
        if uin:
            messages.append({"role": "user", "content": uin})
        if g.result:
            messages.append({"role": "assistant", "content": g.result})
    return {"conversation_id": conversation_id, "messages": messages}


class AgentChatRequest(BaseModel):
    message: str
    history: list[dict] | None = None
    model: str | None = None
    conversation_id: str | None = None  # 多轮续接：传它则后端按会话查历史(刷新不丢、省token)
    selected_files: list[str] | None = None  # 桌面版：老板经文件选择器选定、授权 Agent 读/改的文件绝对路径
    permission_mode: str | None = None  # 桌面权限：ask(默认)/auto_files(信任·自动改文件)/full(最高·全自动)
    full_disk_access: bool | None = None  # 高级·全盘：文件工具不限"内容库+选定文件"，可碰任意路径


@router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    injection = check_input_injection(body.message or "")
    if injection:
        raise AIServiceError(injection)

    await check_quota(db, str(store.id))

    # 注入"懂这家店"：门店画像（同步）+ 店脑记忆 → system prompt
    profile_text = render_operation_profile_context(store)
    memories = await load_store_memory(db, store.id)
    perm_mode, full_disk = _resolve_permission(body.permission_mode, body.full_disk_access)
    # 店脑按需召回：按老板这句话的相关性筛记忆，避免全量注入撑大 prompt（context rot）
    system_prompt = compose_agent_system_prompt(
        profile_text, format_memories_for_prompt(memories, intent=body.message), full_disk=full_disk,
    )
    # 桌面版：老板当场选定的文件 → 注入 prompt（告诉大脑路径）+ 进 ctx.allowed_paths（授权工具可动）
    if body.selected_files and os.environ.get("DESKTOP_LOCAL") == "1":
        note = _selected_files_note(body.selected_files)
        if note:
            system_prompt = system_prompt + "\n\n" + note

    ctx = AgentContext(
        db=db, store=store, user=user, allowed_paths=body.selected_files or [],
        permission_mode=perm_mode, full_disk_access=full_disk,
        auto_spend_limit=getattr(store, "agent_auto_spend_limit", None),
        model_ctx_window=_model_ctx_window(),  # SH-6：配了 DESKTOP_MODEL_CTX_WINDOW 才启用自动瘦身
    )

    # 多轮续接：有 conversation_id 则从 DB 查本会话历史(替代前端全量回传——刷新不丢、省 token、更可靠);否则用前端 history。
    # 统一走 _load_agent_history（与 /agent/execute 同一函数，单一来源，不再两处各抄一份"最近5轮"查询）。
    import uuid as _uuid
    history = body.history
    if body.conversation_id:
        db_hist = await _load_agent_history(db, store, body.conversation_id)
        if db_hist:  # DB 查到本会话历史 → 用它；查不到/失败则保留前端回传的 history
            history = db_hist

    history = _cap_history(history)  # 统一封顶：覆盖 DB 与前端两条路径，长对话不撑爆

    gen_id = str(_uuid.uuid4())
    try:
        conv_uuid = _uuid.UUID(body.conversation_id) if body.conversation_id else _uuid.UUID(gen_id)
    except (ValueError, TypeError):
        conv_uuid = _uuid.UUID(gen_id)

    # SH-8：把本会话已累积的「连续拒绝」计数注入 ctx，让循环里 _denial_fallback 能据此对【反复被拒的动作】
    # 自动回退（不再提请、改走文本/换方案）。故障安全：注不进就当无历史拒绝。
    denial_tracker.load_into_ctx(ctx, str(conv_uuid))

    async def event_generator():
        from services.agent.tools import DELIVERABLE_TOOLS
        final_content = ""
        deliverables: list[str] = []  # 交付类工具的产出(成品)，需并进 result 落库——否则下一轮看不到、改不了
        tools_used: list[str] = []    # 可观测：本轮模型选了哪些工具（含待审批的）
        tool_failures = 0             # 可观测：工具执行失败次数（喂"哪个工具/选择老出问题"）
        turns = 0
        try:
            async for event in run_agent_loop_stream(
                user_message=body.message,
                registry=default_registry,
                ctx=ctx,
                system_prompt=system_prompt,
                history=history,
                model=body.model,
                provider=build_resilient_text_provider(store),  # BYOK：对话走门店自带 key；某家挂了自动切备用档
            ):
                et = event.get("type")
                if et == "final":
                    final_content = event.get("content", "") or final_content
                if et in ("tool_call", "approval_request") and event.get("tool"):
                    tools_used.append(event.get("tool"))
                if et == "tool_result":
                    c = event.get("content") or ""
                    if c.startswith(("[工具执行失败]", "[工具不存在]")):
                        tool_failures += 1
                    if event.get("tool") in DELIVERABLE_TOOLS and c.strip():
                        deliverables.append(c)
                    # B-2 依据可见：loop 已把 knowledge_used 直接放进该 tool_result 事件，
                    # 下面 json.dumps(event) 原样透传给前端成品卡（无需在此重组，{**event,...} 也会保留它）。
                if et == "done":
                    turns = event.get("turns", 0) or 0
                    tokens_used = event.get("tokens_used", 0) or 0  # SH-2：循环累加的真实编排消耗
                    try:  # 工具使用可观测（故障安全，不影响 SSE）
                        from services.usage_event_service import log_event
                        await log_event("agent_tools", store_id=str(store.id),
                                        user_id=(str(user.id) if user else None),
                                        props={"tools": tools_used[:20], "failures": tool_failures,
                                               "turns": turns, "tokens_used": tokens_used})
                    except Exception:
                        pass
                    # 落库 result = 交付成品 + 收尾语：① 历史里看得到真内容 ② 下一轮"把刚才那条改一下"大脑读得到
                    persist_text = final_content
                    if deliverables:
                        tail = f"\n\n{final_content}" if final_content.strip() else ""
                        persist_text = "\n\n".join(deliverables) + tail
                    await _persist_agent_chat(db, store, user, body.message, persist_text, gen_id, conv_uuid,
                                              turns, tokens_used=tokens_used)
                    event = {**event, "generation_id": gen_id, "conversation_id": str(conv_uuid)}
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except Exception:
            logger.exception("agent chat stream error")
            yield f"data: {json.dumps({'type': 'error', 'error': '生成过程中出现错误，请重试'}, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
        background=BackgroundTask(_learn_in_background, str(store.id), body.message),
    )


class AgentExecuteRequest(BaseModel):
    tool: str
    args: dict | None = None
    selected_files: list[str] | None = None  # 同 chat：审批通过后执行写/改时，授权可动这些选定文件
    full_disk_access: bool | None = None     # 同 chat：全盘模式下手动确认的文件改动也需放行
    token: str | None = None                 # 审批提案签名（绑定本组 args，防前端篡改后再确认）
    conversation_id: str | None = None       # 审批回灌：执行后据此取历史，让管家基于结果自然接话


@router.post("/execute")
async def agent_execute(
    body: AgentExecuteRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """确认后执行一个需审批的工具（proposal 模式的执行端点）。

    只允许执行 requires_approval=True 的工具——这些是对话循环里被拦下、等用户点确认的对外/写入动作
    （未来的平台发布、群发客户等：对外不可逆，需人点头防自动对外/封号）。普通工具在循环里直接执行，不经此路径。
    工具自身的护栏（配额/限流/落库）由其 handler 负责；这里让其异常（如配额不足）正常抛出，
    由全局异常处理转成对用户友好的提示。
    """
    tool = default_registry.get(body.tool)
    if tool is None or not tool.requires_approval:
        raise AIServiceError("该操作不可执行，或无需经此确认")

    args = body.args or {}
    # 审批参数绑定（P3.2）：带了 token 就必须匹配本组 args（防"改了参数再确认"）；
    # 没带 token 放行（向后兼容旧客户端）——前端现都会回传 token，实际即绑定。
    if body.token is not None:
        from services.agent.approval import verify_approval
        if not verify_approval(body.tool, args, body.token):
            raise AIServiceError("确认信息已变化，请重新发起这次操作（请勿手动改动待确认的内容）")
    injection = check_input_injection(
        " ".join(str(v) for v in args.values() if isinstance(v, (str, int, float)))
    )
    if injection:
        raise AIServiceError(injection)

    _m, full_disk = _resolve_permission(None, body.full_disk_access)
    ctx = AgentContext(
        db=db, store=store, user=user, allowed_paths=body.selected_files or [],
        full_disk_access=full_disk,
        auto_spend_limit=getattr(store, "agent_auto_spend_limit", None),
        model_ctx_window=_model_ctx_window(),  # SH-6：同 chat，配了环境变量才启用
    )
    # SH-8：老板成功确认执行了这个动作 → 该动作的「连续拒绝」计数清零（他改主意了，回到正常审批节奏）。
    denial_tracker.clear_denial(body.conversation_id, _action_key(body.tool, args))
    # 续接循环用本会话最新拒绝计数（清完零的），让后续若再提别的动作仍受回退保护。
    denial_tracker.load_into_ctx(ctx, body.conversation_id)
    result = await tool.handler(args, ctx)
    if not isinstance(result, str):
        try:
            result = json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            result = str(result)

    # 审批回灌（修"断流"缝）：把执行结果喂回推理循环，让管家"知道"自己做了什么、
    # 自然地接话（"做好啦，要不要我配条文案？"），而不是对话死在这。失败不影响已执行结果。
    continuation = ""
    new_approval = None
    try:
        profile_text = render_operation_profile_context(store)
        memories = await load_store_memory(db, store.id)
        sys_prompt = compose_agent_system_prompt(profile_text, format_memories_for_prompt(memories), full_disk=full_disk)
        history = await _load_agent_history(db, store, body.conversation_id)
        synth = (
            f"[系统提示·非用户输入] 老板已确认、你刚请求的「{body.tool}」已执行完成。"
            f"结果摘要：{result[:300]}。请用一句话自然地告诉老板做好了，若合适顺带建议下一步该做什么；"
            f"不要重复粘贴上面的结果原文，也不要重新调用「{body.tool}」。"
        )
        cont = await run_agent_loop(
            user_message=synth, registry=default_registry, ctx=ctx,
            system_prompt=sys_prompt, history=history,
            provider=build_resilient_text_provider(store),  # 同上：失败自动切备用档
            max_turns=3,
        )
        continuation = cont.final_text or ""
        ap = next((s for s in cont.steps if s.type == "approval_request"), None)
        if ap:  # 续接里若又提出对外/写入动作，带出新审批卡（带签名）
            from services.agent.approval import sign_approval
            new_approval = {"tool": ap.tool_name, "args": ap.tool_args,
                            "token": sign_approval(ap.tool_name, ap.tool_args),
                            "preview": ap.preview,
                            "reason": ap.reason}  # SH-8：续接审批卡也带结构化理由，跟首张卡一致
        # 续接落库进同一会话，刷新不丢、下一轮续得上
        if body.conversation_id and continuation:
            import uuid as _uuid
            try:
                conv_uuid = _uuid.UUID(body.conversation_id)
                await _persist_agent_chat(db, store, user, f"（已确认执行 {body.tool}）",
                                          continuation, str(_uuid.uuid4()), conv_uuid, cont.turns)
            except (ValueError, TypeError):
                pass
    except Exception:
        logger.warning("审批回灌续接失败（不影响已执行结果）", exc_info=True)

    return {"tool": body.tool, "result": result, "continuation": continuation, "approval": new_approval}


class AgentRejectRequest(BaseModel):
    tool: str
    args: dict | None = None
    conversation_id: str | None = None  # 按会话累计拒绝计数，供"连续拒绝就别再提"判定


@router.post("/reject")
async def agent_reject(
    body: AgentRejectRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """SH-8：老板点了审批卡的「拒绝/取消」→ 记一次该动作的拒绝。

    同一动作连续拒绝达阈值后，下一轮循环里 _denial_fallback 会让 Agent 不再反复提请该动作、改走文本/换方案
    （"这个就先不做了，我换个法子"）。纯记账、不执行任何工具。故障安全：记不上也不报错给前端添堵。"""
    denial_tracker.record_denial(body.conversation_id, _action_key(body.tool, body.args or {}))
    return {"ok": True}


@router.post("/daily-drafts")
async def agent_daily_drafts(
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """主动出击：据今日推荐，预生成几条【文字草稿】给老板过目（只产草稿、不自动发；海报类不碰）。

    由老板主动触发（前端"帮我备好今天的"按钮）——要做什么由老板点一下，不做无人值守的定时自动生成。
    走 generate_workbench 管道，配额/落库/店脑/合规全生效；额度不足时由 check_quota 抛出友好提示。
    """
    from core.timezone import business_today
    from services.daily_scheduler import get_cached_drafts, save_drafts
    today = str(business_today())
    cached = get_cached_drafts(str(store.id), today)
    if cached is not None:
        return {"drafts": cached, "cached": True}  # 定时器/早先已备好 → 秒出、不再花 token
    await check_quota(db, str(store.id))
    drafts = await generate_daily_drafts(db, store, user, max_drafts=3)
    save_drafts(str(store.id), today, drafts)  # 缓存当天：二次点击秒出、定时器不再重复生成
    return {"drafts": drafts, "cached": False}
