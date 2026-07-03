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


# ── F-10 复审 Critical 修复：轮收尾整份覆盖写 × 媒体任务完成回调外部追加 竞态 ──
# 相关三个新原语：capture_transcript_baseline_len（轮开始记基准）/ merge_external_tail（收尾前把磁盘上
# 超出基准的尾部行拼回去）/ save_transcript_preserving_external_tail（合并+覆盖写一步到位，供 agent.py
# 两处"整份覆盖写"调用点统一收口）。见 services/agent/transcript.py 顶部本节新增函数的 docstring。

def test_capture_baseline_len_missing_file_is_zero(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    assert T.capture_transcript_baseline_len("aaaaaaaa-0000-0000-0000-000000000000") == 0


def test_capture_baseline_len_existing_file(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "aaaaaaaa-1111-1111-1111-111111111111"
    T.save_transcript(cid, [{"role": "user", "content": "1"}, {"role": "assistant", "content": "2"}])
    assert T.capture_transcript_baseline_len(cid) == 2


def test_merge_external_tail_appends_disk_only_rows(monkeypatch, tmp_path):
    """核心场景：轮开始时基准=1；轮进行中磁盘被外部追加成 2 行；轮收尾算出的 final_messages
    对此一无所知（还是照基准那份延伸出来的）——合并后，外部追加的行要原样接在末尾。"""
    _use_tmp(monkeypatch, tmp_path)
    cid = "bbbbbbbb-1111-1111-1111-111111111111"
    T.save_transcript(cid, [{"role": "user", "content": "1"}])
    baseline = T.capture_transcript_baseline_len(cid)  # 1
    T.append_transcript(cid, [{"role": "assistant", "content": "外部追加"}])  # 磁盘变 2 行
    final_messages = [{"role": "user", "content": "1"}, {"role": "assistant", "content": "本轮新回复"}]
    merged = T.merge_external_tail(cid, final_messages, baseline)
    assert [m["content"] for m in merged] == ["1", "本轮新回复", "外部追加"]


def test_merge_external_tail_none_baseline_noop(monkeypatch, tmp_path):
    # 基准不可用（读取失败等）→ 原样返回，不做任何合并，退化为原覆盖写行为（故障安全）
    _use_tmp(monkeypatch, tmp_path)
    cid = "cccccccc-1111-1111-1111-111111111111"
    T.append_transcript(cid, [{"role": "assistant", "content": "外部追加"}])
    final_messages = [{"role": "user", "content": "x"}]
    merged = T.merge_external_tail(cid, final_messages, None)
    assert merged == final_messages


def test_merge_external_tail_no_disk_change_noop(monkeypatch, tmp_path):
    # 磁盘跟基准一样长（没有外部追加）→ 不节外生枝，原样返回
    _use_tmp(monkeypatch, tmp_path)
    cid = "dddddddd-1111-1111-1111-111111111111"
    T.save_transcript(cid, [{"role": "user", "content": "1"}])
    baseline = T.capture_transcript_baseline_len(cid)
    final_messages = [{"role": "user", "content": "1"}, {"role": "assistant", "content": "回复"}]
    merged = T.merge_external_tail(cid, final_messages, baseline)
    assert merged == final_messages


def test_merge_external_tail_disk_shorter_than_baseline_noop(monkeypatch, tmp_path):
    # 磁盘比基准还短（比如中途被 truncate/回滚过）→ 不强行拼接，交给原覆盖写
    _use_tmp(monkeypatch, tmp_path)
    cid = "eeeeeeee-2222-2222-2222-222222222222"
    T.save_transcript(cid, [{"role": "user", "content": "1"}, {"role": "assistant", "content": "2"}])
    baseline = T.capture_transcript_baseline_len(cid)  # 2
    T.save_transcript(cid, [{"role": "user", "content": "1"}])  # 磁盘被回滚成只剩 1 行
    final_messages = [{"role": "user", "content": "1"}, {"role": "assistant", "content": "本轮回复"}]
    merged = T.merge_external_tail(cid, final_messages, baseline)
    assert merged == final_messages


def test_merge_external_tail_autocompact_rebuilt_final_messages_robust(monkeypatch, tmp_path):
    """对 autocompact 鲁棒：final_messages 不是 baseline 的简单前缀延伸——已经被压缩成一条摘要+
    少数几条，跟磁盘上轮开始时的历史长度/内容完全对不上。merge 只看磁盘现存文件超出 baseline 的
    尾部，不管 final_messages 自己经历了什么重建，一样能把外部追加的尾部接回去。"""
    _use_tmp(monkeypatch, tmp_path)
    cid = "ffffffff-2222-2222-2222-222222222222"
    # 轮开始时磁盘上有 10 行历史
    T.save_transcript(cid, [{"role": "user", "content": f"第{i}轮"} for i in range(10)])
    baseline = T.capture_transcript_baseline_len(cid)  # 10
    T.append_transcript(cid, [{"role": "assistant", "content": "剪辑做好了!"}])  # 磁盘变 11 行
    # autocompact 已经把前缀重建成摘要——跟磁盘上那 10 行完全对不上（长度、内容都变了）
    final_messages = [
        {"role": "user", "content": "[之前对话摘要] 省略前情"},
        {"role": "assistant", "content": "已了解前情"},
        {"role": "user", "content": "剪辑弄完了吗"},
        {"role": "assistant", "content": "还在剪，好了叫你"},
    ]
    merged = T.merge_external_tail(cid, final_messages, baseline)
    assert [m["content"] for m in merged] == [
        "[之前对话摘要] 省略前情", "已了解前情", "剪辑弄完了吗", "还在剪，好了叫你", "剪辑做好了!",
    ]


def test_save_transcript_preserving_external_tail_writes_merged_result(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    cid = "aaaaaaaa-3333-3333-3333-333333333333"
    T.save_transcript(cid, [{"role": "user", "content": "1"}])
    baseline = T.capture_transcript_baseline_len(cid)
    T.append_transcript(cid, [{"role": "assistant", "content": "外部追加"}])
    final_messages = [{"role": "user", "content": "1"}, {"role": "assistant", "content": "本轮回复"}]
    T.save_transcript_preserving_external_tail(cid, final_messages, baseline)
    out = T.load_transcript(cid)
    assert [m["content"] for m in out] == ["1", "本轮回复", "外部追加"]


def test_save_transcript_preserving_external_tail_no_append_matches_plain_save(monkeypatch, tmp_path):
    # 没有外部追加时行为跟直接 save_transcript 完全一致，不引入任何多余内容
    _use_tmp(monkeypatch, tmp_path)
    cid = "bbbbbbbb-3333-3333-3333-333333333333"
    baseline = T.capture_transcript_baseline_len(cid)  # 0（新会话，还没文件）
    final_messages = [{"role": "user", "content": "你好"}, {"role": "assistant", "content": "你好呀"}]
    T.save_transcript_preserving_external_tail(cid, final_messages, baseline)
    out = T.load_transcript(cid)
    assert out == final_messages


def test_append_transcript_own_fresh_read_preserves_concurrent_prior_write(monkeypatch, tmp_path):
    """核实 /agent/execute 审批续接同款 append_transcript 调用点(agent.py:2096)本身是否也会丢外部追加：
    它内部"读现状→追加→整份写回"的读永远是【调用那一刻】的最新磁盘状态（不像主循环那样拿轮开始时的
    旧快照拼出整份内容再覆盖），所以哪怕在它开始追加之前，另一个写者（媒体任务完成回调）已经先落了
    一笔，这笔也不会被冲掉——两次 append_transcript 天然按时间顺序落地，不丢数据、不用改。"""
    _use_tmp(monkeypatch, tmp_path)
    cid = "cccccccc-3333-3333-3333-333333333333"
    T.save_transcript(cid, [{"role": "user", "content": "帮我剪个视频"}])
    T.append_transcript(cid, [{"role": "assistant", "content": "视频剪好了!"}])  # 媒体任务完成回调先落一笔
    T.append_transcript(cid, [  # /agent/execute 审批续接落自己的两条
        {"role": "user", "content": "（已确认执行 render_video）"},
        {"role": "assistant", "content": "已经在弄了，等下告诉你"},
    ])
    out = T.load_transcript(cid)
    assert [m["content"] for m in out] == [
        "帮我剪个视频", "视频剪好了!", "（已确认执行 render_video）", "已经在弄了，等下告诉你",
    ]
