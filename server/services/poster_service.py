import io
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models.generation import Generation
from models.store import Store

logger = logging.getLogger(__name__)

UPLOADS_DIR = Path(settings.upload_dir)
POSTERS_DIR = UPLOADS_DIR / "posters"

# 图片比例 → 尺寸参数
SIZE_MAP = {
    "3:4": "1024x1536",
    "1:1": "1024x1024",
    "9:16": "1024x1820",
    "16:9": "1820x1024",
}

# 场景灵感标签
INSPIRATION_TAGS = [
    {"key": "tournament", "label": "赛事海报", "prompt": "中式八球周赛海报，竞技氛围，专业赛场感，深色背景"},
    {"key": "qiangyi", "label": "抢一大战", "prompt": "台球抢一大战海报，紧张刺激，对抗感，霓虹灯风格"},
    {"key": "assistant", "label": "助教形象", "prompt": "台球助教专业形象照，台球陪练服务，专业台球人设"},
    {"key": "moments", "label": "朋友圈配图", "prompt": "台球房下午场空台促活朋友圈配图，清新休闲风格"},
    {"key": "recruitment", "label": "招聘海报", "prompt": "台球助教招聘海报，便签笔记风格，温馨有吸引力"},
    {"key": "short_video", "label": "短视频封面", "prompt": "台球短视频封面，视觉冲击力强，动态模糊效果"},
    {"key": "opening", "label": "开业活动", "prompt": "台球房开业活动海报，盛大喜庆，红色金色配色"},
    {"key": "holiday", "label": "节日主题", "prompt": "台球房节日主题活动海报，喜庆氛围"},
    {"key": "champion", "label": "冠军战报", "prompt": "台球比赛冠军战报海报，热血竞技感，聚光灯效果"},
    {"key": "store_brand", "label": "门店形象", "prompt": "台球房门店形象宣传图，专业品质感，现代简约"},
    {"key": "partner", "label": "搭子群", "prompt": "台球搭子群招募图文，轻松活泼风格，社交感"},
    {"key": "coach", "label": "教练推广", "prompt": "台球教练教学推广海报，专业教学感，指导动作"},
    {"key": "recharge", "label": "充值活动", "prompt": "台球房会员充值活动海报，高端质感，金色元素"},
    {"key": "watch_party", "label": "看球活动", "prompt": "台球房看球活动海报，大屏幕观赛，啤酒零食氛围"},
    {"key": "free", "label": "自由创作", "prompt": "画一只猫在打台球"},
]


def _get_api_size(ratio: str) -> str:
    return SIZE_MAP.get(ratio, SIZE_MAP["3:4"])


async def generate_images(
    db: AsyncSession,
    store: Store,
    user_id: uuid.UUID,
    prompt: str,
    image_model: str,
    ratio: str = "3:4",
    reference_image_paths: list[str] | None = None,
    count: int = 1,
    refine_from: str | None = None,
    add_store_info: bool = False,
    no_text: bool = False,
    add_logo_overlay: bool = True,
    add_qrcode_overlay: bool = True,
    conversation_id: str | None = None,
    previous_response_id: str | None = None,
) -> dict:
    """AI 生图，支持 Responses API 多轮对话。

    当 previous_response_id 存在时使用 Responses API（多轮）。
    否则使用 Images API（首次生成）。
    """
    from services.ai.providers.openai_response_image import OpenAIResponseImageProvider

    api_key = settings.openai_api_key
    if not api_key:
        raise ValueError("OpenAI API Key 未配置")

    # 构建 prompt
    parts = [prompt]
    if add_store_info:
        if store.name:
            parts.append(f"门店名称：{store.name}")
        if store.city:
            parts.append(f"城市：{store.city}")
    if no_text:
        parts.append("no text, no words, no letters, no typography")
    full_prompt = ", ".join(parts)

    # 加载 Logo bytes（作为 input_image 传给 AI）
    input_images: list[bytes] = []
    if add_logo_overlay and store.logo_url:
        logo_path = Path(settings.upload_dir) / store.logo_url.lstrip("/uploads/")
        if logo_path.exists():
            input_images.append(logo_path.read_bytes())
    if add_qrcode_overlay and store.qrcode_url:
        qr_path = Path(settings.upload_dir) / store.qrcode_url.lstrip("/uploads/")
        if qr_path.exists():
            input_images.append(qr_path.read_bytes())

    size = _get_api_size(ratio)

    # 如果是调整模式，加载原图作为参考
    if refine_from:
        result = await db.execute(
            select(Generation).where(Generation.id == uuid.UUID(refine_from))
        )
        original = result.scalar_one_or_none()
        if original and original.result:
            original_path = Path(settings.upload_dir) / original.result.lstrip("/uploads/")
            if original_path.exists():
                input_images.insert(0, original_path.read_bytes())
                logger.info("基于原图调整: %s", original_path)
    elif reference_image_paths:
        allowed_dir = Path(settings.upload_dir).resolve() / "references"
        for ref_str in reference_image_paths:
            ref_path = Path(ref_str).resolve()
            if not str(ref_path).startswith(str(allowed_dir)):
                raise ValueError("reference_image_path 必须在 uploads/references/ 目录内")
            if ref_path.exists():
                input_images.append(ref_path.read_bytes())

    logger.info("AI 生图: ratio=%s, count=%d, has_ref=%s, conversation=%s, has_logo=%s",
                ratio, count, bool(input_images), bool(conversation_id), bool(input_images))

    # 使用 Responses API 生成
    provider = OpenAIResponseImageProvider(api_key=api_key, base_url=settings.openai_base_url)

    # 生成 conversation_id（如果是新对话）
    conv_id = conversation_id or str(uuid.uuid4())

    POSTERS_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    last_response_id = previous_response_id

    for i in range(count):
        rand = uuid.uuid4().hex[:4]
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        sid = str(store.id).replace("-", "")[:8]
        filename = f"ai_{sid}_{ts}_{rand}.png"
        output_path = POSTERS_DIR / filename

        try:
            image_bytes, response_id = await provider.generate(
                prompt=full_prompt,
                previous_response_id=last_response_id,
                input_images=input_images if input_images else None,
            )
            last_response_id = response_id

            # 保存图片
            img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
            img.save(output_path, "PNG")

            poster_url = f"/uploads/posters/{filename}"
            created_at = datetime.now(timezone.utc)

            generation = Generation(
                store_id=store.id,
                user_id=user_id,
                type="poster",
                sub_type=ratio,
                input_params={
                    "prompt": prompt,
                    "ratio": ratio,
                    "reference_images": reference_image_paths,
                },
                prompt_used=full_prompt,
                result=poster_url,
                model_used="ai:gpt-image-2",
                tokens_used=0,
                conversation_id=uuid.UUID(conv_id),
                openai_response_id=response_id,
            )
            db.add(generation)
            await db.flush()

            results.append({
                "generation_id": generation.id,
                "poster_url": poster_url,
                "created_at": created_at,
            })

            logger.info("AI 生图完成: %s", poster_url)

        except Exception:
            logger.warning("第 %d 张生成失败", i + 1, exc_info=True)
            results.append(None)

    await db.commit()

    valid_results = [r for r in results if r is not None]

    if not valid_results:
        raise RuntimeError("全部图片生成失败，请检查模型配置或稍后重试")

    return {
        "images": valid_results,
        "model_used": "ai:gpt-image-2",
        "count": len(valid_results),
        "conversation_id": conv_id,
        "response_id": last_response_id,
    }


async def get_conversations(
    db: AsyncSession,
    store_id: uuid.UUID,
    limit: int = 10,
) -> list[dict]:
    """获取对话列表（按 conversation_id 分组）。"""
    stmt = (
        select(Generation)
        .where(Generation.store_id == store_id, Generation.type == "poster")
        .where(Generation.conversation_id.isnot(None))
        .order_by(Generation.created_at.desc())
    )
    result = await db.execute(stmt)
    generations = result.scalars().all()

    # 按 conversation_id 分组
    conv_map: dict[str, list[Generation]] = {}
    for gen in generations:
        cid = str(gen.conversation_id)
        if cid not in conv_map:
            conv_map[cid] = []
        conv_map[cid].append(gen)

    conversations = []
    for cid, gens in list(conv_map.items())[:limit]:
        gens_sorted = sorted(gens, key=lambda g: g.created_at)
        conversations.append({
            "id": cid,
            "title": gens_sorted[0].input_params.get("prompt", "海报生成") if gens_sorted[0].input_params else "海报生成",
            "message_count": len(gens_sorted),
            "thumbnail_url": gens_sorted[-1].result,
            "created_at": gens_sorted[0].created_at,
            "updated_at": gens_sorted[-1].created_at,
        })

    return conversations


async def get_conversation_detail(
    db: AsyncSession,
    store_id: uuid.UUID,
    conversation_id: str,
) -> dict | None:
    """获取对话详情（所有 generation 记录）。"""
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.type == "poster",
            Generation.conversation_id == uuid.UUID(conversation_id),
        )
        .order_by(Generation.created_at)
    )
    result = await db.execute(stmt)
    gens = result.scalars().all()

    if not gens:
        return None

    messages = []
    for gen in gens:
        messages.append({
            "generation_id": gen.id,
            "poster_url": gen.result,
            "created_at": gen.created_at,
            "prompt": gen.input_params.get("prompt", "") if gen.input_params else "",
        })

    return {
        "id": conversation_id,
        "title": gens[0].input_params.get("prompt", "海报生成") if gens[0].input_params else "海报生成",
        "created_at": gens[0].created_at,
        "updated_at": gens[-1].created_at,
        "messages": messages,
    }


def get_inspiration_tags() -> list[dict]:
    return INSPIRATION_TAGS


def get_size_options() -> list[dict]:
    return [
        {"value": "3:4", "label": "3:4 竖版海报", "desc": "朋友圈/群，最常用"},
        {"value": "1:1", "label": "1:1 方形", "desc": "小红书/抖音图文"},
        {"value": "9:16", "label": "9:16 手机全屏", "desc": "短视频封面/抖音竖屏"},
        {"value": "16:9", "label": "16:9 横版", "desc": "公众号封面/视频封面"},
    ]
