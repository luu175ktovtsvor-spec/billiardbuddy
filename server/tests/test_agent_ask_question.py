"""AskUserQuestion（借鉴 cc-haha）：提问工具不执行，改吐 ask_question + 回灌"等用户选"。

机制同审批闸——循环里拦截 is_question 工具，让前端渲染选项卡片，老板点选后作为下一句消息发回。
"""
import asyncio

from services.agent.loop import run_agent_loop, _QUESTION_PENDING_MSG
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider

_Q_SCHEMA = {
    "type": "object",
    "properties": {"question": {"type": "string"}, "options": {"type": "array"}},
    "required": ["question", "options"],
}


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def test_question_tool_emits_ask_question_not_executed():
    executed = []

    async def handler(args, ctx):
        executed.append(args)  # 不该被调用
        return "SHOULD NOT RUN"

    reg = ToolRegistry()
    reg.register(Tool(name="ask_user_question", description="问", parameters=_Q_SCHEMA,
                      handler=handler, is_question=True))

    args = '{"question":"海报走哪种风格？","options":[{"label":"暖色温馨"},{"label":"动感霓虹"}]}'
    provider = MockTextProvider(scripted=[
        TextResponse(content="", model="mock", tool_calls=[_tc("ask_user_question", args)], finish_reason="tool_calls"),
        TextResponse(content="你从上面挑一个～", model="mock", finish_reason="stop"),
    ])
    res = asyncio.run(run_agent_loop(user_message="做张海报", registry=reg, provider=provider))

    assert executed == []  # 提问工具绝不执行
    aq = [s for s in res.steps if s.type == "ask_question"]
    assert len(aq) == 1
    assert aq[0].tool_args["question"] == "海报走哪种风格？"
    assert len(aq[0].tool_args["options"]) == 2
    assert aq[0].tool_args["multi"] is False
    # 回灌"等用户选"提示，模型据此简短提示、不替选
    assert any(s.type == "tool_result" and s.content == _QUESTION_PENDING_MSG for s in res.steps)
    assert res.final_text == "你从上面挑一个～"
