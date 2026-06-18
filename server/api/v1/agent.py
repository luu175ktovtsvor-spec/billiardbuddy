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
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.proactive import generate_daily_drafts
from services.ai.factory import ProviderFactory
from services.agent.registry import default_registry
from services.memory_service import format_memories_for_prompt, load_store_memory, remember
from services.quota_service import check_quota
from services.store_profile_service import render_operation_profile_context
import services.agent.tools  # noqa: F401  导入即把内置工具登记进 default_registry

logger = logging.getLogger(__name__)
router = APIRouter()

_AGENT_BASE_PROMPT = (
    "你是台球房运营助手的 AI Agent。用大白话、简洁地帮台球房老板/店员完成日常运营工作。"
    "能用工具完成的就调工具（写文案、约客、经营诊断、做海报、写平台/团购内容等）。"
    "面向不懂技术的店员说话：少术语，给能直接拿去用的结果。"
    "【直接动手，别绕弯】用户已经明确说要做什么（写朋友圈/群公告/活动、做海报、发抖音小红书快手视频号、写团购、约某个客户、诊断经营问题）时，"
    "就直接调用对应工具去做。不要习惯性地先调 get_current_date 或 get_today_recommendation——"
    "这两个只在用户真的问『今天几号/是不是周末』，或开口问『今天该做点啥、给点建议』时才用；写具体内容时系统会自动带上当天日期，不必单独查。"
    "【会花钱/有后果的事】做海报、对外发布等，把方案想好后直接调用对应工具就行——系统会自动弹确认卡片让用户点，"
    "你不要再用文字反复问『行不行/要不要生成』，简短说一句你准备做什么即可。"
    "【交付内容会原样展示，别复述】写文案/活动方案/约客话术/诊断/玩法/平台内容/团购套餐这些工具产出的成品，"
    "系统会原样、完整地展示给用户(可一键复制)，你绝不要在回复里再把整段内容抄一遍或改写精简——"
    "那既多余又会让校准过的内容失真。你只需用一句话说『写好啦，你看看，要改告诉我』这类简短引导即可。"
    "【红线·只有这两件事死活不碰】① 把助教服务直接卖成实际性交易（性服务/援交/陪睡/上门过夜/特殊服务这类）；"
    "② 门店自己当庄、定盘口、按局抽水组织赌球（开设赌场罪）。遇到这两类——"
    "**绝不调用任何工具，哪怕想写个『干净版』也不行**；先停下，一两句说清为什么不能这么搞、给走正路的替代。"
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


_DESKTOP_FILE_OPS_HINT = (
    "【你能直接操作老板本机的文件（桌面版）】你在老板自己的电脑上运行，有一组本地文件工具：\n"
    "- list_files 看内容库里有什么、read_file 读某个文件、write_file 存文件、edit_file 改文本某段、edit_excel 直接改 Excel 报表(改营业额/加列等)。\n"
    "- 老板说『把刚才那份存下来』『把报表里营业额改成 X』『给文案改个价』这类，就**真的去读、去改文件**，别只在对话里复述。\n"
    "- 改之前**先 read_file 看清内容/单元格坐标**再改；写/改会先弹给老板确认、自动备份原件、可回滚——放心动手。"
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


def compose_agent_system_prompt(profile_text: str, brain_text: str) -> str:
    """拼 agent 的 system prompt：基底指令 + 当天日期 + 门店画像 + 店脑记忆（让它"懂当下、懂这家店"）。"""
    parts = [_AGENT_BASE_PROMPT]
    today = _today_line()
    if today:
        parts.append(today)
    # 桌面全本地版：告诉大脑它能直接读写改本机文件，它才会主动用文件工具（云端 web 版不设 DESKTOP_LOCAL→不加）。
    if os.environ.get("DESKTOP_LOCAL") == "1":
        parts.append(_DESKTOP_FILE_OPS_HINT)
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


async def _persist_agent_chat(db, store, user, message: str, content: str, gen_id: str, conv_uuid, turns: int) -> None:
    """落库 agent 会话(type=agent)+conversation_id,供刷新续接/分析,并打点。故障安全:失败不阻断 SSE。"""
    import uuid as _uuid
    try:
        from models.generation import Generation
        db.add(Generation(
            id=_uuid.UUID(gen_id), store_id=store.id, user_id=(user.id if user else None),
            type="agent", sub_type="chat", input_params={"message": message},
            prompt_used=message, result=(content or ""), model_used="agent", tokens_used=0,
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
            if uin:
                hist.append({"role": "user", "content": uin})
            if g.result:
                hist.append({"role": "assistant", "content": g.result[:2000]})
        return hist
    except Exception:
        logger.warning("agent 历史加载失败 conversation_id=%s", conversation_id, exc_info=True)
        return []


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
    system_prompt = compose_agent_system_prompt(profile_text, format_memories_for_prompt(memories))
    # 桌面版：老板当场选定的文件 → 注入 prompt（告诉大脑路径）+ 进 ctx.allowed_paths（授权工具可动）
    if body.selected_files and os.environ.get("DESKTOP_LOCAL") == "1":
        note = _selected_files_note(body.selected_files)
        if note:
            system_prompt = system_prompt + "\n\n" + note

    perm_mode, full_disk = _resolve_permission(body.permission_mode, body.full_disk_access)
    ctx = AgentContext(
        db=db, store=store, user=user, allowed_paths=body.selected_files or [],
        permission_mode=perm_mode, full_disk_access=full_disk,
    )

    # 多轮续接：有 conversation_id 则从 DB 查本会话历史(替代前端全量回传——刷新不丢、省 token、更可靠);否则用前端 history
    import uuid as _uuid
    history = body.history
    if body.conversation_id:
        try:
            from sqlalchemy import select
            from models.generation import Generation as _Gen
            rows = (await db.execute(
                select(_Gen).where(
                    _Gen.store_id == store.id,
                    _Gen.conversation_id == _uuid.UUID(body.conversation_id),
                    _Gen.type == "agent",
                    _Gen.is_deleted == False,  # noqa: E712
                ).order_by(_Gen.created_at)
            )).scalars().all()
            hist: list[dict] = []
            for g in rows[-5:]:  # 只取最近5轮，控 context
                uin = (g.input_params or {}).get("message")
                if uin:
                    hist.append({"role": "user", "content": uin})
                if g.result:
                    hist.append({"role": "assistant", "content": g.result[:2000]})
            if hist:
                history = hist
        except Exception:
            logger.warning("agent 历史加载失败 conversation_id=%s", body.conversation_id, exc_info=True)

    gen_id = str(_uuid.uuid4())
    try:
        conv_uuid = _uuid.UUID(body.conversation_id) if body.conversation_id else _uuid.UUID(gen_id)
    except (ValueError, TypeError):
        conv_uuid = _uuid.UUID(gen_id)

    async def event_generator():
        from services.agent.tools import DELIVERABLE_TOOLS
        final_content = ""
        deliverables: list[str] = []  # 交付类工具的产出(成品)，需并进 result 落库——否则下一轮看不到、改不了
        turns = 0
        try:
            async for event in run_agent_loop_stream(
                user_message=body.message,
                registry=default_registry,
                ctx=ctx,
                system_prompt=system_prompt,
                history=history,
                model=body.model,
                provider=ProviderFactory.get_text_provider_for_store(store),  # BYOK：对话也走门店自带 key
            ):
                et = event.get("type")
                if et == "final":
                    final_content = event.get("content", "") or final_content
                if et == "tool_result" and event.get("tool") in DELIVERABLE_TOOLS:
                    c = event.get("content") or ""
                    if c.strip():
                        deliverables.append(c)
                if et == "done":
                    turns = event.get("turns", 0) or 0
                    # 落库 result = 交付成品 + 收尾语：① 历史里看得到真内容 ② 下一轮"把刚才那条改一下"大脑读得到
                    persist_text = final_content
                    if deliverables:
                        tail = f"\n\n{final_content}" if final_content.strip() else ""
                        persist_text = "\n\n".join(deliverables) + tail
                    await _persist_agent_chat(db, store, user, body.message, persist_text, gen_id, conv_uuid, turns)
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

    只允许执行 requires_approval=True 的工具——这些是对话循环里被拦下、等用户点确认的动作
    （如生图：花钱）。普通工具在循环里直接执行，不经此路径。
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
    )
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
        sys_prompt = compose_agent_system_prompt(profile_text, format_memories_for_prompt(memories))
        history = await _load_agent_history(db, store, body.conversation_id)
        synth = (
            f"[系统提示·非用户输入] 老板已确认、你刚请求的「{body.tool}」已执行完成。"
            f"结果摘要：{result[:300]}。请用一句话自然地告诉老板做好了，若合适顺带建议下一步该做什么；"
            f"不要重复粘贴上面的结果原文，也不要重新调用「{body.tool}」。"
        )
        cont = await run_agent_loop(
            user_message=synth, registry=default_registry, ctx=ctx,
            system_prompt=sys_prompt, history=history,
            provider=ProviderFactory.get_text_provider_for_store(store),
            max_turns=3,
        )
        continuation = cont.final_text or ""
        ap = next((s for s in cont.steps if s.type == "approval_request"), None)
        if ap:  # 续接里若又提出花钱/对外动作，带出新审批卡（带签名）
            from services.agent.approval import sign_approval
            new_approval = {"tool": ap.tool_name, "args": ap.tool_args,
                            "token": sign_approval(ap.tool_name, ap.tool_args)}
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


@router.post("/daily-drafts")
async def agent_daily_drafts(
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """主动出击：据今日推荐，预生成几条【文字草稿】给老板过目（只产草稿、不自动发；海报类不碰）。

    由老板主动触发（前端"帮我备好今天的"按钮）——BYOK 下不背着人烧钱，不做无人值守定时自动生成。
    走 generate_workbench 管道，配额/落库/店脑/合规全生效；额度不足时由 check_quota 抛出友好提示。
    """
    await check_quota(db, str(store.id))
    drafts = await generate_daily_drafts(db, store, user, max_drafts=3)
    return {"drafts": drafts}
