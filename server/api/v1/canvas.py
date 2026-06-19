"""Canvas（画布）路由——成品右侧展开"指着某处说改这里"，以及报表可视化看/改。"""
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.rbac import Permission, require_permission
from models.store import Store
from models.user import User
from services.agent.local_tools import _resolve as _sandbox_resolve
from services.canvas_service import canvas_edit

router = APIRouter()


def _require_desktop() -> None:
    """报表看/改读写本机文件——只在桌面本地版放行；云端多租户绝不能读服务器/他人文件。"""
    if os.environ.get("DESKTOP_LOCAL") != "1":
        raise HTTPException(status_code=403, detail="该功能仅桌面本地版可用")


def _safe_xlsx(path_str: str, selected_files: list[str] | None = None, full_disk: bool = False) -> Path:
    """校验并收敛报表路径：只允许操作【老板当场选定(OS 选择器授权)的文件】或内容库内，
    复用 local_tools 同款沙箱——防路径被下游替换成任意 xlsx(如 ~/账目.xlsx)。"""
    p = Path(path_str or "")
    if p.suffix.lower() not in (".xlsx", ".xlsm"):
        raise HTTPException(status_code=400, detail="只支持 .xlsx 报表")
    ctx = SimpleNamespace(allowed_paths=selected_files or [], full_disk_access=full_disk)
    try:
        resolved = _sandbox_resolve(path_str, ctx)
    except ValueError:
        raise HTTPException(status_code=403, detail="只能看/改你当场选定的报表")
    if not resolved.exists() or not resolved.is_file():
        raise HTTPException(status_code=404, detail="报表文件不存在")
    return resolved


class CanvasEditRequest(BaseModel):
    content: str                          # 当前成品全文（前端持有的最新版）
    instruction: str                      # 怎么改（老板的话）
    selection: str | None = None          # 老板圈中要改的那一段；空=整篇修订
    deliverable_type: str | None = None   # 成品类型(文案/活动方案/话术…)，只影响提示语气


@router.post("/edit")
async def canvas_edit_endpoint(
    body: CanvasEditRequest,
    user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """圈了段只改那段（改这里不动别处），没圈则整篇修订。复用统一管道(配额/合规/落库/BYOK)。"""
    return await canvas_edit(
        db, store, user,
        content=body.content,
        instruction=body.instruction,
        selection=body.selection,
        deliverable_type=body.deliverable_type or "内容",
    )


# ───────────────── 报表可视化：看表格（只读）/ 点格改（写·自动备份） ·桌面专属 ─────────────────

_MAX_ROWS = 200
_MAX_COLS = 30


class SheetRequest(BaseModel):
    path: str  # 老板选定的本机报表路径(.xlsx)
    selected_files: list[str] = []   # OS 选择器授权的文件(沙箱白名单)；path 必须在其中或内容库内
    full_disk_access: bool = False


@router.post("/sheet")
async def read_sheet(
    body: SheetRequest,
    _user: Annotated[User, Depends(get_current_user)],
    _store: Annotated[Store, Depends(get_current_store)],
    _perm: None = Depends(require_permission(Permission.QUOTA_VIEW)),
):
    """读本机报表 → 结构化表格(供前端可视化展示)。桌面专属、只读、限行列防超大。"""
    _require_desktop()
    p = _safe_xlsx(body.path, body.selected_files, body.full_disk_access)
    from openpyxl import load_workbook
    wb = load_workbook(p, data_only=True)
    truncated = len(wb.worksheets) > 5
    sheets = []
    for ws in wb.worksheets[:5]:
        if (ws.max_row or 0) > _MAX_ROWS or (ws.max_column or 0) > _MAX_COLS:
            truncated = True
        rows = []
        for row in ws.iter_rows(max_row=_MAX_ROWS, max_col=_MAX_COLS):
            rows.append(["" if c.value is None else str(c.value) for c in row])
        while rows and not any(cell for cell in rows[-1]):  # 去尾部全空行
            rows.pop()
        # 去尾部全空列（openpyxl 按 max_col 填充会带一堆空列）
        maxc = 0
        for row in rows:
            for i in range(len(row) - 1, -1, -1):
                if row[i]:
                    maxc = max(maxc, i + 1)
                    break
        rows = [row[:maxc] for row in rows]
        sheets.append({"name": ws.title, "rows": rows})
    wb.close()
    return {"name": p.name, "sheets": sheets, "truncated": truncated}


class ExcelCellEdit(BaseModel):
    path: str
    cell: str                 # A1 式坐标，如 B2
    value: str                # 新值（纯数字会自动转数值）
    sheet: str | None = None  # 工作表名，留空=第一个表
    selected_files: list[str] = []   # OS 选择器授权的文件(沙箱白名单)
    full_disk_access: bool = False


@router.post("/excel-edit")
async def excel_edit(
    body: ExcelCellEdit,
    _user: Annotated[User, Depends(get_current_user)],
    _store: Annotated[Store, Depends(get_current_store)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """点格改：改本机报表一个单元格。桌面专属、改前自动备份、返回前后对比(diff)。"""
    _require_desktop()
    import shutil
    from core.timezone import business_now
    from openpyxl import load_workbook
    p = _safe_xlsx(body.path, body.selected_files, body.full_disk_access)
    # 改前自动备份（落到报表同目录的隐藏备份夹，可回滚）
    bdir = p.parent / ".billiards-backups"
    bdir.mkdir(exist_ok=True)
    backup = bdir / f"{p.stem}.{business_now().strftime('%Y%m%d-%H%M%S')}{p.suffix}.bak"
    wb = load_workbook(p)
    ws = wb[body.sheet] if (body.sheet and body.sheet in wb.sheetnames) else wb.active
    try:
        old = ws[body.cell].value
    except Exception:
        wb.close()
        raise HTTPException(status_code=400, detail=f"坐标无效：{body.cell}")
    # 纯数字转数值，否则按文本
    v: object = body.value
    s = (body.value or "").strip()
    try:
        v = int(s) if s.lstrip("-").isdigit() else float(s)
    except ValueError:
        v = body.value
    try:
        ws[body.cell] = v
    except AttributeError:  # 合并单元格的非左上角格只读
        wb.close()
        raise HTTPException(status_code=400, detail=f"{body.cell} 是合并单元格，请改合并区左上角那个格子")
    shutil.copy2(p, backup)  # 改成功才备份，避免改失败留孤儿备份
    wb.save(p)
    wb.close()
    return {"ok": True, "sheet": ws.title, "cell": body.cell,
            "old": "" if old is None else str(old), "new": str(v)}
