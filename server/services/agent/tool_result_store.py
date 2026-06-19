"""SH-3 · 工具结果落盘（persisted-output，给路径而非硬截断）。

为什么：CE「just-in-time」原则——超大工具结果不一次塞满上下文，而是落盘 + 回灌「轻量标识符
（路径）+ 开头预览」，模型按需用 read 工具把它拉回来。比「硬截断 + 让它缩小范围重查（多烧一轮）」
既不丢后半段信息、又不撑爆上下文/BYOK token。

铁律落点：写盘必须走 UPLOAD_DIR（settings.upload_dir，桌面=userData 可写目录）——app 包内只读，
不能往里写。落到 `<UPLOAD_DIR>/tool-results/<session>/<tool>-<uuid>.txt`。
`local_tools._resolve` 的沙箱白名单已把 tool-results/ 加进去，模型 read 得回自己落盘的结果。
"""
import logging
import uuid as _uuid
from pathlib import Path

from config import settings

logger = logging.getLogger(__name__)

# 回灌预览的开头字符数：给模型「这是什么」的信号、又不占多少 token。
_PREVIEW_CHARS = 600

# 落盘根目录名（在 UPLOAD_DIR 下）。local_tools 沙箱白名单按这个名字放行。
TOOL_RESULTS_DIRNAME = "tool-results"


def _safe_session(ctx) -> str:
    """从 ctx 取一个稳定的会话子目录名（按门店分桶，避免不同店混落同一目录）。
    取不到就用 'misc'。只保留文件名安全字符。"""
    store = getattr(ctx, "store", None)
    sid = getattr(store, "id", None)
    raw = str(sid) if sid is not None else "misc"
    safe = "".join(c for c in raw if c.isalnum() or c in "-_")
    return safe or "misc"


def _safe_tool(tool_name: str | None) -> str:
    raw = tool_name or "tool"
    safe = "".join(c for c in raw if c.isalnum() or c in "-_")
    return safe or "tool"


def results_root() -> Path:
    """落盘根：UPLOAD_DIR/tool-results。单一来源，沙箱白名单也引它。"""
    return Path(settings.upload_dir) / TOOL_RESULTS_DIRNAME


def persist(tool_name: str | None, text: str, ctx) -> tuple[str, str]:
    """把一段超大工具结果落盘，返回 (绝对路径, 开头预览)。

    落点：UPLOAD_DIR/tool-results/<session>/<tool>-<uuid>.txt（铁律：UPLOAD_DIR 是 userData 可写区）。
    预览 = 文本开头 _PREVIEW_CHARS 字。写盘失败抛异常由调用方兜底（退回截断），不静默吞。
    """
    session = _safe_session(ctx)
    out_dir = results_root() / session
    out_dir.mkdir(parents=True, exist_ok=True)
    fname = f"{_safe_tool(tool_name)}-{_uuid.uuid4().hex[:12]}.txt"
    path = out_dir / fname
    path.write_text(text, encoding="utf-8")
    preview = text[:_PREVIEW_CHARS]
    return str(path), preview
