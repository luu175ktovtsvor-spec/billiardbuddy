"""AI 原子操作层 —— AI 对时间轴文档发"增删改"指令,本层确定性施加 + 校验 + 失败回滚。

为什么不让 AI 整份重写 JSON(Q3·deep-research 证实):
- 整份重写贵(token 多~31%)且脆(LLM 数组下标算术易错位)。
- 原子操作 + 稳定ID映射(timeline.py)+ 确定性校验,才挡得住非法时间轴状态。
- 范式对照 EditDuet 的 add/remove/switch/move + 一次发一个;可靠性靠"本层校验+回滚",不靠 AI 自评。

保证:一批操作**全成功且校验通过**才返回新文档;任一步出错/校验不过 → 返回**原文档不变** + 错误列表(回灌模型自救)。
"""
from __future__ import annotations

from .timeline import Clip, MediaRef, TimelineDoc, Track


class OpError(Exception):
    """单条操作非法(缺参/目标不存在/未知操作)。"""


# 支持的操作词表(给提示词/工具 schema 用,单一真相源)
OP_NAMES = [
    "add_media", "add_track", "add_clip", "add_caption",
    "remove_clip", "trim_clip", "reorder_clip", "edit_caption",
    "set_music", "set_grade",
]


def _gen_id(existing: dict, prefix: str) -> str:
    """生成不与现有键冲突的稳定 ID(prefix + 最小可用整数)。"""
    i = 1
    while f"{prefix}{i}" in existing:
        i += 1
    return f"{prefix}{i}"


def _next_order(doc: TimelineDoc, track: str) -> int:
    orders = [c.order for c in doc.clips.values() if c.track == track]
    return (max(orders) + 1) if orders else 0


def _require(op: dict, *keys: str) -> None:
    for k in keys:
        if k not in op:
            raise OpError(f"操作 {op.get('op')} 缺必填参数 {k}")


def _apply_one(doc: TimelineDoc, op: dict) -> None:
    kind = op.get("op")

    if kind == "add_media":
        _require(op, "src", "duration")
        mid = op.get("id") or _gen_id(doc.media, "m")
        if mid in doc.media:
            raise OpError(f"媒体 id {mid} 已存在")
        doc.media[mid] = MediaRef(src=op["src"], duration=float(op["duration"]), kind=op.get("kind", "video"))

    elif kind == "add_track":
        _require(op, "kind")
        tid = op.get("id") or _gen_id(doc.tracks, "t")
        if tid in doc.tracks:
            raise OpError(f"轨道 id {tid} 已存在")
        doc.tracks[tid] = Track(kind=op["kind"], order=int(op.get("order", len(doc.tracks))))

    elif kind == "add_clip":
        _require(op, "track")
        cid = op.get("id") or _gen_id(doc.clips, "c")
        if cid in doc.clips:
            raise OpError(f"片段 id {cid} 已存在")
        doc.clips[cid] = Clip(
            track=op["track"], media=op.get("media"),
            src_in=float(op.get("src_in", 0.0)), src_out=float(op.get("src_out", 0.0)),
            order=int(op["order"]) if "order" in op else _next_order(doc, op["track"]),
        )

    elif kind == "add_caption":
        _require(op, "track", "text", "start", "end")
        cid = op.get("id") or _gen_id(doc.clips, "s")
        if cid in doc.clips:
            raise OpError(f"字幕 id {cid} 已存在")
        doc.clips[cid] = Clip(
            track=op["track"], text=op["text"],
            start=float(op["start"]), end=float(op["end"]), style=op.get("style"),
        )

    elif kind == "remove_clip":
        _require(op, "id")
        if op["id"] not in doc.clips:
            raise OpError(f"要删的片段 {op['id']} 不存在")
        del doc.clips[op["id"]]

    elif kind == "trim_clip":
        _require(op, "id")
        c = doc.clips.get(op["id"])
        if c is None:
            raise OpError(f"要裁的片段 {op['id']} 不存在")
        if "src_in" in op:
            c.src_in = float(op["src_in"])
        if "src_out" in op:
            c.src_out = float(op["src_out"])

    elif kind == "reorder_clip":
        _require(op, "id", "order")
        c = doc.clips.get(op["id"])
        if c is None:
            raise OpError(f"要排序的片段 {op['id']} 不存在")
        c.order = int(op["order"])

    elif kind == "edit_caption":
        _require(op, "id")
        c = doc.clips.get(op["id"])
        if c is None:
            raise OpError(f"要改的字幕 {op['id']} 不存在")
        for f in ("text", "style"):
            if f in op:
                setattr(c, f, op[f])
        for f in ("start", "end"):
            if f in op:
                setattr(c, f, float(op[f]))

    elif kind == "set_music":
        _require(op, "media")
        doc.music = op["media"]

    elif kind == "set_grade":
        doc.grade = op.get("grade")

    else:
        raise OpError(f"未知操作:{kind}(支持:{', '.join(OP_NAMES)})")


def apply_operations(doc: TimelineDoc, ops: list[dict]) -> tuple[TimelineDoc, list[str]]:
    """对文档**副本**依次施加原子操作。

    全成功且 validate_doc 通过 → 返回(新文档, []);
    任一步抛 OpError 或最终校验不过 → 返回(**原文档不变**, 错误列表)。
    """
    work = doc.model_copy(deep=True)
    for idx, op in enumerate(ops):
        try:
            _apply_one(work, op)
        except OpError as e:
            return doc, [f"第{idx + 1}步操作失败:{e}"]
        except (KeyError, ValueError, TypeError) as e:
            return doc, [f"第{idx + 1}步操作参数错误:{e}"]

    errs = work.validate_doc()
    if errs:
        return doc, errs
    return work, []
