"""剪辑项目的落盘真相源 —— 时间轴文档持久化在 UPLOAD_DIR/edits/<project>/timeline.json。

agent 工具(video_edit_tools)和 REST 路由(api/v1/video_edit)**共用本模块**,改的是同一份文档:
这正是"时间轴文档=唯一真相源,AI 和面板都只是在它上面做操作"的落地。
"""
from __future__ import annotations

import logging
import os
import shutil
import time
from pathlib import Path

from .timeline import TimelineDoc

logger = logging.getLogger(__name__)

_GC_TTL_S = 7 * 86400        # 项目目录超过 7 天没动过 → 判定为废弃,整个删
_GC_MIN_INTERVAL_S = 3600    # 惰性:每小时最多扫一次,别每次建项目目录都全量 scandir
_gc_last_run = 0.0


def uploads_root() -> Path:
    base = os.environ.get("UPLOAD_DIR") or str(Path.home() / ".billiards-desktop" / "uploads")
    return Path(base)


def _gc_stale_projects(edits_root: Path) -> None:
    """惰性 best-effort 清理:edits/ 下 mtime 超过 7 天的项目目录整个删掉。

    只在新建/访问项目目录时顺手扫一次(限频),删单个项目失败不影响主流程——只记日志。
    项目目录的 mtime 会随 save_doc/save_v2_plan/渲染出片等写操作刷新,真正在用的项目不会被扫中。
    """
    global _gc_last_run
    now = time.time()
    if now - _gc_last_run < _GC_MIN_INTERVAL_S:
        return
    _gc_last_run = now
    try:
        children = list(edits_root.iterdir())
    except Exception:  # noqa: BLE001
        return
    cutoff = now - _GC_TTL_S
    for child in children:
        try:
            if child.is_dir() and child.stat().st_mtime < cutoff:
                shutil.rmtree(child)
                logger.info("惰性 GC:清理超过 7 天未活动的视频剪辑项目目录 %s", child)
        except Exception:  # noqa: BLE001
            logger.warning("惰性 GC:清理项目目录失败(忽略) %s", child, exc_info=True)


def project_dir(project: str) -> Path:
    safe = Path(project).name  # 只取末段,挡路径穿越
    edits_root = uploads_root() / "edits"
    d = edits_root / safe
    d.mkdir(parents=True, exist_ok=True)
    try:
        _gc_stale_projects(edits_root)
    except Exception:  # noqa: BLE001
        logger.warning("惰性 GC 扫描异常(忽略)", exc_info=True)
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
