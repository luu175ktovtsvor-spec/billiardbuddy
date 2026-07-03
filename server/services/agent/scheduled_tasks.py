"""定时任务(Scheduled Tasks)——对标 Claude Code 的 Scheduled Tasks：配好指令 + 定时规则，
到点自动跑一遍 agent 任务、干完写结果回任务行 + 系统通知播报。

与 `reminders.py`（到点只弹一声、不干活、一次性）不同：这里到点真的会跑一遍受限 agent，
产出写文案/出报表/汇总数据这类内容。

安全红线（不可绕过）：无人值守——没人在场点审批卡——所以执行时工具集固定用
`_scheduled_safe_registry()`：照 `im_telegram.py` 的 `_im_safe_registry` 同款裁法，剔除
【requires_approval / force_confirm / run_command / run_background / computer_*】全部
对外·不可逆动作。模型想发布/群发/删数据也没有对应工具可调——产品安全红线（不自动触达）
在这一层被硬约束住，不依赖模型自律，也不是"跳过审批"（force_confirm 类工具任何放行模式
都跳不过，见 registry.py:55-57），而是"这个工具压根不在集里"。

时区口径：`schedule_spec` 的 hour/minute/weekday 按【北京时间】(core.timezone.BUSINESS_TZ)
理解（老板配"每天8点"指的是北京时间8点）。DB 存储/比较统一用 UTC-aware datetime；SQLite
读出来会丢 tzinfo（老坑，见 core/timezone.py 与 M12 记忆：按北京时间聚合前必须先
astimezone(utc)，否则月初/边界时刻会算错），所以任何从库里读出来的 datetime 在参与比较前
一律先经 `_as_aware_utc()` 兜底当 UTC 处理。
"""
import logging
import os
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from core.timezone import BUSINESS_TZ
from models.scheduled_task import ScheduledTask
from models.store import Store
from services import notify_service
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop
from services.agent.registry import tool
from services.agent.skills import maybe_expand_slash
from services.ai.failover import build_resilient_text_provider
from services.memory_service import filter_memories_for_mode, format_memories_for_prompt, load_scoped_store_memory
from services.store_profile_service import render_operation_profile_context

logger = logging.getLogger(__name__)

_MAX_TASKS_PER_STORE = 10
_POLL_INTERVAL_SEC = 45
_RESULT_SUMMARY_MAX_CHARS = 800
# 通知 meta 里"结果全文"的兜底上限——防单条通知在内存队列里无限膨胀（正常文案/报表远小于此）。
_NOTIFY_FULL_TEXT_MAX_CHARS = 8000


def _as_aware_utc(dt: datetime) -> datetime:
    """SQLite 读出来的 DateTime(timezone=True) 列会丢 tzinfo——统一按"没标时区的当 UTC"处理，
    避免裸口径比较出错（老坑：按北京时间聚合前不这么兜底会导致月初/边界时刻算错）。"""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _compute_next_run(kind: str, spec: dict | None, from_time: datetime | None = None) -> datetime:
    """算下次触发时间(UTC-aware)。纯函数，好测。

    daily/weekly 的 hour/minute/weekday 按北京时间理解；interval 是相对时长，无时区歧义。
    """
    base = _as_aware_utc(from_time or datetime.now(timezone.utc))
    spec = spec or {}

    if kind == "interval":
        try:
            minutes = float(spec.get("minutes") or 0)
        except (TypeError, ValueError):
            minutes = 0
        if minutes <= 0:
            minutes = 60  # 防 0/负值配置导致"刚算完又到点"的死循环
        return base + timedelta(minutes=minutes)

    local = base.astimezone(BUSINESS_TZ)
    try:
        hour = int(spec.get("hour", 0))
    except (TypeError, ValueError):
        hour = 0
    try:
        minute = int(spec.get("minute", 0))
    except (TypeError, ValueError):
        minute = 0
    hour = min(max(hour, 0), 23)
    minute = min(max(minute, 0), 59)

    if kind == "daily":
        candidate = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= local:
            candidate += timedelta(days=1)
    elif kind == "weekly":
        try:
            weekday = int(spec.get("weekday", 0))
        except (TypeError, ValueError):
            weekday = 0
        weekday = weekday % 7
        candidate = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        days_ahead = (weekday - local.weekday()) % 7
        candidate += timedelta(days=days_ahead)
        if candidate <= local:
            candidate += timedelta(days=7)
    else:
        raise ValueError(f"未知 schedule_kind: {kind!r}（只支持 daily/weekly/interval）")

    return candidate.astimezone(timezone.utc)


async def due_tasks(session, now: datetime | None = None) -> list[ScheduledTask]:
    """到点未跑的启用中任务(enabled 且 next_run_at <= now)。"""
    now = _as_aware_utc(now or datetime.now(timezone.utc))
    rows = (await session.execute(
        select(ScheduledTask).where(ScheduledTask.enabled.is_(True))
    )).scalars().all()
    return [t for t in rows if t.next_run_at is not None and _as_aware_utc(t.next_run_at) <= now]


def _scheduled_safe_registry(billiards_mode: bool):
    """无人值守安全工具集 = 通用/台球工具表剔除【需审批 / force_confirm / 跑命令 / 操作电脑】。

    照 `im_telegram._im_safe_registry` 同款裁法（那边是 IM 场景同款理由：没人能点审批卡）。
    定时任务能生成内容（写文案/出报表/汇总数据——generate_image/make_poster/
    write_operation_content 等不是 requires_approval，保留在集里），但发布/群发/改本机文件/
    删数据/跑命令/操作电脑这些一律不在集里——模型想干也没有对应函数可调。

    lazy import `_build_agent_registry`：它定义在 api.v1.agent，而 api.v1.agent 又在模块级
    import 本模块（注册 schedule_task 等工具，仿 reminders 的接线方式）——放函数体内避免循环导入。
    """
    from api.v1.agent import _build_agent_registry
    from services.agent.registry import ToolRegistry

    reg = ToolRegistry()
    for t in _build_agent_registry(billiards_mode).all():
        if getattr(t, "requires_approval", False) or getattr(t, "force_confirm", False):
            continue
        if t.name in ("run_command", "run_background") or t.name.startswith("computer_"):
            continue
        reg.register(t)
    return reg


async def run_scheduled_task(task: ScheduledTask, db) -> None:
    """跑一次定时任务(安全裁剪工具集,无人值守)。

    全程故障安全：任何异常都不让调度 loop 崩——记成失败、仍推进 next_run_at（别让一次失败卡死
    后续所有次），并推一条"没跑成"的通知。
    """
    final_text = ""
    ok = True
    try:
        store = (await db.execute(select(Store).where(Store.id == task.store_id))).scalars().first()
        if store is None:
            raise RuntimeError("门店不存在(可能已被删除)")

        # lazy import：compose_agent_system_prompt 定义在 api.v1.agent，理由同 _scheduled_safe_registry。
        from api.v1.agent import compose_agent_system_prompt

        provider = build_resilient_text_provider(store)
        profile_text = render_operation_profile_context(store) if task.billiards_mode else ""
        try:
            memories = filter_memories_for_mode(
                await load_scoped_store_memory(db, store.id, None), task.billiards_mode,
            )
        except Exception:
            memories = []
        system_prompt = compose_agent_system_prompt(
            profile_text, format_memories_for_prompt(memories),
            full_disk=False, billiards_mode=task.billiards_mode,
        )
        registry = _scheduled_safe_registry(task.billiards_mode)
        instruction = maybe_expand_slash(task.instruction) or task.instruction
        ctx = AgentContext(db=db, store=store, permission_mode="ask", billiards_mode=task.billiards_mode)
        result = await run_agent_loop(
            user_message=instruction, registry=registry, ctx=ctx,
            system_prompt=system_prompt, provider=provider, max_turns=6,
        )
        final_text = (getattr(result, "final_text", "") or "").strip() or "(没有产出文字结果)"
        task.last_run_status = "success"
        task.last_result_summary = final_text[:_RESULT_SUMMARY_MAX_CHARS]
    except Exception as e:  # noqa: BLE001 — 故障安全：单次失败绝不能崩调度 loop
        logger.exception("定时任务执行失败 task_id=%s", getattr(task, "id", None))
        ok = False
        final_text = f"跑失败：{type(e).__name__}: {e}"
        task.last_run_status = "error"
        task.last_result_summary = final_text[:_RESULT_SUMMARY_MAX_CHARS]

    task.last_run_at = datetime.now(timezone.utc)
    try:
        task.next_run_at = _compute_next_run(task.schedule_kind, task.schedule_spec, task.last_run_at)
    except Exception:
        # schedule_spec 理论上建任务时已校验过、不该在这里坏——万一坏了兜底 1 天后再试，
        # 别让任务卡死在过去、每次轮询都重复触发。
        logger.exception("定时任务 next_run_at 推进失败,兜底 1 天后 task_id=%s", getattr(task, "id", None))
        task.next_run_at = task.last_run_at + timedelta(days=1)

    try:
        await db.commit()
    except Exception:
        logger.exception("定时任务结果写回失败 task_id=%s", getattr(task, "id", None))
        try:
            await db.rollback()
        except Exception:
            pass

    notify_service.push(
        "定时任务完成" if ok else "定时任务没跑成",
        f"{task.name}：{final_text[:120]}",
        kind="task_done",
        task_id=str(task.id),
        result_text=final_text[:_NOTIFY_FULL_TEXT_MAX_CHARS],
        status=task.last_run_status,
    )


async def scheduled_tasks_loop(stop_event) -> None:
    """进程内 loop：每 ~45s 检查到点任务，逐个串行跑（别并发跑多个 agent loop 撞 ctx.db/烧配额）。"""
    import asyncio
    from db.session import async_session

    while not stop_event.is_set():
        try:
            async with async_session() as db:
                for t in await due_tasks(db):
                    await run_scheduled_task(t, db)
        except Exception:
            logger.exception("定时任务轮询异常(已吞,下个周期再试)")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=_POLL_INTERVAL_SEC)
        except asyncio.TimeoutError:
            pass


async def catch_up_on_startup(session) -> int:
    """启动时补跑：app 关着睡过点的任务(next_run_at 已是过去) → 只补跑最近一次
    (不 backfill 所有错过的次数，Claude Code 同款语义) → run_scheduled_task 内部会把
    next_run_at 从"现在"重新推到未来。返回本次补跑的任务数。"""
    tasks = await due_tasks(session, datetime.now(timezone.utc))
    for t in tasks:
        await run_scheduled_task(t, session)
    return len(tasks)


# ── 工具（DESKTOP_LOCAL 才注册；通用/台球模式都能用，不进 BILLIARDS_TOOL_NAMES）──

async def _schedule_task_handler(args: dict, ctx) -> str:
    name = str(args.get("name") or "").strip()
    instruction = str(args.get("instruction") or "").strip()
    kind = str(args.get("schedule_kind") or "").strip()
    spec = args.get("schedule_spec") or {}
    billiards_mode = bool(args.get("billiards_mode", False))

    if not name or not instruction:
        return "[参数缺失] schedule_task 需要 name 和 instruction"
    if kind not in ("daily", "weekly", "interval"):
        return "[参数错误] schedule_kind 需要是 daily/weekly/interval 之一"
    if not isinstance(spec, dict):
        return "[参数错误] schedule_spec 需要是一个对象，如 {\"hour\":8,\"minute\":0}"

    store = getattr(ctx, "store", None)
    db = getattr(ctx, "db", None)
    if store is None or db is None:
        return "还没配置门店，没法建定时任务。"

    from sqlalchemy import func as sa_func
    count = (await db.execute(
        select(sa_func.count()).select_from(ScheduledTask).where(
            ScheduledTask.store_id == store.id, ScheduledTask.enabled.is_(True)
        )
    )).scalar_one()
    if count >= _MAX_TASKS_PER_STORE:
        return f"[超出上限] 每店最多同时开 {_MAX_TASKS_PER_STORE} 条定时任务，先关掉几条旧的再加。"

    try:
        next_run = _compute_next_run(kind, spec)
    except ValueError as e:
        return f"[参数错误] {e}"

    task = ScheduledTask(
        store_id=store.id, name=name, instruction=instruction, billiards_mode=billiards_mode,
        schedule_kind=kind, schedule_spec=spec, next_run_at=next_run, enabled=True,
    )
    db.add(task)
    await db.commit()
    when = next_run.astimezone(BUSINESS_TZ).strftime("%m-%d %H:%M")
    return f"已建好定时任务「{name}」，下次会在 {when}（北京时间）自动跑，跑完给你弹通知。"


async def _list_scheduled_tasks_handler(args: dict, ctx) -> str:
    store = getattr(ctx, "store", None)
    db = getattr(ctx, "db", None)
    if store is None or db is None:
        return "还没配置门店。"
    rows = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.store_id == store.id).order_by(ScheduledTask.created_at)
    )).scalars().all()
    if not rows:
        return "当前没有定时任务。"
    lines = []
    for t in rows:
        status = "运行中" if t.enabled else "已停用"
        next_s = _as_aware_utc(t.next_run_at).astimezone(BUSINESS_TZ).strftime("%m-%d %H:%M") if t.next_run_at else "-"
        if t.last_run_at:
            last_s = f"上次{t.last_run_status or '?'}：{(t.last_result_summary or '')[:40]}"
        else:
            last_s = "还没跑过"
        lines.append(f"- [{t.id}] {t.name}（{status}，下次 {next_s}）{last_s}")
    return "定时任务：\n" + "\n".join(lines)


async def _cancel_scheduled_task_handler(args: dict, ctx) -> str:
    tid = str(args.get("id") or "").strip()
    if not tid:
        return "[参数缺失] cancel_scheduled_task 需要 id"
    store = getattr(ctx, "store", None)
    db = getattr(ctx, "db", None)
    if store is None or db is None:
        return "还没配置门店。"
    task = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.id == tid, ScheduledTask.store_id == store.id)
    )).scalars().first()
    if task is None:
        return "没找到这个 id 的定时任务。"
    task_name = task.name
    await db.delete(task)
    await db.commit()
    return f"已取消定时任务「{task_name}」。"


if os.environ.get("DESKTOP_LOCAL") == "1":
    tool(name="schedule_task",
         description="建一个定时任务：按 daily(每天)/weekly(每周固定一天)/interval(每隔N分钟) 规则，"
                     "到点自动跑一遍指令（可以是写文案/出报表/汇总数据这类生成类任务，也可以是已装技能的"
                     "slash 命令如 /写今日文案）。**无人值守安全上限**：跑的时候只能生成内容，"
                     "绝不会自动发布/群发/删数据/改本机文件——那些工具在这个场景压根不可用。"
                     "每店最多同时开 10 条，超了要先取消几条旧的。",
         parameters={
             "type": "object",
             "properties": {
                 "name": {"type": "string", "description": "任务展示名，如「每日文案」「周报」"},
                 "instruction": {"type": "string", "description": "到点要跑的指令：自由文本，或已装技能的 slash 命令（如 /写今日文案）"},
                 "schedule_kind": {"type": "string", "enum": ["daily", "weekly", "interval"],
                                    "description": "daily=每天;weekly=每周固定一天;interval=每隔N分钟"},
                 "schedule_spec": {"type": "object", "description":
                     "daily:{hour,minute}；weekly:{weekday(0=周一..6=周日),hour,minute}；interval:{minutes}。"
                     "hour/minute 按北京时间理解"},
                 "billiards_mode": {"type": "boolean", "description": "是否用台球行业知识库人设跑这条任务(默认 false=通用模式)"},
             },
             "required": ["name", "instruction", "schedule_kind", "schedule_spec"],
         })(_schedule_task_handler)
    tool(name="list_scheduled_tasks", description="列出本店定时任务（名字/下次几点跑/上次结果摘要/开关状态）。",
         parameters={"type": "object", "properties": {}}, read_only=True)(_list_scheduled_tasks_handler)
    tool(name="cancel_scheduled_task", description="按 id 取消一个定时任务。",
         parameters={"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}
         )(_cancel_scheduled_task_handler)
