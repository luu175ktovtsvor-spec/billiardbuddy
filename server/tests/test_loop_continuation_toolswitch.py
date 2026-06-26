"""M10 #1 回归 · 截断续写途中模型改去调工具 → 半截续写片段不得串进最终答复。

场景（bug 复现）：
  轮1: 模型输出半句、finish_reason="length"（被 max_tokens 截断）、无 tool_calls
       → 触发续写，半句被收进 final_segments，并回灌"接着写完"。
  轮2: 模型【没有接着写文字，而是改去调一个工具】(finish_reason="tool_calls")。
       → 进入工具分支。bug：final_segments 里那半句没被清掉。
  轮3: 工具跑完，模型收敛给最终答复（finish_reason="stop"）。
       → bug 时 final = 半句 + 最终答复（半句串台）；修复后 final 只应是最终答复。

锁住：同步 run_agent_loop 与流式 run_agent_loop_stream 两入口都不得让半截片段串台；
      且清掉旧片段后，工具之后再发生的【正常续写】仍能从干净基线拼完整（不带上旧半句）。
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _reg():
    async def _look(args, ctx):
        return "查到的资料"

    reg = ToolRegistry()
    reg.register(Tool(name="look", description="查点东西", read_only=True,
                      parameters={"type": "object", "properties": {}}, handler=_look))
    return reg


async def _collect(agen):
    return [ev async for ev in agen]


_TRUNCATED = "我先想一下这个问题，让我"   # 轮1 被 length 截断的半句
_FINAL = "根据查到的资料，结论是这样的。"   # 轮3 收敛后的最终答复


def _script():
    return [
        TextResponse(content=_TRUNCATED, model="mock", finish_reason="length"),                 # 轮1 截断
        TextResponse(content="", model="mock", tool_calls=[_tc("look")], finish_reason="tool_calls"),  # 轮2 改去调工具
        TextResponse(content=_FINAL, model="mock", finish_reason="stop"),                        # 轮3 收敛
    ]


def test_sync_truncated_segment_not_spliced_when_switch_to_tool():
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(),
                                     provider=MockTextProvider(scripted=_script())))
    assert _TRUNCATED not in res.final_text   # 半截片段没串进最终答复
    assert res.final_text == _FINAL           # 最终答复只有收敛那段
    assert res.turns == 3


def test_stream_truncated_segment_not_spliced_when_switch_to_tool():
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="x", registry=_reg(), provider=MockTextProvider(scripted=_script()))))
    final = [e for e in events if e["type"] == "final"]
    assert final, "应有 final 事件"
    assert _TRUNCATED not in final[0]["content"]
    assert final[0]["content"] == _FINAL


# ---------- 清掉旧片段后，工具之后的【正常续写】仍能干净拼接 ----------

_HALF_A = "这是工具前的半句A，"        # 轮1 截断（应被清掉）
_HALF_B = "这是工具后的半句B，"        # 轮3 截断（合法续写，应保留）
_TAIL = "这是结尾。"                    # 轮4 收敛


def _script_continue_after_tool():
    return [
        TextResponse(content=_HALF_A, model="mock", finish_reason="length"),                     # 轮1 截断
        TextResponse(content="", model="mock", tool_calls=[_tc("look")], finish_reason="tool_calls"),  # 轮2 调工具（清旧片段）
        TextResponse(content=_HALF_B, model="mock", finish_reason="length"),                     # 轮3 又被截断（合法续写）
        TextResponse(content=_TAIL, model="mock", finish_reason="stop"),                         # 轮4 收敛
    ]


def test_sync_continuation_after_tool_starts_from_clean_base():
    res = asyncio.run(run_agent_loop(user_message="x", registry=_reg(),
                                     provider=MockTextProvider(scripted=_script_continue_after_tool())))
    assert _HALF_A not in res.final_text       # 工具前那半句不串台
    assert res.final_text == _HALF_B + _TAIL   # 工具后的续写从干净基线拼完整
