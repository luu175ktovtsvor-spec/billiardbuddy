"""A-6 编排脑感知知识 + A-5/C-3 operation 兜底。

锁住：
A-6 look_up_knowledge：
- 工具已注册，标 read_only=True、非 deliverable
- 对全部 knowledge.* 按 topic 排序，返回 name + description（不返回整篇正文）
- rank_knowledge_for_topic 确定性回退（没装语义模型）能把相关知识排前面

A-5/C-3 write_operation_content 兜底：
- pick_best_prompt_key 对贴切需求确定性挑模板、对泛化需求返回 None
- 模型没传 prompt_key 时，贴切需求会兜底挑一个精修模板再渲染
- 模型传了无效（不存在）prompt_key 时，当没传、走兜底
- 模型主动传了【有效】prompt_key 的正常路径不被破坏
- 泛化需求（无贴切模板）退回 free_intent（prompt_key=None）
"""
import asyncio
from types import SimpleNamespace

import services.agent.tools as agent_tools
from services.agent.registry import default_registry
from services.agent.scenario_catalog import pick_best_prompt_key
from services.content_service import rank_knowledge_for_topic


def _ctx(role="manager"):
    return SimpleNamespace(db=object(), store=SimpleNamespace(id="s1"), user=SimpleNamespace(my_role=role))


# ---- A-6 look_up_knowledge ----

def test_look_up_knowledge_registered_readonly_not_deliverable():
    t = default_registry.get("look_up_knowledge")
    assert t is not None
    assert t.read_only is True
    assert t.deliverable is False
    assert t.requires_approval is False
    assert "topic" in t.parameters["properties"]


def test_rank_knowledge_returns_name_and_description_not_full_body():
    hits = rank_knowledge_for_topic("助教推广获客", top=5)
    assert 1 <= len(hits) <= 5
    for h in hits:
        assert h.get("key", "").startswith("knowledge.")
        assert h.get("name")
        assert "description" in h
        # 只返回索引：description 是短句，不该是整篇正文（行业知识正文动辄上千字）
        assert len(h["description"]) < 600


def test_rank_knowledge_relevance_orders_assistant_topic():
    # "助教"相关 topic 应把助教类知识排进前几条（确定性回退：关键词命中 + bigram）
    hits = rank_knowledge_for_topic("助教薪资提成怎么定", top=5)
    keys = {h["key"] for h in hits}
    assert any("assistant" in k for k in keys)


def test_rank_knowledge_empty_topic_deterministic():
    a = rank_knowledge_for_topic("", top=3)
    b = rank_knowledge_for_topic("", top=3)
    assert [h["key"] for h in a] == [h["key"] for h in b]  # 确定性
    assert len(a) == 3


def test_look_up_knowledge_tool_returns_reference_text():
    out = asyncio.run(agent_tools.look_up_knowledge({"topic": "能不能涨价"}, ctx=None))
    assert "行业知识参考" in out
    assert "【" in out and "】" in out  # 每条带【name】


# ---- A-5/C-3 write_operation_content 兜底 ----

def test_pick_best_prompt_key_relevant_hits_template():
    # 用假目录确定性验证（强一比赛名字命中）
    fake = [
        {"key": "operation.qiangyi_battle", "name": "强一比赛主持词"},
        {"key": "operation.assistant_promo", "name": "助教推广文案"},
    ]
    assert pick_best_prompt_key("帮我搞个强一比赛主持", catalog=fake) == "operation.qiangyi_battle"


def test_pick_best_prompt_key_generic_returns_none():
    fake = [{"key": "operation.qiangyi_battle", "name": "强一比赛主持词"}]
    # 完全不沾边的泛化需求 → 分太低 → None（退回 free_intent）
    assert pick_best_prompt_key("今天天气真好", catalog=fake) is None
    assert pick_best_prompt_key("", catalog=fake) is None


def test_write_operation_content_fallback_picks_template(monkeypatch):
    """模型没传 prompt_key，但需求贴切某精修场景 → 兜底挑一个 prompt_key 再渲染（不漏精修）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="精修输出", input_params={"knowledge_used": []})

    # 用确定性兜底（真实目录里有 copywriting.holiday_promo「节日促销文案」）
    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content({"need": "来个节日促销文案"}, _ctx()))
    assert captured["prompt_key"] is not None  # 兜底挑到了精修模板
    assert captured["prompt_key"] == "copywriting.holiday_promo"


def test_write_operation_content_invalid_key_falls_back(monkeypatch):
    """模型编了个不存在的 prompt_key → 当没传，走兜底（不会把无效 key 塞进渲染）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="x", input_params={"knowledge_used": []})

    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content(
        {"need": "来个节日促销文案", "prompt_key": "operation.this_does_not_exist"}, _ctx()))
    assert captured["prompt_key"] != "operation.this_does_not_exist"  # 无效 key 没被透传
    assert captured["prompt_key"] == "copywriting.holiday_promo"  # 改走兜底


def test_write_operation_content_valid_model_key_preserved(monkeypatch):
    """模型主动传了【有效】prompt_key → 正常路径不被破坏（原样透传，不被兜底覆盖）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="x", input_params={"knowledge_used": []})

    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content(
        {"need": "随便写点啥", "prompt_key": "operation.qiangyi_battle"}, _ctx()))
    assert captured["prompt_key"] == "operation.qiangyi_battle"


def test_write_operation_content_generic_need_uses_free_intent(monkeypatch):
    """泛化需求、无贴切模板 → prompt_key=None，退回 free_intent（不强塞模板）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="x", input_params={"knowledge_used": []})

    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content({"need": "今天天气真好啊随便聊聊"}, _ctx()))
    assert captured["prompt_key"] is None
