import logging
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from models.generation import Generation
from models.store import Store
from services.poster.composer import overlay_images

logger = logging.getLogger(__name__)

UPLOADS_DIR = Path(settings.upload_dir)
POSTERS_DIR = UPLOADS_DIR / "posters"

# 图片比例 → 阿里云/OpenAI size 参数映射
SIZE_MAP = {
    "3:4": {"aliyun": "1024*1440", "openai": "1024x1365"},
    "1:1": {"aliyun": "1024*1024", "openai": "1024x1024"},
    "9:16": {"aliyun": "1024*1820", "openai": "1024x1820"},
    "16:9": {"aliyun": "1820*1024", "openai": "1820x1024"},
}

# 场景灵感标签（纯提示文本，点击后填入输入框）
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


def _model_to_provider(model_id: str) -> str:
    """根据 model_id 判断属于哪个 provider。"""
    from services.ai.providers.aliyun_image import ALIYUN_IMAGE_MODELS
    from services.ai.providers.openai_image import OPENAI_IMAGE_MODELS

    if model_id in ALIYUN_IMAGE_MODELS:
        return "aliyun"
    if model_id in OPENAI_IMAGE_MODELS:
        return "openai"
    raise ValueError(f"未知的图片模型: {model_id}")


def _build_image_prompt(
    user_prompt: str,
    store: Store,
    reference_style: str | None = None,
    provider: str = "aliyun",
    add_store_info: bool = True,
    no_text: bool = True,
) -> str:
    """构建 AI 生图 prompt。

    用户描述 + 门店上下文（可选）+ 参考图风格 + 无文字指令（可选）。
    """
    parts = []

    # 用户核心描述
    parts.append(user_prompt)

    # 门店上下文（可选，用户可能想画非球房内容）
    if add_store_info:
        if store.name:
            parts.append(f"门店名称：{store.name}")
        if store.city:
            parts.append(f"城市：{store.city}")

    # 参考图风格描述
    if reference_style:
        parts.append(f"参考风格：{reference_style}")

    # 无文字指令（可选，用户可能想要带文字的图）
    if no_text:
        if provider == "aliyun":
            parts.append("无文字，无文字内容，no text")
        else:
            parts.append("no text, no words, no letters, no typography")

    return ", ".join(parts)


def _get_api_size(ratio: str, provider: str) -> str:
    """根据比例和 provider 获取 API size 参数。"""
    sizes = SIZE_MAP.get(ratio, SIZE_MAP["3:4"])
    return sizes.get(provider, sizes["aliyun"])


async def _analyze_reference_image(image_path: Path) -> str | None:
    """用视觉模型分析参考图，提取风格描述。"""
    try:
        from services.ai.factory import ProviderFactory

        # 用阿里云 qwen-vl-max 作为视觉理解模型
        api_key = settings.dashscope_api_key or settings.bailian_api_key
        if not api_key:
            return None

        import dashscope
        dashscope.api_key = api_key

        from dashscope import MultiModalConversation

        with open(image_path, "rb") as f:
            image_data = f.read()

        import base64
        image_b64 = base64.b64encode(image_data).decode("utf-8")

        messages = [
            {
                "role": "user",
                "content": [
                    {"image": f"data:image/png;base64,{image_b64}"},
                    {"text": "请用2-3句话描述这张图片的视觉风格：包括配色、氛围、设计风格。只描述风格，不描述具体内容。"},
                ],
            }
        ]

        resp = MultiModalConversation.call(
            model="qwen-vl-max",
            messages=messages,
        )

        if resp.status_code == 200:
            style_desc = resp.output.choices[0].message.content[0]["text"]
            logger.info("参考图风格识别: %s", style_desc[:100])
            return style_desc
        else:
            logger.warning("参考图风格识别失败: %s %s", resp.code, resp.message)
            return None

    except Exception:
        logger.warning("参考图风格识别异常", exc_info=True)
        return None


async def generate_images(
    db: AsyncSession,
    store: Store,
    user_id: uuid.UUID,
    prompt: str,
    image_model: str,
    ratio: str = "3:4",
    reference_image_paths: list[str] | None = None,
    count: int = 2,
    refine_from: str | None = None,
    add_store_info: bool = True,
    no_text: bool = True,
    add_overlay: bool = True,
) -> dict:
    """AI 生图并叠加门店 Logo 和二维码，返回多张结果。

    Parameters
    ----------
    prompt : str
        用户描述的文字。
    image_model : str
        AI 生图模型 ID。
    ratio : str
        图片比例 (3:4 / 1:1 / 9:16 / 16:9)。
    reference_image_paths : list[str] | None
        参考图本地路径列表（已上传保存的文件路径）。
    count : int
        生成数量，默认 2。
    """
    from services.ai.factory import ProviderFactory

    provider_name = _model_to_provider(image_model)

    if provider_name == "aliyun":
        api_key = settings.dashscope_api_key or settings.bailian_api_key
    else:
        api_key = settings.openai_api_key

    if not api_key:
        raise ValueError(f"Provider {provider_name} 的 API Key 未配置")

    provider = ProviderFactory.get_image_provider(provider_name, api_key=api_key)

    # 参考图风格识别
    reference_style = None
    from models.generation import Generation
    from sqlalchemy import select
    if refine_from:
        # 基于已生成图片进行调整：找到原图作为参考
        result = await db.execute(
            select(Generation).where(Generation.id == uuid.UUID(refine_from))
        )
        original = result.scalar_one_or_none()
        if original and original.result:
            original_path = Path(settings.upload_dir) / original.result.lstrip("/uploads/")
            if original_path.exists():
                reference_style = await _analyze_reference_image(original_path)
                logger.info("基于原图调整: %s", original_path)
    elif reference_image_paths:
        # 多张参考图：逐一分析，合并风格描述
        allowed_dir = Path(settings.upload_dir).resolve() / "references"
        styles = []
        for ref_str in reference_image_paths:
            ref_path = Path(ref_str).resolve()
            if not str(ref_path).startswith(str(allowed_dir)):
                raise ValueError("reference_image_path 必须在 uploads/references/ 目录内")
            style = await _analyze_reference_image(ref_path)
            if style:
                styles.append(style)
        if styles:
            reference_style = "；".join(styles)

    # 构建 prompt
    full_prompt = _build_image_prompt(prompt, store, reference_style, provider_name, add_store_info, no_text)
    size = _get_api_size(ratio, provider_name)

    logger.info("AI 生图: provider=%s, model=%s, ratio=%s, count=%d, prompt=%s",
                provider_name, image_model, ratio, count, full_prompt[:80])

    # 生成多张图
    POSTERS_DIR.mkdir(parents=True, exist_ok=True)
    results = []
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    sid = str(store.id).replace("-", "")[:8]

    for i in range(count):
        rand = uuid.uuid4().hex[:4]
        filename = f"ai_{sid}_{ts}_{rand}.png"
        output_path = POSTERS_DIR / filename

        try:
            image_bytes = await provider.generate_image(
                prompt=full_prompt,
                model=image_model,
                size=size,
            )

            # 加载 AI 生成的图片
            import io
            ai_img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")

            # 叠加 Logo 和二维码（可选）
            if add_overlay:
                final_img = overlay_images(
                    base_image=ai_img,
                    logo_path=store.logo_url,
                    qrcode_path=store.qrcode_url,
                    upload_dir=UPLOADS_DIR,
                )
            else:
                final_img = ai_img

            # 保存
            final_img.save(output_path, "PNG")

            poster_url = f"/uploads/posters/{filename}"
            created_at = datetime.now(timezone.utc)

            # 写入 generations 表
            generation = Generation(
                store_id=store.id,
                user_id=user_id,
                type="poster",
                sub_type=ratio,
                input_params={
                    "prompt": prompt,
                    "image_model": image_model,
                    "ratio": ratio,
                    "reference_images": reference_image_paths,
                },
                prompt_used=full_prompt,
                result=poster_url,
                model_used=f"ai:{image_model}",
                tokens_used=0,
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

    # 过滤掉失败的
    valid_results = [r for r in results if r is not None]

    if not valid_results:
        raise RuntimeError("全部图片生成失败，请检查模型配置或稍后重试")

    return {
        "images": valid_results,
        "model_used": f"ai:{image_model}",
        "count": len(valid_results),
    }


def get_inspiration_tags() -> list[dict]:
    """返回场景灵感标签列表。"""
    return INSPIRATION_TAGS


def get_size_options() -> list[dict]:
    """返回可选的图片比例列表。"""
    return [
        {"value": "3:4", "label": "3:4 竖版海报", "desc": "朋友圈/群，最常用"},
        {"value": "1:1", "label": "1:1 方形", "desc": "小红书/抖音图文"},
        {"value": "9:16", "label": "9:16 手机全屏", "desc": "短视频封面/抖音竖屏"},
        {"value": "16:9", "label": "16:9 横版", "desc": "公众号封面/视频封面"},
    ]