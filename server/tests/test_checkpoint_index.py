# -*- coding: utf-8 -*-
"""F-12 检查点旁路索引：append/list/get + chat_only 时间线截断（备份而非真删）。"""
from pathlib import Path

import services.agent.checkpoint_index as ci
import services.agent.transcript as T

_CID = "22222222-2222-2222-2222-222222222222"


def _use_tmp(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))


def test_record_and_list_roundtrip(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    ci.record_checkpoint(_CID, sha="a" * 40, tool="write_file", label="write_file:a.txt",
                          target="a.txt", working_dir="/tmp/wd")
    rows = ci.list_checkpoints(_CID)
    assert len(rows) == 1
    assert rows[0]["sha"] == "a" * 40
    assert rows[0]["tool"] == "write_file"
    assert rows[0]["working_dir"] == "/tmp/wd"


def test_list_missing_conversation_returns_empty(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    assert ci.list_checkpoints("no-such-conv") == []


def test_get_checkpoint_by_full_and_prefix_sha(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    sha = "abcdef1234" * 4
    ci.record_checkpoint(_CID, sha=sha, tool="write_file", label="x", target="a.txt", working_dir="/tmp/wd")
    assert ci.get_checkpoint(_CID, sha)["sha"] == sha
    assert ci.get_checkpoint(_CID, "abcdef1234")["sha"] == sha  # 短前缀匹配
    assert ci.get_checkpoint(_CID, "notfound") is None


def test_transcript_len_at_commit_reflects_current_saved_length(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    T.save_transcript(_CID, [{"role": "user", "content": "第一轮"}, {"role": "assistant", "content": "回复1"}])
    ci.record_checkpoint(_CID, sha="a" * 40, tool="write_file", label="x", target="a.txt", working_dir="/tmp/wd")
    rows = ci.list_checkpoints(_CID)
    assert rows[0]["transcript_len_at_commit"] == 2


def test_path_traversal_rejected(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    ci.record_checkpoint("../evil", sha="a" * 40, tool="write_file", label="x", target="a.txt", working_dir=None)
    assert not (Path(tmp_path) / "evil.checkpoints.jsonl").exists()
    assert not (Path(tmp_path).parent / "evil.checkpoints.jsonl").exists()


# ────────────────────────────── chat_only 时间线截断 ──────────────────────────────

def test_truncate_keeps_backup_not_real_delete(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    T.save_transcript(_CID, [
        {"role": "user", "content": "第一轮"}, {"role": "assistant", "content": "回复1"},
        {"role": "user", "content": "第二轮"}, {"role": "assistant", "content": "回复2"},
    ])
    result = ci.truncate_chat_to_checkpoint(_CID, 2)
    assert result["ok"] and result["truncated"] and result["kept"] == 2
    assert Path(result["backup"]).exists()  # "逻辑截断"留了备份，不是真删

    remaining = T.load_transcript(_CID)
    assert len(remaining) == 2
    assert remaining[-1]["content"] == "回复1"

    # 备份里是截断前的完整轨迹
    backup_content = Path(result["backup"]).read_text(encoding="utf-8")
    assert "第二轮" in backup_content and "回复2" in backup_content


def test_truncate_to_zero_leaves_empty_but_present_transcript(monkeypatch, tmp_path):
    """F-12 复审 Important #3 回归：截断到 0 条**不能**直接删掉轨迹文件——那样 `load_transcript`
    会返回 `None`，跟"这个会话从没聊过"（真没建过轨迹文件）完全无法区分，`_load_agent_history`
    会因此误判成后者、掉进 DB 兜底把本该被忘掉的最近几轮聊天翻找回来（见
    tests/test_agent_history_transcript.py 的端到端回归）。改成写一个【空但存在】的轨迹文件——
    `load_transcript` 读到的是 `[]` 而不是 `None`，`_load_agent_history` 据此能分清"真被截断到空"
    和"老会话根本没有轨迹文件"这两种语义完全不同的情况。"""
    _use_tmp(monkeypatch, tmp_path)
    T.save_transcript(_CID, [{"role": "user", "content": "唯一一轮"}, {"role": "assistant", "content": "回复"}])
    result = ci.truncate_chat_to_checkpoint(_CID, 0)
    assert result["ok"] and result["truncated"] and result["kept"] == 0
    assert Path(result["backup"]).exists()
    assert T.transcript_path(_CID).exists()  # 文件还在（空但存在），不是被删掉
    assert T.load_transcript(_CID) == []  # 权威的"空"，不是"没有"


def test_truncate_target_len_already_current_is_noop(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    T.save_transcript(_CID, [{"role": "user", "content": "x"}])
    result = ci.truncate_chat_to_checkpoint(_CID, 5)  # 目标行数 >= 当前长度
    assert result["ok"] and result["truncated"] is False
    assert len(T.load_transcript(_CID)) == 1  # 没动


def test_truncate_missing_transcript_fails_gracefully(monkeypatch, tmp_path):
    _use_tmp(monkeypatch, tmp_path)
    result = ci.truncate_chat_to_checkpoint("no-such-conv", 0)
    assert result["ok"] is False
