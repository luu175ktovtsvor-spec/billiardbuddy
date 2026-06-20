"""Agent 编排引擎 — 指挥官模式的多岗位协作（球房运营智能体的编排层）

架构（orchestrator-worker，对齐业界生产实践）：
  ① 指挥官规划：基于门店画像+行业知识产出《协作框架》（目标/预算分配/时间线/岗位分工边界），
     并由框架同时决定参与岗位——选岗与分工一次完成，从根上解决"各岗位各说各话"
  ② 岗位并行执行：每个岗位 Agent 拿到【框架 + 自身分工边界 + 本店知识库 + 门店画像】，
     只写自己边界内的内容，预算与时间以框架为准
  ③ 汇总整合：汇总 Agent 按框架做一致性校验（预算合计/时间线/边界冲突以框架为准修正），
     整合为一份可直接执行的统一方案，落库 generations

任务状态存数据库（collab_tasks）：多 worker 下任何进程都能查询/取消，解决进程内存方案
在 --workers 2 时约一半轮询 404 的问题。岗位 system prompt 不入库（含门店知识与规则，
防泄露），只在执行进程内传递。
"""

import asyncio
import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy import update as sa_update
from sqlalchemy.exc import IntegrityError

from core.exceptions import AIServiceError
from core.security_guard import check_input_injection, filter_output_leak
from core.tenant import set_tenant
from db.session import async_session
from models.collaboration import CollabTask
from models.store import Store
from services.ai.base import TextRequest
from services.ai.factory import ProviderFactory
from services.content_service import (
    ROLE_LABELS,
    _append_guardrails,
    _validate_provider_for_production,
)

logger = logging.getLogger(__name__)

# 同 worker 内的执行句柄：本进程取消可立即中止 LLM 调用；
# 跨 worker 取消靠 DB 状态在阶段边界生效（规划后/执行后各检查一次）
_task_handles: dict[str, asyncio.Task] = {}

PLAN_TIMEOUT = 90
AGENT_TIMEOUT = 90
SUMMARY_TIMEOUT = 120
# 终态任务在 collab_tasks 的保留天数（结果已另存 generations，这里只是进度快照）
TASK_RETENTION_DAYS = 7


COLLABORATION_SCENARIOS = {
    "activity_planning": {
        "name": "策划活动",
        "default_roles": ["coach", "frontdesk", "operator", "manager"],
        "description": "多角色协作策划一场完整活动",
    },
    "store_opening": {
        "name": "新店开业",
        "default_roles": ["boss", "manager", "frontdesk", "operator"],
        "description": "新店开业全流程筹备",
    },
    "staff_training": {
        "name": "员工培训",
        "default_roles": ["manager", "coach", "frontdesk"],
        "description": "员工入职和技能培训",
    },
    "business_review": {
        "name": "经营复盘",
        "default_roles": ["boss", "manager", "operator"],
        "description": "月度/季度经营分析",
    },
}

ROLE_PROMPTS = {
    "boss": "你是台球房的老板/经营负责人，关注全店经营状况、成本控制和战略决策。",
    "manager": "你是台球房的店长，负责全店日常运营管理。",
    "assistant_manager": "你是台球房的助教管理，负责助教团队管理和推广。",
    "coach": "你是台球房的教练，负责教学和竞技客户维护。",
    "frontdesk": "你是台球房的前厅主管，负责客户接待和前台管理。",
    "operator": "你是台球房的运营负责人，负责内容和数据分析。",
}

VALID_ROLES = set(ROLE_PROMPTS.keys())

COMMANDER_BASE = (
    "你是台球房的运营总策划（指挥官），负责为协作任务制定《协作框架》，"
    "让各岗位照框架分工执行、互不冲突。你只做规划与分工，不写具体文案内容。"
)


# ─── 序列化 ───

def _stage_of(task: CollabTask) -> str:
    """由数据推导当前阶段：planning → executing → synthesizing → 终态"""
    if task.status != "running":
        return task.status
    if not task.framework:
        return "planning"
    agents = task.agents or []
    if agents and all(a.get("status") not in ("pending", "running") for a in agents):
        return "synthesizing"
    return "executing"


def task_to_dict(task: CollabTask) -> dict:
    return {
        "task_id": str(task.id),
        "task_type": task.task_type,
        "status": task.status,
        "stage": _stage_of(task),
        "framework": task.framework,
        "agents": task.agents or [],
        "summary": task.summary,
        "generation_id": str(task.generation_id) if task.generation_id else None,
        "created_at": task.created_at.isoformat() if task.created_at else None,
    }


# ─── DB 小工具（后台协程用独立短会话） ───

async def _update_task(task_id: str, only_if_running: bool = True, **fields) -> None:
    async with async_session() as db:
        stmt = sa_update(CollabTask).where(CollabTask.id == uuid.UUID(task_id))
        if only_if_running:
            # 不覆写已被取消/已终态的任务（取消后完成的更新一律丢弃）
            stmt = stmt.where(CollabTask.status == "running")
        await db.execute(stmt.values(**fields))
        await db.commit()


async def _get_db_status(task_id: str) -> Optional[str]:
    async with async_session() as db:
        return await db.scalar(
            select(CollabTask.status).where(CollabTask.id == uuid.UUID(task_id))
        )


# ─── ① 指挥官规划 ───

async def _plan_framework(description: str, task_type: str, store) -> tuple[str, list[str], int]:
    """指挥官产出《协作框架》并决定参与岗位。返回 (framework, roles, tokens)。"""
    scenario = COLLABORATION_SCENARIOS.get(task_type, {})
    default_roles = scenario.get("default_roles") or ["manager"]

    system_prompt, _ = _append_guardrails(
        COMMANDER_BASE, store, role="manager", intent_text=description
    )
    prompt = f"""任务：{description}

可选岗位（key: 名称）：boss(老板)、manager(店长)、assistant_manager(助教管理)、coach(教练)、frontdesk(前厅)、operator(运营)。

请输出《协作框架》，严格按以下结构：

参与岗位: <从可选岗位中选 2-5 个 key，逗号分隔，只选确有必要的岗位>

## 任务目标
一句话说清这次要达成什么、面向哪类客户。

## 预算分配
列出各项预算及金额，各项合计必须等于总预算；用户未提供预算时金额一律用[请填写]，按占比示意，不得编造具体金额。

## 时间线
关键节点与时间。用户未给具体日期则用相对时间（如"活动前3天"）。

## 岗位分工
每个参与岗位一段：负责什么、交付什么成品、边界是什么（明确写出"不要做哪些属于其他岗位的事"）。

只输出框架本身，不写任何具体文案内容。"""

    provider = ProviderFactory.get_text_provider_for_store(store)
    response = await provider.generate(
        TextRequest(system_prompt=system_prompt, prompt=prompt, max_tokens=1500)
    )
    framework = filter_output_leak(response.content)

    # 从框架首部解析参与岗位；解析失败回退场景默认
    roles: list[str] = []
    m = re.search(r"参与岗位[:：]\s*([a-zA-Z_,，、\s]+)", framework)
    if m:
        roles = [
            r.strip()
            for r in re.split(r"[,，、\s]+", m.group(1))
            if r.strip() in VALID_ROLES
        ]
    if not roles:
        roles = default_roles
    return framework, roles, response.tokens_used or 0


# ─── ② 岗位 Agent 执行 ───

def _build_role_system_prompt(role: str, description: str, store) -> str:
    """岗位 system prompt：人设 + 岗位规则 + 按场景筛选的行业知识 + 门店画像。
    与工作台同一水准，而非裸调通用 AI。"""
    base = ROLE_PROMPTS.get(role, "你是台球房运营专家。")
    text, _ = _append_guardrails(base, store, role=role, intent_text=description)
    return text


async def run_agent(
    role: str, description: str, framework: str, system_prompt: str, store=None
) -> tuple[str, int]:
    """运行单个岗位 Agent（带共享框架），返回 (安全内容, tokens)"""
    provider = ProviderFactory.get_text_provider_for_store(store)
    request = TextRequest(
        system_prompt=system_prompt,
        prompt=f"""总策划已制定《协作框架》，全体岗位必须以它为准（预算、时间、分工边界不得偏离）：

{framework}

---

任务：{description}

你的身份是{ROLE_LABELS.get(role, role)}。请只完成框架中分配给你岗位的部分，交付可直接执行的成品（话术给原话、清单给条目、金额与时间和框架保持一致）。不要重复或代写其他岗位的内容，也不要复述框架本身。""",
        max_tokens=2000,
    )
    response = await provider.generate(request)
    return filter_output_leak(response.content), response.tokens_used or 0


# ─── ③ 汇总整合（含一致性校验） ───

async def _synthesize(description: str, framework: str, joined: str, store=None) -> tuple[str, int]:
    provider = ProviderFactory.get_text_provider_for_store(store)
    request = TextRequest(
        system_prompt=(
            "你是台球房的运营操盘手，负责把各岗位提交的内容整合成一份口径统一、"
            "可直接执行的完整方案。只输出整合后的方案本身，不要评论各岗位的产出。"
        ),
        prompt=f"""任务：{description}

《协作框架》：
{framework}

各岗位产出：

{joined}

请整合为一份统一方案，并完成一致性校验：
1. 预算各项合计必须等于框架总预算；时间线不得自相矛盾；任何与框架冲突之处，以框架为准修正
2. 按「方案概述 → 时间线 → 各岗位分工与执行内容 → 预算 → 风险与备选」结构输出
3. 保留各岗位产出中的可执行细节（原话话术、清单、具体数字），不要泛泛而谈""",
        max_tokens=3000,
    )
    response = await provider.generate(request)
    return filter_output_leak(response.content), response.tokens_used or 0


# ─── 发起任务（请求上下文内） ───

async def start_task(
    db,
    task_type: str,
    description: str,
    store,
    user_id=None,
    roles: Optional[list[str]] = None,
    auto_orchestrate: bool = True,
) -> dict:
    """创建协作任务（状态落库）并启动后台执行，立即返回任务快照。"""
    injection_check = check_input_injection(description)
    if injection_check:
        raise AIServiceError(injection_check)
    _validate_provider_for_production()

    # 每店同时只允许一个运行中任务（DB 部分唯一索引兜底并发竞态）
    existing = await db.scalar(
        select(CollabTask.id).where(
            CollabTask.store_id == store.id, CollabTask.status == "running"
        )
    )
    if existing:
        raise AIServiceError("已有协作任务在执行中，请等它完成后再发起新任务")

    # 机会式清理过期终态任务（结果已另存 generations，这里只是进度快照）
    cutoff = datetime.now(timezone.utc) - timedelta(days=TASK_RETENTION_DAYS)
    await db.execute(
        delete(CollabTask).where(
            CollabTask.status != "running", CollabTask.created_at < cutoff
        )
    )

    task = CollabTask(
        store_id=store.id,
        user_id=user_id,
        task_type=task_type,
        description=description,
        status="running",
        agents=[],
        tokens_used=0,
    )
    db.add(task)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AIServiceError("已有协作任务在执行中，请等它完成后再发起新任务")
    await db.refresh(task)

    manual_roles = None
    if not auto_orchestrate and roles:
        manual_roles = [r for r in roles if r in VALID_ROLES] or None

    task_id = str(task.id)
    _task_handles[task_id] = asyncio.create_task(
        _execute(
            task_id=task_id,
            task_type=task_type,
            description=description,
            store_id=str(store.id),
            user_id=str(user_id) if user_id else None,
            manual_roles=manual_roles,
        )
    )
    return task_to_dict(task)


# ─── 后台执行流水线 ───

async def _execute(
    task_id: str,
    task_type: str,
    description: str,
    store_id: str,
    user_id: Optional[str],
    manual_roles: Optional[list[str]],
):
    # 后台协程显式设租户上下文：CollabTask/Generation 等带 store_id 的查询
    # 在无上下文时会被 tenant fail-safe 过滤成空
    set_tenant(uuid.UUID(store_id))
    tokens_total = 0
    try:
        # 取门店（独立会话的新 ORM 对象）并完成 ① 规划 + 岗位 prompt 构建
        async with async_session() as db:
            store = await db.get(Store, uuid.UUID(store_id))
            if store is None:
                raise RuntimeError(f"store {store_id} 不存在")
            framework, roles, t = await asyncio.wait_for(
                _plan_framework(description, task_type, store), timeout=PLAN_TIMEOUT
            )
            tokens_total += t
            if manual_roles:
                roles = manual_roles
            prompts = {r: _build_role_system_prompt(r, description, store) for r in roles}

        agents = [{"role": r, "status": "pending", "content": None} for r in roles]
        await _update_task(task_id, framework=framework, agents=agents, tokens_used=tokens_total)

        # 阶段边界检查：跨 worker 的取消在这里生效
        if await _get_db_status(task_id) == "cancelled":
            return

        # ② 岗位并行执行（每个 Agent 完成即写库，前端实时看到进度）
        async def run_one(agent: dict):
            nonlocal tokens_total
            agent["status"] = "running"
            await _update_task(task_id, agents=list(agents))
            try:
                content, t = await asyncio.wait_for(
                    run_agent(agent["role"], description, framework, prompts.get(agent["role"], ""), store),
                    timeout=AGENT_TIMEOUT,
                )
                agent["status"] = "completed"
                agent["content"] = content
                tokens_total += t
            except asyncio.TimeoutError:
                agent["status"] = "skipped"
                agent["content"] = "[超时跳过]"
            except asyncio.CancelledError:
                agent["status"] = "cancelled"
                raise
            except Exception:
                # 不把 provider 原始异常透给前端（可能含内部 URL/模型名）
                logger.exception("协作 Agent 失败: task=%s role=%s", task_id, agent["role"])
                agent["status"] = "failed"
                agent["content"] = "[生成失败，请重试]"
            await _update_task(task_id, agents=list(agents), tokens_used=tokens_total)

        await asyncio.gather(*[run_one(a) for a in agents])

        if await _get_db_status(task_id) == "cancelled":
            return

        completed = [a for a in agents if a["status"] == "completed"]
        if not completed:
            await _update_task(task_id, status="failed")
            return

        joined = "\n\n---\n\n".join(
            f"### {ROLE_LABELS.get(a['role'], a['role'])}\n\n{a['content']}"
            for a in completed
        )

        # ③ 汇总整合（含一致性校验）；失败回退到拼接
        summary = joined
        if len(completed) >= 2:
            try:
                summary, t = await asyncio.wait_for(
                    _synthesize(description, framework, joined, store), timeout=SUMMARY_TIMEOUT
                )
                tokens_total += t
            except Exception:
                logger.warning("汇总 Agent 失败，回退到拼接: task=%s", task_id, exc_info=True)
                summary = joined

        gen_id = await _persist_result(
            store_id=store_id,
            user_id=user_id,
            task_type=task_type,
            description=description,
            roles=roles,
            framework=framework,
            summary=summary,
            tokens_total=tokens_total,
        )
        await _update_task(
            task_id,
            status="completed",
            summary=summary,
            tokens_used=tokens_total,
            generation_id=gen_id,
        )
    except asyncio.CancelledError:
        # 本进程被取消：状态已由 cancel_task 落库，这里不再覆写
        pass
    except Exception:
        logger.exception("协作任务执行失败: task=%s", task_id)
        try:
            await _update_task(task_id, status="failed")
        except Exception:
            pass
    finally:
        _task_handles.pop(task_id, None)


async def _persist_result(
    store_id: str,
    user_id: Optional[str],
    task_type: str,
    description: str,
    roles: list[str],
    framework: str,
    summary: str,
    tokens_total: int,
) -> Optional[uuid.UUID]:
    """协作结果写入 generations（接入历史/收藏/统计体系）并补记 tokens 用量"""
    try:
        from models.generation import Generation
        from services.quota_service import increment_usage

        gen_id = uuid.uuid4()
        async with async_session() as db:
            db.add(Generation(
                id=gen_id,
                store_id=uuid.UUID(store_id),
                user_id=uuid.UUID(user_id) if user_id else None,
                type="workbench",
                sub_type=f"collab_{task_type}",
                input_params={
                    "task_type": task_type,
                    "description": description,
                    "roles": roles,
                    "collaboration": True,
                },
                prompt_used=framework[:8000],
                result=summary,
                model_used="collaboration",
                tokens_used=tokens_total,
            ))
            await db.commit()
            if tokens_total:
                # 生成次数已在发起时计费，这里只补记 tokens
                await increment_usage(db, store_id, tokens=tokens_total, count=0)
        return gen_id
    except Exception:
        logger.warning("协作结果落库失败", exc_info=True)
        return None


# ─── 查询 / 取消（任何 worker 都可处理） ───

async def get_task(db, task_id: str, store_id: str) -> Optional[dict]:
    """查询任务状态（校验门店归属，防越权读取别家门店任务）"""
    try:
        tid = uuid.UUID(task_id)
    except ValueError:
        return None
    task = await db.scalar(
        select(CollabTask).where(
            CollabTask.id == tid, CollabTask.store_id == uuid.UUID(store_id)
        )
    )
    return task_to_dict(task) if task else None


async def cancel_task(db, task_id: str, store_id: str) -> bool:
    """取消任务：状态落库（任何 worker 可见）；若执行恰在本进程则立即中止 LLM 调用"""
    try:
        tid = uuid.UUID(task_id)
    except ValueError:
        return False
    task = await db.scalar(
        select(CollabTask).where(
            CollabTask.id == tid, CollabTask.store_id == uuid.UUID(store_id)
        )
    )
    if not task:
        return False
    if task.status != "running":
        return True  # 幂等：终态任务取消视为成功

    task.status = "cancelled"
    task.agents = [
        {**a, "status": "cancelled"} if a.get("status") in ("pending", "running") else a
        for a in (task.agents or [])
    ]
    await db.commit()

    handle = _task_handles.pop(task_id, None)
    if handle and not handle.done():
        handle.cancel()
    return True
