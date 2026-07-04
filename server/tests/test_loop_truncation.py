"""502 大文件 bug 守门：工具入参被 max_tokens 截断时，必须优雅恢复（回灌让模型精简/分次），
不能空参执行→写空文件→反复重试同一超大写入→打转到 max_turns→502。

根因：模型写超大 content 的 write_file，content 在工具调用参数里、撞 max_tokens 被截断 →
入参 JSON 不完整 → 解析失败。修复：_parse_args_ex 区分"截断"与"合法空参"；_plan_tool_call
对截断回灌 _ARGS_TRUNCATED_MSG（截断专属指令），让模型换策略而非死循环。
"""
import asyncio
from types import SimpleNamespace

from services.agent.loop import _parse_args_ex, _parse_args, _plan_tool_call, _ARGS_TRUNCATED_MSG
from services.agent.registry import ToolRegistry


def test_parse_args_ex_distinguishes_truncation_from_empty():
    # 合法：dict / 空 / 空串 / 合法空对象 → parsed_ok=True
    assert _parse_args_ex({"a": 1}) == ({"a": 1}, True)
    assert _parse_args_ex(None) == ({}, True)
    assert _parse_args_ex("") == ({}, True)
    assert _parse_args_ex("   ") == ({}, True)
    assert _parse_args_ex("{}") == ({}, True)
    assert _parse_args_ex('{"path":"a.md","content":"ok"}') == ({"path": "a.md", "content": "ok"}, True)
    # 截断：非空串但 JSON 解析不出（content 被砍断、字符串未闭合）→ parsed_ok=False
    args, ok = _parse_args_ex('{"path":"a.md","content":"# 标题\n这段很长很长被截断了')
    assert ok is False and args == {}
    # 向后兼容：_parse_args 仍只返回 dict
    assert _parse_args('{"x":1}') == {"x": 1}
    assert _parse_args('{"truncated') == {}


def _ctx():
    return SimpleNamespace(permission_mode="full", full_disk_access=True, allowed_paths=[])


def test_plan_tool_call_truncated_args_feeds_back_retry_instruction():
    """入参被截断 → plan 带【截断专属】error 回灌（让模型写精简/分次），而不是拿空参去执行。"""
    reg = ToolRegistry()
    tc = {"id": "tc1", "function": {"name": "write_file",
          "arguments": '{"path":"包厢营销方案.md","content":"# 方案\n一、定位\n（超长内容被截断'}}
    plan = asyncio.run(_plan_tool_call(tc, reg, _ctx()))
    assert plan.error, "截断入参应回灌 error，而不是空参执行"
    assert "没收全" in plan.error or "截断" in plan.error
    assert ("精简" in plan.error and "分多次" in plan.error), "应明确指示写精简/分次重试"
    assert plan.args == {}  # 不把半截参数当真参用


def test_plan_tool_call_valid_empty_args_not_treated_as_truncation():
    """合法空参 '{}' 不能被误判成截断（否则无参工具永远报截断）。"""
    reg = ToolRegistry()
    tc = {"id": "tc2", "function": {"name": "get_current_date", "arguments": "{}"}}
    plan = asyncio.run(_plan_tool_call(tc, reg, _ctx()))
    # 没有截断专属 error（可能因工具不存在/校验有别的提示，但不应是截断指令）
    assert not (plan.error and "没收全" in plan.error)
