# -*- coding: utf-8 -*-
"""跨轮记忆 · 轻量轨迹存储（JSONL）单测。

锁住契约：
- save→load 往返：messages 一致，含 tool_calls / tool 结果 / 多模态结构不丢。
- save 剥掉开头的 system 消息（system 每轮由 compose 重新拼，不该进轨迹）。
- 覆盖写幂等：连写两次 = 同一份，不翻倍。
- load 文件不存在 → None（让上层走"老会话 5 轮文本对"兜底）。
- 路径穿越（../evil）拒写、拒读，绝不落到 transcripts 目录之外。
- 坏行（非 JSON）读时跳过，不崩、不丢好行。
"""
from pathlib import Path

import services.agent.transcript as T


def _use_tmp(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))


def test_save_then_load_roundtrip(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "11111111-1111-1111-1111-111111111111"
    msgs = [
        {"role": "system", "content": "SYS——每轮重拼，不该落盘"},
        {"role": "user", "content": "查下今天日期"},
        {"role": "assistant", "content": "", "tool_calls": [
            {"id": "c1", "type": "function",
             "function": {"name": "get_today", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "c1", "content": "今天是周六"},
        {"role": "assistant", "content": "今天周六，建议搞个充值活动"},
    ]
    T.save_transcript(cid, msgs)
    out = T.load_transcript(cid)

    assert out is not None
    # system 被剥掉，第一条是 user
    assert out[0]["role"] == "user" and out[0]["content"] == "查下今天日期"
    # assistant 的 tool_calls 结构不丢
    assert out[1]["role"] == "assistant"
    assert out[1]["tool_calls"][0]["function"]["name"] == "get_today"
    # tool 结果完整、配对键还在
    assert out[2]["role"] == "tool" and out[2]["tool_call_id"] == "c1"
    assert out[2]["content"] == "今天是周六"
    # 最终答复在
    assert out[-1]["content"] == "今天周六，建议搞个充值活动"


def test_load_missing_returns_none(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    assert T.load_transcript("22222222-2222-2222-2222-222222222222") is None


def test_overwrite_is_idempotent(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "33333333-3333-3333-3333-333333333333"
    msgs = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]
    T.save_transcript(cid, msgs)
    T.save_transcript(cid, msgs)  # 第二次整体覆盖，不在尾部 append → 不翻倍
    out = T.load_transcript(cid)
    assert len(out) == 2


def test_path_traversal_rejected(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    # 恶意 cid 绝不写到 transcripts 目录之外，读也读不到
    T.save_transcript("../evil", [{"role": "user", "content": "x"}])
    assert not (Path(tmp_path) / "evil.jsonl").exists()
    assert not (Path(tmp_path).parent / "evil.jsonl").exists()
    assert T.load_transcript("../evil") is None


def test_malformed_line_skipped(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "44444444-4444-4444-4444-444444444444"
    p = T.transcript_path(cid)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text('{"role":"user","content":"ok"}\n坏行不是JSON\n{"role":"assistant","content":"hi"}\n',
                 encoding="utf-8")
    out = T.load_transcript(cid)
    assert len(out) == 2  # 坏行跳过、好行都在
    assert out[0]["content"] == "ok" and out[1]["content"] == "hi"


def test_multimodal_content_preserved(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "55555555-5555-5555-5555-555555555555"
    msgs = [{"role": "user", "content": [
        {"type": "text", "text": "看这张图"},
        {"type": "image_url", "image_url": {"url": "file:///a.png"}},
    ]}]
    T.save_transcript(cid, msgs)
    out = T.load_transcript(cid)
    assert out[0]["content"][0]["text"] == "看这张图"
    assert out[0]["content"][1]["image_url"]["url"] == "file:///a.png"


def test_empty_or_none_messages_noop(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "66666666-6666-6666-6666-666666666666"
    T.save_transcript(cid, None)
    T.save_transcript(cid, [])
    # 没东西可存 → 不建文件、load 仍 None（不会误判成"有空轨迹"）
    assert T.load_transcript(cid) is None


def test_only_system_message_noop(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "77777777-7777-7777-7777-777777777777"
    # 剥掉 system 后没内容 → 不落盘（避免 load 返回 [] 误盖兜底）
    T.save_transcript(cid, [{"role": "system", "content": "只有系统提示"}])
    assert T.load_transcript(cid) is None


def test_append_extends_existing(monkeypatch, tmp_path):
    # 审批续接：在已有轨迹尾部追加（已确认执行 + 续接答复），不覆盖前文
    _use_tmp(monkeypatch, tmp_path)
    cid = "88888888-8888-8888-8888-888888888888"
    T.save_transcript(cid, [
        {"role": "user", "content": "帮我把这条发朋友圈"},
        {"role": "assistant", "content": "准备发布，确认下？"},
    ])
    T.append_transcript(cid, [
        {"role": "user", "content": "（已确认执行 publish_post）"},
        {"role": "assistant", "content": "发好啦，要不要再配条文案？"},
    ])
    out = T.load_transcript(cid)
    assert len(out) == 4
    assert out[0]["content"] == "帮我把这条发朋友圈"      # 前文还在
    assert out[-1]["content"] == "发好啦，要不要再配条文案？"  # 续接在尾部


def test_append_to_missing_creates(monkeypatch, tmp_path):
    # 防御：没有既有轨迹也能落（至少不丢续接）
    _use_tmp(monkeypatch, tmp_path)
    cid = "99999999-9999-9999-9999-999999999999"
    T.append_transcript(cid, [{"role": "assistant", "content": "做好了"}])
    out = T.load_transcript(cid)
    assert out == [{"role": "assistant", "content": "做好了"}]
