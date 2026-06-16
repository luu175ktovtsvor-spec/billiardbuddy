"""P1.3 agent 端点：system prompt 注入"懂这家店"。

锁住 compose_agent_system_prompt 的拼装规则（纯函数、不碰 DB）：
- 基底指令恒在
- 有门店画像则带上
- 有店脑记忆则带上
- 都为空时只剩基底（不产生空标题/空块）
"""
from api.v1.agent import _AGENT_BASE_PROMPT, compose_agent_system_prompt


def test_compose_includes_profile_and_brain():
    out = compose_agent_system_prompt("门店定位：社区店，主打散客", "请记住：老板叫李伟，主推一卡通")
    assert _AGENT_BASE_PROMPT in out
    assert "社区店" in out
    assert "李伟" in out


def test_compose_empty_is_base_only():
    assert compose_agent_system_prompt("", "") == _AGENT_BASE_PROMPT
    assert compose_agent_system_prompt("   ", None or "") == _AGENT_BASE_PROMPT


def test_compose_profile_only():
    out = compose_agent_system_prompt("门店定位：高端会所", "")
    assert "高端会所" in out
    assert _AGENT_BASE_PROMPT in out
