"""Agent 编排引擎 — 多角色协作生成"""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Optional

from services.ai.base import TextRequest
from services.ai.factory import ProviderFactory


# 内存存储协作任务状态（生产环境可替换为 Redis）
_tasks: dict[str, dict] = {}


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


async def run_agent(role: str, description: str, store_id: str) -> str:
    """运行单个 Agent 生成内容"""
    provider = ProviderFactory.get_text_provider()

    system_prompt = ROLE_PROMPTS.get(role, "你是台球房运营专家。")
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
    return response.content


async def start_task(
    task_type: str,
    description: str,
    store_id: str,
    roles: Optional[list[str]] = None,
    auto_orchestrate: bool = True,
) -> dict:
    """发起协作任务"""
    task_id = str(uuid.uuid4())

    if auto_orchestrate and not roles:
        roles = await analyze_task(description)
    elif not roles:
        scenario = COLLABORATION_SCENARIOS.get(task_type, {})
        roles = scenario.get("default_roles", ["manager"])

    task = {
        "task_id": task_id,
        "task_type": task_type,
        "description": description,
        "store_id": store_id,
        "roles": roles,
        "status": "running",
        "agents": [
            {"role": r, "status": "pending", "content": None}
            for r in roles
        ],
        "summary": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    _tasks[task_id] = task

    asyncio.create_task(_execute_agents(task_id))
    return task


async def _execute_agents(task_id: str):
    """并发执行所有 Agent"""
    task = _tasks.get(task_id)
    if not task:
        return

    store_id = task["store_id"]
    description = task["description"]

    async def run_one(agent: dict):
        agent["status"] = "running"
        try:
            content = await asyncio.wait_for(
                run_agent(agent["role"], description, store_id),
                timeout=30,
            )
            agent["status"] = "completed"
            agent["content"] = content
        except asyncio.TimeoutError:
            agent["status"] = "skipped"
            agent["content"] = "[超时跳过]"
        except Exception as e:
            agent["status"] = "failed"
            agent["content"] = f"[失败: {str(e)}]"

    await asyncio.gather(*[run_one(a) for a in task["agents"]])

    completed = [a for a in task["agents"] if a["status"] == "completed"]
    if completed:
        task["summary"] = "\n\n---\n\n".join(
            f"### {a['role']} Agent\n\n{a['content']}"
            for a in completed
        )
        task["status"] = "completed"
    else:
        task["status"] = "failed"


def get_task(task_id: str) -> Optional[dict]:
    """查询任务状态"""
    return _tasks.get(task_id)


def cancel_task(task_id: str) -> bool:
    """取消任务"""
    task = _tasks.get(task_id)
    if not task:
        return False
    task["status"] = "cancelled"
    for agent in task["agents"]:
        if agent["status"] in ("pending", "running"):
            agent["status"] = "cancelled"
    return True
