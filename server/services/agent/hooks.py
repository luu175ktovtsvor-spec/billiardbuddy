"""Agent Hook 机制（借鉴 cc-haha PreToolUse/PostToolUse）：在工具执行前/后挂可配置逻辑。

用途：把"在固定事件点跑额外逻辑"从硬编码里解放出来——
- **PreToolUse**：工具真正执行【前】跑，可**拦截**该工具（如"群发前校验名单""发布前敏感词检查""下单前校验库存"）。
- **PostToolUse**：工具执行【后】跑，**只观察、不改控制流**（如归档成品、发飞书通知、打点）。

设计：
- 纯进程内 Python 回调注册表（不做 cc-haha 那套 shell-out/JSON 协议，对本项目过重）。
- **故障安全**：任一 hook 抛异常都吞掉、不影响工具执行/循环（observability 不能拖垮主流程）。
- 默认空注册表 → 不挂任何 hook 时零行为变化（安全）。

hook 签名：
- PreToolUse:  `async def fn(tool_name: str, args: dict, ctx) -> dict | None`
              返回 `{"deny": "原因"}` → 拦截该工具；返回 None/其它 → 放行。
- PostToolUse: `async def fn(tool_name: str, args: dict, result: str, ctx) -> None`
"""
import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)

PreToolHook = Callable[[str, dict, Any], Awaitable[dict | None]]
PostToolHook = Callable[[str, dict, str, Any], Awaitable[None]]

_PRE_TOOL_HOOKS: list[PreToolHook] = []
_POST_TOOL_HOOKS: list[PostToolHook] = []


def register_pre_tool_hook(fn: PreToolHook) -> PreToolHook:
    """注册 PreToolUse hook（工具执行前，可拦截）。"""
    _PRE_TOOL_HOOKS.append(fn)
    return fn


def register_post_tool_hook(fn: PostToolHook) -> PostToolHook:
    """注册 PostToolUse hook（工具执行后，只观察）。"""
    _POST_TOOL_HOOKS.append(fn)
    return fn


def clear_hooks() -> None:
    """清空所有 hook（测试用）。"""
    _PRE_TOOL_HOOKS.clear()
    _POST_TOOL_HOOKS.clear()


async def run_pre_tool_hooks(tool_name: str, args: dict, ctx: Any) -> str | None:
    """跑所有 PreToolUse hook。任一返回 deny → 返回拦截原因（不执行工具）；都放行 → None。故障安全。"""
    for fn in _PRE_TOOL_HOOKS:
        try:
            r = await fn(tool_name, args, ctx)
            if isinstance(r, dict) and r.get("deny"):
                return str(r["deny"])
        except Exception:
            logger.exception("PreToolUse hook 失败（忽略，不拦截）: %s", getattr(fn, "__name__", "?"))
    return None


async def run_post_tool_hooks(tool_name: str, args: dict, result: str, ctx: Any) -> None:
    """跑所有 PostToolUse hook（观察/归档/通知）。故障安全：抛异常吞掉、不影响工具结果。"""
    for fn in _POST_TOOL_HOOKS:
        try:
            await fn(tool_name, args, result, ctx)
        except Exception:
            logger.exception("PostToolUse hook 失败（忽略）: %s", getattr(fn, "__name__", "?"))
