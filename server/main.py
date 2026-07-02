import asyncio
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

        # 僵尸任务恢复：上次是被强杀/崩溃退出的，media_jobs 里可能还留着 queued/running 的任务——
        # 但跑它的那个 asyncio 任务早随进程没了，永远不会再推进，前端会对着一个空转的任务一直转圈。
        # 桌面单进程重启＝上一轮生命周期彻底结束，直接把这些残留任务标失败，用户能看到原因、重新发起。
        # 只在 SQLite(桌面单进程)下做：云端多 worker 场景下"我这个进程刚起"不代表全局没人在跑这个任务。
        try:
            from sqlalchemy import update as _upd
            from db.session import async_session as _async_session
            from models.media_job import MediaJob
            async with _async_session() as _jdb:
                await _jdb.execute(
                    _upd(MediaJob)
                    .where(MediaJob.status.in_(("queued", "running")))
                    .values(status="error", error="应用重启，任务已中断，请重新发起")
                )
                await _jdb.commit()
        except Exception:
            logger.exception("僵尸任务恢复失败（已忽略，不阻塞启动）")

    # 启动时打印知识库加载情况：桌面打包版据此确认加密块(prompts.enc)解密成功（模板数应=171），
    # 而非静默回退到明文 prompts/（打包里已删明文 → 回退会是 0，立刻能看出护城河失效）。
    from services.ai.prompt_engine import prewarm_prompt_engine
    _pe = await prewarm_prompt_engine()
    _src = "加密块(prompts.enc)" if __import__("os").environ.get("PROMPTS_PACK_KEY") else "明文YAML"
    logger.info("知识库已加载：%d 模板（来源：%s）", len(_pe._templates), _src)

    # 主动出击·进程内每日定时（opt-in：配了 DESKTOP_DAILY_DRAFTS_HOUR 才启；桌面 SQLite 才有意义）。
    # 到点自动把"今日草稿"预生成缓存好，老板打开就秒出。守红线：只产草稿、绝不自动发布。
    from services import daily_scheduler
    sched_stop = asyncio.Event()
    sched_task = None
    if engine.dialect.name == "sqlite" and daily_scheduler.target_hour() is not None:
        sched_task = asyncio.create_task(daily_scheduler.scheduler_loop(sched_stop))

    # 配置驱动 Hooks（settings.json 的 command 钩子）：自门控 DESKTOP_CONFIG_HOOKS=1 才装，测试零干扰。
    try:
        from services.agent.hooks_config import install_config_hooks
        _nh = install_config_hooks()
        if _nh:
            logger.info("已装配置驱动 Hooks：%d 个事件钩子", _nh)
    except Exception:
        logger.debug("装配置 Hooks 失败（忽略）", exc_info=True)

    # 定时提醒（Cron-lite）：进程内 loop 每 30s 检查到点提醒、弹系统通知。桌面专属。
    rem_task = None
    if __import__("os").environ.get("DESKTOP_LOCAL") == "1":
        try:
            from services.agent.reminders import reminders_loop
            rem_task = asyncio.create_task(reminders_loop(sched_stop))
        except Exception:
            logger.debug("启动提醒 loop 失败（忽略）", exc_info=True)

    # IM 适配 · Telegram：长轮询 bot（配了 TELEGRAM_BOT_TOKEN 才起）。
    im_task = None
    if __import__("os").environ.get("TELEGRAM_BOT_TOKEN"):
        try:
            from services.agent.im_telegram import telegram_loop
            im_task = asyncio.create_task(telegram_loop(sched_stop))
            logger.info("Telegram IM 适配已启动")
        except Exception:
            logger.debug("启动 Telegram loop 失败（忽略）", exc_info=True)

    yield

    sched_stop.set()
    for _t in (sched_task, rem_task, im_task):
        if _t is not None:
            try:
                await asyncio.wait_for(_t, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
                _t.cancel()
    logger.info("服务关闭，清理数据库连接...")
    await engine.dispose()


app = FastAPI(
    title="球房 AI 运营助手",
    description="面向台球房行业的本地 AI 运营助手（单用户·纯 BYOK）",
    version="0.1.0",
    lifespan=lifespan,
)

cors_origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
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
            # 只允许图片 + 视频/音频扩展名(防可执行文件;视频/音频不会被执行,剪辑台成片要能播)
            allowed_exts = {
                ".jpg", ".jpeg", ".png", ".webp",
                ".mp4", ".mov", ".webm", ".m4v", ".m4a", ".mp3", ".aac", ".srt",
            }
            if not any(path.lower().endswith(ext) for ext in allowed_exts):
                from starlette.responses import Response
                return Response(status_code=403, content="Forbidden")
        return await call_next(request)

app.add_middleware(UploadSecurityMiddleware)
app.mount("/uploads", StaticFiles(directory=str(uploads_path)), name="uploads")
