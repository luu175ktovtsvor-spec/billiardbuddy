"""SH-6/SH-8 缺口修复钉死(对抗复核揪出的两处)：
- 中文 token 估算:旧 //4 把中文低估约4倍,改成 CJK≈1token、英文≈4字符1token;
- 连续拒绝全局计数:老板确认执行后归零,解除"一场长会话攒够N次后审批被永久吞掉"的锁。
"""
from services.agent import loop as L
from services.agent import denial_tracker as DT


def test_estimate_tokens_counts_cjk_as_one():
    """中文按≈1token计,不再被旧 //4 低估4倍。"""
    est_cn = L._estimate_tokens([{"role": "user", "content": "球" * 100}])
    assert est_cn >= 90, f"100个中文字应≈100token,旧//4只给25;实得{est_cn}"
    est_en = L._estimate_tokens([{"role": "user", "content": "a" * 100}])
    assert est_en <= 30, f"英文仍按≈4字符1token,实得{est_en}"


def test_clear_denial_resets_global_total():
    """老板确认执行后,全局累计拒绝归零——解除"攒够N次永久锁审批"。"""
    conv = "conv-test-sh68-gapfix"
    DT._STORE.pop(conv, None)
    for _ in range(3):
        DT.record_denial(conv, "make_poster|{}")
    assert DT._STORE[conv]["total"] == 3
    DT.clear_denial(conv, "make_poster|{}")
    assert DT._STORE[conv]["total"] == 0  # 修复前:只清by_action、total不动→会永久锁
    assert "make_poster|{}" not in DT._STORE[conv]["by_action"]
    DT._STORE.pop(conv, None)
