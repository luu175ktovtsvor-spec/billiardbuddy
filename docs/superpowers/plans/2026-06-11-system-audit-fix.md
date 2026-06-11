# 系统审计修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复代码审计发现的 7 个问题：安全检查补全、协作引擎知识加载、输出过滤优化、映射表去重、内存泄漏修复、日志补全、孤立变量清理。

**Architecture:** 在现有代码基础上做针对性修改，不重构整体架构。协作引擎复用 content_service.py 的知识加载函数，安全检查统一调用 security_guard.py 的现有函数。

**Tech Stack:** Python, FastAPI, SQLAlchemy, PyYAML

---

## 文件结构总览

### 修改文件

| 文件 | 改动 |
|------|------|
| `server/core/security_guard.py` | 新增 `filter_output_leak_partial()` |
| `server/services/content_service.py` | 补全安全检查 + 输出过滤 + 加日志 + 从共享文件导入 |
| `server/services/orchestrator.py` | 重构 run_agent 加载知识 + 安全防护 + TTL 清理 |
| `server/api/v1/orchestrate.py` | 传递 store 对象 |
| `server/api/v1/stream.py` | 从共享文件导入 scenario_role_map |

### 新建文件

| 文件 | 职责 |
|------|------|
| `server/services/scenario_role_map.py` | 共享的 scenario-role 映射表 |

### 修改知识文件（清理孤立 variables）

| 文件 | 移除 |
|------|------|
| `server/prompts/knowledge/assistant_promotion.yaml` | `store_name` |
| `server/prompts/knowledge/assistant_service_sop.yaml` | `store_name`, `city` |
| `server/prompts/knowledge/competitive_group_ops.yaml` | `store_name` |
| `server/prompts/knowledge/daily_workflow.yaml` | `store_name`, `city` |
| `server/prompts/knowledge/performance_standards.yaml` | `store_name`, `city` |

---

## Task 1: 新建 scenario_role_map 共享常量

**Files:**
- Create: `server/services/scenario_role_map.py`

- [ ] **Step 1: 创建共享映射文件**

```python
# server/services/scenario_role_map.py
"""共享的场景-角色映射表，避免 content_service.py 和 stream.py 重复定义"""

SCENARIO_ROLE_MAP = {
    "groupbuy_to_private": "frontdesk",
    "assistant_promo": "assistant_manager",
    "partner_match": "coach",
    "tournament": "coach",
    "old_customer_recall": "manager",
    "assistant_outreach": "assistant_manager",
    "assistant_booking": "assistant_manager",
    "member_assistant_notice": "assistant_manager",
    "daily_report": None,  # 使用请求中的 role
    "performance_template": "assistant_manager",
    "daily_task_list": None,  # 使用请求中的 role
    "vip_maintenance": "manager",
    "group_content": "operator",
    "short_video": "operator",
    "complaint_handling": "frontdesk",
    "frontdesk_sop": "frontdesk",
    "tournament_signup": "coach",
    "tournament_report": "coach",
    "qiangyi_battle": "coach",
    "review_guidance": "coach",
    "cart_promotion": "frontdesk",
    "opening_event": "operator",
    "recruitment": "assistant_manager",
    "training_exam": "assistant_manager",
    "diagnosis_tool": "boss",
    "coaching_promo": "coach",
    "competition_customer": "coach",
    "empty_table_promo": "frontdesk",
    "departure_followup": "frontdesk",
    "customer_group_guide": "frontdesk",
    "opening_closing_sop": "frontdesk",
    "equipment_management": "frontdesk",
    "store_atmosphere": "operator",
    "poster_copy": "operator",
    "sports_event_watching": "manager",
    "staff_birthday": "manager",
    "hygiene_check": "frontdesk",
    "champion_poster": "coach",
    "tournament_rules": "coach",
    "monthly_report": "boss",
    "activity_direction": "boss",
    "business_strategy": "boss",
    "table_content_plan": "operator",
    "game_recommend": "coach",
    "ip_cooperation": "assistant_manager",
    "review_meeting": "manager",
}
```

- [ ] **Step 2: Commit**

```bash
git add server/services/scenario_role_map.py
git commit -m "feat: 提取 scenario_role_map 为共享常量"
```

---

## Task 2: 修改 content_service.py 导入共享映射 + 补全安全检查

**Files:**
- Modify: `server/services/content_service.py`

- [ ] **Step 1: 添加日志导入**

在 `content_service.py` 文件顶部的 import 区域，添加：

```python
import logging

logger = logging.getLogger(__name__)
```

- [ ] **Step 2: 替换 scenario_role_map 导入**

找到 `generate_operation()` 函数中的 `scenario_role_map` 定义（约 line 348），替换为：

```python
from services.scenario_role_map import SCENARIO_ROLE_MAP as scenario_role_map
```

同样，找到 `generate_workbench()` 函数中的 `scenario_role_map` 定义（约 line 434），替换为同一个导入。

两处导入只写一次，放在文件顶部。

- [ ] **Step 3: 为 generate_activity() 添加安全检查**

在 `generate_activity()` 函数中，在 `await check_quota(db, str(store.id))` 之后、`_validate_provider_for_production()` 之后，添加：

```python
    injection_check = check_input_injection(extra_note)
    if injection_check:
        raise AIServiceError(injection_check)
```

- [ ] **Step 4: 为 generate_operation() 添加安全检查**

在 `generate_operation()` 函数中，在 `await check_quota(db, str(store.id))` 之后、`_validate_provider_for_production()` 之后，添加：

```python
    injection_check = check_input_injection(extra_note)
    if injection_check:
        raise AIServiceError(injection_check)
```

- [ ] **Step 5: 为 generate_copywriting() 添加输出过滤**

在 `generate_copywriting()` 函数的 return 语句之前，添加：

```python
    content = filter_output_leak(content)
```

- [ ] **Step 6: 为 generate_activity() 添加输出过滤**

在 `generate_activity()` 函数的 return 语句之前，添加：

```python
    content = filter_output_leak(content)
```

- [ ] **Step 7: 为 generate_operation() 添加输出过滤**

在 `generate_operation()` 函数的 return 语句之前，添加：

```python
    content = filter_output_leak(content)
```

- [ ] **Step 8: 为 _load_knowledge_for_role() 添加日志**

在 `_load_knowledge_for_role()` 函数的 except 块中（约 line 136），将：

```python
        except (PromptTemplateNotFoundError, PromptVariableMissingError):
            continue
```

改为：

```python
        except (PromptTemplateNotFoundError, PromptVariableMissingError) as e:
            logger.warning("知识加载跳过: %s - %s", key, str(e))
            continue
```

- [ ] **Step 9: 验证 Python 语法**

Run: `cd server && python -c "from services.content_service import generate_workbench; print('OK')"`

- [ ] **Step 10: Commit**

```bash
git add server/services/content_service.py
git commit -m "fix: 补全安全检查+输出过滤+日志+导入共享映射"
```

---

## Task 3: 重构协作引擎加载知识 + 安全防护

**Files:**
- Modify: `server/services/orchestrator.py`
- Modify: `server/api/v1/orchestrate.py`

- [ ] **Step 1: 重写 orchestrator.py**

将整个文件替换为以下内容：

```python
"""Agent 编排引擎 — 多角色协作生成"""

import asyncio
import logging
import uuid
from datetime import datetime, timezone, timedelta
from typing import Optional

from services.ai.base import TextRequest
from services.ai.factory import ProviderFactory
from services.content_service import (
    _load_rule_safe,
    _load_knowledge_for_role,
)
from services.store_profile_service import render_operation_profile_context
from core.security_guard import check_input_injection, filter_output_leak

logger = logging.getLogger(__name__)

# 内存存储协作任务状态（生产环境可替换为 Redis）
_tasks: dict[str, dict] = {}

# 最大任务数限制
MAX_TASKS = 100
# 任务过期时间（秒）
TASK_TTL = 3600  # 1 小时


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


def _cleanup_old_tasks():
    """清理过期任务"""
    now = datetime.now(timezone.utc)
    expired = [
        tid for tid, task in _tasks.items()
        if (now - datetime.fromisoformat(task["created_at"])).total_seconds() > TASK_TTL
        and task["status"] in ("completed", "cancelled", "failed")
    ]
    for tid in expired:
        del _tasks[tid]
    if expired:
        logger.info("清理过期任务: %d 个", len(expired))


def _build_agent_system_prompt(role: str, store) -> str:
    """为 Agent 构建完整的 system prompt，包含知识、规则和门店信息"""
    sections = []

    # 基线规则
    baseline = _load_rule_safe("rules.baseline", store)
    if baseline:
        sections.append(f"## 通用强制规则\n\n{baseline}")

    # 角色规则
    role_rules = _load_rule_safe(f"rules.role.{role}", store)
    if role_rules:
        sections.append(f"## 岗位规则\n\n{role_rules}")

    # 行业知识
    knowledge = _load_knowledge_for_role(role, store)
    if knowledge:
        sections.append(f"## 行业知识参考\n\n{knowledge}")

    # 门店画像
    profile = render_operation_profile_context(store)
    if profile:
        sections.append(f"## 门店运营画像\n\n{profile}")

    # 角色身份（最后追加，作为核心指令）
    role_prompt = ROLE_PROMPTS.get(role, "你是台球房运营专家。")
    sections.append(f"## 你的身份\n\n{role_prompt}")

    return "\n\n---\n\n".join(sections) if sections else role_prompt


async def analyze_task(description: str) -> list[str]:
    """用 AI 分析任务描述，判断需要哪些角色"""
    # 安全检查
    injection_check = check_input_injection(description)
    if injection_check:
        logger.warning("协作任务输入注入检测: %s", injection_check)
        return ["manager"]  # 回退到默认角色

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


async def run_agent(role: str, description: str, store) -> str:
    """运行单个 Agent 生成内容（含知识加载+安全防护）"""
    # 安全检查
    injection_check = check_input_injection(description)
    if injection_check:
        return f"[输入安全拦截: {injection_check}]"

    provider = ProviderFactory.get_text_provider()

    # 构建完整 system prompt（含知识、规则、门店信息）
    system_prompt = _build_agent_system_prompt(role, store)

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

    # 输出过滤
    return filter_output_leak(response.content)


async def start_task(
    task_type: str,
    description: str,
    store,
    roles: Optional[list[str]] = None,
    auto_orchestrate: bool = True,
) -> dict:
    """发起协作任务"""
    # 清理过期任务
    _cleanup_old_tasks()

    # 检查任务数限制
    if len(_tasks) >= MAX_TASKS:
        raise ValueError("任务数已达上限，请稍后再试")

    # 安全检查
    injection_check = check_input_injection(description)
    if injection_check:
        raise ValueError(injection_check)

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
        "store_id": str(store.id),
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

    asyncio.create_task(_execute_agents(task_id, store))
    return task


async def _execute_agents(task_id: str, store):
    """并发执行所有 Agent"""
    task = _tasks.get(task_id)
    if not task:
        return

    description = task["description"]

    async def run_one(agent: dict):
        agent["status"] = "running"
        try:
            content = await asyncio.wait_for(
                run_agent(agent["role"], description, store),
                timeout=30,
            )
            agent["status"] = "completed"
            agent["content"] = content
        except asyncio.TimeoutError:
            agent["status"] = "skipped"
            agent["content"] = "[超时跳过]"
        except Exception as e:
            logger.error("Agent %s 执行失败: %s", agent["role"], str(e))
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
```

- [ ] **Step 2: 修改 orchestrate.py 传递 store 对象**

将 `server/api/v1/orchestrate.py` 中的 `create_orchestration` 函数修改为：

```python
@router.post("")
async def create_orchestration(
    req: OrchestrateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
):
    """发起协作任务"""
    if req.task_type not in COLLABORATION_SCENARIOS and req.task_type != "custom":
        raise HTTPException(status_code=400, detail=f"未知任务类型: {req.task_type}")

    try:
        task = await start_task(
            task_type=req.task_type,
            description=req.description,
            store=current_store,  # 传递 store 对象而非 store_id
            roles=req.roles,
            auto_orchestrate=req.auto_orchestrate,
        )
        return task
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

- [ ] **Step 3: 验证 Python 语法**

Run: `cd server && python -c "from services.orchestrator import start_task, get_task, cancel_task; print('OK')"`

- [ ] **Step 4: Commit**

```bash
git add server/services/orchestrator.py server/api/v1/orchestrate.py
git commit -m "fix: 重构协作引擎 — 加载知识+安全防护+TTL清理"
```

---

## Task 4: 修改 stream.py 导入共享映射

**Files:**
- Modify: `server/api/v1/stream.py`

- [ ] **Step 1: 替换 scenario_role_map 定义**

在 `stream.py` 中找到 `scenario_role_map` 的定义（约 line 74-124），删除整个字典定义，替换为导入：

```python
from services.scenario_role_map import SCENARIO_ROLE_MAP as scenario_role_map
```

将此导入放在文件顶部的 import 区域。

- [ ] **Step 2: 验证 Python 语法**

Run: `cd server && python -c "from api.v1.stream import router; print('OK')"`

- [ ] **Step 3: Commit**

```bash
git add server/api/v1/stream.py
git commit -m "refactor: stream.py 导入共享 scenario_role_map"
```

---

## Task 5: 清理知识文件孤立 variables

**Files:**
- Modify: 5 个 knowledge YAML 文件

- [ ] **Step 1: 清理 assistant_promotion.yaml**

Read `server/prompts/knowledge/assistant_promotion.yaml`，找到 `variables:` 行，移除 `store_name`。

- [ ] **Step 2: 清理 assistant_service_sop.yaml**

Read `server/prompts/knowledge/assistant_service_sop.yaml`，找到 `variables:` 行，移除 `store_name` 和 `city`。

- [ ] **Step 3: 清理 competitive_group_ops.yaml**

Read `server/prompts/knowledge/competitive_group_ops.yaml`，找到 `variables:` 行，移除 `store_name`。

- [ ] **Step 4: 清理 daily_workflow.yaml**

Read `server/prompts/knowledge/daily_workflow.yaml`，找到 `variables:` 行，移除 `store_name` 和 `city`。

- [ ] **Step 5: 清理 performance_standards.yaml**

Read `server/prompts/knowledge/performance_standards.yaml`，找到 `variables:` 行，移除 `store_name` 和 `city`。

- [ ] **Step 6: 验证所有 YAML 仍然有效**

Run: `cd server && python -c "
import yaml, os
for f in os.listdir('prompts/knowledge'):
    if f.endswith('.yaml'):
        with open(f'prompts/knowledge/{f}') as fh:
            yaml.safe_load(fh)
print('All YAML files valid')"`

- [ ] **Step 7: Commit**

```bash
git add server/prompts/knowledge/assistant_promotion.yaml server/prompts/knowledge/assistant_service_sop.yaml server/prompts/knowledge/competitive_group_ops.yaml server/prompts/knowledge/daily_workflow.yaml server/prompts/knowledge/performance_standards.yaml
git commit -m "chore: 清理5个知识文件的孤立variables声明"
```

---

## Task 6: 最终验证

- [ ] **Step 1: 验证所有生成入口都有安全检查**

Run: `cd server && grep -n "check_input_injection\|filter_output_leak" services/content_service.py services/orchestrator.py api/v1/stream.py`

Expected: 每个生成函数都有这两个调用。

- [ ] **Step 2: 验证 scenario_role_map 只有一份**

Run: `grep -rn "scenario_role_map\|SCENARIO_ROLE_MAP" server/services/ server/api/v1/ | grep -v ".pyc"`

Expected: 只在 `scenario_role_map.py` 中定义，在 `content_service.py` 和 `stream.py` 中导入。

- [ ] **Step 3: 验证无第三方品牌名**

Run: `grep -r "唐希\|彬利烎\|某门店\|某门店\|开火体育" server/services/ server/prompts/ || echo "CLEAN"`

- [ ] **Step 4: 验证 Python 语法全部通过**

Run: `cd server && python -c "
from services.content_service import generate_workbench, generate_copywriting, generate_activity, generate_operation
from services.orchestrator import start_task, get_task, cancel_task
from services.scenario_role_map import SCENARIO_ROLE_MAP
from core.security_guard import check_input_injection, filter_output_leak
print('All imports OK')"`