"""场景模板目录（P2 卡片融合·清单法）测试。

锁住：
- bigram 排序把相关场景排前面（确定性，用假目录）
- 真实目录非空、含已知精修场景、条目有 key+name
- find_scenario 工具返回带 key 的清单文本
- write_operation_content 暴露了 prompt_key 入参
"""
import asyncio

from services.agent.scenario_catalog import get_catalog, rank_scenarios, format_catalog_for_model


_FAKE = [
    {"key": "operation.qiangyi_battle", "name": "强一比赛主持词"},
    {"key": "operation.assistant_promo", "name": "助教推广文案"},
    {"key": "operation.old_customer_recall", "name": "老客回流邀约"},
]


def test_rank_puts_relevant_first():
    ranked = rank_scenarios("帮我搞个强一比赛", catalog=_FAKE)
    assert ranked[0]["key"] == "operation.qiangyi_battle"  # 名字里"强一/比赛"命中


def test_rank_empty_need_keeps_order():
    ranked = rank_scenarios("", catalog=_FAKE)
    assert [r["key"] for r in ranked] == [e["key"] for e in _FAKE]
    assert all(r["_score"] == 0 for r in ranked)


def test_real_catalog_nonempty_and_shaped():
    cat = get_catalog()
    assert len(cat) >= 20  # 实际有 60+ 个精修场景
    assert all(e.get("key") and e.get("name") for e in cat)
    keys = {e["key"] for e in cat}
    # 抽查几个已知精修卡片对应的 key 在目录里
    assert "operation.qiangyi_battle" in keys
    assert "copywriting.moments" in keys


def test_format_catalog_lists_keys():
    text = format_catalog_for_model("强一比赛")
    assert "prompt_key" in text                      # 指引模型怎么用
    assert "operation.qiangyi_battle" in text         # 列出了 key


def test_find_scenario_tool_registered_with_prompt_key():
    # 导入即注册进 default_registry
    import services.agent.tools  # noqa: F401
    from services.agent.registry import default_registry

    fs = default_registry.get("find_scenario")
    assert fs is not None
    woc = default_registry.get("write_operation_content")
    assert woc is not None
    assert "prompt_key" in woc.parameters["properties"]  # 透传入参已暴露


def test_find_scenario_tool_returns_catalog_text():
    import services.agent.tools as t

    out = asyncio.run(t.find_scenario({"need": "强一比赛"}, ctx=None))
    assert "operation.qiangyi_battle" in out
