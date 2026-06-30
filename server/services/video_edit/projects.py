"""剪辑项目的落盘真相源 —— 时间轴文档持久化在 UPLOAD_DIR/edits/<project>/timeline.json。

agent 工具(video_edit_tools)和 REST 路由(api/v1/video_edit)**共用本模块**,改的是同一份文档:
这正是"时间轴文档=唯一真相源,AI 和面板都只是在它上面做操作"的落地。
"""
from __future__ import annotations

import os
from pathlib import Path

from .timeline import TimelineDoc


def uploads_root() -> Path:
    base = os.environ.get("UPLOAD_DIR") or str(Path.home() / ".billiards-desktop" / "uploads")
    return Path(base)


def project_dir(project: str) -> Path:
    safe = Path(project).name  # 只取末段,挡路径穿越
    d = uploads_root() / "edits" / safe
    d.mkdir(parents=True, exist_ok=True)
    return d


def doc_path(project: str) -> Path:
    return project_dir(project) / "timeline.json"


def load_doc(project: str) -> TimelineDoc | None:
    p = doc_path(project)
    if not p.exists():
        return None
    return TimelineDoc.model_validate_json(p.read_text())


def save_doc(project: str, doc: TimelineDoc) -> None:
    doc_path(project).write_text(doc.model_dump_json(), encoding="utf-8")
