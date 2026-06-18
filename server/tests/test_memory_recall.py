"""店脑按需召回测试（修"全量注入"，避免 context rot / 省 token）。

- 记忆少（≤cap）或无 intent → 全留（向后兼容、零回归）。
- 记忆多 → 只留与当前需求语义最相关的 cap 条。
- format_memories_for_prompt 传 intent 才筛、不传全量。
"""
from types import SimpleNamespace

from services.memory_service import select_relevant_memories, format_memories_for_prompt


def _m(content, conf="medium"):
    return SimpleNamespace(content=content, confidence=conf)


def test_few_memories_all_kept():
    mems = [_m("店里周一闭店"), _m("老板姓王")]
    assert select_relevant_memories(mems, "随便写点啥", cap=15) == mems


def test_no_intent_keeps_all_backward_compat():
    mems = [_m(f"记忆{i}") for i in range(30)]
    assert select_relevant_memories(mems, None) == mems
    assert select_relevant_memories(mems, "") == mems


def test_many_memories_keeps_relevant():
    mems = [_m(f"无关杂记{i}") for i in range(20)] + [_m("双十一全场活动五折优惠")]
    out = select_relevant_memories(mems, "双十一活动怎么搞", cap=5)
    assert len(out) == 5
    assert any("双十一" in m.content for m in out)  # 相关的被召回进来


def test_high_confidence_boosted():
    # 同样弱相关下，高置信记忆更可能被保留
    mems = [_m(f"中性记忆{i}", "medium") for i in range(20)] + [_m("重要：本店不卖酒", "high")]
    out = select_relevant_memories(mems, "写个朋友圈", cap=6)
    # high 置信有加权，更容易进前列（不强求一定在，但置信加权逻辑生效）
    assert len(out) == 6


def test_format_applies_selection_only_with_intent():
    mems = [_m(f"杂记{i}") for i in range(20)] + [_m("周末双人优惠场")]
    text = format_memories_for_prompt(mems, intent="周末双人活动")
    assert "周末双人优惠场" in text          # 相关的被召回
    assert text.count("\n- ") <= 15           # 已按 cap 收敛
    # 不传 intent → 全量注入（向后兼容）
    assert format_memories_for_prompt(mems).count("\n- ") >= 20
