"""审批提案签名（P3.2）测试：绑定 args、防篡改。"""
from services.agent.approval import sign_approval, verify_approval


def test_sign_verify_roundtrip():
    args = {"description": "周末活动海报", "size": "1:1", "quality": "medium"}
    tok = sign_approval("make_poster", args)
    assert verify_approval("make_poster", args, tok)


def test_key_order_irrelevant():
    tok = sign_approval("make_poster", {"a": 1, "b": 2})
    assert verify_approval("make_poster", {"b": 2, "a": 1}, tok)  # 键序不影响（sort_keys）


def test_tampered_args_rejected():
    tok = sign_approval("make_poster", {"quality": "medium"})
    assert not verify_approval("make_poster", {"quality": "high"}, tok)  # 偷改质量 → 拒


def test_wrong_tool_rejected():
    tok = sign_approval("make_poster", {"x": 1})
    assert not verify_approval("write_file", {"x": 1}, tok)  # 换工具 → 拒


def test_missing_token_false():
    assert not verify_approval("make_poster", {"x": 1}, None)
    assert not verify_approval("make_poster", {"x": 1}, "")


def test_empty_args_consistent():
    tok = sign_approval("make_poster", None)
    assert verify_approval("make_poster", {}, tok)  # None 与 {} 规范化一致
