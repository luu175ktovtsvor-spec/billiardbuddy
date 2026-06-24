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

from fastapi import APIRouter, Depends, Form, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.agent import skills as _agent_skills  # noqa: F401  注册 skill 工具 + 渲染技能清单（渐进披露）
from services.agent import computer_tools as _agent_computer  # noqa: F401  注册 computer_view/computer_control（DESKTOP_LOCAL）
from services.agent import image_tools as _agent_image  # noqa: F401  注册 edit_image 本机改图（DESKTOP_LOCAL）
from services.agent import background_tools as _agent_bg  # noqa: F401  注册 run_background（DESKTOP_LOCAL）
from services.agent import reminders as _agent_reminders  # noqa: F401  注册 schedule_reminder/list/cancel（DESKTOP_LOCAL）
from services.agent import plugins as _agent_plugins  # noqa: F401  注册 install_plugin（DESKTOP_LOCAL）
from services.agent import mcp_client as _agent_mcp  # noqa: F401  MCP 客户端（动态发现外部 server 工具）
from services.agent.goal_hook import install_goal_hook as _install_goal_hook
_install_goal_hook()  # /goal 目标驱动 Stop hook（常驻；无 ctx.goal 时 no-op）
from starlette.background import BackgroundTask

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import AIServiceError, AppException
from core.security_guard import check_input_injection
from db.session import async_session
from models.user import User
from services.agent.context import AgentContext
from services.agent import denial_tracker
from services.agent.loop import _action_key, run_agent_loop, run_agent_loop_stream
from services.agent.multimodal import is_media, needs_video_upload, resolve_media_for_upload
from services.agent.proactive import generate_daily_drafts
from services.ai.failover import build_resilient_text_provider  # BYOK 失败自动切备用配置档
from services.ai.prompt_engine import get_prompt_engine  # L0 核心层(core.*)注入台球 system prompt
from services.agent.registry import default_registry, general_registry, billiards_registry, BILLIARDS_TOOL_NAMES
from services.memory_service import format_memories_for_prompt, load_store_memory, remember
from services.quota_service import check_quota
from services.store_profile_service import render_operation_profile_context
import services.agent.tools  # noqa: F401  导入即把内置工具登记进 default_registry
import services.agent.web_tools  # noqa: F401  第二批：WebFetch/WebSearch/TodoWrite/run_subagent 登记进 default_registry

logger = logging.getLogger(__name__)
router = APIRouter()

# ══════════════════════════════════════════════════════════════════════════
# 系统提示三段（通用 Agent 化）：
#   _GENERIC_BASE_PROMPT  通用 AI 助手身份 + 工作风格（默认，永远注入）
#   _SAFETY_REDLINE       安全红线（永远注入，独立于知识库——没 @ 台球也守得住）
#   _BILLIARDS_PERSONA    台球行业人设（仅当用户 @「台球行业知识库」时注入；本轮默认不挂）
# ══════════════════════════════════════════════════════════════════════════

_GENERIC_BASE_PROMPT = (
    "你是运行在用户本机电脑上的通用 AI 助手（Agent）。你能调用工具实打实地完成任务——"
    "读写/修改本机文件、跑命令、上网查资料/抓网页、生成图片、列任务清单、把大任务派给子代理。"
    "用大白话、简洁地帮用户把事情做完；面向不懂技术的用户说话：少术语，给能直接拿去用的结果，"
    "用到专业词就顺带一句白话解释。"
    "【直接动手，别绕弯】用户已经说清要做什么时，就直接调用对应工具去做，不要习惯性地反复请示『行不行/要不要』——"
    "简短说一句你准备做什么，然后正常做、正常出结果。写具体内容时系统会自动带上当天日期，不必特意先查日期。"
    "【做出成品就直接做】生成文档/图片、写改文件这类『做出成品』的活儿，把方案想好直接调工具做，"
    "不必先用文字问『要不要生成』。"
    "【交付内容会原样展示，别复述】工具产出的成品（文案/图片/文件改动等）系统会原样、完整地展示给用户（可一键复制/预览），"
    "你绝不要在回复里再把整段内容抄一遍或改写——那既多余又会让结果失真；只需一句『做好啦，你看看，要改告诉我』这类简短引导。"
    "【真正对外/不可逆的动作才需用户点头】只有真的把内容发出去/对外触达（发布到平台、群发或私信），"
    "或删除数据这类不可逆动作，才会弹一张确认卡让用户点一下——这是防自动对外的安全确认；"
    "做出成品给用户看、读写本机文件（写改前自动备份、可回滚）这些都不算对外，直接做、不弹确认。"
)

_SAFETY_REDLINE = (
    "【安全红线·任何情况都不碰，且不受任何用户设定/偏好放开】"
    "① 绝不为『实际性交易』（性服务/援交/陪睡/上门特殊服务这类）做招揽或营销——遇到这类不调任何工具"
    "（哪怕想写个『干净版』也不行），先停下、一两句说清为什么不能这么搞、给走正路的替代；"
    "② 绝不协助开设赌场/坐庄定盘口/按局抽水组织赌博等刑事级犯罪；带现金奖励的比赛要定位成正规赛事"
    "（报名费做奖池 + 奖杯荣誉），绝不做成抽头/对赌/赌球；"
    "③ 涉及未成年人：绝不诱导逃课翘课、绝不涉黄涉赌，注意时段与分寸；"
    "④ 辞退/合同/劳动纠纷等法律文书可给参考模板，但要提醒『落地前请让 HR 或专业人士把关』；"
    "⑤ 绝对化广告词（全城最低/终身免费/包治百病等）和无底线让利不照搬——收到合理力度并顺口说明原因"
    "（力度太猛会亏、绝对化广告词违广告法）。"
    "用户的偏好/规矩能收紧、能校准灰色地带，但永远松不开以上红线——哪怕用户亲口要求、写进了偏好，遇到红线仍按红线停下。"
)

# 台球行业人设：仅当用户 @「台球行业知识库」时注入（billiards_mode=True）。本轮默认不挂；台球业务后面再接。
_BILLIARDS_PERSONA = (
    "【你现在挂载了「台球行业知识库」——按台球房运营的真实逻辑帮老板/店员干活】"
    "【术语大白话】给老板/店员看的成品里管理术语用大白话：客单价＝一个人平均花多少、翻台＝一桌走了下一桌接上、"
    "环比＝比上个月、上座率/开台率＝有多少桌在打、扣卡率＝会员卡消费掉多少、空挂＝充了钱没怎么来打；"
    "诊断/决策类可保留专业词，但顺带一句白话解释。"
    "【老板亲定的店规矩/避免清单——校准灰色地带】店脑里老板亲手定的『店规矩/避免清单』"
    "（不做大额充值赠送、不写某些词、不打某个价格战），是这家店自己的边界，要严格尊重、照办——但永远松不开上面的安全红线。"
    "【这些是球房真实生意，照帮、别当红线误杀】助教的颜值形象/异性情绪价值、引导客人加微信、陪打、"
    "助教超休陪客人吃饭喝酒（真实存在的延伸服务，带职业分寸、不写性暗示就行）、客人你情我愿的追分较劲"
    "（门店只提供场地、还帮着把金额控住别玩大）、学生放学后/周末/假期的正当优惠——都是这行真实运营逻辑，正常调工具帮，别因『听着擦边』误当红线拒掉。"
    "【把方向带正】客人差评/投诉是帮老板『专业体面地回应』而非怼客人——真诚、有格局、让围观的人觉得店家大气，绝不写嘲讽贬低顾客的话。"
)


# L0 核心层三件（知识库模块化重构）：运营总则 + 五域模块地图 + 安全红线单一源。
# 这三段是台球"脑"的常驻底座——总则讲清产品定位与"骨架在此、场景临场延伸、细则按需查"的工作方式，
# 模块地图给五域任务路由（agent 据此判断任务属哪域 → 用 look_up_knowledge 查该域 L1 目录页/细则），
# 安全红线是全产品唯一可信源（其余知识只引用不复述）。仅 @台球 时注入。
_CORE_LAYER_KEYS = ("core.operating_principles", "core.module_map", "core.safety_redlines")


def _render_core_layer() -> str:
    """取 L0 核心层三件的正文拼成一段，注入台球 system prompt。

    直接读 template 原文（这三件 variables 为空、无 {占位符}），**不走 prompt_engine.render()**——
    render() 会给 category!=knowledge 的模板前置【当前时间】日期头（与 _today_line 重复、每天变，
    会顶掉服务端前缀缓存）。缺文件时静默跳过，保证故障安全。"""
    try:
        eng = get_prompt_engine()
    except Exception:
        return ""
    parts: list[str] = []
    for key in _CORE_LAYER_KEYS:
        data = eng._templates.get(key) or {}
        tpl = (data.get("template") or "").strip()
        if tpl:
            parts.append(tpl)
    return "\n\n".join(parts)


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
    "- run_command：跑一条命令（ls/find/python 脚本/git status 等），「标准/自动编辑」档每条都把命令原文弹给老板确认才执行，"
    "「完全自主」档则自己跑（命令显示在对话里、老板可随时打断）；禁止用 && | ; > < 等拼接，危险命令(删根/提权/格式化)会被直接拒。\n"
    "你就是长在老板这台电脑上的助手：他说「去桌面找那个文件夹/那个报表」你就 find_files 去找、找到 read_file 去读、要改就 edit_file/edit_excel——大胆动手，写改都会先确认+自动备份。\n"
    "【你就是长在用户这台电脑上的通用助手】本机上的活你都能干：在桌面/任意目录新建文件夹、读改任意文件（包括 ~/.claude/CLAUDE.md 这种全局配置）、跑脚本/命令整理资料、生成任何文档/图片。"
    "用户让你干什么，你就用文件/命令/生图工具实打实地去干，别给自己设限。"
)


_VALID_PERMISSION_MODES = {"ask", "auto_files", "full", "plan"}


def _resolve_permission(mode: str | None, full_disk: bool | None) -> tuple[str, bool]:
    """把请求里的权限/范围设置收敛成安全值。
    非桌面（云端 web 多租户）一律强制 ask + 无全盘——那里压根没注册本地文件工具，
    且绝不能让某租户的请求拿到任何文件自主权（防御性）。"""
    if os.environ.get("DESKTOP_LOCAL") != "1":
        return "ask", False
    m = mode if mode in _VALID_PERMISSION_MODES else "ask"
    # 桌面单机版（老板自己的机器 + 自带 key）：默认放开「完全本地访问」——能找/读/改本机任意文件、跑命令，
    # 像 Claude Code 一样真长在电脑上。安全不靠把能力锁死，而靠：① 权限模式（默认「标准」每步先弹确认）；
    # ② 写/改前自动备份可回滚；③ 危险命令黑名单；④ 对外群发/平台发布仍强制确认（封号红线）。
    # 仅当请求显式传 false 时才收回为「内容库+选定文件」受限沙箱。
    fd = True if full_disk is None else bool(full_disk)
    return m, fd


# 已知模型的上下文窗口（token）：给 autocompact 一道"模型自适应"的默认安全网。
# 只登记我们确知窗口的模型（内置 mimo-v2.5 = 1M·小米官方）——给它一道防溢出兜底，长任务顶满前自动语义瘦身，
# 不再"默认全关、几十轮长任务裸奔顶满窗口被 provider 直接报错"（G.1 P0）。窗口 1M 下触发点≈700k token，
# 正常对话永远碰不到 → 不会过早压缩、不伤质量/缓存，只在真·失控长任务时兜底。
# 表外/未知 BYOK 模型保持 None＝沿用旧的"默认不启用、需 DESKTOP_MODEL_CTX_WINDOW 显式开"
# （窗口未知，乱设一个常数反而误触发/迟触发）。子串匹配 → mimo-v2.5 / mimo-v2.5-pro 都命中。
_KNOWN_MODEL_CTX_WINDOWS = {
    "mimo-v2.5": 1_000_000,
}


def _model_ctx_window() -> int | None:
    """SH-6/G.1 autocompact 触发用的模型上下文窗口（token）。
    优先级：① 环境变量 DESKTOP_MODEL_CTX_WINDOW 显式配置（最高，覆盖一切）；② 当前编排模型在已知窗口表里
    → 用其窗口（给内置 mimo 这类已知模型防溢出安全网）；③ 表外/未知 BYOK 模型 → None＝默认不启用。
    非法值按 None。"""
    try:
        v = int(os.environ.get("DESKTOP_MODEL_CTX_WINDOW", "") or 0)
        if v > 0:
            return v
    except (TypeError, ValueError):
        pass
    try:
        from config import settings
        name = (settings.effective_orchestration_model or "").strip().lower()
    except Exception:
        name = ""
    for key, win in _KNOWN_MODEL_CTX_WINDOWS.items():
        if key in name:
            return win
    return None


def _build_agent_registry(billiards_mode: bool):
    """本次请求的工具表 = 通用/台球工具 + 已配置 MCP server 的工具（动态发现，缓存）。"""
    reg = billiards_registry() if billiards_mode else general_registry()
    try:
        for mt in _agent_mcp.load_mcp_tools():
            if reg.get(mt.name) is None:
                reg.register(mt)
    except Exception:
        pass
    return reg


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


def compose_agent_system_prompt(profile_text: str, brain_text: str, full_disk: bool = False,
                                billiards_mode: bool = False, output_style: str = "") -> str:
    """拼 agent 的 system prompt。

    本体是【通用 AI Agent】：默认只注入通用身份 + 安全红线 + 通用/桌面文件能力。
    仅当用户 @ 了「台球行业知识库」(billiards_mode=True) 时，才追加台球人设 + 门店画像 + 店脑记忆——
    默认就是个通用电脑助手，台球只是可挂载的领域知识。安全红线【永远注入】、与 billiards_mode 无关
    （没 @ 台球也守得住性交易/赌博/未成年红线）。

    顺序铁律（缓存稳定·借鉴 learn-claude-code s10）：先放【字节稳定】的静态段（通用身份 + 红线 + 能力 hint
    +【@台球时】L0 核心层 core.* 三件 + 台球人设——这些会话内不变），再放每天/每店/每句变的【动态尾段】
    （当天日期 + 门店画像 + 店脑记忆）。动态串绝不插进静态前缀中间，否则顶掉服务端自动前缀缓存命中
    （DeepSeek/硅基流动等 OpenAI 兼容端点按请求前缀自动命中，省钱省延迟）。
    full_disk=True（开了完全访问模式）时额外注入"可找/搜文件、列任意目录、跑命令"的 hint。"""
    # —— 静态前缀：通用身份 + 安全红线(永远) + 通用能力 + 桌面文件能力（与当天/门店无关，逐字节稳定，可被前缀缓存复用）——
    parts = [_GENERIC_BASE_PROMPT, _SAFETY_REDLINE, _WEB_AGENT_TOOLS_HINT]
    # 桌面全本地版：告诉大脑它能直接读写改本机文件，它才会主动用文件工具（云端 web 版不设 DESKTOP_LOCAL→不加）。
    if os.environ.get("DESKTOP_LOCAL") == "1":
        parts.append(_DESKTOP_FILE_OPS_HINT)
        # 完全访问模式：再告诉它能自己找/搜文件、列任意目录、跑命令（会弹卡确认）。
        if full_disk:
            parts.append(_DESKTOP_FULL_ACCESS_HINT)
        # 渐进式披露：已安装技能(Skill)的"名字+描述"清单(正文调用时才展开)。session 稳定，放动态日期之前(守前缀缓存)。
        # G.2：通用模式不披露台球领域技能（擦边/上钟等仅 @台球 时才进系统提示），守"通用 Agent 为默认"定位。
        try:
            _sk_section = _agent_skills.render_skills_for_prompt(billiards_mode=billiards_mode)
            if _sk_section:
                parts.append(_sk_section)
        except Exception:
            pass
    # 输出风格（用户选的，session 稳定）：追加一段风格指令。通用，与 DESKTOP_LOCAL 无关。
    if output_style:
        try:
            from services.agent.output_styles import render_output_style_prompt
            _os_section = render_output_style_prompt(output_style)
            if _os_section:
                parts.append(_os_section)
        except Exception:
            pass
    # —— 台球 L0 核心层（运营总则 + 五域模块地图 + 安全红线单一源）+ 台球人设：仅 @台球 时注入。
    # 放在【当天日期之前】的静态前缀区——这几段 byte 稳定（不随日期/门店/这句话变），守服务端前缀缓存；
    # 真正每天/每店/每句变的（当天日期 + 门店画像 + 店脑记忆）才进下面的动态尾段。
    if billiards_mode:
        core_layer = _render_core_layer()
        if core_layer:
            parts.append(core_layer)
        parts.append(_BILLIARDS_PERSONA)
    # —— 动态尾段：当天日期（通用也需要）→ 仅 @台球 时：门店画像 + 店脑记忆 ——
    today = _today_line()
    if today:
        parts.append(today)
    if billiards_mode:
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
                              tokens_used: int = 0, source_rec_id: str | None = None) -> None:
    """落库 agent 会话(type=agent)+conversation_id,供刷新续接/分析,并打点。故障安全:失败不阻断 SSE。
    SH-2：tokens_used 拿循环累加的真实编排消耗（喂 BYOK 成本看板），端点没返回时为粗估值。
    source_rec_id：本次对话若由今日推荐触发，记下是哪条 → 隐式反馈"采纳上浮"（behavior_service 据此聚合）。"""
    import uuid as _uuid
    try:
        from models.generation import Generation
        db.add(Generation(
            id=_uuid.UUID(gen_id), store_id=store.id, user_id=(user.id if user else None),
            type="agent", sub_type="chat", input_params={"message": message},
            prompt_used=message, result=(content or ""), model_used="agent",
            tokens_used=(tokens_used or 0),
            conversation_id=conv_uuid,
            source_rec_id=(source_rec_id or None),
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
        c = m.get("content")
        if isinstance(c, str):
            out.append({**m, "content": c[:_HIST_MAX_CHARS]} if len(c) > _HIST_MAX_CHARS else m)
        elif isinstance(c, list):
            # 多模态历史（list of parts）：逐 text 段按预算截断、图片段原样保留。
            # （旧版 len(list)/list[:N] 把"段数"当字符数 → 对带图历史截断完全失效，G.1 类型 bug。）
            budget = _HIST_MAX_CHARS
            capped: list = []
            for part in c:
                if isinstance(part, dict) and part.get("type") == "text":
                    t = str(part.get("text") or "")
                    if budget <= 0:
                        continue
                    t = t[:budget]
                    budget -= len(t)
                    capped.append({**part, "text": t})
                else:
                    capped.append(part)
            out.append({**m, "content": capped})
        else:
            out.append(m)
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
    knowledge_packs: list[str] | None = None  # @ 挂载的知识库（如 ["billiards"]）；含 "billiards" → 切台球专家模式
    output_style: str | None = None  # 输出风格名（如 "explanatory"/"concise"），空=默认
    goal: str | None = None  # /goal 目标驱动：本次会话的目标条件，空=不启用
    source_rec_id: str | None = None  # 隐式反馈：本次对话由今日推荐哪一条触发（rec.id），落到 generation 上做"采纳上浮"


@router.get("/skills")
async def agent_list_skills(billiards: bool = False, user: User = Depends(get_current_user)):
    """列出已安装技能(Skill)，供前端 `/` 命令面板展示。技能=文件系统全局、与门店无关。
    G.2：默认（billiards=false）只列通用技能，台球领域技能（擦边/上钟/团购等）仅在前端挂了
    台球知识库、传 billiards=true 时才列出——别让普通用户的命令面板看到台球擦边技能。"""
    skills = _agent_skills.filter_skills_by_mode(_agent_skills.load_skills(), billiards)
    items = [
        {
            "name": s.name, "description": s.description, "source": s.source,
            "argument_hint": s.argument_hint, "user_invocable": s.user_invocable,
        }
        for s in skills
    ]
    return {"skills": items}


@router.get("/output-styles")
async def agent_list_output_styles(user: User = Depends(get_current_user)):
    """列出可用输出风格，供前端切换。"""
    from services.agent import output_styles as _os
    items = [
        {"name": s.name, "description": s.description, "source": s.source}
        for s in _os.load_output_styles()
    ]
    return {"output_styles": items}


@router.get("/mcp")
async def agent_list_mcp(refresh: bool = False, user: User = Depends(get_current_user)):
    """列出已配置 MCP server 的连接状态 + 工具数。P2：默认走短 TTL 缓存（设置页反复打开不再每次重握手 5 个
    server ≈ 9s）；refresh=true 强制重探。配置变更（add/remove）已自动失效缓存，故无需每次都强刷工具缓存。"""
    from services.agent import mcp_client as _mc
    status = _mc.mcp_status(force=refresh)
    if refresh:
        try:
            _mc.load_mcp_tools(force=True)
        except Exception:
            pass
    return {"servers": status}


@router.get("/mcp/presets")
async def agent_mcp_presets(user: User = Depends(get_current_user)):
    """免 key 的官方 MCP server 预设（fetch/time/memory/DuckDuckGo），供界面"一键加"。"""
    from services.agent.mcp_config import MCP_PRESETS
    return {"presets": MCP_PRESETS}


def _require_desktop() -> None:
    """这些管理端点只在桌面单机版可用；云端 web 多租户严禁让某租户改服务器侧的 MCP/插件配置。"""
    if os.environ.get("DESKTOP_LOCAL") != "1":
        raise HTTPException(status_code=403, detail="该操作仅在桌面版可用")


class McpAddRequest(BaseModel):
    name: str
    command: str
    args: list[str] | None = None
    env: dict | None = None


@router.post("/mcp/add")
async def agent_mcp_add(body: McpAddRequest, user: User = Depends(get_current_user)):
    """界面加/覆盖一个 MCP server（写门店库 .mcp.json，原子写）。成功后刷新工具缓存，下次对话生效。"""
    _require_desktop()
    from services.agent import mcp_config as _mcfg
    ok, msg = _mcfg.add_server(body.name, body.command, body.args, body.env)
    if ok:
        try:
            from services.agent import mcp_client as _mc
            _mc.invalidate_mcp_cache()  # 清工具+状态缓存，下次取即重握手（新 server 生效）
            _mc.load_mcp_tools(force=True)
        except Exception:
            pass
    return {"ok": ok, "message": msg}


class McpNameRequest(BaseModel):
    name: str


@router.post("/mcp/remove")
async def agent_mcp_remove(body: McpNameRequest, user: User = Depends(get_current_user)):
    """界面删一个 MCP server（写门店库 .mcp.json，原子写）。"""
    _require_desktop()
    from services.agent import mcp_config as _mcfg
    ok, msg = _mcfg.remove_server(body.name)
    if ok:
        try:
            from services.agent import mcp_client as _mc
            _mc.invalidate_mcp_cache()  # 清工具+状态缓存，下次取即重握手（删掉的 server 不再出现）
            _mc.load_mcp_tools(force=True)
        except Exception:
            pass
    return {"ok": ok, "message": msg}


class McpToggleRequest(BaseModel):
    name: str
    disabled: bool


@router.post("/mcp/toggle")
async def agent_mcp_toggle(body: McpToggleRequest, user: User = Depends(get_current_user)):
    """界面启用/停用一个 MCP server（写 disabled 标记，配置仍留着）。"""
    _require_desktop()
    from services.agent import mcp_config as _mcfg
    ok, msg = _mcfg.set_server_disabled(body.name, body.disabled)
    if ok:
        try:
            from services.agent import mcp_client as _mc
            _mc.load_mcp_tools(force=True)
        except Exception:
            pass
    return {"ok": ok, "message": msg}


@router.get("/plugins")
async def agent_list_plugins(user: User = Depends(get_current_user)):
    """列出本地插件（名字/启用/描述/组件计数）。插件的技能/风格/MCP 已自动并入对应系统。"""
    from services.agent import plugins as _plugins
    return {"plugins": _plugins.list_plugins()}


class PluginToggleRequest(BaseModel):
    name: str
    enabled: bool


@router.post("/plugins/toggle")
async def agent_plugin_toggle(body: PluginToggleRequest, user: User = Depends(get_current_user)):
    """界面启用/停用一个插件（改它的 plugin.json `enabled`）。重开会话生效。"""
    _require_desktop()
    from services.agent import plugins as _plugins
    ok, msg = _plugins.set_plugin_enabled(body.name, body.enabled)
    return {"ok": ok, "message": msg}


class PluginInstallRequest(BaseModel):
    repo: str


@router.post("/plugins/install")
async def agent_plugin_install(body: PluginInstallRequest, user: User = Depends(get_current_user)):
    """界面从 GitHub 装插件（owner/repo 或 https url），git clone 到门店插件库。"""
    _require_desktop()
    from services.agent import plugins as _plugins
    ok, msg = _plugins.install_plugin_from_github(body.repo)
    return {"ok": ok, "message": msg}


class ImageValidateRequest(BaseModel):
    base_url: str | None = None
    model: str | None = None


@router.post("/image/validate")
async def agent_image_validate(body: ImageValidateRequest, user: User = Depends(get_current_user)):
    """温和校验生图 model 是否属于所选 base_url 那家供应商（按 IMAGE_PROVIDER_CATALOG）。
    不匹配返回 ok=False + 一句"模型名跟所选供应商对不上，确认下？"；未知端点不拦。"""
    from services.ai.providers.image_catalog import validate_image_model
    return validate_image_model(body.base_url, body.model)


class ImWebhookRequest(BaseModel):
    text: str
    platform: str | None = None


@router.post("/im/webhook")
async def im_webhook(body: ImWebhookRequest, x_im_secret: str = Header(default="")):
    """通用 IM webhook（飞书/微信/钉钉/WhatsApp 用，配内网穿透 POST 进来）。密钥保护：
    需 env `IM_WEBHOOK_SECRET` 且请求头 `X-Im-Secret` 匹配；未设密钥=端点禁用。"""
    from services.agent.im_telegram import handle_im_webhook
    status, payload = await handle_im_webhook(body.text or "", x_im_secret)
    if status != 200:
        raise HTTPException(status_code=status, detail=payload.get("detail", "error"))
    return payload


@router.post("/im/wechat")
async def im_wechat(
    type: str = Form(default="text"),
    content: str = Form(default=""),
    source: str = Form(default=""),
    isMentioned: str = Form(default="0"),
    isMsgFromSelf: str = Form(default="0"),
    token: str | None = None,
):
    """对接 wechatbot-webhook（个人微信本地桥）：店主在本机跑 wechatbot-webhook、扫码登小号、把它的
    RECVD_MSG_API 指向本端点（建议带 `?token=<IM_WEBHOOK_SECRET>`）。微信来消息 → 这里跑 Agent →
    按它要的 JSON 返回 → 它发回微信，即「微信发消息 → 本地 Agent 响应」。
    安全：① 配了 IM_WEBHOOK_SECRET 才校验 token；② 只回文本、不回自己发的（防自回环）；
    ③ 群里只回 @ 我的；④ 配了 IM_WECHAT_ALLOW（逗号分隔微信名/id）则只回名单内的人。"""
    import os
    import json as _json
    from services.agent.im_telegram import _run_agent_for_im

    secret = os.environ.get("IM_WEBHOOK_SECRET")
    if secret and token != secret:
        return {"success": False, "error": "forbidden"}
    if type != "text" or isMsgFromSelf == "1" or not (content or "").strip():
        return {"success": True}  # 非文本 / 自己发的 / 空 → 静默不回

    try:
        src = _json.loads(source) if source else {}
    except Exception:
        src = {}
    if src.get("room") and isMentioned != "1":
        return {"success": True}  # 群里没 @ 我 → 不回

    allow = os.environ.get("IM_WECHAT_ALLOW")
    if allow:
        names = {a.strip() for a in allow.split(",") if a.strip()}
        sender = src.get("from") or {}
        if not (names & {str(sender.get("name") or ""), str(sender.get("id") or "")}):
            return {"success": True}  # 不在白名单 → 不回

    reply = await _run_agent_for_im(content.strip())
    return {"success": True, "data": {"type": "text", "content": reply}}


@router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    injection = check_input_injection(body.message or "")
    if injection:
        raise AIServiceError(injection)

    # 空输入守卫：空消息/纯空格/纯斜杠(// 、/ 等) → 别让 ReAct 循环瞎逛（实测会乱调 list_files/web_search 烧 BYOK 额度），直接友好提示。
    if not (body.message or "").strip().strip("/").strip():
        async def _empty_gen():
            tip = "你还没说要做什么呢～告诉我一句就行，比如「写条周末活动朋友圈」「看看这个报表」「做张拉新海报」。"
            yield f"data: {json.dumps({'type': 'final', 'content': tip}, ensure_ascii=False)}\n\n"
            yield f"data: {json.dumps({'type': 'done', 'turns': 0}, ensure_ascii=False)}\n\n"
        return StreamingResponse(_empty_gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"})

    # Slash 命令：'/name args' 且 name 是可调用技能 → 展开技能正文喂模型（前端仍显示用户原文 body.message）。
    effective_message = _agent_skills.maybe_expand_slash(body.message) or body.message

    await check_quota(db, str(store.id))

    # 注入"懂这家店"：门店画像（同步）+ 店脑记忆 → system prompt
    profile_text = render_operation_profile_context(store)
    memories = await load_store_memory(db, store.id)
    perm_mode, full_disk = _resolve_permission(body.permission_mode, body.full_disk_access)
    # @ 知识库：前端 @ 选了「台球行业知识库」→ knowledge_packs 含 "billiards" → 挂台球人设+门店画像+台球工具集；
    # 否则默认通用 Agent。安全红线两种模式都常驻（由 compose 内部保证）。
    billiards_mode = bool(body.knowledge_packs and "billiards" in body.knowledge_packs)
    # 店脑按需召回：按老板这句话的相关性筛记忆，避免全量注入撑大 prompt（context rot）
    system_prompt = compose_agent_system_prompt(
        profile_text, format_memories_for_prompt(memories, intent=body.message),
        full_disk=full_disk, billiards_mode=billiards_mode, output_style=body.output_style or "",
    )
    # 桌面版：老板当场选定的文件 → 注入 prompt（告诉大脑路径）+ 进 ctx.allowed_paths（授权工具可动）
    if body.selected_files and os.environ.get("DESKTOP_LOCAL") == "1":
        note = _selected_files_note(body.selected_files)
        if note:
            system_prompt = system_prompt + "\n\n" + note

    # 事件 Hooks：UserPromptSubmit（可注入上下文/拦截）+ SessionStart（新会话注入上下文）。无配置时 no-op。
    try:
        from services.agent.hooks import run_event_hooks
        _ups_block, _ups_ctx = await run_event_hooks("UserPromptSubmit", {"prompt": body.message})
        if _ups_block:
            raise AIServiceError(f"输入被 hook 拦截：{_ups_block}")
        _ss_ctx = None
        if not body.conversation_id:
            _, _ss_ctx = await run_event_hooks("SessionStart", {})
        _extra = "\n\n".join(x for x in (_ups_ctx, _ss_ctx) if x)
        if _extra:
            system_prompt = system_prompt + "\n\n" + _extra
    except AIServiceError:
        raise
    except Exception:
        logger.debug("事件 hooks 失败（忽略）", exc_info=True)

    ctx = AgentContext(
        db=db, store=store, user=user, allowed_paths=body.selected_files or [],
        permission_mode=perm_mode, full_disk_access=full_disk,
        auto_spend_limit=getattr(store, "agent_auto_spend_limit", None),
        model_ctx_window=_model_ctx_window(),  # SH-6：配了 DESKTOP_MODEL_CTX_WINDOW 才启用自动瘦身
        goal=body.goal or "",
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
        # 多模态：老板随消息选的图片/视频。大视频(超内联上限)先上传 provider 换文件引用(仅 Moonshot/Kimi 端点支持)；
        # 其余(图片/小视频/非 Moonshot 端点)原样——build_user_content 据类型塞 image_url/video_url。
        _media = [p for p in (body.selected_files or []) if is_media(p)] if os.environ.get("DESKTOP_LOCAL") == "1" else None
        if _media and needs_video_upload(_media):
            try:
                from services.ai.factory import ProviderFactory
                _up = ProviderFactory.get_text_provider_for_store(store)
                _media = await resolve_media_for_upload(_media, getattr(_up, "upload_video", None))
            except Exception:
                logger.warning("大视频预上传失败，保留原路径(超限视频将跳过)", exc_info=True)
        try:
            async for event in run_agent_loop_stream(
                user_message=effective_message,
                # 通用 Agent 默认走通用工具集；@ 了台球知识库则用全集；再并入已配置的 MCP server 工具
                registry=_build_agent_registry(billiards_mode),
                ctx=ctx,
                system_prompt=system_prompt,
                history=history,
                # 多模态：图片/视频进 user 消息（image_url / video_url），大视频已换 provider 文件引用。
                user_images=_media,
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
                    # 采纳信号只记在推荐触发的那一轮（首轮、无续接 id）；同会话后续追问不重复计采纳。
                    _rec_id = body.source_rec_id if not body.conversation_id else None
                    await _persist_agent_chat(db, store, user, body.message, persist_text, gen_id, conv_uuid,
                                              turns, tokens_used=tokens_used, source_rec_id=_rec_id)
                    event = {**event, "generation_id": gen_id, "conversation_id": str(conv_uuid)}
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
        except AppException as e:
            # 业务异常（含 BYOK 守卫的"还没配 key"友好 503 AIProviderError）：把明确的中文引导透传给前端，
            # 让用户知道去「模型设置」配自己的 key，而不是看笼统的"出现错误请重试"。need_byok=True 时前端弹「去设置」。
            logger.info("agent chat 业务异常→前端: %s (status=%s)", e.message, e.status_code)
            yield f"data: {json.dumps({'type': 'error', 'error': e.message, 'need_byok': e.status_code == 503}, ensure_ascii=False)}\n\n"
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
    knowledge_packs: list[str] | None = None  # 同 chat：续接也按是否 @ 台球决定身份/工具集


@router.post("/execute")
async def agent_execute(
    body: AgentExecuteRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """确认后执行一个需审批的工具（proposal 模式的执行端点）。

    只允许执行 requires_approval=True 的工具——这些是对话循环里被拦下、等用户点确认的对外/写入动作
    （未来的平台发布、群发客户等：对外不可逆，需人点头防自动对外/封号）。普通工具在循环里直接执行，不经此路径。
    工具自身的护栏（配额/限流/落库）由其 handler 负责；这里让其异常（如配额不足）正常抛出，
    由全局异常处理转成对用户友好的提示。
    """
    tool = default_registry.get(body.tool)
    if tool is None and body.tool.startswith("mcp__"):
        # MCP 工具是按请求注入的（不在全局 default_registry）；审批执行端也要能找到它们，否则需确认的 MCP 动作无法落地。
        try:
            from services.agent.mcp_client import load_mcp_tools
            tool = next((t for t in load_mcp_tools() if t.name == body.tool), None)
        except Exception:
            tool = None
    if tool is None or not tool.requires_approval:
        raise AIServiceError("该操作不可执行，或无需经此确认")
    # P2 收紧：execute 端走与对话端【同一套 billiards 过滤】——没挂台球知识库就不让执行台球专用工具，
    # 别让执行端比对话端权限更宽（绕过 _build_agent_registry 的 billiards 门控）。
    billiards_mode = bool(body.knowledge_packs and "billiards" in body.knowledge_packs)
    if (not billiards_mode) and body.tool in BILLIARDS_TOOL_NAMES:
        raise AIServiceError("该操作需要先挂载台球行业知识库才能执行")

    args = body.args or {}
    # 审批参数绑定（P3.2）：execute 端【强制】要带签名 token 且匹配本组 args（防"改了参数再确认"/无 token 裸调）。
    # P2 收紧：去掉"没带 token 放行"的向后兼容缺口——前端现都会回传 token，强制即彻底绑定、堵住直接 POST 绕过审批。
    from services.agent.approval import verify_approval
    if not verify_approval(body.tool, args, body.token):
        raise AIServiceError("确认信息缺失或已变化，请重新发起这次操作（请勿手动改动待确认的内容）")
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
        billiards_mode = bool(body.knowledge_packs and "billiards" in body.knowledge_packs)
        sys_prompt = compose_agent_system_prompt(profile_text, format_memories_for_prompt(memories),
                                                 full_disk=full_disk, billiards_mode=billiards_mode)
        history = await _load_agent_history(db, store, body.conversation_id)
        synth = (
            f"[系统提示·非用户输入] 老板已确认、你刚请求的「{body.tool}」已执行完成。"
            f"结果摘要：{result[:300]}。请用一句话自然地告诉老板做好了，若合适顺带建议下一步该做什么；"
            f"不要重复粘贴上面的结果原文，也不要重新调用「{body.tool}」。"
        )
        cont = await run_agent_loop(
            user_message=synth, registry=_build_agent_registry(billiards_mode), ctx=ctx,
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
