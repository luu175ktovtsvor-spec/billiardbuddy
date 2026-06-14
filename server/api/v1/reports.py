"""报表/日报 API：取表单 schema、提交生成、列表、导出 Excel。

复用 generations 表（type="report"）。导出端点用 /{report_id}/export 后缀，避开
GET /{report_type} 的路径冲突。
"""
import io
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import NotFoundException
from core.rbac import Permission, require_permission
from core.timezone import business_now
from models.generation import Generation
from models.store import Store
from models.user import User
from schemas.report import (
    ReportCreateRequest,
    ReportExtractRequest,
    ReportExtractResponse,
    ReportListItem,
    ReportResponse,
)
from services.report_excel import render_report
from services.report_schema import get_report_schema
from services.report_service import extract_report_data, generate_report

router = APIRouter()
_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get("/schema/{report_type}")
async def get_schema(
    report_type: str,
    _user: Annotated[User, Depends(get_current_user)],
    _store: Annotated[Store, Depends(get_current_store)],
):
    """返回某张表的表单 schema，供前端动态渲染。"""
    return get_report_schema(report_type)


@router.get("", response_model=list[ReportListItem])
async def list_reports(
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_LIST)),
):
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store.id,
            Generation.type == "report",
            Generation.is_deleted == False,  # noqa: E712
        )
        .order_by(Generation.created_at.desc())
        .limit(200)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        ReportListItem(
            id=str(r.id), report_type=r.sub_type, title=r.title,
            created_at=r.created_at.isoformat(),
        )
        for r in rows
    ]


@router.get("/today-status")
async def today_status(
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_LIST)),
):
    """今天哪些日报已交（老板/团队看交付状态）。按 input_params['date'] 比，避开时区坑。"""
    today = business_now().strftime("%Y-%m-%d")
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store.id,
            Generation.type == "report",
            Generation.is_deleted == False,  # noqa: E712
        )
        .order_by(Generation.created_at.desc())
        .limit(50)
    )
    rows = (await db.execute(stmt)).scalars().all()
    submitted = sorted({
        r.sub_type for r in rows
        if r.sub_type and str((r.input_params or {}).get("date", "")) == today
    })
    return {"date": today, "submitted": submitted}


@router.post("/{report_type}", response_model=ReportResponse)
async def submit_report(
    report_type: str,
    payload: ReportCreateRequest,
    user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    gen = await generate_report(db, store, user, report_type, payload.data, payload.note)
    return ReportResponse(
        report_id=str(gen.id),
        narrative=gen.result,
        deltas=gen.input_params.get("_deltas", {}),
    )


@router.post("/{report_type}/extract", response_model=ReportExtractResponse)
async def extract_report(
    report_type: str,
    payload: ReportExtractRequest,
    _user: Annotated[User, Depends(get_current_user)],
    _store: Annotated[Store, Depends(get_current_store)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """「说一句话」→ AI 抽取结构化字段，前端拿去预填表单（用户再核对）。"""
    return ReportExtractResponse(data=await extract_report_data(report_type, payload.text))


@router.get("/{report_id}/export")
async def export_report(
    report_id: str,
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_LIST)),
):
    gen = (
        await db.execute(
            select(Generation).where(
                Generation.id == report_id,
                Generation.store_id == store.id,
                Generation.is_deleted == False,  # noqa: E712
            )
        )
    ).scalar_one_or_none()
    if gen is None:
        raise NotFoundException("报表记录不存在")
    schema = get_report_schema(gen.sub_type)
    xlsx = render_report(schema, gen.input_params, gen.result)
    fname = f"{gen.sub_type}_{gen.created_at:%Y%m%d}.xlsx"
    return StreamingResponse(
        io.BytesIO(xlsx),
        media_type=_XLSX,
        headers={"Content-Disposition": f"attachment; filename={fname}"},
    )
