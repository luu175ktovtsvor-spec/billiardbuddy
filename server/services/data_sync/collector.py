"""采集器：把本机已存的数据增量取出、去重入队到 sync_outbox（上行队列）。

四个源，全量不裁剪（铁律1，owner §0.3 拍板）：
- usage_events：动作流水（做了啥/成没成/耗时）。
- generations：生成记录，**全列快照**（提示词/结果/模型/token/好评差评…一列不落）。
- stores：门店档案，**全列快照**；ref_id 带 updated_at，画像变了才是新一条。
- transcripts：对话轨迹落盘文件，入队存路径（上行时才读文件内容，见 uploader）。

幂等（铁律，按 (kind, ref_id) 唯一）：重复跑不会重复入队。时间游标存 sync_state。
时间戳一律转 UTC（铁律2，SQLite 丢 tzinfo 时按 UTC 兜，Windows 无 tzdata 也不崩）。
全程只读现有业务表 + 只写自己的 sync_outbox/sync_state，对现有功能零侵入。
"""

from datetime import datetime, timezone
import uuid as _uuid

from sqlalchemy import inspect as sa_inspect, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from models.sync_outbox import SyncOutbox
from models.sync_state import SyncState
from models.usage_event import UsageEvent
from models.generation import Generation
from models.store import Store


def _iso_utc(dt) -> str | None:
    """datetime → UTC ISO 字符串。SQLite 读回的是 naive datetime（丢了 tzinfo），
    我们落库时一律写 UTC，所以 naive 一律按 UTC 解读、别当本地时间（否则差 8 小时）。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    return dt.isoformat()


def _json_safe(v):
    if isinstance(v, datetime):
        return _iso_utc(v)
    if isinstance(v, _uuid.UUID):
        return str(v)
    return v


def _full_snapshot(obj) -> dict:
    """把 ORM 对象的全部普通列塞进 dict（全量·不裁剪）。"""
    return {c.key: _json_safe(getattr(obj, c.key)) for c in sa_inspect(obj).mapper.column_attrs}


async def _cursor(db, source: str):
    st = await db.get(SyncState, source)
    return st.last_ts if st else None


async def _advance(db, source: str, ts) -> None:
    st = await db.get(SyncState, source)
    if st is None:
        db.add(SyncState(source=source, last_ts=ts))
    else:
        st.last_ts = ts


async def _enqueue(db, kind: str, ref_id: str, payload: dict | None) -> int:
    """幂等入队：唯一冲突 (kind, ref_id) 则忽略。返回真正新入队的条数（0 或 1）。"""
    stmt = (
        sqlite_insert(SyncOutbox)
        .values(kind=kind, ref_id=ref_id, payload=payload)
        .on_conflict_do_nothing(index_elements=["kind", "ref_id"])
    )
    res = await db.execute(stmt)
    return res.rowcount or 0


async def collect_once(db) -> int:
    """把自上次游标以来的新数据入队。返回本次真正新入队条数。故障安全由调用方(uploader_loop)兜。"""
    n = 0

    # —— 使用事件 ——
    # 游标用 >=(而非 >):usage_events.created_at 是 SQLite func.now() 的**秒级**时间戳,
    # 同一秒内"SELECT 已跑、事件稍后才 commit"会让 created_at == 游标而被 > 永久漏采。
    # >= 会把边界秒重扫一遍,靠 outbox 的 (kind,ref_id) 唯一约束幂等去重(重复不入队),不丢不重。
    cur = await _cursor(db, "usage_events")
    q = select(UsageEvent).order_by(UsageEvent.created_at)
    if cur is not None:
        q = q.where(UsageEvent.created_at >= cur)
    rows = (await db.execute(q)).scalars().all()
    for r in rows:
        n += await _enqueue(db, "event", str(r.id), {
            "id": str(r.id),
            "event": r.event,
            "store_id": str(r.store_id) if r.store_id else None,
            "user_id": str(r.user_id) if r.user_id else None,
            "props": r.props,
            "created_at": _iso_utc(r.created_at),
        })
    if rows and rows[-1].created_at is not None:
        await _advance(db, "usage_events", rows[-1].created_at)

    # —— 生成记录（is_deleted==False）：全列快照 ——
    # ⚠️ 绕开 core/tenant.py 的自动租户过滤：它对不带 store_id 条件的 generations 查询,
    #    在「无租户上下文」(我们这个后台 loop 正是)时 fail-safe 成 `WHERE store_id IS NULL`→ 一条都取不到。
    #    采集器是**跨店**汇聚器,要的就是所有门店的生成记录。显式带上 `store_id IS NOT NULL`
    #    (语义=全部真实生成记录)即命中该监听器的"已自带 store_id 过滤则不插手"约定,取回全量。
    cur = await _cursor(db, "generations")
    q = (
        select(Generation)
        .where(Generation.store_id.isnot(None), Generation.is_deleted == False)  # noqa: E712
        .order_by(Generation.created_at)
    )
    if cur is not None:
        q = q.where(Generation.created_at >= cur)  # 同 usage_events:>= + outbox 幂等,防边界丢采
    rows = (await db.execute(q)).scalars().all()
    for r in rows:
        n += await _enqueue(db, "gen", str(r.id), _full_snapshot(r))
    if rows and rows[-1].created_at is not None:
        await _advance(db, "generations", rows[-1].created_at)

    # —— 门店档案：全列快照，ref_id 含 updated_at（画像变了才是新一条）——
    stores = (await db.execute(select(Store))).scalars().all()
    for s in stores:
        upd = getattr(s, "updated_at", None)
        ref = f"{s.id}:{upd.isoformat() if upd else ''}"
        n += await _enqueue(db, "store", ref, {"id": str(s.id), "snapshot": _full_snapshot(s)})

    # —— 对话轨迹：落盘文件入队存路径（上行时才读内容）——
    try:
        from services.agent.transcript import _transcript_dir
        tdir = _transcript_dir()
        if tdir.exists():
            for p in tdir.glob("*.jsonl"):
                cid = p.stem
                # ref_id 带上文件 mtime:对话续聊→文件变长→mtime 变→新 ref_id→重新入队上行,
                # 服务器按 conversation_id 做 ON CONFLICT DO UPDATE 覆盖成最新整段(否则首同步后
                # 的后续轮次永远传不上去,违背全量)。mtime 没变则同 ref_id 幂等跳过、不空跑。
                try:
                    mtime = int(p.stat().st_mtime)
                except Exception:
                    mtime = 0
                n += await _enqueue(db, "trace", f"{cid}:{mtime}",
                                    {"conversation_id": cid, "path": str(p)})
    except Exception:
        # 轨迹目录不可用不影响其它源
        pass

    await db.commit()
    return n
