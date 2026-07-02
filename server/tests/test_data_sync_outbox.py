import pytest
from sqlalchemy import select

from models.sync_outbox import SyncOutbox


@pytest.mark.asyncio
async def test_outbox_unique_kind_ref(db_session):
    row = SyncOutbox(kind="gen", ref_id="gen-1", payload={"a": 1})
    db_session.add(row)
    await db_session.commit()
    db_session.add(SyncOutbox(kind="gen", ref_id="gen-1", payload={"a": 2}))
    with pytest.raises(Exception):
        await db_session.commit()
    await db_session.rollback()
    got = (await db_session.execute(select(SyncOutbox))).scalars().all()
    assert len(got) == 1 and got[0].synced_at is None and got[0].attempts == 0
