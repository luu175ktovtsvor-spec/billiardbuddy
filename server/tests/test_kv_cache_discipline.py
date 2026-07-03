"""F8乙 · KV-cache 纪律自查护栏（内置 key 成本命门：命中与否差 10 倍钱，见 loop.py SH-9 注释）。

三条铁律各配一个廉价护栏测试（不改架构，只锁行为）：
1. 系统提示零时间戳/随机内容：同样输入下 `compose_agent_system_prompt` 两次组装逐字节相同。
   （`_today_line()` 只精确到"天"，同一天内多次调用不该产生任何字节差异——若未来有人不慎加了
   秒级时间戳/随机数，这个测试会红。）
2. 历史严格 append-only + 会话中途绝不增删工具定义：`run_agent_loop`/`run_agent_loop_stream` 只在
   起跑前 `registry.to_openai_tools()` 快照一次，之后各轮复用同一份局部变量——即便某个工具 handler
   在执行期间往 registry 里偷插新工具，本轮/后续轮发给 provider 的 tools 参数也不会变。
3. 工具 JSON 序列化 sort_keys：`ToolRegistry.to_openai_tools()`／`Tool.to_openai_schema()` 全程不用
   `sort_keys`，工具列表顺序 = 注册顺序、每个工具 `parameters` 内的 key 顺序 = 声明时的字典顺序，
   原样直达 provider（loop.py 里唯一用到 `sort_keys=True` 的两处——`_action_key`/`_execute_tool` 的
   防打转签名——只用于内部去重比对，从不进入发给模型的 messages/tools）。
"""
import asyncio
import json

from api.v1.agent import compose_agent_system_prompt
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


# ---------- 1. 系统提示零时间戳/随机内容 ----------

def test_system_prompt_deterministic_general_mode():
    a = compose_agent_system_prompt("门店画像XYZ", "店脑记忆ABC", full_disk=False)
    b = compose_agent_system_prompt("门店画像XYZ", "店脑记忆ABC", full_disk=False)
    assert a == b


def test_system_prompt_deterministic_billiards_mode_full_disk_and_working_dir():
    """多分支组合（billiards_mode + full_disk + working_dir + output_style）同样必须逐字节稳定——
    这些是真机常见组合，任何一个分支混进随机/时间戳都会在这里露出来。"""
    kwargs = dict(billiards_mode=True, full_disk=True, output_style="concise",
                 working_dir="/Users/laoban/项目")
    a = compose_agent_system_prompt("门店画像XYZ", "店脑记忆ABC", **kwargs)
    b = compose_agent_system_prompt("门店画像XYZ", "店脑记忆ABC", **kwargs)
    assert a == b


# ---------- 2. 会话中途绝不增删工具定义 ----------

def _base_reg():
    reg = ToolRegistry()

    async def _sneaky_new_tool_handler(args, ctx):
        return "x"

    async def _sneaky_handler(args, ctx):
        # 模拟一个"手贱"工具:执行期间往 registry 里偷插一个新工具定义——现实中不该有工具这么做，
        # 这里只是压力测试"就算有人这么干,loop 会不会被带偏"。
        if reg.get("sneaky_new_tool") is None:
            reg.register(Tool(name="sneaky_new_tool", description="y",
                              parameters={"type": "object", "properties": {}},
                              handler=_sneaky_new_tool_handler))
        return "done"

    reg.register(Tool(name="sneaky", description="x", parameters={"type": "object", "properties": {}},
                      handler=_sneaky_handler))
    return reg


def test_tool_definitions_frozen_within_one_loop_run():
    reg = _base_reg()
    seen_tool_names_per_call: list[list[str]] = []

    class _P(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.n = 0

        async def generate(self, request):
            self.n += 1
            seen_tool_names_per_call.append([t["function"]["name"] for t in (request.tools or [])])
            if self.n == 1:
                return TextResponse(content="", model="mock", tool_calls=[
                    {"id": "c1", "type": "function", "function": {"name": "sneaky", "arguments": "{}"}}])
            return TextResponse(content="最终答复", model="mock", finish_reason="stop")

    res = asyncio.run(run_agent_loop(user_message="x", registry=reg, provider=_P(), ctx=AgentContext()))
    assert res.final_text == "最终答复"
    assert len(seen_tool_names_per_call) == 2
    # 第一轮(sneaky 还没执行)和第二轮(sneaky 已执行、registry 已被偷插)发给 provider 的工具表【完全一样】——
    # 证明 loop 全程用起跑前 snapshot 的同一份 tools，不会因 registry 被中途改动而变（KV-cache 前缀稳定）。
    assert seen_tool_names_per_call[0] == seen_tool_names_per_call[1]
    assert "sneaky_new_tool" not in seen_tool_names_per_call[1]
    # 而 registry 本身确实被改了（证明"手贱"工具真的执行过、不是没触发）
    assert reg.get("sneaky_new_tool") is not None


# ---------- 3. sort_keys 只用于内部签名，不进发给模型的 tools ----------

def test_to_openai_tools_preserves_registration_order_not_sorted():
    reg = ToolRegistry()
    reg.register(Tool(name="zebra_tool", description="z", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    reg.register(Tool(name="apple_tool", description="a", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    names = [t["function"]["name"] for t in reg.to_openai_tools()]
    assert names == ["zebra_tool", "apple_tool"]  # 注册顺序，不是字母序（sort_keys 会把它排成 apple 在前）


def test_tool_parameters_key_order_preserved_not_sorted():
    """工具 parameters 里 properties 的 key 顺序 = 声明时写的顺序；json.dumps 默认 sort_keys=False，
    这里显式验证真到了"喂给模型的 tools 数组"这一步依然没被排序过。

    审批闸 2.0 ②：to_openai_schema 无条件在末尾追加 security_risk 字段（见 registry.py），
    这里的"顺序不被打乱"断言相应更新为"声明的 key 保序 + security_risk 固定追加在最后"。"""
    params = {"type": "object", "properties": {"zebra": {"type": "string"}, "apple": {"type": "string"}},
              "required": ["zebra", "apple"]}
    reg = ToolRegistry()
    reg.register(Tool(name="t", description="x", parameters=params, handler=lambda a, c: None))
    schema = reg.to_openai_tools()[0]
    prop_keys = list(schema["function"]["parameters"]["properties"].keys())
    assert prop_keys == ["zebra", "apple", "security_risk"]
    # 序列化成真正发给 provider 的 JSON 串也保持顺序（default sort_keys=False）
    dumped = json.dumps(schema)
    assert dumped.index('"zebra"') < dumped.index('"apple"') < dumped.index('"security_risk"')
