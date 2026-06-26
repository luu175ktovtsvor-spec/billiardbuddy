# -*- coding: utf-8 -*-
"""跨轮记忆 · 轻量对话轨迹存储（JSONL，每会话一个文件）。

为什么要它：对话端点过去只把"用户话 + 最终答复"落一条 Generation，工具调用/结果/中间思考全丢；
续接时只还原最近 5 轮"文本对"——AI 看不到自己上轮到底查了什么、做了什么，老板得反复交代。
这里把 loop 产出的【完整对话轨迹】（user / assistant(含 tool_calls) / tool 结果）整段落盘，
续接时整段读回当 history，模型就"记得住前面聊的"。长度交给 loop 的 autocompact/microcompact 正经控，
这层只管【忠实存、忠实读】。

落点：UPLOAD_DIR/transcripts/<conversation_id>.jsonl（UPLOAD_DIR 指向 userData 可写目录，app 包内只读）。
格式：JSONL，一行一条消息。每轮 loop 结束【整体覆盖写】（loop 返回的 messages 已含传进去的历史，
append 会翻倍，故覆盖）。原子写（临时文件 + os.replace）防写一半损坏。

不存 system：system 每轮由 compose_agent_system_prompt 重新拼，读回当 history 时 loop 的 _init_messages
会自己加 system——轨迹只存对话轮，避免把会变的系统提示固化进历史。
"""
from __future__ import annotations

import json
import logging
import os
import re
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

# conversation_id 正常是 UUID；防御性只放行 UUID/字母数字/下划线/连字符，挡住 ../ 、/ 、绝对路径等穿越。
_SAFE_CID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

_SUBDIR = "transcripts"


def _safe_cid(conversation_id: str | None) -> str | None:
    """校验 conversation_id 能否安全当文件名；非法返回 None（上层据此跳过、走兜底）。"""
    if not conversation_id:
        return None
    cid = str(conversation_id).strip()
    if not _SAFE_CID.match(cid):
        return None
    return cid


def _transcript_dir() -> Path:
    """轨迹目录：每次按当下 settings.upload_dir 取（桌面把它指到 userData 可写目录）。"""
    return Path(settings.upload_dir) / _SUBDIR


def transcript_path(conversation_id: str | None) -> Path | None:
    """该会话的轨迹文件路径；conversation_id 非法（穿越等）返回 None。"""
    cid = _safe_cid(conversation_id)
    if cid is None:
        return None
    return _transcript_dir() / f"{cid}.jsonl"


def _strip_leading_system(messages: list[dict]) -> list[dict]:
    """剥掉开头的 system 消息（只剥最前面一条；轨迹只存对话轮）。"""
    if messages and isinstance(messages[0], dict) and messages[0].get("role") == "system":
        return list(messages[1:])
    return list(messages)


def save_transcript(conversation_id: str | None, messages: list[dict] | None) -> None:
    """把完整轨迹【整体覆盖写】进该会话的 JSONL。故障安全：任何异常只记日志、不抛（不阻断对话）。

    - conversation_id 非法 → 静默跳过。
    - messages 剥掉开头 system 后为空 → 不建文件（避免 load 返回 [] 误盖兜底）。
    - 原子写：先写 .tmp 再 os.replace，防写一半被读到半截。
    """
    path = transcript_path(conversation_id)
    if path is None:
        return
    try:
        rows = _strip_leading_system(messages or [])
        if not rows:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            for m in rows:
                # default=str 兜底极端不可序列化字段（正常 messages 全是 str/list/dict，能直接序列化）。
                f.write(json.dumps(m, ensure_ascii=False, default=str))
                f.write("\n")
        os.replace(tmp, path)
    except Exception:
        logger.warning("对话轨迹落盘失败 conversation_id=%s", conversation_id, exc_info=True)


def append_transcript(conversation_id: str | None, new_messages: list[dict] | None) -> None:
    """在既有轨迹尾部追加几条消息（审批续接专用：/agent/execute 把"已确认执行 + 续接答复"接到主轨迹后面）。
    既有轨迹缺失也兜底创建（至少不丢续接）。故障安全：异常只记日志。整体仍走 save_transcript 覆盖写（幂等）。"""
    if not new_messages:
        return
    existing = load_transcript(conversation_id) or []
    save_transcript(conversation_id, existing + list(new_messages))


def load_transcript(conversation_id: str | None) -> list[dict] | None:
    """读回该会话的完整轨迹。文件不存在 → None（上层走"老会话 5 轮文本对"兜底）。
    坏行（非 JSON / 非 dict）逐行跳过、不崩。读出来不带 system（存时已剥）。"""
    path = transcript_path(conversation_id)
    if path is None or not path.exists():
        return None
    try:
        out: list[dict] = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except (ValueError, TypeError):
                    continue  # 坏行跳过
                if isinstance(obj, dict) and obj.get("role"):
                    out.append(obj)
        return out
    except Exception:
        logger.warning("对话轨迹读取失败 conversation_id=%s", conversation_id, exc_info=True)
        return None
