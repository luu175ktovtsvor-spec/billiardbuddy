import io
import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from core.exceptions import AIServiceError
from core.security_guard import check_input_injection
from models.generation import Generation
from models.store import Store
from services.quota_service import check_quota, increment_usage

logger = logging.getLogger(__name__)

UPLOADS_DIR = Path(settings.upload_dir)
POSTERS_DIR = UPLOADS_DIR / "posters"

# 图片比例 → 尺寸参数（宽高必须能被 16 整除）
# gpt-image-2 支持任意分辨率：单边≤3840，总像素 655360~8294400，宽高为16的倍数
SIZE_MAP = {
    "3:4": "1024x1536",
    "1:1": "1024x1024",
    "9:16": "1024x1536",
    "16:9": "1536x1024",
}

# 场景灵感标签（按分类组织）
INSPIRATION_TAGS = [
    # 赛事类
    {"key": "tournament", "label": "赛事海报", "category": "赛事类", "prompt": "中式八球周赛海报，竞技氛围，专业赛场感，深色背景"},
    {"key": "qiangyi", "label": "抢一大战", "category": "赛事类", "prompt": "台球抢一大战海报，紧张刺激，对抗感，霓虹灯风格"},
    {"key": "champion", "label": "冠军战报", "category": "赛事类", "prompt": "台球比赛冠军战报海报，热血竞技感，聚光灯效果"},
    # 社交媒体
    {"key": "moments", "label": "朋友圈配图", "category": "社交媒体", "prompt": "台球房下午场空台促活朋友圈配图，清新休闲风格"},
    {"key": "short_video", "label": "短视频封面", "category": "社交媒体", "prompt": "台球短视频封面，视觉冲击力强，动态模糊效果"},
    {"key": "store_brand", "label": "门店形象", "category": "社交媒体", "prompt": "台球房门店形象宣传图，专业品质感，现代简约"},
    # 营销推广
    {"key": "opening", "label": "开业活动", "category": "营销推广", "prompt": "台球房开业活动海报，盛大喜庆，红色金色配色"},
    {"key": "holiday", "label": "节日主题", "category": "营销推广", "prompt": "台球房节日主题活动海报，喜庆氛围"},
    {"key": "recharge", "label": "充值活动", "category": "营销推广", "prompt": "台球房会员充值活动海报，高端质感，金色元素"},
    {"key": "watch_party", "label": "看球活动", "category": "营销推广", "prompt": "台球房看球活动海报，大屏幕观赛，啤酒零食氛围"},
    # 助教相关
    {"key": "assistant", "label": "助教形象", "category": "助教相关", "prompt": "台球助教专业形象照，台球陪练服务，专业台球人设"},
    {"key": "coach", "label": "教练推广", "category": "助教相关", "prompt": "台球教练教学推广海报，专业教学感，指导动作"},
    {"key": "recruitment", "label": "招聘海报", "category": "助教相关", "prompt": "台球助教招聘海报，便签笔记风格，温馨有吸引力"},
    # 其他
    {"key": "partner", "label": "搭子群", "category": "其他", "prompt": "台球搭子群招募图文，轻松活泼风格，社交感"},
    {"key": "free", "label": "自由创作", "category": "其他", "prompt": "画一只猫在打台球"},
]


def _get_api_size(ratio: str) -> str:
    return SIZE_MAP.get(ratio, SIZE_MAP["3:4"])


# API 单次请求最多接受的输入图片数
_MAX_INPUT_IMAGES = 16


def build_poster_prompt(
    prompt: str,
    history_prompts: list[str],
    has_base_image: bool,
    ref_count: int,
    add_store_info: bool = False,
    store_name: str = "",
    city: str = "",
    no_text: bool = False,
) -> str:
    """组装生图 prompt（纯函数，便于测试）。

    多图时必须声明图片角色——模型分不清"哪张是要改的底图、哪些只是风格参考"，
    不声明会把参考图的内容直接抄进结果。
    """
    parts = [prompt]
    if add_store_info:
        if store_name:
            parts.append(f"门店名称：{store_name}")
        if city:
            parts.append(f"城市：{city}")
    if no_text:
        parts.append("no text, no words, no letters, no typography")

    if has_base_image and ref_count > 0:
        parts.append(
            "The first input image is the base image to modify; "
            "the remaining input images are style references only, do not copy their content"
        )
        parts.append("keep the overall composition and style of the base image unchanged, only modify what the user requested")
    elif has_base_image:
        parts.append("keep the overall composition and style unchanged, only modify what the user requested")
    elif ref_count > 0:
        parts.append("use the input images as style and mood references")

    current = ", ".join(parts)
    if history_prompts:
        lines = "\n".join(f"{i}. {p}" for i, p in enumerate(history_prompts, 1))
        return f"之前的设计要求：\n{lines}\n当前要求：{current}"
    return current


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
    conversation_id: str | None = None,
    quality: str = "auto",
) -> dict:
    """AI 生图，支持多轮调整（底图）与参考图（风格）同时传入。

    图片角色模型：
    - 底图（refine_from 指向的上一张生成图）= "在这张上改"，永远排第一张
    - 参考图（用户上传）= "照这个感觉来"，对话级有效，由前端每轮全量传入
    两者不互斥——修复旧版 elif 导致调整模式下新参考图被静默丢弃的问题。
    """
    from services.ai.providers.openai_image import OpenAIImageProvider

    api_key = settings.openai_api_key
    if not api_key:
        raise ValueError("OpenAI API Key 未配置")

    # ── 1. 全部校验前置：非法参数必须在调用生图 API（真金白银）之前拦下 ──
    conv_uuid: uuid.UUID | None = None
    if conversation_id:
        try:
            conv_uuid = uuid.UUID(conversation_id)
        except ValueError:
            raise AIServiceError("对话不存在或已失效，请新建对话")

    original: Generation | None = None
    if refine_from:
        try:
            refine_uuid = uuid.UUID(refine_from)
        except ValueError:
            raise AIServiceError("要调整的图片不存在")
        result = await db.execute(
            select(Generation).where(
                Generation.id == refine_uuid,
                Generation.store_id == store.id,
                Generation.type == "poster",
                Generation.is_deleted == False,
            )
        )
        original = result.scalar_one_or_none()
        if not original or not original.result:
            raise AIServiceError("要调整的图片不存在")

    injection_check = check_input_injection(prompt)
    if injection_check:
        raise AIServiceError(injection_check)
    await check_quota(db, str(store.id))

    # ── 2. 多轮对话：收集历史设计要求（最近 5 轮）──
    history_prompts: list[str] = []
    if conv_uuid:
        try:
            hist_stmt = (
                select(Generation)
                .where(
                    Generation.conversation_id == conv_uuid,
                    Generation.type == "poster",
                    Generation.is_deleted == False,
                )
                .order_by(Generation.created_at)
            )
            hist_result = await db.execute(hist_stmt)
            history_gens = hist_result.scalars().all()
            for hg in history_gens[-5:]:
                hist_prompt = hg.input_params.get("prompt", "") if hg.input_params else ""
                if hist_prompt:
                    history_prompts.append(hist_prompt)
            if history_prompts:
                logger.info("拼接对话上下文: %d 轮历史", len(history_prompts))
        except Exception:
            logger.warning("加载对话历史失败，跳过上下文拼接", exc_info=True)

    # ── 3. 组装输入图片：底图排第一，参考图随后（API 上限 16 张）──
    base_image: bytes | None = None
    if original and original.result:
        original_path = Path(settings.upload_dir) / original.result.removeprefix("/uploads/")
        if original_path.exists():
            base_image = original_path.read_bytes()
            logger.info("基于原图调整: %s", original_path)

    ref_bytes: list[bytes] = []
    if reference_image_paths:
        upload_dir = Path(settings.upload_dir)
        for ref_str in reference_image_paths:
            # 前端传的是 /uploads/references/xxx.jpg，去掉 /uploads/ 前缀得到相对路径
            if ".." in ref_str:
                raise ValueError("reference_image_path 必须在 uploads/ 目录内")
            rel = ref_str.removeprefix("/uploads/")
            ref_path = upload_dir / rel
            if not ref_path.resolve().is_relative_to(upload_dir.resolve()):
                raise ValueError("reference_image_path 必须在 uploads/ 目录内")
            if ref_path.exists():
                ref_bytes.append(ref_path.read_bytes())

    max_refs = _MAX_INPUT_IMAGES - (1 if base_image else 0)
    ref_bytes = ref_bytes[:max_refs]
    input_images: list[bytes] = ([base_image] if base_image else []) + ref_bytes

    # ── 4. 组装 prompt（含图片角色声明）──
    full_prompt = build_poster_prompt(
        prompt=prompt,
        history_prompts=history_prompts,
        has_base_image=base_image is not None,
        ref_count=len(ref_bytes),
        add_store_info=add_store_info,
        store_name=store.name or "",
        city=store.city or "",
        no_text=no_text,
    )

    size = _get_api_size(ratio)
    logger.info("AI 生图: ratio=%s, count=%d, base=%s, refs=%d, conversation=%s",
                ratio, count, bool(base_image), len(ref_bytes), bool(conv_uuid))

    # 使用 Images API 生成
    provider = OpenAIImageProvider(api_key=api_key, base_url=settings.openai_base_url)

    # 生成 conversation_id（如果是新对话；旧对话沿用已校验的 conv_uuid）
    conv_id = str(conv_uuid) if conv_uuid else str(uuid.uuid4())

    POSTERS_DIR.mkdir(parents=True, exist_ok=True)
    results = []

    for i in range(count):
        rand = uuid.uuid4().hex[:4]
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        sid = str(store.id).replace("-", "")[:8]
        filename = f"ai_{sid}_{ts}_{rand}.png"
        output_path = POSTERS_DIR / filename

        try:
            image_bytes = await provider.generate_image(
                prompt=full_prompt,
                model="gpt-image-2",
                size=size,
                quality=quality,
                image=input_images if input_images else None,
            )

            # 保存图片（JPEG 格式，减小文件体积）
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            output_path_jpg = output_path.with_suffix(".jpg")
            img.save(output_path_jpg, "JPEG", quality=90)

            poster_url = f"/uploads/posters/{output_path_jpg.name}"
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
                    "refine_from": refine_from,
                },
                prompt_used=full_prompt,
                result=poster_url,
                model_used="ai:gpt-image-2",
                tokens_used=0,
                conversation_id=uuid.UUID(conv_id),
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
        # AIServiceError 而非 RuntimeError：后者落到通用兜底处理器变成无差别 500，
        # 这句友好提示到不了用户
        raise AIServiceError("图片生成失败，请稍后重试")

    # 按实际成功生成的张数计入配额（每张图都是一次计费生成）
    await increment_usage(db, str(store.id), tokens=0, count=len(valid_results))

    return {
        "images": valid_results,
        "model_used": "ai:gpt-image-2",
        "count": len(valid_results),
        "conversation_id": conv_id,
    }


async def get_conversations(
    db: AsyncSession,
    store_id: uuid.UUID,
    limit: int = 10,
) -> list[dict]:
    """获取对话列表（按 conversation_id 分组）。"""
    stmt = (
        select(Generation)
        .where(Generation.store_id == store_id, Generation.type == "poster", Generation.is_deleted == False)
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
            Generation.is_deleted == False,
        )
        .order_by(Generation.created_at)
    )
    result = await db.execute(stmt)
    gens = result.scalars().all()

    if not gens:
        return None

    messages = []
    for gen in gens:
        params = gen.input_params or {}
        messages.append({
            "generation_id": gen.id,
            "poster_url": gen.result,
            "created_at": gen.created_at,
            "prompt": params.get("prompt", ""),
            "reference_images": params.get("reference_images") or [],
            "refine_from": params.get("refine_from"),
            "ratio": params.get("ratio"),
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
