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


async def observe_compliance(raw_content: str, *, store_id=None, sub_type: str = "") -> None:
    """可观测性：统计模型【原始输出】里的铁律违反（绝对化广告词等），喂"铁律违反率"指标。

    扫【过滤前】的原始内容，测的是模型真实 slip 率（代码闸随后会修掉、用户看到的是安全版）——
    这样能量化"换了模型/改了 prompt 后，模型违反铁律的频率有没有下降"，让架构改进可被验证。
    命中才记一条 compliance_hit。故障安全：绝不影响生成。
    """
    try:
        from core.security_guard import scan_compliance
        hits = scan_compliance(raw_content or "")
        if hits:
            await log_event("compliance_hit", store_id=store_id,
                            props={"terms": hits[:10], "sub_type": (sub_type or "")[:60]})
    except Exception:
        logger.warning("compliance 观测失败", exc_info=True)
