"""店脑（门店 AI 记忆）查看/编辑 API ——「AI 眼里的你的店」页用。
所有查询显式按 store_id 过滤（绕开租户自动过滤的无上下文 fail-safe）。"""
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from api.deps import get_db, get_current_store
from core.security_guard import check_input_injection
from models.store_memory import StoreMemory

router = APIRouter()

_TYPE_LABEL = {
    "semantic": "门店事实",
    "preference": "偏好",
    "operational": "运营模式",
    "episodic": "发生过的事",
}

_SOURCE_LABEL = {"manual": "店主定", "auto": "AI学到", "pending": "待确认"}


class MemoryItem(BaseModel):
    id: str
    type: str
    type_label: str
    content: str
    confidence: str
    source: str
    source_label: str
    scope: str = "global"
    scope_label: str = "全局"


class MemoryUpdate(BaseModel):
    content: str


class MemoryCreate(BaseModel):
    content: str
    type: str = "semantic"
    working_dir: str | None = None


class MemoryCandidateCreate(BaseModel):
    content: str
    type: str = "semantic"
    working_dir: str | None = None


def _workdir_label(path: str | None) -> str:
    """marker 里存【完整规范路径】（按整路径隔离项目记忆，避免同名文件夹串记忆）；
    UI 显示见 _split_scope（取文件夹名，对用户友好）。"""
    from services.memory_service import canon_workdir_path
    return canon_workdir_path(path)


def _apply_workdir_scope(content: str, working_dir: str | None) -> str:
    label = _workdir_label(working_dir)
    return f"【工作目录:{label}】{content}" if label else content


def _split_scope(content: str) -> tuple[str, str, str]:
    from services.memory_service import _memory_workdir, _strip_workdir_mark
    wd = _memory_workdir(content)
    if not wd:
        return "global", "全局", content
    # marker 里存的是完整路径(隔离用)，UI 只显示文件夹名(友好)
    display = wd.rstrip("/\\").replace("\\", "/").split("/")[-1] or wd
    return "working_dir", f"工作目录：{display}", _strip_workdir_mark(content)


def _replace_content_preserving_scope(old_content: str, new_content: str) -> str:
    """面板编辑的是去掉作用域前缀后的正文；保存时保留原来的工作目录作用域。"""
    from services.memory_service import _memory_workdir
    wd = _memory_workdir(old_content)
    if not wd:
        return new_content
    plain = _split_scope(new_content)[2]
    return _apply_workdir_scope(plain, wd)


def _item(m: StoreMemory) -> MemoryItem:
    src = getattr(m, "source", None) or "auto"
    scope, scope_label, content = _split_scope(m.content)
    return MemoryItem(
        id=str(m.id), type=m.type, type_label=_TYPE_LABEL.get(m.type, m.type),
        content=content, confidence=m.confidence,
        source=src, source_label=_SOURCE_LABEL.get(src, src),
        scope=scope, scope_label=scope_label,
    )


async def _get_memory(memory_id: str, store, db, *, include_deleted: bool = False) -> StoreMemory:
    try:
        mem_uuid = uuid.UUID(memory_id)
    except (ValueError, TypeError):
        raise HTTPException(status_code=404, detail="记忆不存在")
    filters = [StoreMemory.id == mem_uuid, StoreMemory.store_id == store.id]
    if not include_deleted:
        filters.append(StoreMemory.is_deleted == False)  # noqa: E712
    m = await db.scalar(select(StoreMemory).where(*filters))
    if not m:
        raise HTTPException(status_code=404, detail="记忆不存在")
    return m


@router.get("", response_model=list[MemoryItem])
async def list_memories(store=Depends(get_current_store), db=Depends(get_db)):
    rows = (
        await db.execute(
            select(StoreMemory)
            .where(StoreMemory.store_id == store.id, StoreMemory.is_deleted == False)  # noqa: E712
            .order_by(StoreMemory.type, StoreMemory.created_at)
        )
    ).scalars().all()
    return [_item(m) for m in rows]


@router.post("", response_model=MemoryItem)
async def add_memory(
    body: MemoryCreate,
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    # 店脑会注入该店所有后续生成的 prompt，等同门店级设置；
    # 过注入检查，防止往记忆里塞 prompt 注入内容（本地单用户，无多角色权限闸）。
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="内容不能为空")
    injection = check_input_injection(content)
    if injection:
        raise HTTPException(status_code=400, detail=injection)
    # 老板亲自填的 = 店规矩，标 source="manual"：AI 学习时绝不删改、注入时最高优先。
    m = StoreMemory(
        store_id=store.id, type=body.type, content=_apply_workdir_scope(content, body.working_dir),
        confidence="high", source="manual",
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return _item(m)


@router.post("/candidates", response_model=MemoryItem)
async def add_memory_candidate(
    body: MemoryCandidateCreate,
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """新增一条待确认记忆：AI 推断/文件提取的事实先到这里，用户确认后才进 prompt。"""
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="内容不能为空")
    injection = check_input_injection(content)
    if injection:
        raise HTTPException(status_code=400, detail=injection)
    m = StoreMemory(
        store_id=store.id, type=body.type, content=_apply_workdir_scope(content, body.working_dir),
        confidence="low", source="pending",
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return _item(m)


@router.patch("/{memory_id}", response_model=MemoryItem)
async def update_memory(memory_id: str, body: MemoryUpdate,
                        store=Depends(get_current_store), db=Depends(get_db),
                        ):
    m = await _get_memory(memory_id, store, db)
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="内容不能为空")
    injection = check_input_injection(content)
    if injection:
        raise HTTPException(status_code=400, detail=injection)
    m.content = _replace_content_preserving_scope(m.content, content)
    # 老板亲手改过 = 认定为店规矩，转 manual：此后 AI 学习绝不删改、注入最高优先。
    m.source = "manual"
    await db.commit()
    return _item(m)


@router.post("/{memory_id}/confirm", response_model=MemoryItem)
async def confirm_memory(memory_id: str, store=Depends(get_current_store), db=Depends(get_db)):
    m = await _get_memory(memory_id, store, db)
    m.source = "manual"
    m.confidence = "high"
    await db.commit()
    return _item(m)


@router.delete("/{memory_id}")
async def delete_memory(memory_id: str, store=Depends(get_current_store), db=Depends(get_db),
                        ):
    m = await _get_memory(memory_id, store, db)
    m.is_deleted = True
    m.deleted_at = datetime.now(timezone.utc)
    await db.commit()
    return {"status": "ok"}
