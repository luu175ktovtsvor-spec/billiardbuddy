from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db
from api.v1.auth import router as auth_router
from api.v1.stores import router as stores_router
from api.v1.generate import router as generate_router
from api.v1.generations import router as generations_router
from api.v1.posters import router as posters_router
from api.v1.dashboard import router as dashboard_router
from api.v1.outreach import router as outreach_router
from api.v1.sop import router as sop_router
from api.v1.games import router as games_router
from api.v1.performance import router as performance_router
from api.v1.diagnosis import router as diagnosis_router
from api.v1.stream import router as stream_router
from api.v1.knowledge import router as knowledge_router
from api.v1.quota import router as quota_router
from api.v1.models import router as models_router
from api.v1.members import router as members_router
from api.v1.admin import router as admin_router
from api.v1.feedback import router as feedback_router
from api.v1.templates import router as templates_router
from api.v1.repurpose import router as repurpose_router
from api.v1.batch import router as batch_router
from api.v1.orchestrate import router as orchestrate_router
from api.v1.client_logs import router as client_logs_router
from api.v1.store_memory import router as store_memory_router
from api.v1.reports import router as reports_router
from api.v1.agent import router as agent_router
from api.v1.canvas import router as canvas_router

router = APIRouter()

router.include_router(auth_router, prefix="/auth", tags=["认证"])
router.include_router(stores_router, prefix="/stores", tags=["门店"])
router.include_router(generate_router, prefix="/generate", tags=["内容生成"])
router.include_router(generations_router, prefix="/generations", tags=["generations"])
router.include_router(posters_router, prefix="/posters", tags=["posters"])
router.include_router(dashboard_router, prefix="/dashboard", tags=["今日工作台"])
router.include_router(outreach_router, prefix="/outreach", tags=["助教约客"])
router.include_router(sop_router, prefix="/sop", tags=["前厅SOP"])
router.include_router(games_router, prefix="/games", tags=["玩法推荐"])
router.include_router(performance_router, prefix="/performance", tags=["绩效考核"])
router.include_router(diagnosis_router, prefix="/diagnosis", tags=["经营诊断"])
router.include_router(stream_router, prefix="/stream", tags=["流式生成"])
router.include_router(knowledge_router, prefix="/knowledge", tags=["知识库"])
router.include_router(quota_router, prefix="/quota", tags=["配额"])
router.include_router(models_router, prefix="/models", tags=["模型"])
router.include_router(members_router, prefix="/members", tags=["成员管理"])
router.include_router(admin_router, prefix="/admin", tags=["管理后台"])
router.include_router(feedback_router, prefix="/feedback", tags=["反馈"])
router.include_router(templates_router, prefix="/templates", tags=["模板"])
router.include_router(repurpose_router, prefix="/generate", tags=["内容变体"])
router.include_router(batch_router, prefix="/generate", tags=["批量生成"])
router.include_router(orchestrate_router, prefix="/orchestrate", tags=["协作任务"])
router.include_router(client_logs_router, prefix="/logs", tags=["客户端日志"])
router.include_router(store_memory_router, prefix="/store-memory", tags=["店脑·门店记忆"])
router.include_router(reports_router, prefix="/reports", tags=["报表日报"])
router.include_router(agent_router, prefix="/agent", tags=["AI Agent 对话"])
router.include_router(canvas_router, prefix="/canvas", tags=["画布定向改写"])


@router.get("/health")
async def health_check(db: AsyncSession = Depends(get_db)):
    """真健康检查：探一次 DB。DB 不通返回 503，让外部拨测/探活能发现"进程活着但业务全挂"。"""
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "degraded", "db": "down"}, status_code=503)
    return {"status": "ok", "db": "up"}
