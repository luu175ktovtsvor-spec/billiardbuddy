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

F-10 复审 Critical 修复（跨单元竞态）：上面说的"整体覆盖写"曾经有个坑——`media_job_notify.py`
挂在聊天里的慢工具（视频/剪辑）做完时，会在【本轮聊天进行中途】用 `append_transcript` 往磁盘追加一条
"做好了"；但轮收尾的整体覆盖写用的是【轮开始时加载的历史】拼出来的内容，对这次外部追加一无所知，
一覆盖就把它冲掉了。`capture_transcript_baseline_len`（轮开始记基准）+ `merge_external_tail`
（收尾前把磁盘上超出基准的尾部拼回去）+ `save_transcript_preserving_external_tail`（合并+覆盖写一步
到位）三个函数就是补这个坑的——agent.py 的两处"整轮覆盖写"（done 分支 + 取消分支）都已经改用后者，
不再直接调裸的 `save_transcript`。
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


def capture_transcript_baseline_len(conversation_id: str | None) -> int | None:
    """F-10 复审 Critical 修复：轮开始时（loop 还没跑）调一次，记下磁盘现存转录文件的行数基准，
    供轮收尾 `merge_external_tail`/`save_transcript_preserving_external_tail` 用——判断磁盘内容是否
    已被外部（media_job_notify 完成回调等）追加过。

    - 文件不存在（新会话/还没建过轨迹）→ 0（"当前磁盘等价于空"这一有效基准，仍能让 merge 正确捕捉
      轮进行中才出现的外部追加行）。
    - `load_transcript` 本身故障安全（内部已 try/except，异常只返回 None、不外抛），这里对"文件不存在"
      和"读取异常"统一按 0 处理——两者在收尾合并逻辑里都意味着"没有可信的既有内容需要跳过"，宁可多做
      一次(无害的)合并尝试，也不要因为一次读取失败就整体放弃合并、退回旧 bug 行为。"""
    tr = load_transcript(conversation_id)
    return len(tr) if tr is not None else 0


def merge_external_tail(
    conversation_id: str | None, final_messages: list[dict] | None, baseline_len: int | None,
) -> list[dict] | None:
    """F-10 复审 Critical 修复：轮收尾整份覆盖写前，把"轮进行中被外部（如 media_job_notify 完成回调）
    追加进磁盘"的尾部消息拼回 `final_messages` 末尾——防止覆盖写把它们冲掉。

    baseline_len：本轮开始时（loop 跑之前）磁盘轨迹的行数基准，由调用方在轮开始时读一次记下
    （`capture_transcript_baseline_len` 的返回值）。传 None 表示基准不可靠，本函数原样返回
    `final_messages`、不做任何合并——退化为原覆盖写行为，故障安全。

    对 autocompact 鲁棒：不假设 `final_messages` 是 baseline 的简单前缀延伸——autocompact 可能已经把
    本轮内部的前缀整段重建成摘要，长度/内容都变了，没法拿"多出来的部分"去跟 final_messages 做 diff。
    这里只在【磁盘现存文件】上判断：现在文件行数比 baseline_len 多出来的尾部就是外部追加（这段时间里，
    除了 media_job_notify 这类完成回调，没人会去写同一个会话的转录文件）——不管 final_messages 自己
    经历了什么压缩重建，把这段尾部原样接到它后面即可。磁盘现存内容 ≤ baseline_len（没变化，或中途被
    截断/回滚过）→ 不强行拼接，原样返回。读取失败也原样返回（故障安全）。"""
    if baseline_len is None or not final_messages:
        return final_messages
    current = load_transcript(conversation_id)
    if not current or len(current) <= baseline_len:
        return final_messages
    tail = current[baseline_len:]
    return list(final_messages) + tail


def save_transcript_preserving_external_tail(
    conversation_id: str | None, final_messages: list[dict] | None, baseline_len: int | None,
) -> None:
    """轮收尾整份覆盖写的安全版本：先按 baseline_len 把外部追加的尾部并回，再走 save_transcript。

    调用方两处同款用法（agent.py）：主循环"done"收尾的 `ctx.final_messages` + 用户取消时落的
    `ctx.live_messages`——都是"拿一份在轮开始时就定型/只在内存里累积的消息列表，整段覆盖写文件"，
    都会撞上同一个竞态（F-10 复审 Critical：异步媒体任务完成回灌 × 主循环整轮覆盖写的跨单元竞态），
    用同一个安全版本收口，别各自维护一份合并逻辑。"""
    save_transcript(conversation_id, merge_external_tail(conversation_id, final_messages, baseline_len))


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
