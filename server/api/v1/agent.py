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
import re
import asyncio
import uuid as _uuid_mod
from dataclasses import dataclass, field

from fastapi import APIRouter, Depends, Form, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from services.agent import skills as _agent_skills  # noqa: F401  注册 skill 工具 + 渲染技能清单（渐进披露）
from services.agent import computer_tools as _agent_computer  # noqa: F401  注册 computer_view/computer_control（DESKTOP_LOCAL）
from services.agent import image_tools as _agent_image  # noqa: F401  注册 edit_image 本机改图（DESKTOP_LOCAL）
from services.agent import background_tools as _agent_bg  # noqa: F401  注册 run_background（DESKTOP_LOCAL）
from services.agent import video_edit_tools as _agent_videdit  # noqa: F401  注册 inventory_footage/edit_timeline/auto_caption/render_video（DESKTOP_LOCAL）
from services.agent import reminders as _agent_reminders  # noqa: F401  注册 schedule_reminder/list/cancel（DESKTOP_LOCAL）
from services.agent import plugins as _agent_plugins  # noqa: F401  注册 install_plugin（DESKTOP_LOCAL）
from services.agent import mcp_client as _agent_mcp  # noqa: F401  MCP 客户端（动态发现外部 server 工具）
from services.agent.goal_hook import install_goal_hook as _install_goal_hook
_install_goal_hook()  # /goal 目标驱动 Stop hook（常驻；无 ctx.goal 时 no-op）
from services.agent.shadow_git_hook import install_shadow_git_hook as _install_shadow_git_hook
_install_shadow_git_hook()  # F-12 影子 git 检查点 PostToolUse hook（常驻；无 git/工作目录时静默降级）
from starlette.background import BackgroundTask

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import AIServiceError, AppException
from core.security_guard import check_input_injection
from db.session import async_session
from models.user import User
from services.agent.context import AgentContext
from services.agent import denial_tracker
from services.agent.hooks import run_pre_tool_hooks, run_post_tool_hooks
from services.agent.loop import _action_key, _cap_tool_result, _DEFAULT_TOOL_TIMEOUT, run_agent_loop, run_agent_loop_stream
from services.agent.multimodal import is_media, needs_video_upload, resolve_media_for_upload
from services.agent.proactive import generate_daily_drafts
from services.ai.failover import build_resilient_text_provider  # BYOK 失败自动切备用配置档
from services.ai.prompt_engine import get_prompt_engine  # L0 核心层(core.*)注入台球 system prompt
from services.agent.registry import default_registry, general_registry, billiards_registry, BILLIARDS_TOOL_NAMES
from services.memory_service import filter_memories_for_mode, format_memories_for_prompt, load_scoped_store_memory, load_store_memory, memory_reference_labels, remember
from services.quota_service import check_quota
from services.store_profile_service import render_operation_profile_context
import services.agent.tools  # noqa: F401  导入即把内置工具登记进 default_registry
import services.agent.web_tools  # noqa: F401  第二批：WebFetch/WebSearch/TodoWrite/run_subagent 登记进 default_registry

logger = logging.getLogger(__name__)
router = APIRouter()


@dataclass
class _AgentTask:
    id: str
    conversation_id: str | None = None
    generation_id: str | None = None
    status: str = "running"
    events: list[str] = field(default_factory=list)
    total: int = 0      # 累计追加事件数=逻辑 offset 高水位，永不回退（队尾截断也不变）
    dropped: int = 0    # 已从队首丢弃的事件数，把"逻辑 offset"映射成"当前列表下标": idx = offset - dropped
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    runner: asyncio.Task | None = None
    # 方向盘：本任务运行中的 AgentContext（_stream_agent_events 建好后挂上来）。两个用途：
    # ① 插话路由 POST /tasks/{id}/message 往 ctx.steer_inbox 塞话，loop 下一轮注入；
    # ② 取消（CancelledError）时用 ctx.live_messages 照样落轨迹——停掉的活不失忆。
    ctx: AgentContext | None = None
    # F-3b：本轮 AI 交付摘要（persist_text 截断版）——_stream_agent_events 算出 persist_text 时回填，
    # _runner() 收尾喂进 _learn_in_background，让店脑记得"上次帮老板做了什么"。默认空串=向后兼容。
    delivery_text: str = ""


_AGENT_TASKS: dict[str, _AgentTask] = {}
_AGENT_TASK_LIMIT = 40


def _sse_line(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


_TASK_EVENT_CAP = 800  # 内存里每个任务最多保留多少条最近事件（队首超额截断）


async def _task_append(task: _AgentTask, event: dict) -> None:
    """追加一条事件：用单调递增的"逻辑 offset"（task.total），不受队尾截断影响。

    历史 bug：旧实现把 events 截成最近 800 条，但 offset/订阅游标按列表绝对下标算——
    一旦事件数 > 800（长回复每 token 一条，主路径极易触发），队首移位导致订阅者
    要么静默卡死收不到新事件、要么重连越界。这里改成逻辑 offset + dropped 映射，彻底修掉。
    """
    async with task.condition:
        offset = task.total
        line = _sse_line({**event, "task_id": task.id, "offset": offset})
        task.events.append(line)
        task.total += 1
        if len(task.events) > _TASK_EVENT_CAP:
            extra = len(task.events) - _TASK_EVENT_CAP
            del task.events[:extra]
            task.dropped += extra
        task.condition.notify_all()


def _drain_events(task: _AgentTask, cursor: int) -> tuple[list[str], int]:
    """从逻辑 offset `cursor` 起把当前可用事件取出，返回 (事件行, 新游标)。

    cursor 是逻辑 offset；idx = cursor - dropped 映射到当前列表下标。
    若 cursor 落在已被队首丢弃的区间（idx<0），跳到当前最早可用的一条，不报错也不重复。
    供订阅端点与单测共用，保证读取逻辑单一来源。
    """
    out: list[str] = []
    while cursor < task.total:
        idx = cursor - task.dropped
        if idx < 0:
            cursor = task.dropped
            idx = 0
        out.append(task.events[idx])
        cursor += 1
    return out, cursor


def _trim_agent_tasks() -> None:
    if len(_AGENT_TASKS) <= _AGENT_TASK_LIMIT:
        return
    done = [t for t in _AGENT_TASKS.values() if t.status != "running"]
    done.sort(key=lambda t: t.id)
    for t in done[: max(0, len(_AGENT_TASKS) - _AGENT_TASK_LIMIT)]:
        _AGENT_TASKS.pop(t.id, None)

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
    "【交付前自己核一遍】说『做完了』之前，对照用户最初的要求过一遍：步骤有没有漏、改动是不是真的生效了"
    "（别只是说改了，读回去看看确实改对了）；生成图片后如果系统把图回传给你看，顺手扫一眼是否符合要求"
    "（文字有没有糊、构图对不对），明显翻车就重画一次，别翻车了还直接扔给用户。"
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
    "【知识要接地·别编】要写具体做法/话术/细则/硬数字时：先 look_up_knowledge 查目录、再 read_knowledge 读你挑中那条的整篇正文，"
    "据读到的内容写；没查到/没读到的具体数字或细则，就说『按一般经验』或让老板提供，绝不凭空编造台球行业的数字和打法。"
    "【别念叨内部过程】查知识、读资料、改草稿都是你的内部动作——直接给老板能用的结果，"
    "别在回答里说『好，知识读完了/查完了』『让我查一下知识库』『这个模板太笼统了，我重写一版』这类自言自语的话。"
)

_BILLIARDS_P0A_BOUNDARY = (
    "【台球行业 P0-A 对话边界】"
    "1. 用户提到追分、玩大、彩头、赌、押注、盘口、抽水、坐庄这类词时，边界必须是你回答的【开头第一段】、"
    "在任何氛围/玩法/方案之前先说清：门店不能组织赌博、不能坐庄/定盘口/抽水、不能把输赢付款或赌彩头包装成活动。"
    "（最优先这条：红线放到方案中间或末尾＝出现太晚＝等于没说。）"
    "边界说完，再给正路替代：正规周赛/会员赛、技术挑战、积分榜、奖杯荣誉、台费优惠、会员积分、饮品小奖品、报名费透明奖池等。"
    "2. 助教/陪打/加微信/私域导流可以按真实运营给建议，但必须保持职业分寸，不写性暗示、性交易、灰色服务。"
    "3. 回答台球运营问题时按这个顺序：先给一句判断，再给 3 条以内今晚/明天能做的动作，再给可复制话术，最后给下一步；不要输出课程式长文。"
    "4. 行业知识、门店事实、本机使用习惯分层：PPT/知识库是行业方法，门店资料/店脑才是这家店事实。"
    "没有明确确认的店名、城市、价格、活动时间，用 [门店名] / [城市] / [价格] 占位或追问，不要私自套用旧会话、测试数据里的店名。"
    "尤其不要把「鑫和台球」「泉州鑫和台球」「测试球城」当作当前门店名，除非用户在当前对话或门店资料里明确确认。"
    "5. 角色只是【回答视角】不是权限：用户说『按店长/前厅/教练/助教视角』『给店长写汇报』『以前台口吻』时，"
    "直接按那个视角产出，绝不因为『你不是这个角色』而拒绝；一次回答里也可以跨视角（如先给前厅处理客诉的话术、再给店长一段汇报）。"
    "写日报/复盘表/任务表时按对应岗位（店长看营业额/台费/好评、助教管理看上钟/招聘/服务、教练看竞技客户/比赛）的真实关注点组织。"
)

_STALE_STORE_NAME_PATTERNS = (
    re.compile(r"泉州\s*鑫和台球"),
    re.compile(r"鑫和台球"),
    re.compile(r"测试球城"),
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
# 不再"默认全关、几十轮长任务裸奔顶满窗口被 provider 直接报错"（G.1 P0）。触发阈值口径见 loop.py 的
# max(窗口−48k, 窗口×0.7)：窗口 1M 时≈952k token 才触发（大窗由固定余量主导、接近顶满才压，不是 700k）。
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


def _agent_max_turns() -> int:
    """G.1 P2：Agent 循环最大轮数。默认从 8 提到 12——"读5文件→改3处→跑测试→修"这类多步任务 8 轮偏小。
    可经 DESKTOP_AGENT_MAX_TURNS 调；越界钳到 [1,50]。"""
    try:
        v = int(os.environ.get("DESKTOP_AGENT_MAX_TURNS") or 12)
        return max(1, min(v, 50))
    except (TypeError, ValueError):
        return 12


def _agent_token_budget() -> int | None:
    """G.1 P2：交互式对话的 token 总量刹车（防发散打转空烧，BYOK/内置 key 自费场景兜底）。
    默认 None=不限（行为不变）；配 DESKTOP_AGENT_TOKEN_BUDGET=如 200000 启用。"""
    try:
        v = int(os.environ.get("DESKTOP_AGENT_TOKEN_BUDGET") or 0)
        return v if v > 0 else None
    except (TypeError, ValueError):
        return None


def _deep_thinking_to_param(deep: bool | None) -> dict | None:
    """F.2 深度思考"开/关" → 归一成 provider 的 thinking 参数。
    True=开→{"type":"enabled"}；False=关→{"type":"disabled"}（更快、省思考 token）；None=跟随模型默认（mimo 默认开）。
    mimo/Kimi 只有开/关；若将来接"档位制"模型（OpenAI reasoning_effort 等），在这一层再扩成档位映射即可。"""
    if deep is None:
        return None
    return {"type": "enabled"} if deep else {"type": "disabled"}


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


def _sanitize_stale_store_names(text: str | None) -> str:
    """清掉历史测试店名，避免店脑/旧会话把未确认门店名带进正式回答。"""
    if not text:
        return ""
    cleaned = text
    for pat in _STALE_STORE_NAME_PATTERNS:
        cleaned = pat.sub("[门店名]", cleaned)
    return cleaned


def compose_agent_system_prompt(profile_text: str, brain_text: str, full_disk: bool = False,
                                billiards_mode: bool = False, output_style: str = "",
                                working_dir: str = "") -> str:
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
        parts.append(_BILLIARDS_P0A_BOUNDARY)
    # —— 动态尾段：当天日期（通用也需要）→ 门店画像（仅台球）+ 店脑记忆（M1：通用也注入）——
    today = _today_line()
    if today:
        parts.append(today)
    # 工作目录(选项一·对标 CC)：告诉模型默认在哪干活——不是牢笼，出界改文件会弹卡。放动态尾段不破前缀缓存。
    if working_dir and working_dir.strip():
        parts.append(
            f"当前工作目录：{working_dir.strip()}。新建/保存文件、跑命令默认在这里；"
            "你仍可访问电脑别处的文件，但改工作目录外的文件会先弹卡请用户确认。"
        )
    # 门店画像（台球房档案：台数/定价/会员卡）= 台球专属领域数据 → 仅 @台球 时注入，
    # 别把台球档案渗进通用对话（守 G.2「通用 Agent 为默认」定位）。
    if billiards_mode and profile_text and profile_text.strip():
        # 门店画像同样清掉历史测试店名（鑫和台球/测试球城等），别让旧档案把未确认店名带进正式回答
        parts.append("【这家店的情况】\n" + _sanitize_stale_store_names(profile_text).strip())
    # M1：店脑记忆（AI 学到的关于你/你店的事）= 通用助手的【长期记忆】，通用模式也注入——
    # 治"通用模式零长期记忆"的致命缺口，让助手越用越懂你。放在动态尾段、不进可缓存静态前缀。
    if brain_text and brain_text.strip():
        # format_memories_for_prompt 自带"如与其他资料冲突以此为准"的前缀
        parts.append(_sanitize_stale_store_names(brain_text).strip())
    return "\n\n".join(parts)


# F-3b：交付摘要喂进学习前的截断上限——别把整篇长文案/长表格塞进抽取器（既费 token 又没必要，
# 抽取器只需要够判断"这次帮老板做了什么"的摘要）。
_DELIVERY_LEARN_MAX_CHARS = 1600
_DELIVERY_MARK_USER = "【用户说】"
_DELIVERY_MARK_AI = "【本轮助手交付】"


async def _learn_in_background(store_id: str, text: str, delivery: "dict | str | None" = None) -> None:
    """对话后台学习：独立 session 从"用户消息 + 本轮 AI 交付摘要"抽取门店记忆、整合进店脑。
    失败静默、不计配额。

    delivery（F-3b 新增，可选）：本轮 AI 交付了什么的摘要，治"AI 记不住上次给你做了什么"——
    - 传字符串：已经算好的 persist_text（非流式/任务路径，见 start_agent_task 的 _runner()）。
    - 传可变容器 {"text": "..."}：流式路径专用——BackgroundTask 在响应流开始前就绑定，此刻
      persist_text 还没算出来，靠流内（_stream_agent_events 的 done 分支）回填这个容器，
      背景任务真正执行（响应发完之后）时再读，读到的就是完整值。
    - 不传/交付为空：原样只喂用户消息，向后兼容、绝不因此报错或阻断 SSE。
    """
    if not text or not text.strip():
        return
    delivery_text = ""
    try:
        if isinstance(delivery, dict):
            delivery_text = (delivery.get("text") or "").strip()
        elif isinstance(delivery, str):
            delivery_text = delivery.strip()
    except Exception:
        delivery_text = ""
    interaction_text = text
    if delivery_text:
        interaction_text = (
            f"{_DELIVERY_MARK_USER}{text}\n"
            f"{_DELIVERY_MARK_AI}{delivery_text[:_DELIVERY_LEARN_MAX_CHARS]}"
        )
    try:
        async with async_session() as bg_db:
            await remember(bg_db, store_id, interaction_text)
    except Exception:
        logger.exception("agent 店脑后台学习失败 store_id=%s", store_id)


async def _persist_agent_chat(db, store, user, message: str, content: str, gen_id: str, conv_uuid, turns: int,
                              tokens_used: int = 0, source_rec_id: str | None = None,
                              display_text: str | None = None) -> None:
    """落库 agent 会话(type=agent)+conversation_id,供刷新续接/分析,并打点。故障安全:失败不阻断 SSE。
    SH-2：tokens_used 拿循环累加的真实编排消耗（喂 BYOK 成本看板），端点没返回时为粗估值。
    source_rec_id：本次对话若由今日推荐触发，记下是哪条 → 隐式反馈"采纳上浮"（behavior_service 据此聚合）。
    display_text：C2 历史回放半——快捷按钮等场景的短标签，纯显示旁路，存进 input_params 供
    get_agent_conversation 回放时带出；不传（多数场景）时 input_params 结构和以前完全一样，向后兼容。"""
    import uuid as _uuid
    try:
        from models.generation import Generation
        _input_params: dict = {"message": message}
        if display_text:
            _input_params["display_text"] = display_text
        db.add(Generation(
            id=_uuid.UUID(gen_id), store_id=store.id, user_id=(user.id if user else None),
            type="agent", sub_type="chat", input_params=_input_params,
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


# 跨轮记忆：封顶只当【极端兜底】（损坏轨迹文件/恶意全量回传），正常长度交给 loop 的
# autocompact/microcompact 正经控（内置 mimo-v2.5 = 1M 窗口，autocompact 阈值 max(窗口−48k, 窗口×0.7)≈952k 才触发）。
# 旧值 12 条 / 每条 2000 字会把工具结果截烂、把长历史砍没，和"全历史一直带"冲突，故抬到很高。
_HIST_MAX_MSGS = 2000        # 安全上限：超过才兜底裁（留最近），正常对话永远碰不到
_HIST_MAX_CHARS = 100_000    # 单条安全上限：不再截工具结果，只挡"单条爆炸"撑爆上下文


def _cap_history(history: list[dict] | None) -> list[dict] | None:
    """极端兜底：只在条数/单条字数超【高安全上限】时才裁（留最近 _HIST_MAX_MSGS 条、单条截 _HIST_MAX_CHARS 字）。
    正常长度不动——长度由 loop 的三级压缩（snip/microcompact/autocompact）正经处理。
    仍兜底堵住"前端全量回传 history / 损坏轨迹"这两条没护栏的极端路径。"""
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
    """供续接的本会话历史。两条路径，优先级如下：

    ① 有【完整轨迹文件】（跨轮记忆，照 Claude Code 做对）→ 整段读回（含工具调用/结果/中间思考），
       模型真看得到自己上轮干了啥，不用老板反复交代。新会话都走这条。
    ② 无轨迹文件（老会话/读失败）→ 兜底：DB 最近 5 轮"user/assistant 文本对"（旧逻辑，保证老会话续聊不崩）。
    失败一律返回空。

    F-12 复审 Important #3 修复：判据从 `if tr:` 改成 `if tr is not None:`——
    `load_transcript` 返回 `None` 代表"文件真不存在"（老会话/从没建过轨迹，① 路径确实没东西，
    该走 DB 兜底），返回 `[]` 代表"文件存在但没有有效行"（比如 `checkpoint_index` 里
    `chat_only`/`both` 恢复"回到最开始"——truncate 到 0 条后，写的是一个空但存在的轨迹文件，
    见 `checkpoint_index.truncate_chat_to_checkpoint`）。原先 `if tr:` 把这两种情况混为一谈：
    truncate 到 0 想让模型忘掉的历史，会因为 `tr == []` 判假而掉进 ② 的 DB 兜底，把 DB 里
    同一个 conversation_id 的最近 5 轮又翻出来塞回上下文——"回退到最开始"等于没生效。"""
    if not conversation_id:
        return []
    # ① 完整轨迹优先
    try:
        from services.agent.transcript import load_transcript
        tr = load_transcript(conversation_id)
        if tr is not None:  # 文件存在（哪怕是"截断到空"的空文件）→ 当权威源，不落 ② 的 DB 兜底
            return tr
    except Exception:
        logger.warning("agent 轨迹读取失败，回退文本对 conversation_id=%s", conversation_id, exc_info=True)
    # ② 兜底：DB 最近 5 轮文本对
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


def _recent_artifact_item(g) -> dict:
    """把 Generation 统一压成普通用户能看懂的最近作品/任务条目。"""
    params = g.input_params or {}
    typ = g.type or ""
    result = g.result or ""
    title = (
        g.title
        or params.get("prompt")
        or params.get("need")
        or params.get("message")
        or {
            "poster": "生成的图片",
            "video": "生成的视频",
            "agent": "最近任务",
            "diagnosis": "报表诊断",
            "platform_content": "平台内容",
            "groupbuy": "团购文案",
        }.get(typ, "生成内容")
    )
    title = str(title).replace("\n", " ").strip()[:48] or "生成内容"
    kind = "task" if typ == "agent" else "content"
    if typ == "poster":
        kind = "poster"
    elif typ == "video":
        kind = "video"
    subtitle = {
        "poster": "图片作品",
        "video": "视频任务",
        "agent": "最近任务",
        "diagnosis": "报表诊断",
        "platform_content": "平台内容",
        "groupbuy": "团购文案",
        "workbench": "文案作品",
        "activity": "活动方案",
    }.get(typ, typ or "作品")
    return {
        "id": str(g.id),
        "kind": kind,
        "type": typ,
        "title": title,
        "subtitle": subtitle,
        "url": result if kind in {"poster", "video"} else None,
        "content": result[:1200] if kind in {"content", "task"} else None,
        "conversation_id": str(g.conversation_id) if g.conversation_id else None,
        "created_at": g.created_at.isoformat() if g.created_at else None,
        "ratio": params.get("ratio") or g.sub_type,
        "duration": params.get("duration"),
        "width": params.get("width"),
        "height": params.get("height"),
    }


def _deleted_memory_item(m) -> dict:
    return {
        "id": str(m.id),
        "kind": "memory",
        "type": "store_memory",
        "title": str(m.content or "门店资料").replace("\n", " ").strip()[:48] or "门店资料",
        "subtitle": "门店资料",
        "url": None,
        "content": m.content,
        "conversation_id": None,
        "created_at": (m.deleted_at or m.updated_at or m.created_at).isoformat()
        if (m.deleted_at or m.updated_at or m.created_at) else None,
        "ratio": None,
        "duration": None,
        "width": None,
        "height": None,
    }


def _file_change_item(row: dict, *, deleted: bool = False) -> dict:
    path = str(row.get("path") or "")
    name = str(row.get("name") or path.split("/")[-1] or "文件改动")
    backup_path = str(row.get("backup_path") or "")
    return {
        "id": backup_path,
        "kind": "file_change",
        "type": "file_backup",
        "title": name,
        "subtitle": "已删除文件备份" if deleted else "文件改动",
        "url": None,
        "content": path,
        "conversation_id": None,
        "created_at": row.get("created_at"),
        "ratio": None,
        "duration": None,
        "width": None,
        "height": None,
        "path": path,
        "backup_path": backup_path,
    }


@router.get("/recent-artifacts")
async def list_recent_artifacts(
    limit: int = 12,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """P0-B 轻量找回：最近图片/视频/文案/报表诊断/任务，不做完整素材库。"""
    from sqlalchemy import select
    from models.generation import Generation as _Gen
    from services.agent.local_tools import list_file_backups

    limit = max(1, min(int(limit or 12), 30))
    rows = (await db.execute(
        select(_Gen).where(
            _Gen.store_id == store.id,
            _Gen.is_deleted == False,  # noqa: E712
        ).order_by(_Gen.created_at.desc()).limit(200)
    )).scalars().all()

    items: list[dict] = []
    seen_task_conversations: set[str] = set()
    for g in rows:
        if g.type == "agent":
            cid = str(g.conversation_id) if g.conversation_id else str(g.id)
            if cid in seen_task_conversations:
                continue
            seen_task_conversations.add(cid)
        item = _recent_artifact_item(g)
        if not item["url"] and not item["content"]:
            continue
        items.append(item)
    # 文件改动按"原文件"去重 + 只留还在的文件：同一文件多次备份只留最近一条；原文件已不存在的属于"最近删除"、
    # 不进"最近作品"(否则指向已删文件的僵尸备份会刷屏挤掉真成品)。多取些(已按时间倒序)再筛，保证清单干净。
    seen_backup_files: set[str] = set()
    for row in list_file_backups(limit=80):
        p = str(row.get("path") or "")
        if not p or not row.get("exists") or p in seen_backup_files:
            continue
        seen_backup_files.add(p)
        items.append(_file_change_item(row, deleted=False))
    items.sort(key=lambda x: str(x.get("created_at") or ""), reverse=True)
    return {"items": items[:limit]}


@router.get("/deleted-items")
async def list_deleted_items(
    limit: int = 30,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """P0-B 轻量最近删除：会话/作品先能找回，不做完整回收站。"""
    from sqlalchemy import select
    from models.generation import Generation as _Gen
    from models.store_memory import StoreMemory as _Mem
    from services.agent.local_tools import list_file_backups

    limit = max(1, min(int(limit or 30), 80))
    rows = (await db.execute(
        select(_Gen).where(
            _Gen.store_id == store.id,
            _Gen.is_deleted == True,  # noqa: E712
        ).order_by(_Gen.updated_at.desc(), _Gen.created_at.desc()).limit(200)
    )).scalars().all()
    mem_rows = (await db.execute(
        select(_Mem).where(
            _Mem.store_id == store.id,
            _Mem.is_deleted == True,  # noqa: E712
        ).order_by(_Mem.deleted_at.desc(), _Mem.updated_at.desc(), _Mem.created_at.desc()).limit(80)
    )).scalars().all()

    items: list[dict] = []
    seen_task_conversations: set[str] = set()
    for g in rows:
        if g.type == "agent" and g.conversation_id:
            cid = str(g.conversation_id)
            if cid in seen_task_conversations:
                continue
            seen_task_conversations.add(cid)
        items.append(_recent_artifact_item(g))
        if len(items) >= limit:
            break
    if len(items) < limit:
        for m in mem_rows:
            items.append(_deleted_memory_item(m))
            if len(items) >= limit:
                break
    if len(items) < limit:
        for row in list_file_backups(limit=limit):
            if row.get("path") and not row.get("exists"):
                items.append(_file_change_item(row, deleted=True))
                if len(items) >= limit:
                    break
    return {"items": items}


class DeletedItemAction(BaseModel):
    id: str | None = None
    conversation_id: str | None = None
    kind: str | None = None


class ArtifactRating(BaseModel):
    rating: str            # "good"(👍) | "bad"(👎)
    note: str | None = None


class SavedArtifactIn(BaseModel):
    title: str | None = None
    content: str
    conversation_id: str | None = None
    kind: str | None = None


@router.post("/saved-artifacts")
async def save_agent_artifact(
    body: SavedArtifactIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """把用户明确点过“保存”的回答/诊断/文案落进最近作品。

    这是 P0-B 的轻量成品闭环：不做完整成品库，但让有价值的文字结果可找回、可恢复/彻底删除。
    """
    from models.generation import Generation as _Gen

    content = (body.content or "").strip()
    if not content:
        raise AIServiceError("没有可保存的内容")
    title = (body.title or "保存的成品").replace("\n", " ").strip()[:80] or "保存的成品"
    conv_uuid = None
    if body.conversation_id:
        try:
            conv_uuid = _uuid_mod.UUID(body.conversation_id)
        except (ValueError, TypeError):
            conv_uuid = None
    gen = _Gen(
        store_id=store.id,
        user_id=getattr(user, "id", None),
        type="workbench",
        sub_type=(body.kind or "saved_text")[:50],
        title=title,
        input_params={"source": "assistant_action", "kind": body.kind or "saved_text"},
        prompt_used="保存成品",
        result=content,
        model_used="agent",
        tokens_used=0,
        conversation_id=conv_uuid,
    )
    db.add(gen)
    await db.commit()
    return _recent_artifact_item(gen)


@router.delete("/recent-artifacts/{artifact_id}")
async def delete_recent_artifact(
    artifact_id: str,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """把单条最近作品移入最近删除。

    P0-B：成品不只要能保存/找回，也要能误删后恢复。这里仅软删本店生成记录；
    真正彻底删除走 /agent/deleted-items/purge。
    """
    import uuid as _uuid
    from sqlalchemy import update as _update
    from models.generation import Generation as _Gen

    try:
        gid = _uuid.UUID(artifact_id)
    except (ValueError, TypeError):
        raise AIServiceError("作品 id 不对")
    await db.execute(
        _update(_Gen).where(
            _Gen.store_id == store.id,
            _Gen.id == gid,
            _Gen.is_deleted == False,  # noqa: E712
        ).values(is_deleted=True)
    )
    await db.commit()
    return {"ok": True, "id": artifact_id}


@router.post("/recent-artifacts/{artifact_id}/rating")
async def rate_recent_artifact(
    artifact_id: str,
    body: ArtifactRating,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """给单条成品打效果反馈(👍good / 👎bad):写 effect_rating + effect_note + rated_at。

    P1-4 效果闭环:好评成品下游(RAG 召回 / brand voice / dashboard 好评墙)早已只读消费
    effect_rating=="good",全仓却没有写入口。这里补上,只改本店成品(多租户),不弹钱味文案。
    """
    import uuid as _uuid
    from datetime import datetime, timezone
    from sqlalchemy import update as _update
    from models.generation import Generation as _Gen

    rating = (body.rating or "").strip().lower()
    if rating not in ("good", "bad"):
        raise AIServiceError("评价只能是 good 或 bad")
    try:
        gid = _uuid.UUID(artifact_id)
    except (ValueError, TypeError):
        raise AIServiceError("作品 id 不对")
    result = await db.execute(
        _update(_Gen).where(
            _Gen.store_id == store.id,
            _Gen.id == gid,
            _Gen.is_deleted == False,  # noqa: E712
        ).values(
            effect_rating=rating,
            effect_note=(body.note or None),
            rated_at=datetime.now(timezone.utc),
        )
    )
    await db.commit()
    if not result.rowcount:
        raise AIServiceError("没找到这条成品")
    return {"ok": True, "id": artifact_id, "rating": rating}


@router.get("/media-jobs/{job_id}")
async def get_media_job(
    job_id: str,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """查异步任务进度/结果(生成工作室生图/改图/视频轮询用)。本店作用域。"""
    from services import media_jobs_service as _mj

    job = await _mj.get_job(db, job_id, store.id)
    if job is None:
        raise AIServiceError("没找到这个任务")
    return {
        "id": str(job.id),
        "kind": job.kind,
        "status": job.status,        # queued / running / done / error
        "progress": job.progress,    # 0-100
        "stage": job.stage,          # 大白话阶段文案
        "result": job.result,        # 产物 {urls/generation_ids...}
        "error": job.error,
    }


@router.post("/deleted-items/restore")
async def restore_deleted_item(
    body: DeletedItemAction,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """恢复最近删除的单条作品或整条会话。"""
    import uuid as _uuid
    from sqlalchemy import update as _update
    from models.generation import Generation as _Gen
    from models.store_memory import StoreMemory as _Mem

    if body.kind == "file_change":
        from services.agent.local_tools import restore_file_backup
        result = restore_file_backup(body.conversation_id or "", body.id)
        if not result.get("ok"):
            raise AIServiceError(str(result.get("error") or "恢复文件失败"))
        return result
    if body.kind == "memory":
        try:
            mid = _uuid.UUID(body.id or "")
        except (ValueError, TypeError):
            raise AIServiceError("记忆 id 不对")
        await db.execute(
            _update(_Mem).where(
                _Mem.store_id == store.id,
                _Mem.id == mid,
            ).values(is_deleted=False, deleted_at=None)
        )
    elif body.conversation_id:
        try:
            cid = _uuid.UUID(body.conversation_id)
        except (ValueError, TypeError):
            raise AIServiceError("会话 id 不对")
        await db.execute(
            _update(_Gen).where(
                _Gen.store_id == store.id,
                _Gen.conversation_id == cid,
            ).values(is_deleted=False)
        )
    elif body.id:
        try:
            gid = _uuid.UUID(body.id)
        except (ValueError, TypeError):
            raise AIServiceError("记录 id 不对")
        await db.execute(
            _update(_Gen).where(
                _Gen.store_id == store.id,
                _Gen.id == gid,
            ).values(is_deleted=False)
        )
    else:
        raise AIServiceError("缺少要恢复的内容")
    await db.commit()
    return {"ok": True}


@router.post("/deleted-items/purge")
async def purge_deleted_item(
    body: DeletedItemAction,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """彻底删除最近删除里的单条作品或整条会话。"""
    import uuid as _uuid
    from sqlalchemy import delete as _delete
    from models.generation import Generation as _Gen
    from models.store_memory import StoreMemory as _Mem

    if body.kind == "file_change":
        from pathlib import Path
        try:
            from services.agent.local_tools import _library_root
            backup = Path(body.id or "").expanduser().resolve()
            bdir = (_library_root() / ".backups").resolve()
            if backup.parent != bdir or backup.suffix != ".bak":
                raise AIServiceError("只能清理自动备份")
            if backup.exists():
                backup.unlink()
            meta = backup.with_suffix(backup.suffix + ".json")
            if meta.exists():
                meta.unlink()
        except AIServiceError:
            raise
        except Exception as e:
            raise AIServiceError(str(e)[:120])
        return {"ok": True}
    if body.kind == "memory":
        try:
            mid = _uuid.UUID(body.id or "")
        except (ValueError, TypeError):
            raise AIServiceError("记忆 id 不对")
        await db.execute(
            _delete(_Mem).where(
                _Mem.store_id == store.id,
                _Mem.id == mid,
                _Mem.is_deleted == True,  # noqa: E712
            )
        )
    elif body.conversation_id:
        try:
            cid = _uuid.UUID(body.conversation_id)
        except (ValueError, TypeError):
            raise AIServiceError("会话 id 不对")
        await db.execute(
            _delete(_Gen).where(
                _Gen.store_id == store.id,
                _Gen.conversation_id == cid,
                _Gen.is_deleted == True,  # noqa: E712
            )
        )
    elif body.id:
        try:
            gid = _uuid.UUID(body.id)
        except (ValueError, TypeError):
            raise AIServiceError("记录 id 不对")
        await db.execute(
            _delete(_Gen).where(
                _Gen.store_id == store.id,
                _Gen.id == gid,
                _Gen.is_deleted == True,  # noqa: E712
            )
        )
    else:
        raise AIServiceError("缺少要彻底删除的内容")
    await db.commit()
    return {"ok": True}


@router.post("/deleted-items/clear")
async def clear_deleted_items(
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """清空最近删除：彻底删除本店已删除的会话/作品/门店资料，并清理已删除文件的备份。"""
    from pathlib import Path
    from sqlalchemy import delete as _delete
    from models.generation import Generation as _Gen
    from models.store_memory import StoreMemory as _Mem
    from services.agent.local_tools import _library_root, list_file_backups

    await db.execute(
        _delete(_Gen).where(
            _Gen.store_id == store.id,
            _Gen.is_deleted == True,  # noqa: E712
        )
    )
    await db.execute(
        _delete(_Mem).where(
            _Mem.store_id == store.id,
            _Mem.is_deleted == True,  # noqa: E712
        )
    )
    removed_backups = 0
    bdir = (_library_root() / ".backups").resolve()
    for row in list_file_backups(limit=80):
        if row.get("exists") or not row.get("backup_path"):
            continue
        try:
            backup = Path(str(row["backup_path"])).expanduser().resolve()
            if backup.parent != bdir or backup.suffix != ".bak":
                continue
            if backup.exists():
                backup.unlink()
                removed_backups += 1
            meta = backup.with_suffix(backup.suffix + ".json")
            if meta.exists():
                meta.unlink()
        except Exception:
            logger.debug("failed to purge deleted file backup", exc_info=True)
    await db.commit()
    return {"ok": True, "removed_file_backups": removed_backups}


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
            _msg: dict = {"role": "user", "content": uin}
            # C2 历史回放半：老会话/老客户端没落 display_text → 不带 display_content 字段，
            # 前端 displayContent ?? content 自动落回全文（向后兼容天然成立）。
            _dt = (g.input_params or {}).get("display_text") if g.input_params else None
            if _dt:
                _msg["display_content"] = _dt
            messages.append(_msg)
        if g.result:
            messages.append({"role": "assistant", "content": g.result})
    return {"conversation_id": conversation_id, "messages": messages}


@router.delete("/conversations/{conversation_id}")
async def delete_agent_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """删除（软删）某个 agent 会话：把该会话所有记录 is_deleted=True（可恢复，跟现有 generations 软删规矩一致）。
    多租户：限定 store_id 防跨店删。P1-3b（前端侧栏垃圾桶按钮经此删历史会话）。"""
    import uuid as _uuid
    from sqlalchemy import update as _update
    from models.generation import Generation as _Gen
    try:
        cid = _uuid.UUID(conversation_id)
    except (ValueError, TypeError):
        raise AIServiceError("会话 id 不对")
    await db.execute(
        _update(_Gen).where(
            _Gen.store_id == store.id,            # 防跨店删
            _Gen.conversation_id == cid,
            _Gen.type == "agent",
        ).values(is_deleted=True)
    )
    await db.commit()
    return {"ok": True, "conversation_id": conversation_id}


class AgentChatRequest(BaseModel):
    message: str
    display_text: str | None = None  # C2：快捷按钮等场景，气泡只显示这个短标签；message 原文不变、照常处理
    history: list[dict] | None = None
    model: str | None = None
    conversation_id: str | None = None  # 多轮续接：传它则后端按会话查历史(刷新不丢、省token)
    selected_files: list[str] | None = None  # 桌面版：老板经文件选择器选定、授权 Agent 读/改的文件绝对路径
    permission_mode: str | None = None  # 桌面权限：ask(默认)/auto_files(信任·自动改文件)/full(最高·全自动)
    full_disk_access: bool | None = None  # 高级·全盘：文件工具不限"内容库+选定文件"，可碰任意路径
    knowledge_packs: list[str] | None = None  # @ 挂载的知识库（如 ["billiards"]）；含 "billiards" → 切台球专家模式
    output_style: str | None = None  # 输出风格名（如 "explanatory"/"concise"），空=默认
    goal: str | None = None  # /goal 目标驱动：本次会话的目标条件，空=不启用
    deep_thinking: bool | None = None  # F.2 深度思考开关：True=开/False=关/None=跟随模型默认（mimo 默认开）
    source_rec_id: str | None = None  # 隐式反馈：本次对话由今日推荐哪一条触发（rec.id），落到 generation 上做"采纳上浮"
    working_dir: str | None = None  # 本会话工作目录:相对路径默认落它 + 自动接受编辑的范围(可达范围不收,对标 CC)


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


@router.get("/file-diff")
async def agent_file_diff(path: str, backup_path: str | None = None, user: User = Depends(get_current_user)):
    """B.2：给 AI 改过的本机文件返回"改前/改后"对比数据（old=最近备份、new=当前内容），供右侧 diff 视图让老板确认。只读。
    M5b：敏感文件（密钥/凭据）拦截——内容不经此端点泄露。"""
    from services.agent.local_tools import _is_sensitive_file, get_file_backup_diff
    if _is_sensitive_file(path):
        return {"ok": False, "error": "该文件可能含敏感信息（密钥/凭据），需在对话中经确认闸授权后才能查看内容。"}
    return get_file_backup_diff(path, backup_path)


class FileRestoreRequest(BaseModel):
    path: str
    backup_path: str | None = None


@router.post("/file-restore")
async def agent_file_restore(body: FileRestoreRequest, user: User = Depends(get_current_user)):
    """把 AI 改过/删过的文件恢复到自动备份。恢复前会再备份当前版本。"""
    from services.agent.local_tools import _is_sensitive_file, restore_file_backup
    if _is_sensitive_file(body.path):
        return {"ok": False, "error": "该文件可能含敏感信息，需要在对话中经确认后处理。"}
    result = restore_file_backup(body.path, body.backup_path)
    if not result.get("ok"):
        return result
    return result


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
    """出厂 MCP server 预设（现为空——原 fetch/time/DuckDuckGo 与内置工具重复已下线）；机制保留，供将来按需加。"""
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
            _mc.invalidate_mcp_cache()  # 清状态+工具缓存，前端立刻看到启用/停用结果（不等 30s TTL）
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


async def _stream_agent_events(body: AgentChatRequest, user: User, store, db, task: "_AgentTask | None" = None,
                               delivery_box: "dict | None" = None):
    """跑一次 Agent 对话并逐事件产出。task（可选）：后台任务模式由 _runner 传进来，
    好把运行中的 ctx 挂回 task——插话路由与取消落轨迹都靠它拿到活的 ctx。/chat 直连路径不传，行为不变。
    delivery_box（F-3b 新增，可选）：/chat 流式路径专用的可变容器——done 事件算出 persist_text 后
    回填 delivery_box["text"]，供响应发完后才跑的 _learn_in_background 读到"本轮 AI 交付了什么"。
    不传就跳过（向后兼容，/tasks 路径改用 task.delivery_text 承载，见下方 done 分支）。"""
    injection = check_input_injection(body.message or "")
    if injection:
        raise AIServiceError(injection, status_code=400)

    if not (body.message or "").strip().strip("/").strip():
        tip = "你还没说要做什么呢～告诉我一句就行，比如「写条周末活动朋友圈」「看看这个报表」「做张拉新海报」。"
        yield {"type": "final", "content": tip}
        yield {"type": "done", "turns": 0, "stopped_reason": "stop"}
        return

    effective_message = _agent_skills.maybe_expand_slash(body.message) or body.message
    await check_quota(db, str(store.id))

    profile_text = render_operation_profile_context(store)
    perm_mode, full_disk = _resolve_permission(body.permission_mode, body.full_disk_access)
    billiards_mode = bool(body.knowledge_packs and "billiards" in body.knowledge_packs)
    memories = filter_memories_for_mode(
        await load_scoped_store_memory(db, store.id, body.working_dir),
        billiards_mode,
    )
    memory_refs = memory_reference_labels(memories, intent=body.message)
    system_prompt = compose_agent_system_prompt(
        profile_text, format_memories_for_prompt(memories, intent=body.message),
        full_disk=full_disk, billiards_mode=billiards_mode, output_style=body.output_style or "",
        working_dir=body.working_dir or "",
    )
    if body.selected_files and os.environ.get("DESKTOP_LOCAL") == "1":
        note = _selected_files_note(body.selected_files)
        if note:
            system_prompt = system_prompt + "\n\n" + note

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
        working_dir=body.working_dir,
        conversation_id=body.conversation_id,
        auto_spend_limit=getattr(store, "agent_auto_spend_limit", None),
        model_ctx_window=_model_ctx_window(),
        token_budget=_agent_token_budget(),
        goal=body.goal or "",
    )
    # 方向盘：后台任务模式把活的 ctx 挂回 task——插话路由塞 steer_inbox / 取消时取 live_messages 落轨迹。
    if task is not None:
        task.ctx = ctx

    import uuid as _uuid
    history = body.history
    if body.conversation_id:
        db_hist = await _load_agent_history(db, store, body.conversation_id)
        if db_hist:
            history = db_hist
    history = _cap_history(history)

    gen_id = str(_uuid.uuid4())
    try:
        conv_uuid = _uuid.UUID(body.conversation_id) if body.conversation_id else _uuid.UUID(gen_id)
    except (ValueError, TypeError):
        conv_uuid = _uuid.UUID(gen_id)

    denial_tracker.load_into_ctx(ctx, str(conv_uuid))

    from services.agent.tools import DELIVERABLE_TOOLS
    final_content = ""
    deliverables: list[str] = []
    tools_used: list[str] = []
    tool_failures = 0
    turns = 0
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
            registry=_build_agent_registry(billiards_mode),
            ctx=ctx,
            system_prompt=system_prompt,
            history=history,
            user_images=_media,
            model=body.model,
            provider=build_resilient_text_provider(store),
            thinking=_deep_thinking_to_param(body.deep_thinking),
            max_turns=_agent_max_turns(),
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
            if et == "done":
                turns = event.get("turns", 0) or 0
                tokens_used = event.get("tokens_used", 0) or 0
                try:
                    from services.usage_event_service import log_event
                    await log_event("agent_tools", store_id=str(store.id),
                                    user_id=(str(user.id) if user else None),
                                    props={"tools": tools_used[:20], "failures": tool_failures,
                                           "turns": turns, "tokens_used": tokens_used})
                except Exception:
                    pass
                persist_text = final_content
                if deliverables:
                    tail = f"\n\n{final_content}" if final_content.strip() else ""
                    persist_text = "\n\n".join(deliverables) + tail
                # F-3b：把本轮 AI 交付摘要（截断）旁路送去后台学习——只读 persist_text，不改它本身的
                # 落库语义。delivery_box 走 /chat 流式路径；task.delivery_text 走 /tasks 路径。
                _delivery_summary = persist_text.strip()[:_DELIVERY_LEARN_MAX_CHARS] if persist_text else ""
                if delivery_box is not None:
                    delivery_box["text"] = _delivery_summary
                if task is not None:
                    task.delivery_text = _delivery_summary
                _rec_id = body.source_rec_id if not body.conversation_id else None
                await _persist_agent_chat(db, store, user, body.message, persist_text, gen_id, conv_uuid,
                                          turns, tokens_used=tokens_used, source_rec_id=_rec_id,
                                          display_text=body.display_text)
                try:
                    from services.agent.transcript import save_transcript
                    save_transcript(str(conv_uuid), getattr(ctx, "final_messages", None))
                except Exception:
                    logger.warning("agent 轨迹落盘失败，跳过", exc_info=True)
                event = {**event, "generation_id": gen_id, "conversation_id": str(conv_uuid)}
                if memory_refs:
                    event["memory_refs"] = memory_refs
            yield event
    except AppException as e:
        logger.info("agent chat 业务异常→前端: %s (status=%s)", e.message, e.status_code)
        if deliverables or final_content.strip():
            try:
                _pt = "\n\n".join(deliverables) + (f"\n\n{final_content}" if final_content.strip() else "") if deliverables else final_content
                await _persist_agent_chat(db, store, user, body.message, _pt, gen_id, conv_uuid, turns, tokens_used=0,
                                          display_text=body.display_text)
            except Exception:
                logger.exception("error path: 成品落库失败")
        yield {"type": "error", "error": e.message, "need_byok": e.status_code == 503}
        event = {"type": "done", "turns": turns, "stopped_reason": "error", "generation_id": gen_id, "conversation_id": str(conv_uuid)}
        if memory_refs:
            event["memory_refs"] = memory_refs
        yield event
    except Exception:
        logger.exception("agent chat stream error")
        if deliverables or final_content.strip():
            try:
                _pt = "\n\n".join(deliverables) + (f"\n\n{final_content}" if final_content.strip() else "") if deliverables else final_content
                await _persist_agent_chat(db, store, user, body.message, _pt, gen_id, conv_uuid, turns, tokens_used=0,
                                          display_text=body.display_text)
            except Exception:
                logger.exception("error path: 成品落库失败")
        yield {"type": "error", "error": "生成过程中出现错误，请重试"}
        event = {"type": "done", "turns": turns, "stopped_reason": "error", "generation_id": gen_id, "conversation_id": str(conv_uuid)}
        if memory_refs:
            event["memory_refs"] = memory_refs
        yield event


@router.post("/chat")
async def agent_chat(
    body: AgentChatRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    # F-3b：可变容器——BackgroundTask 在这里绑定时响应流还没跑，persist_text 没算出来；
    # _stream_agent_events 的 done 分支会在流内回填它，背景任务真正执行（响应发完后）时再读。
    delivery_box: dict = {"text": ""}

    async def event_generator():
        async for event in _stream_agent_events(body, user, store, db, delivery_box=delivery_box):
            if event.get("type") == "keepalive":
                yield ": keepalive\n\n"
            else:
                yield _sse_line(event)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
        background=BackgroundTask(_learn_in_background, str(store.id), body.message, delivery_box),
    )


@router.post("/tasks")
async def start_agent_task(
    body: AgentChatRequest,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """P0-B 最小后台任务：创建 task_id 后在服务进程内后台跑 Agent，前端只订阅事件。

    v1 边界：任务状态保存在本进程内存，App/后端重启后丢失；不做全局任务中心。
    """
    if not (body.message or "").strip().strip("/").strip():
        task_id = _uuid_mod.uuid4().hex
        task = _AgentTask(id=task_id, status="done")
        task.events = [
            _sse_line({"type": "final", "content": "你还没说要做什么呢～告诉我一句就行，比如「写条周末活动朋友圈」「看看这个报表」「做张拉新海报」。", "task_id": task_id, "offset": 0}),
            _sse_line({"type": "done", "turns": 0, "stopped_reason": "stop", "task_id": task_id, "offset": 1}),
        ]
        task.total = len(task.events)  # 手工建的事件也要把逻辑 offset 高水位对齐，订阅端才取得到
        _AGENT_TASKS[task_id] = task
        _trim_agent_tasks()
        return {"task_id": task_id, "status": task.status}

    task_id = _uuid_mod.uuid4().hex
    task = _AgentTask(id=task_id)
    _AGENT_TASKS[task_id] = task
    _trim_agent_tasks()

    async def _runner():
        try:
            async with async_session() as bg_db:
                db_user = await bg_db.get(User, user.id)
                from models.store import Store
                db_store = await bg_db.get(Store, store.id)
                async for event in _stream_agent_events(body, db_user or user, db_store or store, bg_db, task=task):
                    if event.get("type") == "keepalive":
                        continue
                    if event.get("type") == "done":
                        task.status = "done" if event.get("stopped_reason") != "error" else "error"
                        task.conversation_id = event.get("conversation_id") or task.conversation_id
                        task.generation_id = event.get("generation_id") or task.generation_id
                    await _task_append(task, event)
        except asyncio.CancelledError:
            task.status = "cancelled"
            # 取消不丢记忆：把跑到一半的活轨迹（loop 挂在 ctx.live_messages 的引用）照 done 分支的写法落盘，
            # 停掉的活下一轮"接着做"能接得上。只在会话已有 id 时落——新会话首轮还没有 conversation_id，
            # 落成孤儿文件也没人读得回（前端下一轮不带这个 id）。先落盘再 await（sync 写文件），
            # 即使后面的 await 在取消语义下再抛也不丢。
            try:
                _c = task.ctx
                _cid = getattr(_c, "conversation_id", None) if _c is not None else None
                _live = getattr(_c, "live_messages", None) if _c is not None else None
                if _cid and _live:
                    from services.agent.transcript import save_transcript
                    save_transcript(str(_cid), _live)
            except Exception:
                logger.warning("取消路径轨迹落盘失败，跳过", exc_info=True)
            await _task_append(task, {"type": "done", "turns": 0, "stopped_reason": "cancelled"})
        except Exception:
            logger.exception("agent task failed: %s", task.id)
            task.status = "error"
            await _task_append(task, {"type": "error", "error": "后台任务执行失败，请重试"})
            await _task_append(task, {"type": "done", "turns": 0, "stopped_reason": "error"})
        finally:
            # 任务收尾即释放运行时引用（ctx 里挂着 messages/db/store 等大对象）：
            # _AGENT_TASKS 会缓存最近 40 个任务的事件供重放，别让完成的任务把整段对话上下文拖在内存里。
            task.ctx = None
            # F-3b：此刻 _stream_agent_events 已跑完，task.delivery_text 已是算好的 persist_text
            # 摘要（没有则默认空串，行为回退到只喂用户消息）。
            await _learn_in_background(str(store.id), body.message, task.delivery_text)
            async with task.condition:
                task.condition.notify_all()

    task.runner = asyncio.create_task(_runner())
    return {"task_id": task_id, "status": task.status}


@router.get("/tasks/{task_id}/events")
async def subscribe_agent_task_events(task_id: str, after: int = -1):
    task = _AGENT_TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")

    async def event_generator():
        cursor = max(0, int(after) + 1)  # 逻辑 offset：下一条要发的事件
        while True:
            batch, cursor = _drain_events(task, cursor)
            for line in batch:
                yield line
            if task.status != "running":
                break
            try:
                async with task.condition:
                    await asyncio.wait_for(task.condition.wait(), timeout=15)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/tasks/{task_id}/cancel")
async def cancel_agent_task(task_id: str):
    task = _AGENT_TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    if task.status == "running":
        task.status = "cancelled"
        if task.runner and not task.runner.done():
            task.runner.cancel()
        else:
            await _task_append(task, {"type": "done", "turns": 0, "stopped_reason": "cancelled"})
    return {"ok": True, "task_id": task_id, "status": task.status}


class AgentTaskMessageRequest(BaseModel):
    message: str


# 方向盘：跑动中插话队列封顶（条）。防手快连发/脚本狂灌把一轮上下文塞爆；到顶让用户等 AI 消化完再说。
_STEER_INBOX_CAP = 10


@router.post("/tasks/{task_id}/message")
async def send_agent_task_message(task_id: str, body: AgentTaskMessageRequest):
    """任务跑动中给它捎话（steering，对标 Claude Code 运行中打字排队）：
    新话进该任务 ctx 的插话队列，loop 在每批工具做完、下一次调模型前注入成 user 消息，模型当场改道。
    不新起任务、不打断当前轮——只排队等下一轮。任务不存在 404 / 已结束 409 / 队列满 429，错误都说人话。"""
    task = _AGENT_TASKS.get(task_id)
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在或已过期")
    if task.status != "running":
        raise HTTPException(status_code=409, detail="这个任务已经结束了，直接发新消息就行")
    msg = (body.message or "").strip()
    if not msg:
        raise HTTPException(status_code=400, detail="补充的内容是空的，写点什么再发")
    injection = check_input_injection(msg)
    if injection:
        raise HTTPException(status_code=400, detail=injection)
    ctx = task.ctx
    if ctx is None:
        # 任务刚创建、循环还没跑起来（ctx 尚未挂上，窗口极短）：别静默吞话，让前端稍后重试
        raise HTTPException(status_code=409, detail="任务刚启动还没就绪，等一两秒再发一次")
    inbox = getattr(ctx, "steer_inbox", None)
    if inbox is None:
        raise HTTPException(status_code=409, detail="这个任务不支持中途捎话")
    if len(inbox) >= _STEER_INBOX_CAP:
        raise HTTPException(status_code=429, detail="补充的话有点多啦，等 AI 消化一下前面的再说")
    inbox.append(msg)
    return {"ok": True, "task_id": task_id, "queued": len(inbox)}


class AgentExecuteRequest(BaseModel):
    tool: str
    args: dict | None = None
    selected_files: list[str] | None = None  # 同 chat：审批通过后执行写/改时，授权可动这些选定文件
    full_disk_access: bool | None = None     # 同 chat：全盘模式下手动确认的文件改动也需放行
    token: str | None = None                 # 审批提案签名（绑定本组 args，防前端篡改后再确认）
    conversation_id: str | None = None       # 审批回灌：执行后据此取历史，让管家基于结果自然接话
    knowledge_packs: list[str] | None = None  # 同 chat：续接也按是否 @ 台球决定身份/工具集
    working_dir: str | None = None  # 本会话工作目录:相对路径默认落它 + 自动接受编辑的范围(可达范围不收,对标 CC)


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

    P1 关联项（全仓七路审查 2026-07-02「关联」）：此前直调 tool.handler，绕过了主循环 _execute_tool
    的 PreToolUse hook / 超时兜底 / 结果封顶——这里补齐同款三件套（见下方执行段落），但【异常传播行为
    不变】：不像主循环那样把工具异常吞成字符串回灌模型，execute 是非流式 JSON 端点，工具自身抛出的
    AppException/AIServiceError 等仍正常向上抛，交给上面这句"由全局异常处理转成提示"承接，返回契约不破。
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
        raise AIServiceError(injection, status_code=400)

    # 审批闸 2.0 复审修复（Critical #1）：越界文件写会被 loop 转成审批卡（`_file_target_oob`），
    # 老板点"允许"后这次执行必须真的跑通——否则重建的 ctx.allowed_paths 只来自 body.selected_files
    # （不含刚被批准的越界路径），write_file/edit_image 里的 `_resolve` 照样抛 ValueError，
    # 而这里（跟主循环不同）没有把工具异常吞成字符串回灌的机制，未捕获的 ValueError 会一路
    # 冒到全局异常处理变成一句不知所云的 500——对 full 档是行为倒退（原来至少静默失败还能让
    # 老板看见回灌的人话，现在弹卡点了确认反而收到"服务器内部错误"）。
    # 只在【签名验证已通过】（上面 verify_approval 那行）之后才做这件事：HMAC 签名绑的是
    # (tool, 完整 args)（含 path/output_path，见 services/agent/approval.py 的 _canonical），
    # 验证通过就等于老板已经明确点头允许了这组参数里的这个具体路径——把它一次性并进
    # 这次请求的 allowed_paths 是兑现闸已经放行的授权，不是绕过闸的后门；且只对本次执行生效，
    # 不做任何跨请求/跨会话的持久化（下一次主循环再摸这个路径，仍然会照常重新弹卡）。
    #
    # F-6 复审修复：批准的 path/output_path 若是【相对路径】（如 `../../外部.txt`），不能原样
    # 塞进 allowed_paths——下面 `_allowed_paths()` 对列表每项是裸调 `Path(s).resolve()`（相对
    # 【进程 CWD】解析），跟 `_resolve()` 判越界时"相对路径 = 相对 working_dir/内容库解析"的
    # 坐标系对不上，会导致已批准的相对越界路径摆进 allowed_paths 后算出的绝对路径依然对不上号，
    # `_resolve()` 里的比较照样失败、抛 ValueError（现象＝签名批准后仍 500）。
    # 用 `local_tools.resolve_under_base` 把原始参数先归一成跟 `_resolve` 同坐标系的绝对路径字符串
    # 再放进去——base 逻辑只在 local_tools 那一处维护，这里不重抄一份（会跟 `_resolve` 漂移）。
    from services.agent.local_tools import resolve_under_base
    approval_paths: list[str] = list(body.selected_files or [])
    if getattr(tool, "approval_class", None) == "file":
        for _key in ("path", "output_path"):
            _val = args.get(_key)
            if isinstance(_val, str) and _val.strip():
                try:
                    approval_paths.append(resolve_under_base(_val, body.working_dir))
                except Exception:
                    approval_paths.append(_val)  # 归一失败极端兜底：退回原值，不比归一前更差

    _m, full_disk = _resolve_permission(None, body.full_disk_access)
    ctx = AgentContext(
        db=db, store=store, user=user, allowed_paths=approval_paths,
        full_disk_access=full_disk,
        working_dir=body.working_dir,
        conversation_id=body.conversation_id,
        auto_spend_limit=getattr(store, "agent_auto_spend_limit", None),
        model_ctx_window=_model_ctx_window(),  # SH-6：同 chat，配了环境变量才启用
    )
    # SH-8：老板成功确认执行了这个动作 → 该动作的「连续拒绝」计数清零（他改主意了，回到正常审批节奏）。
    denial_tracker.clear_denial(body.conversation_id, _action_key(body.tool, args))
    # 续接循环用本会话最新拒绝计数（清完零的），让后续若再提别的动作仍受回退保护。
    denial_tracker.load_into_ctx(ctx, body.conversation_id)
    # 三件套之一·PreToolUse hook：与主循环 _execute_tool 一致，执行前可拦截（故障安全，hook 抛错不影响执行）。
    deny = await run_pre_tool_hooks(body.tool, args, ctx)
    if deny:
        result = f"[已被拦截] {body.tool}：{deny}"
    else:
        # 三件套之二·统一超时兜底：工具自带 timeout 优先，否则用全局默认（同主循环 _DEFAULT_TOOL_TIMEOUT），
        # 绝不让审批执行的请求无限期挂住（此前 generate_image 等慢工具在这条路径完全没有超时保护）。
        _timeout = tool.timeout if getattr(tool, "timeout", None) is not None else _DEFAULT_TOOL_TIMEOUT
        _timed_out = False
        try:
            if _timeout and _timeout > 0:
                result = await asyncio.wait_for(tool.handler(args, ctx), timeout=_timeout)
            else:
                result = await tool.handler(args, ctx)
        except (asyncio.TimeoutError, TimeoutError):
            _timed_out = True
            logger.warning("审批执行超时(%.0fs)，已掐断: %s", _timeout, body.tool)
            result = (f"[工具超时] {body.tool} 跑了超过 {int(_timeout)} 秒还没回，已自动掐断。"
                     f"可以重新发起这次操作，或换个更小的输入再试。")
        if not isinstance(result, str):
            try:
                result = json.dumps(result, ensure_ascii=False)
            except (TypeError, ValueError):
                result = str(result)
        if not _timed_out:
            # 三件套之三·结果封顶：deliverable 工具（生图/生视频/发布等成品）不截断，行为零变化；
            # 只对非成品的超大结果落盘/截断，护住返回体大小（同主循环 _cap_tool_result 口径）。
            result = _cap_tool_result(tool, result, ctx)
            # PostToolUse hook：与主循环一致，只在成功路径跑（超时同主循环 _execute_tool 直接跳过，
            # 别把"超时"提示文案当工具结果喂给用户配置的 hook）。
            await run_post_tool_hooks(body.tool, args, result, ctx)

    # 审批回灌（修"断流"缝）：把执行结果喂回推理循环，让管家"知道"自己做了什么、
    # 自然地接话（"做好啦，要不要我配条文案？"），而不是对话死在这。失败不影响已执行结果。
    continuation = ""
    new_approval = None
    try:
        profile_text = render_operation_profile_context(store)
        billiards_mode = bool(body.knowledge_packs and "billiards" in body.knowledge_packs)
        memories = filter_memories_for_mode(
            await load_scoped_store_memory(db, store.id, body.working_dir),
            billiards_mode,
        )
        sys_prompt = compose_agent_system_prompt(profile_text, format_memories_for_prompt(memories),
                                                 full_disk=full_disk, billiards_mode=billiards_mode,
                                                 working_dir=body.working_dir or "")
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
                # 跨轮记忆：把"已确认执行 + 续接答复"接到主会话轨迹尾部，否则审批一发生轨迹就停在"待确认"、
                # 下一轮主对话读回的历史看不到这次执行（审批流的记忆断点）。故障安全：失败不影响已执行结果。
                try:
                    from services.agent.transcript import append_transcript
                    append_transcript(body.conversation_id, [
                        {"role": "user", "content": f"（已确认执行 {body.tool}）"},
                        {"role": "assistant", "content": continuation},
                    ])
                except Exception:
                    logger.warning("审批续接轨迹追加失败，跳过", exc_info=True)
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
