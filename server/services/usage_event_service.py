"""使用事件记录（产品分析 / AI 可观测性）——喂版本迭代。

设计铁律：**故障安全**。打点绝不能影响主流程——独立 session、吞掉一切异常。
跨店只做统计聚合（admin），不参与租户隔离。
"""
import logging
import uuid

from db.session import async_session
from models.usage_event import UsageEvent

logger = logging.getLogger(__name__)


def _uuid_or_none(v):
    if v is None or isinstance(v, uuid.UUID):
        return v
    try:
        return uuid.UUID(str(v))
    except (ValueError, TypeError):
        return None


async def log_event(event: str, *, store_id=None, user_id=None, props: dict | None = None) -> None:
    """记一条使用事件。独立 session、失败静默、绝不抛到调用方。

    event：小写下划线事件名（如 "generation"）。props：小 JSON 上下文。
    store_id/user_id 接受 str / UUID / None。
    """
    try:
        async with async_session() as db:
            db.add(UsageEvent(
                event=(event or "")[:40],
                store_id=_uuid_or_none(store_id),
                user_id=_uuid_or_none(user_id),
                props=props or {},
            ))
            await db.commit()
    except Exception:
        logger.warning("usage event 记录失败 event=%s", event, exc_info=True)
