import logging
from contextlib import asynccontextmanager

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from api.v1.router import router as v1_router
from config import settings, validate_production_config
from core.exceptions import register_exception_handlers

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("服务启动中...")
    from db.session import engine

    # secret_key 必须非空（无论开发/生产）
    if not settings.secret_key:
        raise RuntimeError("SECRET_KEY 未设置，拒绝启动。请在 .env 中配置 SECRET_KEY")

    # 生产环境额外安全校验
    config_warnings = validate_production_config()
    for w in config_warnings:
        logger.warning("生产安全警告: %s", w)

    # 桌面全本地版（SQLite）：无 Alembic 迁移，启动时按模型 create_all 建表（幂等）。
    # 云端 PostgreSQL 不走此路（仍靠 Alembic 迁移建库），按 engine 方言判断。
    if engine.dialect.name == "sqlite":
        from db.init_local import init_local_db
        await init_local_db()

    # 启动时打印知识库加载情况：桌面打包版据此确认加密块(prompts.enc)解密成功（模板数应=171），
    # 而非静默回退到明文 prompts/（打包里已删明文 → 回退会是 0，立刻能看出护城河失效）。
    from services.ai.prompt_engine import get_prompt_engine
    _pe = get_prompt_engine()
    _src = "加密块(prompts.enc)" if __import__("os").environ.get("PROMPTS_PACK_KEY") else "明文YAML"
    logger.info("知识库已加载：%d 模板（来源：%s）", len(_pe._templates), _src)

    yield

    logger.info("服务关闭，清理数据库连接...")
    await engine.dispose()


app = FastAPI(
    title="球房 AI 运营助手",
    description="面向台球房行业的 AI 运营辅助 SaaS 工具",
    version="0.1.0",
    lifespan=lifespan,
)

cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Accept", "X-Store-Id"],
)

app.include_router(v1_router, prefix="/api/v1")
register_exception_handlers(app)

# 确保上传目录存在
uploads_path = Path(settings.upload_dir)
uploads_path.mkdir(parents=True, exist_ok=True)
(uploads_path / "logos").mkdir(exist_ok=True)
(uploads_path / "qrcodes").mkdir(exist_ok=True)
(uploads_path / "posters").mkdir(exist_ok=True)
(uploads_path / "references").mkdir(exist_ok=True)

# 挂载上传目录静态文件访问
# P0 阶段：限制只能访问图片扩展名，防止恶意文件被执行
from starlette.middleware.base import BaseHTTPMiddleware

class UploadSecurityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        path = request.url.path
        if path.startswith("/uploads/"):
            # 只允许图片扩展名
            allowed_exts = {".jpg", ".jpeg", ".png", ".webp"}
            if not any(path.lower().endswith(ext) for ext in allowed_exts):
                from starlette.responses import Response
                return Response(status_code=403, content="Forbidden")
        return await call_next(request)

app.add_middleware(UploadSecurityMiddleware)
app.mount("/uploads", StaticFiles(directory=str(uploads_path)), name="uploads")
