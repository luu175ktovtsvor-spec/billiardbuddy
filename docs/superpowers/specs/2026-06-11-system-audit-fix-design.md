# 系统审计修复设计

> **日期**: 2026-06-11
> **状态**: 待实现
> **范围**: 基于代码审计发现的 7 个问题的修复

---

## 修复清单

### P0-1: 安全检查补全

**问题**: `generate_activity()` 和 `generate_operation()` 缺少输入注入检查和输出泄露过滤。

**修改文件**: `server/services/content_service.py`

**改动**:
- `generate_activity()` (line ~269): 在函数开头添加 `check_input_injection(extra_note)` 调用
- `generate_operation()` (line ~333): 在函数开头添加 `check_input_injection(extra_note)` 调用
- `generate_copywriting()` / `generate_activity()` / `generate_operation()`: 在 return 前添加 `filter_output_leak(content)` 调用

---

### P0-2: 协作引擎加载知识 + 安全防护

**问题**: `orchestrator.py` 的 Agent 只有一句话 prompt，没有加载任何知识、规则、门店信息，也没有安全检查。

**修改文件**: `server/services/orchestrator.py`

**改动**:
- `run_agent()` 函数重构：
  1. 接收 `store` 对象（而非 `store_id`）
  2. 调用 `_load_rule_safe("rules.baseline", store)` 加载基线规则
  3. 调用 `_load_rule_safe(f"rules.role.{role}", store)` 加载角色规则
  4. 调用 `_load_knowledge_for_role(role, store)` 加载行业知识
  5. 调用 `render_operation_profile_context(store)` 加载门店画像
  6. 拼接为完整 system prompt
  7. 调用 `check_input_injection(description)` 检查输入
  8. 调用 `filter_output_leak(content)` 过滤输出
- `analyze_task()` 函数：添加 `check_input_injection(description)` 调用
- `_execute_agents()` 函数：传递 `store` 对象给 `run_agent()`
- `start_task()` 函数：接收 `store` 对象并传递下去
- API 路由 `orchestrate.py`: 传递 store 对象

**新增导入**:
```python
from server.services.content_service import (
    _load_rule_safe,
    _load_knowledge_for_role,
    _append_guardrails,
)
from server.services.store_profile_service import render_operation_profile_context
from server.core.security_guard import check_input_injection, filter_output_leak
```

---

### P1-3: 输出过滤改为只替换泄露部分

**问题**: `filter_output_leak()` 是全有或全无——一个词触发就整段替换。

**修改文件**: `server/core/security_guard.py`

**改动**:
- 新增 `filter_output_leak_partial(content)` 函数
- 逻辑：逐行检查，只删除包含泄露模式的行，保留其余内容
- 如果删除后内容为空（全部都是泄露），才回退到安全消息
- 保留原 `filter_output_leak()` 不变（向后兼容）
- 在 `content_service.py` 和 `stream.py` 中将 `filter_output_leak()` 替换为 `filter_output_leak_partial()`

---

### P1-4: scenario_role_map 去重 + 清理死条目

**问题**: 同一个映射表在 `content_service.py` 和 `stream.py` 中各维护一份，且有 4 个死条目。

**新建文件**: `server/services/scenario_role_map.py`

**改动**:
- 将 `scenario_role_map` 提取为共享常量
- 删除 `recruitment`、`holiday_promo`、`new_store_opening`、`member_day` 4 个死条目
- `content_service.py` 和 `stream.py` 都从新文件导入

---

### P1-5: 协作引擎加 TTL 清理

**问题**: `_tasks` 字典无限增长，没有清理机制。

**修改文件**: `server/services/orchestrator.py`

**改动**:
- 在 `start_task()` 中记录 `created_at` 时间戳
- 添加 `cleanup_old_tasks()` 函数：删除超过 1 小时的已完成/已取消任务
- 在每次 `start_task()` 调用前执行清理
- 添加最大任务数限制（100 个），超过时拒绝新任务

---

### P2-6: 知识加载加日志

**问题**: 知识加载失败时静默跳过，无日志。

**修改文件**: `server/services/content_service.py`

**改动**:
- 在 `_load_knowledge_for_role()` 的 `except` 块中添加 `logger.warning(f"知识加载跳过: {key} - {str(e)}")`
- 添加 `import logging` 和 `logger = logging.getLogger(__name__)`

---

### P2-7: 清理知识文件孤立 variables

**问题**: 5 个知识文件声明了未使用的 variables。

**修改文件**:
- `server/prompts/knowledge/assistant_promotion.yaml` — 移除 `store_name`
- `server/prompts/knowledge/assistant_service_sop.yaml` — 移除 `store_name` 和 `city`
- `server/prompts/knowledge/competitive_group_ops.yaml` — 移除 `store_name`
- `server/prompts/knowledge/daily_workflow.yaml` — 移除 `store_name` 和 `city`
- `server/prompts/knowledge/performance_standards.yaml` — 移除 `store_name` 和 `city`

---

## 不修改的内容

- 前端代码
- 知识文件内容（只清理孤立 variables，不改 template）
- 角色 rules YAML（只改 required_knowledge 引用，不改 template）
- Prompt 模板
- Few-shot 样例库

---

## 验证标准

1. 所有生成入口都有输入注入检查
2. 所有生成入口都有输出泄露过滤
3. 协作引擎 Agent 能加载知识并生成专业内容
4. scenario_role_map 只有一份，无死条目
5. 协作引擎任务不会无限增长
6. 知识加载失败有日志
7. 无 Python 语法错误
