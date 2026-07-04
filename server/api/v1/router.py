from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db
# 单窗口产品：只保留 AI agent 会话 + 其所需路由（鉴权/门店&BYOK/今日建议/配额/店脑/客户端日志/画布/生成工作室/AI剪辑台）。
# 旧的内容生成/海报/历史/报表/工作台/协作等页面路由已随单窗口化删除（agent 直接调用底层 service，不经这些 HTTP 路由）。
from api.v1.auth import router as auth_router
from api.v1.stores import router as stores_router
from api.v1.dashboard import router as dashboard_router
from api.v1.quota import router as quota_router
from api.v1.client_logs import router as client_logs_router
from api.v1.store_memory import router as store_memory_router
from api.v1.agent import router as agent_router
from api.v1.canvas import router as canvas_router
from api.v1.studio import router as studio_router
from api.v1.video_edit import router as video_edit_router
from api.v1.notifications import router as notifications_router
from api.v1.checkpoints import router as checkpoints_router
from api.v1.scheduled_tasks import router as scheduled_tasks_router
from api.v1.store_docs import router as store_docs_router
from api.v1.voice import router as voice_router

router = APIRouter()

router.include_router(auth_router, prefix="/auth", tags=["认证"])
router.include_router(stores_router, prefix="/stores", tags=["门店"])
router.include_router(dashboard_router, prefix="/dashboard", tags=["今日工作台"])
router.include_router(quota_router, prefix="/quota", tags=["配额"])
router.include_router(client_logs_router, prefix="/logs", tags=["客户端日志"])
router.include_router(store_memory_router, prefix="/store-memory", tags=["店脑·门店记忆"])
router.include_router(agent_router, prefix="/agent", tags=["AI Agent 对话"])
router.include_router(canvas_router, prefix="/canvas", tags=["画布定向改写"])
router.include_router(studio_router, prefix="/studio", tags=["生成工作室·直连"])
router.include_router(video_edit_router, prefix="/video-edit", tags=["AI 剪辑台·直连"])
router.include_router(notifications_router, prefix="/notifications", tags=["通知中心"])
router.include_router(checkpoints_router, prefix="/checkpoints", tags=["检查点·影子git回滚"])
router.include_router(scheduled_tasks_router, prefix="/scheduled-tasks", tags=["定时任务"])
router.include_router(store_docs_router, prefix="/store-docs", tags=["店铺资料库"])
router.include_router(voice_router, prefix="/voice", tags=["语音输入"])


@router.get("/health")
async def health_check(db: AsyncSession = Depends(get_db)):
    """真健康检查：探一次 DB。DB 不通返回 503，让外部拨测/探活能发现"进程活着但业务全挂"。"""
    try:
        await db.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse({"status": "degraded", "db": "down"}, status_code=503)
    return {"status": "ok", "db": "up"}
