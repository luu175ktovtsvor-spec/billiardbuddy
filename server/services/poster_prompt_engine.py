# -*- coding: utf-8 -*-
"""海报提示词扩写引擎。

职责：把老板的大白话海报需求，扩写成可直接交给图像模型(gpt-image-2)出图的结构化提示词。
设计要点：
- 这是 AI 海报生成里的**内部步骤、不计用户配额**——照 memory_service.py 直连 DeepSeek、JSON 模式的做法。
- 画面描述走英文（出图更稳），但要画在海报上的中文文字一律原样保留、不翻译。
- 解析失败/异常**绝不抛到调用方**：降级返回 {"image_prompt": description, "needs": []}。
"""
import json
import logging

import httpx
from openai import AsyncOpenAI

from config import settings

logger = logging.getLogger(__name__)


_client: AsyncOpenAI | None = None


def _get_client() -> AsyncOpenAI:
    global _client
    if _client is None:
        _client = AsyncOpenAI(
            base_url=settings.deepseek_base_url,
            api_key=settings.deepseek_api_key,
            timeout=httpx.Timeout(60.0, connect=10.0),
        )
    return _client


_EXPAND_SYS = """你是台球房营销海报的"提示词扩写师"。把老板的大白话需求，扩写成一段可直接交给图像模型(gpt-image-2)出图的提示词。只输出 JSON。

【输入是大白话】用户多半是文化水平不高的台球房老板/店员，输入往往很短、很糙、很口语（如"搞个抢一海报 一天两场 冠军500"）。你要读懂他真正想要的、自己把画面补全——细节是你的活，绝不指望他给。

【image_prompt 的写法】
1. 画面描述用英文（场景/主体/构图/光线/风格——英文出图更稳）。
2. 但要画在海报上的中文文字，一律用中文原样保留，不许翻译、不许改动一个字；在英文里点明 render this exact Chinese text and keep every character correct。
3. 结构按顺序：海报用途 → 场景/背景 → 主体 → 关键细节 → 构图与文字排版（标题最大、活动信息其次、联系方式最小，元素对齐、留足边距）→ 光线/色彩/情绪 → 风格 → 约束。
4. 这是台球房（中式八球/斯诺克/球房环境）的营销海报，画面必须贴合这个行业。
5. 把用户提供的"要写的字"（标题/活动信息/联系方式）合理安排进画面，文字清晰、排版整齐。
6. 若提供了 Logo，在提示词里说明"把提供的 Logo 自然、清晰地融入画面合适位置"；若提供了二维码，说明"把提供的二维码清晰完整地放在角落，保证可扫描"。
7. 若是"门店照优化"模式，按"在提供的门店实拍照基础上优化：改善光线、统一色调、清理杂物、营造高级感，但保持门店原貌可辨认"来写，而不是从零生成新场景。

【画面：给信息，别替模型把画面框死（重要）】
- gpt-image-2 自己就知道台球房长什么样、各种节日/活动是什么氛围——**相信它的识别力和抽象力，别硬塞一长串家具/装修清单去框死它**（不用写"绿呢台+橙沙发+灰地毯"那种细节堆砌）。
- 也别用空话套话（"霓虹电竞风""高级质感""大气磅礴"），那等于没说。
- 你的活：把"用途/场合 + 要写的字 + 排版 + 约束"给清楚给到位；画面的具体长相交给模型发挥，让它出一张真实可信、不像通用模板的台球房海报。

【约束（写进 image_prompt 结尾）】
- 不编造用户没给的价格/时间/奖金/电话/地址等任何信息。
- 画面专业、健康、不擦边、不夸大不实承诺。
- 不出现任何第三方品牌/机构/出处名（台球器材品类俗称如乔氏/星牌/中八等行业通用叫法可以出现）。

【needs】
列出"这类海报观众通常必须看到、但用户这次没提供"的关键信息（例：招聘缺联系方式/待遇；赛事缺时间/报名方式；充值活动缺优惠内容）。用户给全了就返回空数组 []。绝不替用户编造这些信息，只列缺口。

【严格输出格式】
{"image_prompt": "<英文画面描述，内嵌要渲染的中文原文与 constraints>", "needs": ["<缺失信息1>", "..."]}"""


_BACKGROUND_MODE_DESC = {
    "ai_generate": "AI生成全新场景",
    "store_photo": "在用户上传的门店照上优化",
}


def _build_user_message(
    description: str,
    poster_text: dict | None,
    background_mode: str,
    has_logo: bool,
    has_qr: bool,
    ratio: str,
    store_context: str,
) -> str:
    if poster_text:
        poster_text_str = json.dumps(poster_text, ensure_ascii=False)
    else:
        poster_text_str = "（未提供，可拟一个简短标题，但不要编造价格/时间/联系方式）"

    bg_desc = _BACKGROUND_MODE_DESC.get(background_mode, background_mode)
    store_block = store_context.strip() if store_context and store_context.strip() else "（未提供）"

    return (
        "【老板的大白话需求】\n"
        f"{description}\n\n"
        "【要写在海报上的字（结构化）】\n"
        f"{poster_text_str}\n\n"
        "【背景模式】\n"
        f"{bg_desc}\n\n"
        "【是否提供 Logo】\n"
        f"{'是' if has_logo else '否'}\n\n"
        "【是否提供二维码】\n"
        f"{'是' if has_qr else '否'}\n\n"
        "【画面比例】\n"
        f"{ratio}\n\n"
        "【门店品牌/背景】\n"
        f"{store_block}"
    )


def _fallback(description: str) -> dict:
    return {"image_prompt": description, "needs": []}


async def expand_poster_prompt(
    description: str,
    poster_text: dict | None = None,
    background_mode: str = "ai_generate",
    has_logo: bool = False,
    has_qr: bool = False,
    ratio: str = "3:4",
    store_context: str = "",
) -> dict:
    """把大白话海报需求扩写成可直接出图的结构化提示词。

    返回 {"image_prompt": str, "needs": list[str]}。
    调 DeepSeek JSON 模式扩写；解析失败或异常时降级返回
    {"image_prompt": description, "needs": []}（绝不抛到调用方）。
    """
    user_msg = _build_user_message(
        description, poster_text, background_mode, has_logo, has_qr, ratio, store_context
    )
    try:
        resp = await _get_client().chat.completions.create(
            model=settings.text_model_name,
            messages=[
                {"role": "system", "content": _EXPAND_SYS},
                {"role": "user", "content": user_msg},
            ],
            response_format={"type": "json_object"},
            temperature=0.4,
            max_tokens=900,
        )
        raw = resp.choices[0].message.content or ""
        data = json.loads(raw)
    except Exception:
        logger.warning("poster_prompt_engine 扩写失败，降级返回原始描述", exc_info=True)
        return _fallback(description)

    image_prompt = data.get("image_prompt")
    if not isinstance(image_prompt, str) or not image_prompt.strip():
        logger.warning("poster_prompt_engine 返回缺少有效 image_prompt，降级")
        return _fallback(description)

    raw_needs = data.get("needs") or []
    needs: list[str] = []
    if isinstance(raw_needs, list):
        for item in raw_needs:
            s = str(item).strip()
            if s:
                needs.append(s)

    return {"image_prompt": image_prompt, "needs": needs}
