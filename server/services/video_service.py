"""AI 文生视频 / 图生视频服务（火山方舟 Seedance，原生异步）。

与 poster_service(生图) 对称：取配置 → 建 provider → 提交+轮询 → 下载落盘 → 落库 generations(type=video) → 返回本地 url。
首帧图（图生视频）：支持本应用产出的 /uploads 图片（转 base64 data-uri）或公网 url；
本机路径限定在 uploads 沙箱内（挡住"借首帧把任意本地文件塞给外部 API"）。
"""
import asyncio
import base64
import logging
import mimetypes
import uuid
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.exceptions import AIServiceError
from models.generation import Generation
from services.ai.factory import ProviderFactory
from services.ai.providers.ark_video import ArkVideoProvider, fetch_video_bytes

logger = logging.getLogger(__name__)

UPLOADS_DIR = Path(settings.upload_dir)
VIDEOS_DIR = UPLOADS_DIR / "videos"


def _resolve_first_frame(first_frame: str | None, allow_paths: set[str] | None = None) -> str | None:
    """把工具传入的首帧图（字符串）解析成可直接塞进 image_url 的值：
    - http(s) 公网 url → 原样（火山方舟服务端自行拉取）；
    - 本应用产出的 /uploads/... 路径，或老板当场选定的图片绝对路径 → 读 bytes 转 base64 data-uri
      （本机 url 火山方舟拉不到，必须内联）。
    安全：本机路径只允许落在 uploads 沙箱内 **或** 在 allow_paths（老板本轮显式选定的文件）里，
    挡住"模型借首帧参数把任意本地文件 base64 后塞给外部 API"。"""
    if not first_frame:
        return None
    s = str(first_frame).strip()
    if not s:
        return None
    if s.startswith("http://") or s.startswith("https://"):
        return s

    base = UPLOADS_DIR.resolve()
    allow = {str(Path(p).resolve()) for p in (allow_paths or set())}

    # /uploads/... 或 uploads/... 是【对外 url 路径】(以 / 开头但不是本地绝对路径) → 拼到 UPLOADS_DIR；
    # 其余以 / 开头的当真·本地绝对路径(老板选定的图)；相对路径兜底也按 uploads 相对解析。
    rel, stripped = s, False
    for pre in ("/uploads/", "uploads/"):
        if rel.startswith(pre):
            rel, stripped = rel[len(pre):], True
            break
    if stripped:
        p = (UPLOADS_DIR / rel).resolve()
    elif Path(s).is_absolute():
        p = Path(s).resolve()
    else:
        p = (UPLOADS_DIR / s).resolve()

    in_uploads = str(p) == str(base) or str(p).startswith(str(base) + "/")
    if not (in_uploads or str(p) in allow):
        raise AIServiceError("首帧图片只能用本应用生成的图片（uploads 目录内）或你当场选定的图片")
    if not p.exists():
        raise AIServiceError(f"首帧图片找不到：{first_frame}")

    data = p.read_bytes()
    mime = mimetypes.guess_type(str(p))[0] or "image/jpeg"
    b64 = base64.b64encode(data).decode()
    return f"data:{mime};base64,{b64}"


async def generate_video(
    *,
    db: AsyncSession,
    store,
    user_id,
    prompt: str,
    ratio: str = "9:16",   # 默认竖屏：视频是发社交媒体账号的营销内容(抖音/视频号/快手/小红书/朋友圈)，不是店内大屏
    resolution: str | None = None,   # Seedance 2.0 用 ratio+duration 控画幅、不收 resolution；给了才发(兼容 1.x)
    duration: int = 5,
    first_frame: str | None = None,
    allow_paths: set[str] | None = None,
    conversation_id=None,
) -> dict:
    """生成一段视频并落盘+落库，返回 {"video_url"(本地 /uploads/videos/..), "generation_id", "conversation_id"}。"""
    api_key, base_url, model = ProviderFactory.get_video_config_for_store(store)
    if not api_key:
        raise AIServiceError("还没配置视频模型 Key（内置 key 未注入），请检查安装或在「模型设置」里填写")

    first_frame_url = _resolve_first_frame(first_frame, allow_paths)
    provider = ArkVideoProvider(api_key=api_key, base_url=base_url)

    logger.info("AI 生视频: ratio=%s, res=%s, dur=%s, i2v=%s, model=%s",
                ratio, resolution, duration, bool(first_frame_url), model)

    # 提交 + 轮询（耗时 1-8 分钟；超时由 settings.video_timeout 兜底）
    video_url = await provider.generate_video(
        prompt=prompt, model=model or settings.video_model_name,
        ratio=ratio, resolution=resolution, duration=int(duration or 5),
        first_frame_url=first_frame_url,
    )
    # 即时下载落盘（远端 url 短期有效）
    video_bytes = await fetch_video_bytes(video_url)

    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    rand = uuid.uuid4().hex[:4]
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    sid = str(store.id).replace("-", "")[:8]
    filename = f"ai_{sid}_{ts}_{rand}.mp4"
    output_path = VIDEOS_DIR / filename
    await asyncio.to_thread(output_path.write_bytes, video_bytes)

    local_url = f"/uploads/videos/{filename}"
    conv_id = str(conversation_id) if conversation_id else str(uuid.uuid4())
    generation = Generation(
        store_id=store.id,
        user_id=user_id,
        type="video",
        sub_type=ratio,
        input_params={
            "prompt": prompt, "ratio": ratio, "resolution": resolution,
            "duration": duration, "first_frame": first_frame,
            "image_to_video": bool(first_frame_url),
        },
        prompt_used=prompt,
        result=local_url,
        model_used=f"ai:{model or settings.video_model_name}",
        tokens_used=0,
        conversation_id=uuid.UUID(conv_id),
    )
    db.add(generation)
    await db.flush()
    await db.commit()

    logger.info("AI 生视频完成: %s", local_url)
    return {"video_url": local_url, "generation_id": generation.id, "conversation_id": conv_id}
