"""Agent 核心机制集成验证：真跑 ReAct 循环 → 调 run_command → 完整命令过程进 tool_result 事件。

钉死「执行命令的完整过程（命令原文 + 标准输出 + 返回码）确实被产出、并随流式 tool_result 吐出」——
这正是「Claude Code 式终端展示」的【数据源】：后端把完整内容都给到了，前端据此渲染终端块。
用脚本化 Mock 驱动循环，不联网、不花钱、确定性。
"""
import asyncio
import json

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.loop import run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.agent.context import AgentContext
from services.agent import local_tools as lt


class _ScriptedStreamProvider(MockTextProvider):
    """按顺序吐脚本：每次 generate_stream 取下一条 TextResponse（含 tool_calls / finish_reason）。"""

    def __init__(self, calls):
        super().__init__()
        self._calls = list(calls)
        self._i = 0

    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        resp = self._calls[self._i] if self._i < len(self._calls) else TextResponse(
            content="完成", model="mock", finish_reason="stop")
        self._i += 1
        if resp.content:
            yield resp.content
        if resp.tool_calls and tool_calls_sink is not None:
            tool_calls_sink.extend(resp.tool_calls)
        if finish_sink is not None and resp.finish_reason:
            finish_sink["finish_reason"] = resp.finish_reason


def _registry_with_run_command():
    reg = ToolRegistry()
    reg.register(Tool(
        name="run_command", description="在本机跑一条命令",
        parameters={"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
        handler=lt.run_command, requires_approval=True, approval_class="command",
    ))
    return reg


def _collect_events(provider, ctx):
    events = []

    async def go():
        async for ev in run_agent_loop_stream(
            user_message="跑一下 echo hello-agent-2026",
            registry=_registry_with_run_command(),
            ctx=ctx,
            system_prompt="你是运行在用户本机的通用 AI 助手。",
            provider=provider,
        ):
            events.append(ev)

    asyncio.run(go())
    return events


def _cmd_call(command: str):
    return {"id": "c1", "type": "function",
            "function": {"name": "run_command", "arguments": json.dumps({"command": command})}}


def test_loop_runs_command_and_streams_full_output():
    """full + 全盘 + 关上限闸 → run_command 自动执行（不弹审批），完整输出进 tool_result。"""
    provider = _ScriptedStreamProvider([
        TextResponse(content="", model="mock", tool_calls=[_cmd_call("echo hello-agent-2026")], finish_reason="tool_calls"),
        TextResponse(content="命令跑完了。", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext(permission_mode="full", full_disk_access=True, auto_spend_limit=-1)
    events = _collect_events(provider, ctx)

    results = [e for e in events if e.get("type") == "tool_result" and e.get("tool") == "run_command"]
    assert results, f"没有 run_command 的 tool_result 事件；事件类型={[e.get('type') for e in events]}"
    content = results[0]["content"]
    # 完整执行过程：命令原文 + 返回码 + 标准输出全在（终端式展示的数据源）
    assert "命令：echo hello-agent-2026" in content
    assert "返回码：0" in content
    assert "hello-agent-2026" in content
    # tool_call 事件也带了完整命令参数（前端审批/展示用）
    calls = [e for e in events if e.get("type") == "tool_call" and e.get("tool") == "run_command"]
    assert calls and calls[0]["args"].get("command") == "echo hello-agent-2026"


def test_loop_blocks_command_without_full_disk():
    """没开完全访问 → run_command 硬门控拒绝（结果文本说明需开启），绝不真跑。"""
    provider = _ScriptedStreamProvider([
        TextResponse(content="", model="mock", tool_calls=[_cmd_call("echo x")], finish_reason="tool_calls"),
        TextResponse(content="好的。", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext(permission_mode="full", full_disk_access=False, auto_spend_limit=-1)
    events = _collect_events(provider, ctx)
    results = [e for e in events if e.get("type") == "tool_result" and e.get("tool") == "run_command"]
    assert results
    assert "完全访问" in results[0]["content"]  # 硬门控拦下，没真执行


def test_loop_streams_command_progress():
    """命令边跑边显示：run_command 执行中把 stdout 逐段经 tool_progress 事件实时推出（带步骤 id）。"""
    provider = _ScriptedStreamProvider([
        TextResponse(content="", model="mock", tool_calls=[_cmd_call("echo live-progress-2026")], finish_reason="tool_calls"),
        TextResponse(content="完成。", model="mock", finish_reason="stop"),
    ])
    ctx = AgentContext(permission_mode="full", full_disk_access=True, auto_spend_limit=-1)
    events = _collect_events(provider, ctx)
    progress = [e for e in events if e.get("type") == "tool_progress" and e.get("tool") == "run_command"]
    assert progress, f"没有 tool_progress 事件；类型={[e.get('type') for e in events]}"
    assert any("live-progress-2026" in (p.get("chunk") or "") for p in progress)
    assert all(p.get("id") for p in progress)  # 每条进度带步骤 id，前端据此回填到对应终端块
