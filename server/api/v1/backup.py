"""数据安全兜底(G4) · 设置抽屉「备份店铺数据」一键导出。

打包成 zip 交给前端「另存为」写到用户自己选的位置(桌面/U盘/网盘同步文件夹)——目标是"电脑坏了
数据不至于全丢"。zip 内容 = 主库的 WAL 安全快照(`services.db_backup.safe_copy`，与后台定期
备份同一条安全路径，不是裸文件拷贝) + `UPLOAD_DIR` 整个目录(海报/二维码/logo/视频等产出，
这些是店主真正在意的"作品"，只备库不备这些等于白备一半)。

仅本地 SQLite 桌面版有意义；云端 PG 版数据由服务器另行运维备份，非 SQLite 直接 400。
"""
from __future__ import annotations

import shutil
import tempfile
import zipfile
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from api.deps import get_current_user
from config import settings
from models.user import User
from services import db_backup

router = APIRouter()


@router.get("/export")
async def export_store_data(user: User = Depends(get_current_user)):
    """打包当前主库快照 + uploads 目录为 zip，返回给前端下载/另存为。"""
    import asyncio

    db_path = db_backup.sqlite_db_path()
    if db_path is None or not db_path.exists():
        raise HTTPException(status_code=400, detail="当前不是本地 SQLite 模式，无法导出（云端版数据由服务器另行备份）")

    tmp_dir = Path(tempfile.mkdtemp(prefix="billiards-export-"))
    snapshot = tmp_dir / "billiards.db"

    def _build() -> Path:
        db_backup.safe_copy(db_path, snapshot)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        zip_path = tmp_dir / f"球房数据备份-{ts}.zip"
        uploads_dir = Path(settings.upload_dir)
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(snapshot, arcname="billiards.db")
            if uploads_dir.is_dir():
                for p in uploads_dir.rglob("*"):
                    if p.is_file():
                        zf.write(p, arcname=str(Path("uploads") / p.relative_to(uploads_dir)))
        return zip_path

    try:
        zip_path = await asyncio.to_thread(_build)
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        raise HTTPException(status_code=500, detail=f"打包数据失败：{e}")

    return FileResponse(
        str(zip_path),
        media_type="application/zip",
        filename=zip_path.name,
        background=BackgroundTask(shutil.rmtree, tmp_dir, ignore_errors=True),
    )
