# -*- coding: utf-8 -*-
"""F-12 检查点旁路索引：把每次影子 git commit 关联到某会话时间线的位置。

**旁路**——不碰 `transcript.py` 的核心结构/语义（那份 JSONL 只管"忠实存、忠实读"对话消息本身）。
这里另开一个同目录的侧车文件 `UPLOAD_DIR/transcripts/<cid>.checkpoints.jsonl`，一行一条检查点记录：
`{sha, tool, label, target, working_dir, created_at, transcript_len_at_commit}`。

⚠️ 已知限制（诚实记录，别当 bug 反复排查）：
1. **粒度只到"轮"边界**：`transcript.save_transcript` 只在【每一轮 Agent 循环结束】才整体覆盖写
   （见 transcript.py 顶部说明）；而 PostToolUse 钩子在【本轮循环执行中途】触发——commit 那一刻，
   磁盘上的 transcript 文件反映的还是【上一次落盘时】的状态。所以 `transcript_len_at_commit` 精确到
   "轮"级别：同一轮里若连续多次写改文件，会共享同一个 `transcript_len_at_commit`（那一轮开始前的
   行数）。这不是缺陷——一轮对话还没说完，本来就没有"轮内中间态"可回，回退到"这一轮开始前"
   在语义上就是正确答案。
2. **全新会话的第一轮不会被索引**：新会话第一条消息时 `ctx.conversation_id` 还是 `None`
   （`api/v1/agent.py` 里真正的 `conversation_id`——`conv_uuid`——要到 `run_agent_loop_stream`
   跑完才计算/落库，中途的 PostToolUse 钩子拿不到它）。这种情况下影子 git 快照仍然正常打上
   （文件恢复不受影响），只是没法把这个检查点关联进某个会话的时间线列表——是既有架构的
   自然限制，不是本单引入的新问题；从第二轮起 conversation_id 稳定，索引完全正常。
"""
from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from core.timezone import business_now
from services.agent.transcript import (
    _safe_cid, _transcript_dir, load_transcript, save_transcript, transcript_path,
)

logger = logging.getLogger(__name__)

_SUFFIX = ".checkpoints.jsonl"


def _index_path(conversation_id: str | None) -> Path | None:
    cid = _safe_cid(conversation_id)
    if cid is None:
        return None
    return _transcript_dir() / f"{cid}{_SUFFIX}"


def record_checkpoint(conversation_id: str, *, sha: str, tool: str, label: str,
                       target: str | None, working_dir: str | None) -> None:
    """追加一条检查点记录（append-only，旁路，不影响 transcript 本体）。
    故障安全：任何异常只记日志，不向上抛（PostToolUse 钩子那边也会再兜一层）。"""
    path = _index_path(conversation_id)
    if path is None or not sha:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "sha": sha,
            "tool": tool,
            "label": label,
            "target": target,
            "working_dir": working_dir,
            "created_at": business_now().isoformat(),
            "transcript_len_at_commit": len(load_transcript(conversation_id) or []),
        }
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False))
            f.write("\n")
    except Exception:
        logger.warning("检查点索引写入失败 conversation_id=%s", conversation_id, exc_info=True)


def list_checkpoints(conversation_id: str, limit: int = 50) -> list[dict]:
    """按时间正序（越晚越靠后）返回该会话的检查点记录。故障安全：读取失败返回空列表。"""
    path = _index_path(conversation_id)
    if path is None or not path.exists():
        return []
    out: list[dict] = []
    try:
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except (ValueError, TypeError):
                    continue
                if isinstance(obj, dict) and obj.get("sha"):
                    out.append(obj)
    except Exception:
        logger.warning("检查点索引读取失败 conversation_id=%s", conversation_id, exc_info=True)
        return []
    return out[-max(1, min(int(limit or 50), 200)):]


def get_checkpoint(conversation_id: str, sha: str) -> dict | None:
    """按 sha 精确取一条记录（恢复前二次校验这个 sha 确实属于这个会话，防传错/传别的库的 sha）。
    支持短 sha 前缀匹配（跟 git 自己的习惯一致）。"""
    sha = (sha or "").strip()
    if not sha:
        return None
    for row in list_checkpoints(conversation_id, limit=200):
        row_sha = row.get("sha") or ""
        if row_sha == sha or row_sha.startswith(sha):
            return row
    return None


def truncate_chat_to_checkpoint(conversation_id: str, transcript_len_at_commit: int) -> dict:
    """chat_only 恢复：把对话时间线【逻辑截断】回到某检查点所在轮开始前的状态。

    "逻辑截断"而不是"真删"——截断前先把当前完整轨迹整份备份到旁路文件（文件名带时间戳，
    不覆盖旧备份，可以手动找回），再用 `save_transcript` 覆盖写只保留前 N 条
    （N = `transcript_len_at_commit`）。

    F-12 复审 Important #3 修复：截断到 0 条时，**不能**直接 `unlink()` 删掉轨迹文件本身——
    那样 `load_transcript` 读到的是文件不存在 → 返回 `None`，跟"这个会话本来就从没建过轨迹文件"
    （比如很老的会话）在返回值层面完全无法区分。`api/v1/agent.py` 的 `_load_agent_history` 靠
    `load_transcript` 是不是 `None` 判断要不要落到 DB 最近 5 轮兜底——一旦分不清，"回退到最开始"
    这个动作反而会让下一轮从 DB 兜底里把本该被忘掉的最近几轮聊天重新翻出来塞回上下文，等于回退
    完全没生效。改成写一个【空但存在】的轨迹文件（绕开 `save_transcript([])` 自己"空消息不建
    文件"的短路逻辑，那条短路是为了防"误判成有效空轨迹"，语义上是给"从没存过东西"的场景用的，
    跟这里"确实存过、现在要清空"是两回事）——`load_transcript` 读到的是 `[]`（文件存在但没有
    有效行），`_load_agent_history` 据此能把"真被截断到空"和"老会话根本没有轨迹文件"这两种语义
    完全不同的情况分开处理（见 `_load_agent_history` 里 `if tr is not None:` 的判据）。
    """
    rows = load_transcript(conversation_id)
    if rows is None:
        return {"ok": False, "error": "没有找到这个会话的聊天记录"}
    n = max(0, int(transcript_len_at_commit or 0))
    if n >= len(rows):
        return {"ok": True, "truncated": False}  # 已经在这条线之前，没什么可回退的
    path = transcript_path(conversation_id)
    backup_path: str | None = None
    try:
        if path is not None and path.exists():
            backup = path.with_name(
                path.name.replace(".jsonl", f".before-restore-{business_now().strftime('%Y%m%d%H%M%S')}.jsonl")
            )
            shutil.copy2(path, backup)
            backup_path = str(backup)
        if n == 0:
            if path is not None:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("", encoding="utf-8")  # 空但存在——不是 unlink，见上方 docstring
        else:
            save_transcript(conversation_id, rows[:n])
    except Exception:
        logger.warning("聊天时间线回退失败 conversation_id=%s", conversation_id, exc_info=True)
        return {"ok": False, "error": "聊天记录回退失败"}
    return {"ok": True, "truncated": True, "kept": n, "backup": backup_path}
