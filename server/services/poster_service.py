import asyncio
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
from services.quota_service import check_poster_quota, increment_poster_usage

logger = logging.getLogger(__name__)

UPLOADS_DIR = Path(settings.upload_dir)
POSTERS_DIR = UPLOADS_DIR / "posters"

# 全局生图并发闸：限制本进程同时调用 OpenAI 生图的数量，避免突发把 Tier1 的 IPM(每分钟图片数)打满触发 429。
# 超出上限的请求在此排队等待（生图本身就要 5-10 分钟，排队可接受），而不是立刻失败。
# 注：asyncio.Semaphore 是进程内的——生产 2 worker 各持一个，实际全局并发≈2×本值；这是刻意取舍：
# 429 是"被拒绝"不扣钱，不值得为精确全局限流上 Redis。真正烧钱的是"超时+重试"，那条已由超时拉满+max_retries=0 堵死。
_image_semaphore: asyncio.Semaphore | None = None


def _get_image_semaphore() -> asyncio.Semaphore:
    """懒加载生图信号量（首次调用时按配置创建，绑定到当前事件循环）。"""
    global _image_semaphore
    if _image_semaphore is None:
        _image_semaphore = asyncio.Semaphore(settings.poster_max_concurrency)
    return _image_semaphore

# 图片比例 → 尺寸参数（宽高必须能被 16 整除）
# gpt-image-2 支持任意分辨率：单边≤3840，总像素 655360~8294400，宽高为16的倍数
# 每个尺寸都精确等于声称的比例，且宽高均为 16 的倍数（见 tests/test_poster_sizing.py）。
# 旧版 3:4 与 9:16 都误填 1024x1536(实为2:3)、16:9 误填 1536x1024(实为3:2)——选不同比例出同一张图。
SIZE_MAP = {
    "3:4": "1152x1536",   # 0.75
    "1:1": "1024x1024",   # 1.0
    "9:16": "1152x2048",  # 0.5625
    "16:9": "2048x1152",  # 1.7778
}


def _get_api_size(ratio: str) -> str:
    return SIZE_MAP.get(ratio, SIZE_MAP["3:4"])


# API 单次请求最多接受的输入图片数
_MAX_INPUT_IMAGES = 16


def _load_upload_bytes(path_str: str | None) -> bytes | None:
    """从 uploads 目录内安全加载图片字节；空/越界/不存在一律返回 None。"""
    if not path_str or ".." in path_str:
        return None
    upload_dir = Path(settings.upload_dir)
    rel = path_str.removeprefix("/uploads/")
    p = upload_dir / rel
    try:
        if not p.resolve().is_relative_to(upload_dir.resolve()):
            return None
    except (OSError, ValueError):
        return None
    return p.read_bytes() if p.exists() else None


def _format_poster_text(poster_text: dict | None) -> str:
    """把结构化「要写的字」(标题/多行信息/联系方式)拼成给模型的渲染指令，中文逐字保留。
    未走扩写直接出图时用它确保文字进入提示词——扩写路径已由引擎把文字编进 image_prompt，故不在那条路重复。"""
    if not isinstance(poster_text, dict):
        return ""
    parts: list[str] = []
    title = str(poster_text.get("title") or "").strip()
    if title:
        parts.append(f"标题「{title}」")
    lines = poster_text.get("lines") or []
    if isinstance(lines, (list, tuple)):
        body_lines = [str(x).strip() for x in lines if str(x).strip()]
        if body_lines:
            parts.append("、".join(body_lines))
    contact = str(poster_text.get("contact") or "").strip()
    if contact:
        parts.append(f"联系方式「{contact}」")
    if not parts:
        return ""
    return "在画面醒目位置原样渲染以下中文文字（一字不差、清晰可读、排版整齐）：" + "；".join(parts) + "。"


def build_poster_prompt(
    prompt: str,
    history_prompts: list[str],
    has_base_image: bool,
    ref_count: int,
    add_store_info: bool = False,
    store_name: str = "",
    city: str = "",
    no_text: bool = False,
    has_logo: bool = False,
    has_qr: bool = False,
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

    if has_logo:
        parts.append("one of the input images is the store logo — integrate it cleanly into the design without distorting it")
    if has_qr:
        parts.append("one of the input images is a QR code — place it clearly in a corner, do not stylize or recolor it, reproduce it as-is in high contrast so it stays scannable")

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
    image_prompt: str | None = None,
    poster_text: dict | None = None,
    background_mode: str = "ai_generate",
    store_photo_path: str | None = None,
    logo_path: str | None = None,
    qr_path: str | None = None,
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
    await check_poster_quota(db, str(store.id))

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

    # 门店照优化：上传的门店实拍照作为底图（与 refine_from 互斥，refine_from 优先）
    if base_image is None and background_mode == "store_photo" and store_photo_path:
        sp = _load_upload_bytes(store_photo_path)
        if sp is not None:
            base_image = sp
            logger.info("门店照优化底图: %s", store_photo_path)

    # 品牌资产：手动上传的 Logo / 二维码（all-GPT 直接作为输入图交模型渲染）
    logo_bytes = _load_upload_bytes(logo_path)
    qr_bytes = _load_upload_bytes(qr_path)

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

    # 输入图顺序：要保真的排前面（底图→二维码→Logo），风格参考随后（官方：靠前输入图保真更强）。
    # 二维码紧跟底图——它最需要原样复现才能扫得出，享受前排更强的保真。
    preserve_imgs: list[bytes] = []
    if base_image:
        preserve_imgs.append(base_image)
    if qr_bytes:
        preserve_imgs.append(qr_bytes)
    if logo_bytes:
        preserve_imgs.append(logo_bytes)
    max_refs = max(0, _MAX_INPUT_IMAGES - len(preserve_imgs))
    ref_bytes = ref_bytes[:max_refs]
    input_images: list[bytes] = preserve_imgs + ref_bytes

    # ── 4. 组装 prompt（核心用扩写后的 image_prompt，无则用原文；含图片角色声明）──
    core_prompt = image_prompt if (image_prompt and image_prompt.strip()) else prompt
    # 没走扩写时，结构化「要写的字」不在 core_prompt 里——显式拼上，确保 GPT 渲染。
    # （扩写路径已把文字编进 image_prompt，故只在未扩写时补、不会重复。）
    if not (image_prompt and image_prompt.strip()):
        _pt = _format_poster_text(poster_text)
        if _pt:
            core_prompt = f"{core_prompt}。{_pt}" if core_prompt and core_prompt.strip() else _pt
    full_prompt = build_poster_prompt(
        prompt=core_prompt,
        history_prompts=history_prompts,
        has_base_image=base_image is not None,
        ref_count=len(ref_bytes),
        add_store_info=add_store_info,
        store_name=store.name or "",
        city=store.city or "",
        no_text=no_text,
        has_logo=logo_bytes is not None,
        has_qr=qr_bytes is not None,
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
            # 经全局并发闸：超出 poster_max_concurrency 的请求在此排队，护住 OpenAI 每分钟出图限额(IPM)
            async with _get_image_semaphore():
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
                    # ── 生图重构：结构化保存，为"回退到 Pillow 合成"预留（不动数据模型）──
                    "image_prompt": image_prompt,
                    "poster_text": poster_text,
                    "background_mode": background_mode,
                    "store_photo_path": store_photo_path,
                    "logo_path": logo_path,
                    "qr_path": qr_path,
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

    # 按实际成功生成的张数计入海报额度（独立池，不挤占文案次数）
    await increment_poster_usage(db, str(store.id), count=len(valid_results))

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


def get_size_options() -> list[dict]:
    return [
        {"value": "3:4", "label": "3:4 竖版海报", "desc": "朋友圈/群，最常用"},
        {"value": "1:1", "label": "1:1 方形", "desc": "小红书/抖音图文"},
        {"value": "9:16", "label": "9:16 手机全屏", "desc": "短视频封面/抖音竖屏"},
        {"value": "16:9", "label": "16:9 横版", "desc": "公众号封面/视频封面"},
    ]


# 「看看能做成什么样」示例：idea_text 可一键"参考思路"填进描述框；image_url 待补成品图
SHOWCASE_EXAMPLES = [
    {"idea_text": "周五晚上抢一大战，图上写「报名费10元、赢家拿奖金」，要热血电竞风", "image_url": None},
    {"idea_text": "中式八球周赛报名海报，写「每周五19点开赛，群里接龙报名」，专业赛场感", "image_url": None},
    {"idea_text": "充值送活动，写「充500送100，仅限本周」，高端金色质感", "image_url": None},
    {"idea_text": "助教招聘，写「底薪+高提成、日结、免费培训、微信XXX」，年轻有活力", "image_url": None},
    {"idea_text": "世界杯决赛看球夜，写「今晚8点大屏看球，啤酒小吃管够」，热闹氛围", "image_url": None},
    {"idea_text": "用我们店的实拍照做一张春节活动海报，喜庆红金、灯笼氛围", "image_url": None},
]


def get_showcase_examples() -> list[dict]:
    return SHOWCASE_EXAMPLES
