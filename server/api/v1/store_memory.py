"""店脑（门店 AI 记忆）查看/编辑 API ——「AI 眼里的你的店」页用。
所有查询显式按 store_id 过滤（绕开租户自动过滤的无上下文 fail-safe）。"""
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, delete

from api.deps import get_db, get_current_store
from models.store_memory import StoreMemory

router = APIRouter()

_TYPE_LABEL = {
    "semantic": "门店事实",
    "preference": "偏好",
    "operational": "运营模式",
    "episodic": "发生过的事",
}


class MemoryItem(BaseModel):
    id: str
    type: str
    type_label: str
    content: str
    confidence: str


class MemoryUpdate(BaseModel):
    content: str


class MemoryCreate(BaseModel):
    content: str
    type: str = "semantic"


def _item(m: StoreMemory) -> MemoryItem:
    return MemoryItem(
        id=str(m.id), type=m.type, type_label=_TYPE_LABEL.get(m.type, m.type),
        content=m.content, confidence=m.confidence,
    )


@router.get("", response_model=list[MemoryItem])
async def list_memories(store=Depends(get_current_store), db=Depends(get_db)):
    rows = (
        await db.execute(
            select(StoreMemory)
            .where(StoreMemory.store_id == store.id)
            .order_by(StoreMemory.type, StoreMemory.created_at)
        )
    ).scalars().all()
    return [_item(m) for m in rows]


@router.post("", response_model=MemoryItem)
async def add_memory(body: MemoryCreate, store=Depends(get_current_store), db=Depends(get_db)):
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="内容不能为空")
    m = StoreMemory(store_id=store.id, type=body.type, content=content, confidence="high")
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return _item(m)


@router.patch("/{memory_id}", response_model=MemoryItem)
async def update_memory(memory_id: str, body: MemoryUpdate,
                        store=Depends(get_current_store), db=Depends(get_db)):
    m = await db.scalar(
        select(StoreMemory).where(
            StoreMemory.id == uuid.UUID(memory_id), StoreMemory.store_id == store.id
        )
    )
    if not m:
        raise HTTPException(status_code=404, detail="记忆不存在")
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="内容不能为空")
    m.content = content
    await db.commit()
    return _item(m)


@router.delete("/{memory_id}")
async def delete_memory(memory_id: str, store=Depends(get_current_store), db=Depends(get_db)):
    await db.execute(
        delete(StoreMemory).where(
            StoreMemory.id == uuid.UUID(memory_id), StoreMemory.store_id == store.id
        )
    )
    await db.commit()
    return {"status": "ok"}
