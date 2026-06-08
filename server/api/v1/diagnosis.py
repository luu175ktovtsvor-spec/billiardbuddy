from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from core.rbac import Permission, require_permission
from models.user import User
from models.store import Store
from schemas.diagnosis import DiagnosisRequest, DiagnosisResponse
from services.diagnosis_service import analyze_diagnosis

router = APIRouter(tags=["经营诊断"])


@router.post("/analyze", response_model=DiagnosisResponse)
async def analyze_diagnosis_api(
    body: DiagnosisRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    generation = await analyze_diagnosis(
        db=db,
        store=current_store,
        user=current_user,
        problem_area=body.problem_area,
        current_situation=body.current_situation,
    )
    return DiagnosisResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )
