"""店铺资料库 REST API —— 给下一单(D-Task-6)前端「选文件夹」面板用：设资料夹/查状态/重新索引/清除。

免登录单用户：`get_current_store` 返本地 seed 的唯一店；`store_doc_libraries` 表不在
`core/tenant.py` 的自动租户过滤覆盖范围内（那套只兜 generations/usage_quotas），
所以这里全部手写 `.where(store_id==)` —— 漏写就是跨店泄露(CLAUDE.md 铁律)。

索引/检索的真正逻辑在 `services/rag/store_docs.py`；这里只是配置的 CRUD 壳子 + 触发后台索引。

设计取舍：PUT（设资料夹）会立即触发一次后台索引——背景目标里明确写"选一个文件夹 → 自动索引"，
选完就该自动开始，不该还要老板再手动点一次"重新索引"。POST /reindex 留给后续手动重新扫描
（比如老板往文件夹里加了新文件，想手动触发一次刷新）。两者都立即返回、真正的索引在后台跑，
状态经 `status` 字段（idle/indexing/ready/error）反映。
"""
import asyncio
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from api.deps import get_current_store, get_db
from models.store_doc_library import StoreDocLibrary
from services.rag import index_store
from services.rag.store_docs import run_folder_reindex_job

router = APIRouter()

# 持有后台索引任务引用，防被 GC（asyncio 不持引用会随时回收，同 media_jobs_runner 的做法）。
_tasks: "set[asyncio.Task]" = set()


def _spawn_reindex(store_id, folder_path: str) -> None:
    task = asyncio.create_task(run_folder_reindex_job(store_id, folder_path))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


class StoreDocLibraryItem(BaseModel):
    folder_path: str | None
    status: str
    indexed_file_count: int
    indexed_chunk_count: int
    last_indexed_at: str | None
    last_error: str | None


class SetFolderBody(BaseModel):
    folder_path: str


def _item(row: StoreDocLibrary | None) -> StoreDocLibraryItem:
    if row is None:
        return StoreDocLibraryItem(
            folder_path=None, status="idle", indexed_file_count=0,
            indexed_chunk_count=0, last_indexed_at=None, last_error=None,
        )
    return StoreDocLibraryItem(
        folder_path=row.folder_path,
        status=row.status,
        indexed_file_count=row.indexed_file_count,
        indexed_chunk_count=row.indexed_chunk_count,
        last_indexed_at=row.last_indexed_at.isoformat() if row.last_indexed_at else None,
        last_error=row.last_error,
    )


async def _get_row(store, db) -> StoreDocLibrary | None:
    return (await db.execute(
        select(StoreDocLibrary).where(StoreDocLibrary.store_id == store.id)
    )).scalars().first()


@router.get("", response_model=StoreDocLibraryItem)
async def get_store_docs_route(store=Depends(get_current_store), db=Depends(get_db)):
    return _item(await _get_row(store, db))


@router.put("", response_model=StoreDocLibraryItem)
async def set_store_docs_folder_route(
    body: SetFolderBody, store=Depends(get_current_store), db=Depends(get_db),
):
    folder_path = body.folder_path.strip()
    if not folder_path:
        raise HTTPException(status_code=400, detail="folder_path 不能为空")
    if not Path(folder_path).is_dir():
        raise HTTPException(status_code=400, detail=f"不是一个存在的文件夹：{folder_path}")

    row = await _get_row(store, db)
    if row is None:
        row = StoreDocLibrary(store_id=store.id, folder_path=folder_path, status="indexing")
        db.add(row)
    else:
        row.folder_path = folder_path
        row.status = "indexing"
        row.last_error = None
    await db.commit()
    await db.refresh(row)

    item = _item(row)
    _spawn_reindex(store.id, folder_path)
    return item


@router.post("/reindex", response_model=StoreDocLibraryItem)
async def reindex_store_docs_route(store=Depends(get_current_store), db=Depends(get_db)):
    row = await _get_row(store, db)
    if row is None or not row.folder_path:
        raise HTTPException(status_code=400, detail="还没设置店铺资料文件夹，先用 PUT 设一个")
    row.status = "indexing"
    row.last_error = None
    await db.commit()
    await db.refresh(row)

    item = _item(row)
    _spawn_reindex(store.id, row.folder_path)
    return item


@router.delete("")
async def clear_store_docs_route(store=Depends(get_current_store), db=Depends(get_db)):
    row = await _get_row(store, db)
    index_store.delete_by_source_type(str(store.id), "store_doc")
    if row is not None:
        row.folder_path = None
        row.status = "idle"
        row.indexed_file_count = 0
        row.indexed_chunk_count = 0
        row.last_indexed_at = None
        row.last_error = None
        await db.commit()
    return {"status": "ok"}
