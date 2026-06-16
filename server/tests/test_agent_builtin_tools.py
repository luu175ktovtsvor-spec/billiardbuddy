"""P1.1/P1.2 内置 Agent 工具（感知 + 生成）。

锁住：
- 预期工具均已登记进 default_registry 且能导出 OpenAI schema
- 生成类工具把 args 正确映射到现有服务函数并返回其 .result
- 感知类工具把服务返回格式化成可读文本
底层服务用 monkeypatch 替身（不碰真实 DB / 不调真实 AI / 不花钱）。
"""
import asyncio
from types import SimpleNamespace

import services.agent.tools as agent_tools
from services.agent.registry import default_registry


def _ctx(role="manager"):
    return SimpleNamespace(db=object(), store=SimpleNamespace(id="s1"), user=SimpleNamespace(my_role=role))


def _gen(result="MOCK输出"):
    return SimpleNamespace(result=result)


def test_expected_tools_registered():
    names = set(default_registry.names())
    for n in ["get_current_date", "get_today_recommendation", "write_operation_content",
              "assistant_outreach", "diagnose_operation", "recommend_games"]:
        assert n in names, f"工具 {n} 未注册"


def test_tools_export_openai_schema():
    schemas = {t["function"]["name"] for t in default_registry.to_openai_tools()}
    assert "write_operation_content" in schemas
    assert "assistant_outreach" in schemas


def test_write_operation_content_maps_args(monkeypatch):
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return _gen("朋友圈文案")

    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    out = asyncio.run(agent_tools.write_operation_content(
        {"need": "写条周末活动朋友圈", "customer_type": "old", "outputs": ["moments"]}, _ctx("coach")))
    assert out == "朋友圈文案"
    assert captured["user_intent"] == "写条周末活动朋友圈"
    assert captured["role"] == "coach"  # 跟随 ctx.user.my_role
    assert captured["target_customer_type"] == "old"
    assert captured["output_package"] == ["moments"]
    assert captured["concise"] is True


def test_assistant_outreach_maps_args(monkeypatch):
    captured = {}

    async def fake_outreach(db, store, user, **kwargs):
        captured.update(kwargs)
        return _gen("约客话术")

    monkeypatch.setattr(agent_tools, "generate_outreach", fake_outreach)
    out = asyncio.run(agent_tools.assistant_outreach(
        {"customer_name": "王哥", "customer_type": "vip"}, _ctx()))
    assert out == "约客话术"
    assert captured["customer_name"] == "王哥"
    assert captured["customer_type"] == "vip"


def test_diagnose_maps_args(monkeypatch):
    captured = {}

    async def fake_diag(db, store, user, **kwargs):
        captured.update(kwargs)
        return _gen("诊断建议")

    monkeypatch.setattr(agent_tools, "analyze_diagnosis", fake_diag)
    out = asyncio.run(agent_tools.diagnose_operation({"situation": "周中没人"}, _ctx()))
    assert out == "诊断建议"
    assert captured["current_situation"] == "周中没人"


def test_recommend_games_maps_args(monkeypatch):
    captured = {}

    async def fake_games(db, store, user, **kwargs):
        captured.update(kwargs)
        return _gen("玩法推荐")

    monkeypatch.setattr(agent_tools, "_recommend_games", fake_games)
    out = asyncio.run(agent_tools.recommend_games({"count": 6, "skill_level": "beginner"}, _ctx()))
    assert out == "玩法推荐"
    assert captured["customer_count"] == 6
    assert captured["skill_level"] == "beginner"


def test_today_recommendation_formats(monkeypatch):
    async def fake_dash(db, store):
        return SimpleNamespace(
            weekday="周二", greeting="新的一天开始啦",
            recommendations=[SimpleNamespace(category="活动", title="双人局", description="周中拉新好时机")],
            tips=["多发朋友圈"])

    monkeypatch.setattr(agent_tools, "get_today_dashboard", fake_dash)
    out = asyncio.run(agent_tools.get_today_recommendation({}, _ctx()))
    assert "周二" in out and "双人局" in out and "周中拉新好时机" in out
