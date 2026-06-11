"""Agent 编排引擎 — 多角色协作生成"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional

from core.exceptions import AIServiceError
from core.security_guard import check_input_injection, filter_output_leak
from services.ai.base import TextRequest
from services.ai.factory import ProviderFactory
from services.content_service import _append_guardrails, ROLE_LABELS

logger = logging.getLogger(__name__)

# 内存存储协作任务状态（生产环境可替换为 Redis）
_tasks: dict[str, dict] = {}
# 各任务的岗位 system prompt（单独存放，不随 API 响应返回，避免泄露 prompt）
_task_prompts: dict[str, dict[str, str]] = {}
# 后台执行句柄：取消任务时真正中止 LLM 调用，不白烧 token
_task_handles: dict[str, asyncio.Task] = {}

# 单 Agent 生成超时（DeepSeek 非流式 2000 token 高峰期可能超 30s，放宽到 90s）
AGENT_TIMEOUT = 90
# 汇总 Agent 超时
SUMMARY_TIMEOUT = 90
# 终态任务保留时长与总量上限
TASK_TTL_SECONDS = 3600
MAX_TASKS = 100


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


async def analyze_task(description: str) -> list[str]:
    """用 AI 分析任务描述，判断需要哪些角色"""
    provider = ProviderFactory.get_text_provider()

    request = TextRequest(
        prompt=f"""分析以下任务描述，判断需要哪些台球房角色参与协作。

可选角色：boss(老板), manager(店长), assistant_manager(助教管理), coach(教练), frontdesk(前厅), operator(运营)

任务描述：{description}

请只返回需要的角色 key，用逗号分隔，不要其他内容。例如：coach,frontdesk,operator""",
        max_tokens=100,
    )

    response = await provider.generate(request)
    roles = [r.strip() for r in response.content.split(",") if r.strip()]
    return [r for r in roles if r in VALID_ROLES]


def _build_role_system_prompt(role: str, description: str, store) -> str:
    """在请求上下文内（session 存活）构建岗位 system prompt：
    岗位人设 + 岗位规则 + 按场景筛选的行业知识 + 门店画像。
    这样协作页的每个 Agent 与工作台同一水准，而非裸调通用 AI。
    """
    base = ROLE_PROMPTS.get(role, "你是台球房运营专家。")
    return _append_guardrails(base, store, role=role, intent_text=description)


async def run_agent(role: str, description: str, system_prompt: str) -> tuple[str, int]:
    """运行单个 Agent，返回 (安全内容, 消耗tokens)"""
    provider = ProviderFactory.get_text_provider()

    request = TextRequest(
        system_prompt=system_prompt,
        prompt=f"""请根据以下任务，从你的专业角度生成相关内容：

任务：{description}

要求：
1. 内容要专业、实用、可直接执行
2. 结合台球房行业特点
3. 用清晰的结构输出""",
        max_tokens=2000,
    )

    response = await provider.generate(request)
    return filter_output_leak(response.content), response.tokens_used or 0


async def _synthesize(description: str, joined: str) -> tuple[str, int]:
    """汇总 Agent：把各岗位产出综合成一份口径统一的完整方案"""
    provider = ProviderFactory.get_text_provider()
    request = TextRequest(
        system_prompt=(
            "你是台球房的运营操盘手，负责把各岗位提交的内容整合成一份口径统一、"
            "可直接执行的完整方案。只输出整合后的方案本身，不要评论各岗位的产出。"
        ),
        prompt=f"""任务：{description}

以下是各岗位的产出：

{joined}

请整合为一份统一方案，要求：
1. 统一预算、时间线、人员分工，消除各岗位之间的矛盾和重复
2. 按「方案概述 → 时间线 → 各岗位分工 → 预算 → 风险与备选」结构输出
3. 保留各岗位产出中的可执行细节（话术、清单、数字），不要泛泛而谈""",
        max_tokens=3000,
    )
    response = await provider.generate(request)
    return filter_output_leak(response.content), response.tokens_used or 0


def _cleanup_old_tasks() -> None:
    """清理超过 TTL 的终态任务，防止内存无限堆积"""
    now = datetime.now(timezone.utc)
    expired = []
    for tid, t in _tasks.items():
        if t.get("status") in ("completed", "failed", "cancelled"):
            try:
                created = datetime.fromisoformat(t["created_at"])
            except (KeyError, ValueError):
                expired.append(tid)
                continue
            if (now - created).total_seconds() > TASK_TTL_SECONDS:
                expired.append(tid)
    for tid in expired:
        _tasks.pop(tid, None)
        _task_prompts.pop(tid, None)
        _task_handles.pop(tid, None)


async def start_task(
    task_type: str,
    description: str,
    store,
    user_id=None,
    roles: Optional[list[str]] = None,
    auto_orchestrate: bool = True,
) -> dict:
    """发起协作任务。store 为完整 Store 对象（用于在请求上下文内构建含知识的 prompt）。"""
    injection_check = check_input_injection(description)
    if injection_check:
        raise AIServiceError(injection_check)

    _cleanup_old_tasks()
    if len(_tasks) >= MAX_TASKS:
        raise AIServiceError("当前协作任务过多，请稍后再试")
    # 每店同时只允许一个运行中任务：一次协作 = 多路 LLM 调用，防止并发刷
    for t in _tasks.values():
        if t.get("store_id") == str(store.id) and t.get("status") == "running":
            raise AIServiceError("已有协作任务在执行中，请等它完成后再发起新任务")

    task_id = str(uuid.uuid4())

    if auto_orchestrate and not roles:
        roles = await analyze_task(description)
    if not roles:
        # 自动编排返回为空（LLM 输出全非法）或未指定：回退到场景默认角色
        scenario = COLLABORATION_SCENARIOS.get(task_type, {})
        roles = scenario.get("default_roles") or ["manager"]

    # 在请求上下文内（store 仍可读）预构建各岗位 system prompt，存入单独 dict
    _task_prompts[task_id] = {
        r: _build_role_system_prompt(r, description, store) for r in roles
    }

    task = {
        "task_id": task_id,
        "task_type": task_type,
        "description": description,
        "store_id": str(store.id),
        "user_id": str(user_id) if user_id else None,
        "roles": roles,
        "status": "running",
        "agents": [
            {"role": r, "status": "pending", "content": None}
            for r in roles
        ],
        "summary": None,
        "generation_id": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _tasks[task_id] = task

    _task_handles[task_id] = asyncio.create_task(_execute_agents(task_id))
    return task


async def _execute_agents(task_id: str):
    """并发执行所有 Agent，完成后汇总并落库"""
    task = _tasks.get(task_id)
    if not task:
        return

    description = task["description"]
    prompts = _task_prompts.get(task_id, {})
    tokens_total = 0

    async def run_one(agent: dict):
        nonlocal tokens_total
        agent["status"] = "running"
        try:
            content, tokens = await asyncio.wait_for(
                run_agent(agent["role"], description, prompts.get(agent["role"], "")),
                timeout=AGENT_TIMEOUT,
            )
            agent["status"] = "completed"
            agent["content"] = content
            tokens_total += tokens
        except asyncio.TimeoutError:
            agent["status"] = "skipped"
            agent["content"] = "[超时跳过]"
        except asyncio.CancelledError:
            agent["status"] = "cancelled"
            raise
        except Exception:
            # 不把 provider 原始异常透给前端（可能含内部 URL/模型名）
            logger.exception("协作 Agent 生成失败: task=%s role=%s", task_id, agent["role"])
            agent["status"] = "failed"
            agent["content"] = "[生成失败，请重试]"

    try:
        await asyncio.gather(*[run_one(a) for a in task["agents"]])
    except asyncio.CancelledError:
        for a in task["agents"]:
            if a["status"] in ("pending", "running"):
                a["status"] = "cancelled"
        task["status"] = "cancelled"
        _task_prompts.pop(task_id, None)
        _task_handles.pop(task_id, None)
        return

    # 已被取消则不再覆写状态（修复：完成后无条件覆写回 completed 的状态机 bug）
    if task.get("status") == "cancelled":
        _task_prompts.pop(task_id, None)
        _task_handles.pop(task_id, None)
        return

    completed = [a for a in task["agents"] if a["status"] == "completed"]
    if completed:
        joined = "\n\n---\n\n".join(
            f"### {ROLE_LABELS.get(a['role'], a['role'])}\n\n{a['content']}"
            for a in completed
        )
        if len(completed) >= 2:
            # 汇总 Agent：第二轮综合，统一预算/时间线/分工；失败则回退到拼接
            try:
                summary, tokens = await asyncio.wait_for(
                    _synthesize(description, joined), timeout=SUMMARY_TIMEOUT
                )
                tokens_total += tokens
                task["summary"] = summary
            except Exception:
                logger.warning("汇总 Agent 失败，回退到拼接: task=%s", task_id, exc_info=True)
                task["summary"] = joined
        else:
            task["summary"] = joined
        task["status"] = "completed"
    else:
        task["status"] = "failed"

    # 用完即清理预构建的 prompt，避免内存堆积与 prompt 残留
    _task_prompts.pop(task_id, None)
    _task_handles.pop(task_id, None)

    if task["status"] == "completed":
        await _persist_result(task, tokens_total)


async def _persist_result(task: dict, tokens_total: int) -> None:
    """协作结果写入 generations（接入历史/统计体系）并补记 tokens 用量"""
    try:
        from db.session import async_session
        from models.generation import Generation
        from services.quota_service import increment_usage

        gen_id = uuid.uuid4()
        async with async_session() as db:
            db.add(Generation(
                id=gen_id,
                store_id=uuid.UUID(task["store_id"]),
                user_id=uuid.UUID(task["user_id"]) if task.get("user_id") else None,
                type="workbench",
                sub_type=f"collab_{task['task_type']}",
                input_params={
                    "task_type": task["task_type"],
                    "description": task["description"],
                    "roles": task["roles"],
                    "collaboration": True,
                },
                result=task.get("summary"),
                model_used="collaboration",
                tokens_used=tokens_total,
            ))
            await db.commit()
            if tokens_total:
                # 生成次数已在发起时计 1，这里只补记 tokens
                await increment_usage(db, task["store_id"], tokens=tokens_total, count=0)
        task["generation_id"] = str(gen_id)
    except Exception:
        logger.warning("协作结果落库失败: task=%s", task.get("task_id"), exc_info=True)


def get_task(task_id: str, store_id: str) -> Optional[dict]:
    """查询任务状态（校验门店归属，防越权读取别家门店任务）"""
    task = _tasks.get(task_id)
    if not task or task.get("store_id") != store_id:
        return None
    return task


def cancel_task(task_id: str, store_id: str) -> bool:
    """取消任务（校验门店归属；真正中止后台 LLM 调用，不白烧 token）"""
    task = _tasks.get(task_id)
    if not task or task.get("store_id") != store_id:
        return False
    task["status"] = "cancelled"
    for agent in task["agents"]:
        if agent["status"] in ("pending", "running"):
            agent["status"] = "cancelled"
    handle = _task_handles.pop(task_id, None)
    if handle and not handle.done():
        handle.cancel()
    _task_prompts.pop(task_id, None)
    return True
