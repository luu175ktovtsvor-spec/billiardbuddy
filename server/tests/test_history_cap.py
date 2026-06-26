"""长对话上下文封顶（防撑爆）测试 —— 跨轮记忆改造后【放松版】契约。

改造前：12 条 + 每条 2000 字硬砍——会把工具结果截烂、把长历史砍没，和"全历史一直带"冲突。
改造后：封顶只当【极端兜底】（损坏文件/恶意全量回传），正常长度交给 loop 的 autocompact/microcompact。
所以阈值抬到很高：不再按 12 条砍，不再把工具消息截到 2000 字。
"""
from api.v1.agent import _cap_history, _HIST_MAX_MSGS, _HIST_MAX_CHARS


def test_high_thresholds():
    # 安全上限必须抬得很高（防极端而非常态裁剪）
    assert _HIST_MAX_MSGS >= 1000
    assert _HIST_MAX_CHARS >= 50_000


def test_does_not_cap_normal_long_history():
    # 40 条历史（远超旧的 12）现在【原样保留】——续接看得到完整轨迹
    hist = [{"role": "user", "content": f"m{i}"} for i in range(40)]
    out = _cap_history(hist)
    assert len(out) == 40
    assert out[0]["content"] == "m0"      # 最旧的也不丢
    assert out[-1]["content"] == "m39"


def test_does_not_truncate_tool_results():
    # 9000 字的工具结果（远超旧的 2000）现在【不截断】——记忆不被截烂
    out = _cap_history([{"role": "tool", "tool_call_id": "c1", "content": "x" * 9000}])
    assert len(out[0]["content"]) == 9000


def test_extreme_message_count_still_capped():
    # 极端：超过安全上限的条数仍兜底裁到上限（保留最近的）
    n = _HIST_MAX_MSGS + 50
    hist = [{"role": "user", "content": f"m{i}"} for i in range(n)]
    out = _cap_history(hist)
    assert len(out) == _HIST_MAX_MSGS
    assert out[-1]["content"] == f"m{n - 1}"   # 留最近
    assert out[0]["content"] == f"m{n - _HIST_MAX_MSGS}"  # 丢最旧


def test_extreme_single_message_still_truncated():
    # 极端：单条爆炸（>安全上限）仍兜底截断，防一条把上下文撑爆
    big = "y" * (_HIST_MAX_CHARS + 1000)
    out = _cap_history([{"role": "assistant", "content": big}])
    assert len(out[0]["content"]) == _HIST_MAX_CHARS


def test_none_and_empty_unchanged():
    assert _cap_history(None) is None
    assert _cap_history([]) == []


def test_short_history_unchanged():
    hist = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]
    assert _cap_history(hist) == hist


def test_multimodal_text_capped_images_kept():
    # 多模态：超大 text 段按预算截、图片段原样保留（不被当字符数误伤）
    big = "z" * (_HIST_MAX_CHARS + 500)
    out = _cap_history([{"role": "user", "content": [
        {"type": "text", "text": big},
        {"type": "image_url", "image_url": {"url": "file:///a.png"}},
    ]}])
    parts = out[0]["content"]
    assert parts[0]["type"] == "text" and len(parts[0]["text"]) == _HIST_MAX_CHARS
    assert parts[1]["image_url"]["url"] == "file:///a.png"   # 图片段不丢
