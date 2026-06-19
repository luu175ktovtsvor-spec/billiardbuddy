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


def _gen(result="MOCK输出", knowledge_used=None):
    # input_params 带 knowledge_used：deliverable 工具会读它写进 ctx.last_knowledge_used（B-2 依据可见）
    return SimpleNamespace(result=result, input_params={"knowledge_used": knowledge_used or []})


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


# ---- make_poster（生图工具：直接出图、当成品返回，不再弹审批——纯 BYOK 老板自带 key 本就花自己钱） ----

def test_make_poster_is_deliverable_and_no_approval():
    t = default_registry.get("make_poster")
    assert t is not None
    assert t.requires_approval is False  # 去钱味：做海报=直接做、不弹确认（不是对外动作）
    assert t.deliverable is True         # 成品卡直接展示海报，并进会话 result 落库


def test_make_poster_calls_generate_images_and_returns_image(monkeypatch):
    captured = {}

    async def fake_gen(**kwargs):
        captured.update(kwargs)
        return {"images": [{"poster_url": "/uploads/posters/x.png", "generation_id": "g1"}], "count": 1}

    import services.poster_service as ps
    monkeypatch.setattr(ps, "generate_images", fake_gen)
    ctx = SimpleNamespace(db=object(), store=SimpleNamespace(id="s1"), user=SimpleNamespace(id="u1"))
    out = asyncio.run(agent_tools.make_poster({"description": "周末活动海报，热闹风", "ratio": "9:16"}, ctx))

    assert "/uploads/posters/x.png" in out and "![" in out  # 返回 markdown 图片
    assert captured["count"] == 1          # 强制单张
    assert captured["quality"] == "medium"  # 成本可控
    assert captured["prompt"] == "周末活动海报，热闹风"
    assert captured["ratio"] == "9:16"


def test_make_poster_empty_desc_skips_generation(monkeypatch):
    called = []

    async def fake_gen(**kwargs):
        called.append(1)
        return {"images": []}

    import services.poster_service as ps
    monkeypatch.setattr(ps, "generate_images", fake_gen)
    ctx = SimpleNamespace(db=None, store=None, user=SimpleNamespace(id="u"))
    out = asyncio.run(agent_tools.make_poster({"description": "   "}, ctx))
    assert called == []  # 空描述绝不触发花钱的生图
    assert "描述" in out


# ---- make_platform_content（抖音/小红书/快手/视频号 平台定制内容） ----

def test_make_platform_content_registered_no_approval():
    t = default_registry.get("make_platform_content")
    assert t is not None
    assert t.requires_approval is False  # 内容生成+复制，不自动发、不需审批


def test_make_platform_content_routes_and_passes_need(monkeypatch):
    captured = {}

    def fake_guardrails(prompt, store, role=None, intent_text=""):
        captured["role"] = role
        return prompt, ["平台运营知识库"]  # B-2：现返回 (prompt, knowledge_names)

    async def fake_run(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="抖音脚本内容 #台球",
                              input_params=kwargs.get("input_params") or {})

    monkeypatch.setattr(agent_tools, "_append_guardrails", fake_guardrails)
    monkeypatch.setattr(agent_tools, "run_generation", fake_run)
    ctx = SimpleNamespace(db=object(), store=SimpleNamespace(), user=SimpleNamespace(my_role="operator"))
    out = asyncio.run(agent_tools.make_platform_content({"platform": "抖音", "need": "周末双人半价"}, ctx))

    assert out == "抖音脚本内容 #台球"
    assert captured["sub_type"] == "douyin"          # 中文"抖音"归一到 douyin
    assert captured["gen_type"] == "platform_content"
    assert captured["input_params"]["need"] == "周末双人半价"
    assert "周末双人半价" in captured["prompt"]       # need 进了 prompt
    assert captured["role"] == "operator"            # 跟随 my_role
    assert captured["input_params"]["knowledge_used"] == ["平台运营知识库"]  # B-2 依据带进落库
    assert ctx.last_knowledge_used == ["平台运营知识库"]                     # 经 ctx 传给 loop


def test_make_platform_content_xiaohongshu_alias(monkeypatch):
    captured = {}
    monkeypatch.setattr(agent_tools, "_append_guardrails",
                        lambda prompt, store, role=None, intent_text="": (prompt, []))

    async def fake_run(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="小红书笔记", input_params=kwargs.get("input_params") or {})

    monkeypatch.setattr(agent_tools, "run_generation", fake_run)
    ctx = SimpleNamespace(db=None, store=None, user=SimpleNamespace(my_role=None))
    out = asyncio.run(agent_tools.make_platform_content({"platform": "xiaohongshu", "need": "约球"}, ctx))
    assert out == "小红书笔记"
    assert captured["sub_type"] == "xiaohongshu"


def test_make_platform_content_unknown_platform_skips(monkeypatch):
    called = []

    async def fake_run(db, store, user, **kwargs):
        called.append(1)
        return SimpleNamespace(result="x")

    monkeypatch.setattr(agent_tools, "run_generation", fake_run)
    ctx = SimpleNamespace(db=None, store=None, user=SimpleNamespace(my_role=None))
    out = asyncio.run(agent_tools.make_platform_content({"platform": "twitter", "need": "x"}, ctx))
    assert called == []  # 未知平台不触发生成
    assert "平台" in out


# ---- make_groupbuy_content（美团/抖音团购套餐文案） ----

def test_make_groupbuy_content_registered_no_approval():
    t = default_registry.get("make_groupbuy_content")
    assert t is not None
    assert t.requires_approval is False


def test_make_groupbuy_content_generates(monkeypatch):
    captured = {}
    monkeypatch.setattr(agent_tools, "_append_guardrails",
                        lambda prompt, store, role=None, intent_text="": (prompt, []))

    async def fake_run(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="团购套餐文案", input_params=kwargs.get("input_params") or {})

    monkeypatch.setattr(agent_tools, "run_generation", fake_run)
    ctx = SimpleNamespace(db=None, store=None, user=SimpleNamespace(my_role="manager"))
    out = asyncio.run(agent_tools.make_groupbuy_content({"need": "周末双人套餐", "platform": "美团"}, ctx))
    assert out == "团购套餐文案"
    assert captured["gen_type"] == "groupbuy"
    assert captured["sub_type"] == "meituan"  # 美团→meituan
    assert "周末双人套餐" in captured["prompt"]
    assert captured["input_params"]["need"] == "周末双人套餐"


def test_make_groupbuy_content_empty_skips(monkeypatch):
    called = []

    async def fake_run(db, store, user, **kwargs):
        called.append(1)
        return SimpleNamespace(result="x")

    monkeypatch.setattr(agent_tools, "run_generation", fake_run)
    ctx = SimpleNamespace(db=None, store=None, user=SimpleNamespace(my_role=None))
    out = asyncio.run(agent_tools.make_groupbuy_content({"need": "  "}, ctx))
    assert called == []
    assert "团购" in out
