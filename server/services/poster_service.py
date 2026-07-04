import asyncio
import io
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageStat
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
#
# E2-1b・"2:5"(易拉宝竖长条)/"5:2"(横幅宽版)是 Seedream 专属挡(gpt-image-2 出不了这么极端的
# 长宽比的海报场景，见 _SEEDREAM_ONLY_RATIOS + generate_images 里的强制路由)。尺寸查证 seedream_image.py
# 真机实测的像素下限 _SEEDREAM_MIN_PIXELS=3,686,400——1216x3040(=3,696,640px)刚好压线越过下限，
# 且两边都是 16 的倍数、比例精确等于 0.4/2.5，喂进 _normalize_seedream_size 时 px 已达标不会被
# 二次缩放拉伸变形（会原样透传，见 test_poster_sizing.py 的验证）。
SIZE_MAP = {
    "3:4": "1152x1536",   # 0.75
    "1:1": "1024x1024",   # 1.0
    "9:16": "1152x2048",  # 0.5625
    "16:9": "2048x1152",  # 1.7778
    "2:5": "1216x3040",   # 0.4    易拉宝竖长条(Seedream 专属)
    "5:2": "3040x1216",   # 2.5    横幅宽版(Seedream 专属)
}

# 这两挡只有 Seedream 能出（gpt-image-2 走极端长宽比不可靠，见模块顶部说明）——
# generate_images 里据此在算完路由后强制切回 Seedream，不管内容启发式/改图路由/调用方显式选了什么。
_SEEDREAM_ONLY_RATIOS = {"2:5", "5:2"}


def _get_api_size(ratio: str) -> str:
    return SIZE_MAP.get(ratio, SIZE_MAP["3:4"])


def _ratio_value(ratio: str) -> float:
    try:
        w, h = ratio.split(":", 1)
        return int(w) / int(h)
    except Exception:
        return 3 / 4


def _read_image_dimensions(path: Path) -> tuple[int, int]:
    with Image.open(path) as img:
        return img.size


def _assert_saved_ratio(path: Path, ratio: str) -> tuple[int, int]:
    """读取落盘图片真实宽高，确保 provider/保存链路没有悄悄改比例。

    `ratio if ratio in SIZE_MAP else "3:4"` 是安全网：只有 SIZE_MAP 里登记过的比例才信任它自己的
    期望值，没登记的一律按 3:4 校验（E2-1b 前 "2:5"/"5:2" 没进 SIZE_MAP 时就是靠这条兜底防止
    "标 2:5 实出 3:4"却被错误判定通过——现在两者都已登记，走各自真实比例，不再落这个兜底分支）。
    0.02 绝对容差对新增的极端比例(0.4/2.5)同样够用：Seedream 若因内部取整产生 ±16px 级别的
    像素偏差，换算到比例误差远小于 0.02（验证见 tests/test_poster_sizing.py）。
    """
    width, height = _read_image_dimensions(path)
    expected = _ratio_value(ratio if ratio in SIZE_MAP else "3:4")
    actual = width / height
    if abs(actual - expected) > 0.02:
        raise AIServiceError(
            f"图片比例校验失败：需要 {ratio}，实际 {width}x{height}（{actual:.3f}）"
        )
    return width, height


# API 单次请求最多接受的输入图片数
_MAX_INPUT_IMAGES = 16


def _save_png_as_jpeg(image_bytes: bytes, output_path_jpg) -> None:
    """同步：把模型返回的 PNG 解码并以 JPEG 落盘。CPU 密集，由调用方经 to_thread 调用，
    避免在生图回写阶段阻塞事件循环（拖慢同 worker 的其他请求/SSE）。"""
    Image.open(io.BytesIO(image_bytes)).convert("RGB").save(output_path_jpg, "JPEG", quality=90)


def _overlay_logo(image_bytes: bytes, logo_bytes: bytes) -> bytes:
    """把门店真实 logo 像素级贴到海报右上角（不经模型→店名文字不糊）。logo 缩到海报宽 ~16%、留边距、保留透明通道。
    解决"模型复刻 logo 把店名画成乱码"。任何异常安全返回原图（贴不上不该让整张图失败）。"""
    try:
        poster = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
        logo = Image.open(io.BytesIO(logo_bytes)).convert("RGBA")
        target_w = max(1, int(poster.width * 0.16))
        logo = logo.resize((target_w, max(1, int(logo.height * target_w / logo.width))), Image.LANCZOS)
        margin = int(poster.width * 0.04)
        poster.alpha_composite(logo, (poster.width - logo.width - margin, margin))
        out = io.BytesIO()
        poster.convert("RGB").save(out, "PNG")
        return out.getvalue()
    except Exception:
        logger.warning("logo 合成失败，返回原图", exc_info=True)
        return image_bytes


def _overlay_print_qr(image_bytes: bytes, qr_bytes: bytes) -> bytes:
    """U5(E3d)・owner §3-4 窄例外：仅"印刷/关键投放"场景(调用方显式传 print_mode=True)才会被调用——
    默认路径完全不碰这里(见 generate_images 的 print_mode 参数，默认 False，行为不变)。

    从用户给的二维码图片里用 OpenCV(已是项目依赖，scenedetect[opencv] 带来)解码出真实编码内容，
    再用 qrcode 库重新生成一张像素级精确、机器保证能扫的二维码，贴到成图右下角(白底留白/quiet zone，
    避免贴在深色背景上扫不出)。任何一步失败(源图解码不出/不是合法二维码)→ 安全返回原图，
    不让整张海报因为这步失败。

    这是全新独立函数，绝不是 _overlay_logo——_overlay_logo 依旧是死代码，本函数不调用它、不复活它
    (test_overlay_logo_still_dead_code 只守 `_overlay_logo(` 不出现在 generate_images 源码里，
    与本函数无关)。
    """
    try:
        import cv2
        import numpy as np
        import qrcode

        arr = np.frombuffer(qr_bytes, dtype=np.uint8)
        cv_img = cv2.imdecode(arr, cv2.IMREAD_GRAYSCALE)
        if cv_img is None:
            logger.warning("印刷二维码源图解码失败(不是合法图片)，跳过叠层")
            return image_bytes
        content, _points, _ = cv2.QRCodeDetector().detectAndDecode(cv_img)
        if not content:
            logger.warning("印刷二维码识别不出编码内容(源图可能不是二维码)，跳过叠层")
            return image_bytes

        poster = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
        qr_img = qrcode.make(content).convert("RGBA")
        target_w = max(1, int(poster.width * 0.18))  # 印刷用二维码要比风格 logo 更大、更好扫
        qr_img = qr_img.resize((target_w, target_w), Image.LANCZOS)  # 二维码天然正方形
        pad = max(4, int(target_w * 0.08))  # 白底留白(quiet zone)：即使贴在深色背景上也能识别边界
        canvas = Image.new("RGBA", (target_w + pad * 2, target_w + pad * 2), (255, 255, 255, 255))
        canvas.paste(qr_img, (pad, pad))
        margin = int(poster.width * 0.04)
        poster.alpha_composite(
            canvas, (poster.width - canvas.width - margin, poster.height - canvas.height - margin)
        )
        out = io.BytesIO()
        poster.convert("RGB").save(out, "PNG")
        return out.getvalue()
    except Exception:
        logger.warning("印刷二维码叠层失败，返回原图", exc_info=True)
        return image_bytes


def _apply_print_qr_overlay(output_path_jpg: Path, qr_bytes: bytes) -> None:
    """同步：读已落盘的成图 jpg → 贴印刷级真二维码 → 覆写回同一路径。由调用方经 to_thread 调用
    (图像编解码是 CPU 密集操作，不能在事件循环里同步跑)。"""
    current = output_path_jpg.read_bytes()
    overlaid_png = _overlay_print_qr(current, qr_bytes)
    _save_png_as_jpeg(overlaid_png, output_path_jpg)


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


# ────────────────────────────── 安全护栏：logo/qr/底图/参考图/mask 路径校验 ──────────────────────────────
# 这几个参数(logo_path/qr_path/store_photo_path/reference_image_paths/mask_path)桌面版下经【Agent 工具
# 调用】传入——而工具的入参是【模型自己填的】，不能假设它一定落在 uploads 沙箱或老板真选过的文件里。
# 旧实现在 DESKTOP_LOCAL 下对"沙箱外的绝对路径"来者不拒(Path(path).read_bytes())，等于让模型/prompt注入
# 拿这几个参数当"读任意本机文件并把内容发给外部生图 API"的后门。对齐 video_service._resolve_first_frame
# 的 allow_paths 校验模式：沙箱外的绝对路径必须 ∈ 老板当场经 OS 文件选择器选定的 allowed_paths(含选中
# 目录内的文件)，否则视为越界——抛人话错误而不是静默略过(静默会把"读到了别的敏感文件"悄悄含糊过去)。

def _resolve_allowed_paths(allowed_paths) -> set[Path]:
    """把调用方给的 allowed_paths（老板当场选定的文件/目录绝对路径）解析成一组 resolved Path，
    坏路径丢弃、故障安全。空/None → 空集合（=沙箱外绝对路径一律拒绝，安全默认）。"""
    out: set[Path] = set()
    for raw in (allowed_paths or []):
        try:
            out.add(Path(raw).resolve())
        except (OSError, ValueError):
            continue
    return out


def _is_path_allowed(resolved: Path, allowed: set[Path]) -> bool:
    for a in allowed:
        if resolved == a or a in resolved.parents:
            return True
    return False


def _resolve_agent_selected_bytes(path_str: str | None, allowed: set[Path], kind: str) -> bytes | None:
    """读一张【可能来自 Agent 工具模型入参】的图片：先试 uploads 沙箱（_load_upload_bytes，云端/桌面通用）；
    沙箱外的绝对路径只在 DESKTOP_LOCAL 且该路径 ∈ allowed（老板当场选定的文件/目录）时才读，
    越界抛 AIServiceError 人话错误（不是静默忽略——防止一个"看着正常"实为别的敏感文件的路径蒙混过关）。
    云端 web 版沙箱外一律不读（没有"老板当场选定本机文件"这个概念）。"""
    if not path_str:
        return None
    b = _load_upload_bytes(path_str)
    if b is not None:
        return b
    if os.environ.get("DESKTOP_LOCAL") != "1":
        return None  # 云端沙箱外静默跳过，与旧行为一致（未越权也未收紧）
    try:
        resolved = Path(path_str).resolve()
    except (OSError, ValueError):
        raise AIServiceError(f"{kind}路径无效，没法读取：{path_str}")
    if not _is_path_allowed(resolved, allowed):
        raise AIServiceError(f"{kind}不在你当场选定的文件范围内，出于安全没有读取：{path_str}")
    if not resolved.is_file():
        return None
    return resolved.read_bytes()


def _format_poster_text(poster_text: dict | None) -> str:
    """把结构化「要写的字」(标题/日期/价格/多行信息/联系方式)拼成给模型的渲染指令，中文逐字保留。
    未走扩写直接出图时用它确保文字进入提示词——扩写路径已由引擎把文字编进 image_prompt，故不在那条路重复。"""
    if not isinstance(poster_text, dict):
        return ""
    parts: list[str] = []
    title = str(poster_text.get("title") or "").strip()
    if title:
        parts.append(f"标题「{title}」")
    date = str(poster_text.get("date") or "").strip()
    if date:
        parts.append(f"日期/时间「{date}」")
    price = str(poster_text.get("price") or "").strip()
    if price:
        parts.append(f"价格「{price}」")
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


# ────────────────── U1・硬要素结构化收集 + 扩写统一校验层 ──────────────────
# owner 2026-07-04 铁律：所有元素全让大模型发挥，我们只提供物料，不做任何程序叠层——
# 精确文字进 prompt 让模型自己画；logo/二维码原图进 input_images 融合（现状，不动）。
# 下面这套"程序补回"是【纯文本层面】把丢失的硬文字要素拼回 prompt 字符串里，最终这段文字仍是
# 交给模型自己画的——不是 PIL/像素级图片合成，不违反上面这条铁律（_overlay_logo 那类图片叠层
# 依旧是死代码，本单未复活、未调用）。

# 硬文字要素：店名/标题、日期/时间、价格、联系方式——海报上要一字不差出现的"硬信息"，不能瞎编。
HARD_ELEMENT_LABELS: dict[str, str] = {
    "title": "店名/标题",
    "date": "日期/时间",
    "price": "价格",
    "contact": "联系方式(电话/微信等)",
}


def collect_hard_text_values(poster_text: dict | None) -> dict[str, str]:
    """从结构化 poster_text 里提取【非空】的硬文字要素值，供扩写后 string-match 校验使用。"""
    if not isinstance(poster_text, dict):
        return {}
    out: dict[str, str] = {}
    for field in HARD_ELEMENT_LABELS:
        text = str(poster_text.get(field) or "").strip()
        if text:
            out[field] = text
    return out


def detect_missing_hard_elements(poster_text: dict | None) -> list[str]:
    """"缺就问用户不猜"：给定结构化 poster_text，返回其中【调用方已声明要用但没填值】的硬要素字段名。

    判定规则：字段名要作为 key 出现在 poster_text 里(哪怕值是 None/空串)才算"这次海报打算用这个要素"——
    没提过的字段不算缺失（不是每张海报都要日期/价格）。这里从不编造缺失值本身，只把"缺哪个"这个信号
    报给上层：ReAct 对话路径据此在生成前先问老板（见 tools.py make_poster/generate_image）；
    studio 直连路径把它放进返回结果，供前端未来做"缺项提示"用（不阻断生成，见 generate_images）。
    """
    if not isinstance(poster_text, dict):
        return []
    missing = []
    for field in HARD_ELEMENT_LABELS:
        if field not in poster_text:
            continue  # 没声明要用这个要素，不算缺失
        text = str(poster_text.get(field) or "").strip()
        if not text:
            missing.append(field)
    return missing


def verify_hard_elements_preserved(text: str, hard_values: dict[str, str]) -> list[str]:
    """逐个 string-match 校验硬文字要素的值是否还在扩写后的文本里。返回丢失的字段名列表(空=一个不少)。"""
    body = text or ""
    return [field for field, val in hard_values.items() if val not in body]


def ensure_hard_elements_preserved(text: str, hard_values: dict[str, str]) -> str:
    """扩写后的文本层兜底校验：丢了哪个硬文字要素就原样拼回文本末尾（纯字符串拼接，
    不做任何图片程序叠层——这段文字最终仍是喂给模型自己画）。已包含则原样返回，不重复拼。"""
    missing = verify_hard_elements_preserved(text, hard_values)
    if not missing:
        return text
    labels = "；".join(f"{HARD_ELEMENT_LABELS.get(f, f)}「{hard_values[f]}」" for f in missing)
    body = (text or "").strip()
    return f"{body}。必须原样包含以下文字：{labels}" if body else labels


POSTER_EXPAND_SYSTEM_PROMPT = (
    "你是顶级的图片生成提示词优化师。把用户的大白话需求改写成一段【可直接喂给文生图模型、能出好图】的中文提示词。\n"
    "要求：\n"
    "- 只丰富场景/构图/光影/风格/氛围/质感这些视觉细节，不改变用户的核心意图；\n"
    "- 硬文字要素(店名/电话/价格/日期/地址等)必须原样保留、放在引号里逐字抄一遍，一个字都不能改、不能省、不能意译；\n"
    "- 绝不杜撰用户没提供的价格、电话、地址、日期等具体信息；\n"
    "- 用中文输出一段连贯描述，不分点、不解释、不加除了引用硬文字要素外的任何引号或前后缀；\n"
    "- 守安全红线：不露骨色情、不涉及实际性交易、不赌博、保护未成年。\n"
    "只输出优化后的提示词本身。"
)


async def expand_poster_text_with_llm(
    provider,
    raw_prompt: str,
    poster_text: dict | None = None,
) -> str:
    """统一扩写层（studio `/expand` 用；系统提示对所有调用方写死同一套规则，见 POSTER_EXPAND_SYSTEM_PROMPT）。

    调文本模型把大白话(+结构化硬要素)改写成可直接喂给生图模型的提示词；扩写完代码 string-match
    校验硬文字要素是否一个不少：丢了就【程序补回】(纯文本拼接，非图片叠层——拼接后必然通过校验，
    无需重扩)；调用异常/空返回 → 直接用原始 prompt 发，不卡生成流程。
    """
    from services.ai.base import TextRequest

    raw = (raw_prompt or "").strip()
    hard_values = collect_hard_text_values(poster_text)
    hard_text = _format_poster_text(poster_text) if poster_text else ""
    llm_input = f"{raw}。{hard_text}" if (hard_text and hard_text not in raw) else raw
    if not llm_input:
        return raw_prompt

    async def _call() -> str:
        resp = await provider.generate(
            TextRequest(
                system_prompt=POSTER_EXPAND_SYSTEM_PROMPT,
                prompt=llm_input,
                max_tokens=600,
                thinking={"type": "disabled"},
            )
        )
        return (getattr(resp, "content", "") or "").strip()

    try:
        expanded = await _call()
    except Exception:
        logger.warning("扩写调用失败，直接用原始 prompt", exc_info=True)
        return raw_prompt
    if not expanded:
        return raw_prompt

    if not verify_hard_elements_preserved(expanded, hard_values):
        return expanded

    # 程序补回=纯字符串拼接（ensure_hard_elements_preserved 把丢失的硬要素值原样追加到文本末尾），
    # 补回后该值必然出现在文本里，string-match 校验必然通过——不存在"补不回"的情况，
    # 因此无需（也没有可达路径需要）再重扩一次。
    return ensure_hard_elements_preserved(expanded, hard_values)


# ────────────────── U2・自动路由 + 并行生成 + 失败降级(安全网) ──────────────────
# 下一批(E2)要砍掉前端的模型选择器——请求不再传 image_model 时会落到这里的默认值。
# ⚠️ 默认绝不能是 gpt-image-2：大陆客户机握到美国 relay 的长连接约 60s 会被网络掐断
# =图丢+白扣 owner 的 key 钱(2026-07-03 实测确证)。只有明显判断为"复杂创意/西文为主/
# 高保真人像改图"或调用方显式手选 GPT 时才路由 GPT，其余(含判断不出/内容空)一律默认落
# Seedream(火山方舟，大陆机房，又快又稳，中文精确文字/海报排版第一梯队)——这是上线级安全底座。

# 单一真相源：直接复用 seedream_image.py 的默认模型/base_url 常量，不再手写第二份字面量（防漂移）。
from services.ai.providers.seedream_image import (
    _DEFAULT_BASE as _ARK_BASE_URL,
    _DEFAULT_MODEL as _AUTO_ROUTE_SEEDREAM_MODEL,
)
_AUTO_ROUTE_GPT_MODEL = "gpt-image-2"

# 明显"复杂创意/高保真人像改图"的关键词——判据从简、可测，不做玄乎的 LLM 判断。
_COMPLEX_CREATIVE_KEYWORDS = (
    "写实人像", "高保真", "高保真度", "photorealistic", "photo-realistic",
    "high fidelity", "high-fidelity", "复杂创意", "艺术级", "电影感人像", "肖像重塑",
)


def _has_hard_chinese_text_requirement(text: str, poster_text: dict | None) -> bool:
    """判断这次生图是否有"中文精确文字/排版"的硬要求——这类交给 Seedream 更稳(中文渲染强项)。"""
    if collect_hard_text_values(poster_text):
        return True
    return any(kw in (text or "") for kw in ("写上", "写着", "中文文案排版", "标题文字要"))


def _is_western_dominant(text: str) -> bool:
    """粗略估计文本是否"西文为主"(中文字符占比很低)。空文本不算西文为主——
    没有信号时要安全落 Seedream，不能因为"判断不出"就滑向 GPT。"""
    s = (text or "").strip()
    if not s:
        return False
    cjk = sum(1 for ch in s if "一" <= ch <= "鿿")
    letters = sum(1 for ch in s if ch.isascii() and ch.isalpha())
    total = cjk + letters
    if total == 0:
        return False
    return cjk / total < 0.3


def _route_image_model(prompt: str | None, poster_text: dict | None, user_choice: str | None) -> str:
    """自动选生图模型：调用方显式手选(user_choice)一律尊重(向后兼容 studio 现有手选)；
    没手选时按内容启发式判断，默认落 Seedream。

    ⚠️ 默认必须落 Seedream——本单最重要的正确性要求(见模块顶部说明)，配单测钉死
    "不传 image_model → 不落 gpt-image-2"。只有明显复杂创意/西文为主/高保真人像改图才路由 GPT。
    """
    choice = (user_choice or "").strip()
    if choice:
        return choice
    text = prompt or ""
    if _has_hard_chinese_text_requirement(text, poster_text):
        return _AUTO_ROUTE_SEEDREAM_MODEL
    if any(kw in text for kw in _COMPLEX_CREATIVE_KEYWORDS):
        return _AUTO_ROUTE_GPT_MODEL
    if _is_western_dominant(text):
        return _AUTO_ROUTE_GPT_MODEL
    return _AUTO_ROUTE_SEEDREAM_MODEL


def _force_seedream_for_ratio(image_model: str | None, ratio: str) -> str | None:
    """E2-1b：ratio 落在 Seedream 专属挡(易拉宝 2:5/横幅 5:2)时，不管上面算出的路由结果是什么
    (内容启发式、改图路由 _route_edit_model、甚至调用方显式手选 gpt-image-2)，一律强制切回
    Seedream——gpt-image-2 对这种极端长宽比的海报场景没有把握(见模块顶部说明)，这两挡是
    Seedream 差异化能力，绝不能落 GPT。已经是 Seedream 的直接原样返回，不重复判断。"""
    if ratio in _SEEDREAM_ONLY_RATIOS and "seedream" not in (image_model or "").lower():
        return _AUTO_ROUTE_SEEDREAM_MODEL
    return image_model


# ────────────────── U5(E3d)・改图侧独立路由(不改上面 U2 的生成路由) ──────────────────
# 改图(refine_from 有值)按"这轮改的是文字还是内容"选模型：字错/改字 → Seedream(中文文字渲染强项，
# 官方文档确认 doubao-seedream-4.0/4.5/5.0 不支持 seed 但文字编辑能力是其强项，见 u5-report.md 查证)；
# 改内容 → GPT edits(input_fidelity=high，见 openai_image.py——gpt-image-2 恒高保真、该参数只在
# 非 gpt-image-2 的 GPT 模型上才会真正透传)。调用方可显式传 edit_type("text_fix"/"content")；
# 不传则从改图指令文本粗略判断，默认 content(大多数改图诉求是换背景/加减元素，不是文字问题)。
_EDIT_TEXT_FIX_KEYWORDS = (
    "错别字", "打错", "改错字", "字错了", "文字错", "别字", "重复字",
    "多了个字", "少了个字", "文字看不清", "文字模糊", "改文字", "改个字",
)


def _infer_edit_type(prompt: str | None) -> str:
    """没有显式 edit_type 时，从改图指令文本粗略判断是"改文字"还是"改内容"，默认 content。"""
    text = prompt or ""
    return "text_fix" if any(kw in text for kw in _EDIT_TEXT_FIX_KEYWORDS) else "content"


def _resolve_edit_type(prompt: str | None, edit_type: str | None) -> str:
    """统一算出这轮改图的类型：调用方显式传了 edit_type 就用它(去空白转小写)，没传则从
    prompt 文本推断——`_route_edit_model` 和 `generate_images` 都要这份判定结果，抽出来
    避免两处各写一遍同样的表达式(review 发现的重复，见 u5-report.md 修复记录)。"""
    return (edit_type or "").strip().lower() or _infer_edit_type(prompt)


def _route_edit_model(prompt: str | None, user_choice: str, edit_type: str | None) -> str:
    """改图专用路由：调用方显式选了模型(user_choice)一律尊重(与 U2 手选优先级一致)；
    否则按 edit_type(显式传入或从 prompt 推断)：text_fix→Seedream，content→GPT。"""
    if user_choice:
        return user_choice
    et = _resolve_edit_type(prompt, edit_type)
    return _AUTO_ROUTE_SEEDREAM_MODEL if et == "text_fix" else _AUTO_ROUTE_GPT_MODEL


def _build_seedream_fallback_provider():
    """GPT 失败降级安全网用：构造一个直连火山方舟 Seedream 的 provider。

    只有桌面盒子(DESKTOP_LOCAL=1)且配置了 ark_api_key 时才能造出来——造不出返回 None，
    调用方据此决定这次没法降级(如实报错，不装作有安全网)。"""
    import os
    if os.environ.get("DESKTOP_LOCAL") != "1" or not getattr(settings, "ark_api_key", ""):
        return None
    from services.ai.providers.seedream_image import SeedreamImageProvider
    return SeedreamImageProvider(api_key=settings.ark_api_key, base_url=_ARK_BASE_URL)


# ────────────────── U4・确定性预筛(零依赖) + RapidOCR 中文文字校验 + 抽风自动重出 ──────────────────
# owner 2026-07-04 真机实测拍板：Seedream 综合最好，唯一短板=中文精确文字偶发"抽风"(实测出过
# "充充"这种重复字、多画一行没要求的促销文案)。这里做两道零 token 的确定性质检：
# 1. 黑图/纯色/分辨率下限——只用 Pillow(已是硬依赖)算整图灰度均值/标准差，不引入 numpy/cv2，
#    阈值刻意保守("宁漏勿误杀")：只拦"明显生成失败"的占位图，不误杀正常深色系/简约风格海报。
# 2. RapidOCR 中文文字比对——只在 poster_text 声明了硬文字要素(店名/日期/价格/联系方式)时才查，
#    要求【一字不差包含】(零容忍模糊匹配)：这类字段本就要求分毫不差，模糊匹配会放过"关键数字
#    错一位"这种最不能接受的错误。装饰字/花体不在硬要素里，天然不会被拿来比对、不会被误杀。

# 分辨率下限：远低于 SIZE_MAP 最小边(1024)才拦，避免卡到任何真实输出尺寸。
_MIN_SCREEN_DIMENSION = 400
# 灰度均值低于此值(0-255)→ 判定"近全黑"：只有几乎纯黑的画面才会踩到，
# 深色主题但有文字/图形对比度的正常海报均值通常远高于这个数。
_BLACK_MEAN_THRESHOLD = 8.0
# 灰度标准差低于此值 → 判定"近纯色/空白图"：任何色调的真实海报只要有文字/图案就会有明显方差，
# 只有整张几乎单一颜色(渲染失败的占位图)才会踩到。
_SOLID_STD_THRESHOLD = 3.0


def _screen_generated_image(path: Path) -> tuple[bool, str]:
    """零依赖确定性预筛：黑图/纯色/分辨率下限。宁漏勿误杀——阈值刻意保守，只拦截"明显生成
    失败"(纯色占位图/近全黑帧/异常小分辨率)，不误杀正常的深色系/简约风格海报。
    返回 (ok, reason)：ok=False 时 reason 是给人看的中文原因；读图本身失败时故障安全放行(True)，
    不能因为预筛自己读图出错就连累一张可能完全正常的图被判废。"""
    try:
        with Image.open(path) as img:
            width, height = img.size
            if width < _MIN_SCREEN_DIMENSION or height < _MIN_SCREEN_DIMENSION:
                return False, f"分辨率异常偏低({width}x{height})"
            stat = ImageStat.Stat(img.convert("L"))
            mean = stat.mean[0]
            std = stat.stddev[0]
    except Exception:
        logger.warning("预筛读图失败，视为通过(宁漏勿误杀): %s", path, exc_info=True)
        return True, ""
    if std < _SOLID_STD_THRESHOLD:
        return False, "疑似纯色/空白图(没有实际内容)"
    if mean < _BLACK_MEAN_THRESHOLD:
        return False, "疑似近全黑图"
    return True, ""


_ocr_engine = None  # 懒加载单例：RapidOCR 初始化要读 onnx 模型，只在真用到时(有硬文字要素)才建


def _get_ocr_engine():
    """懒加载 RapidOCR 引擎单例（纯本地 onnx 推理，不联网，符合离线打包铁律）。"""
    global _ocr_engine
    if _ocr_engine is None:
        from rapidocr_onnxruntime import RapidOCR
        _ocr_engine = RapidOCR()
    return _ocr_engine


def _run_ocr_texts(path: Path) -> list[str]:
    """跑本地 RapidOCR，识别图片里的文字行。任何异常（含模型加载失败）安全返回空列表——
    OCR 本身故障不该拖垮生图，退化成"这次不校验文字"而不是硬失败。"""
    try:
        engine = _get_ocr_engine()
        result, _elapse = engine(str(path))
    except Exception:
        logger.warning("OCR 识别失败，跳过文字校验(宁漏勿误杀): %s", path, exc_info=True)
        return []
    if not result:
        return []
    return [str(item[1]).strip() for item in result if len(item) >= 2 and str(item[1]).strip()]


def _levenshtein(a: str, b: str) -> int:
    """标准编辑距离（无第三方依赖的最短实现），仅用于给"文字有出入 vs 完全找不到"分类描述用。"""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
        prev = cur
    return prev[-1]


def _find_best_edit_distance(value: str, full_text: str) -> int:
    """在整段 OCR 文本里滑窗找与 value 长度相近的子串，返回其中的最小编辑距离——
    只用来把"文字有出入(离得很近)"和"压根没有(离得很远)"分类成不同的人话提示，不参与判定本身
    (判定本身是零容忍的精确包含比对，见 detect_ocr_text_anomalies)。"""
    n = len(value)
    if n == 0:
        return 0
    if not full_text:
        return n
    best = _levenshtein(value, full_text)
    for wlen in range(max(1, n - 2), n + 3):
        for start in range(0, max(1, len(full_text) - wlen + 1)):
            window = full_text[start:start + wlen]
            d = _levenshtein(value, window)
            if d < best:
                best = d
                if best == 0:
                    return 0
    return best


def _has_clean_occurrence(value: str, full_text: str) -> bool:
    """在 full_text 里找 value 的"干净"出现：要求紧邻处不是 value 自己首/尾字符的重复延伸——
    排掉"续充"被"续充充"这种紧邻重复字污染的子串蒙混过关(纯 in 判断会把"续充充"误判成"含有
    续充"，因为原字符串恰好是被污染文本的前缀)。用首尾字符各一个的负向环视实现，两侧都是定长
    1 个字符，满足 Python re 对环视要求"定长"的限制。"""
    if not value:
        return True
    pattern = re.compile(
        f"(?<!{re.escape(value[0])})" + re.escape(value) + f"(?!{re.escape(value[-1])})"
    )
    return bool(pattern.search(full_text))


def detect_ocr_text_anomalies(ocr_texts: list[str], hard_values: dict[str, str]) -> dict[str, str]:
    """比对 OCR 读出的文字与硬要素期望值(店名/日期/价格/联系方式)，返回 {字段名: 人话原因}
    (空 dict = 一个不少、都对得上)。

    判定本身是【精确包含比对】(忽略空白)、零容忍模糊——硬要素必须一字不差、干净地出现在 OCR
    结果里，任何偏差(缺字/多字/紧邻重复字/错位数字)都判定为"抽风"：这类字段本就要求分毫不差，
    模糊匹配会放过"关键数字错一位"这种最不能接受的错误。编辑距离只用来给出更友好的原因文案
    (离得近=像是画错了几个字，离得远=压根没画)，不影响判定结果。装饰字/花体不在 hard_values 里，
    天然不查、不会被误杀。
    """
    if not hard_values:
        return {}
    full_text = re.sub(r"\s+", "", "".join(ocr_texts))
    anomalies: dict[str, str] = {}
    for field, value in hard_values.items():
        norm_value = re.sub(r"\s+", "", str(value or ""))
        if not norm_value or _has_clean_occurrence(norm_value, full_text):
            continue
        label = HARD_ELEMENT_LABELS.get(field, field)
        distance = _find_best_edit_distance(norm_value, full_text)
        if distance <= max(1, len(norm_value) // 2):
            anomalies[field] = f"{label}文字疑似出错(如重复字/错位)：应为「{value}」"
        else:
            anomalies[field] = f"{label}没有识别到：应为「{value}」"
    return anomalies


async def _quality_check_image(output_path_jpg: Path, hard_values: dict[str, str]) -> tuple[bool, str, bool]:
    """一张已落盘图片的完整质检：先零依赖预筛，通过后（有硬文字要素时）再跑 OCR 比对。
    两类检查都在线程池跑(CPU 密集：图像统计 / onnx 推理)，避免阻塞事件循环。

    返回 (ok, reason, is_ocr_only)——第三项标记这次判废是不是【纯粹因为 OCR 文字比对不过】
    (画面本身已经过了零依赖预筛，不是黑图/纯色这类真正的生成失败)。改图轮 U5 修复用这个信号
    区分"画面本身坏了"(仍要放弃)和"只是文字没对上"(可以 best-effort 放行+警告)，见调用方
    `_generate_one`。fresh 生成路径不看这一项，行为不变。"""
    ok, reason = await asyncio.to_thread(_screen_generated_image, output_path_jpg)
    if not ok:
        return False, reason, False
    if hard_values:
        ocr_texts = await asyncio.to_thread(_run_ocr_texts, output_path_jpg)
        anomalies = detect_ocr_text_anomalies(ocr_texts, hard_values)
        if anomalies:
            return False, "；".join(anomalies.values()), True
    return True, "", False


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
    brand_color: str | None = None,
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
    if brand_color:
        # U5(E3d)・门店品牌包：只是提示模型延续品牌基调，不强求整图都是这个颜色。
        parts.append(f"品牌主色调呼应 {brand_color}（背景/点缀色协调这个颜色，不要求整图都是它）")

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
    image_model: str | None,
    ratio: str = "3:4",
    reference_image_paths: list[str] | None = None,
    count: int = 1,
    refine_from: str | None = None,
    mask_path: str | None = None,
    add_store_info: bool = False,
    no_text: bool = False,
    conversation_id: str | None = None,
    quality: str = "medium",
    image_prompt: str | None = None,
    poster_text: dict | None = None,
    background_mode: str = "ai_generate",
    store_photo_path: str | None = None,
    logo_path: str | None = None,
    qr_path: str | None = None,
    allowed_paths: list[str] | set[str] | None = None,
    edit_type: str | None = None,
    print_mode: bool = False,
) -> dict:
    """AI 生图，支持多轮调整（底图）与参考图（风格）同时传入。

    图片角色模型：
    - 底图（refine_from 指向的上一张生成图）= "在这张上改"，永远排第一张
    - 参考图（用户上传）= "照这个感觉来"，对话级有效，由前端每轮全量传入
    两者不互斥——修复旧版 elif 导致调整模式下新参考图被静默丢弃的问题。

    allowed_paths：老板当场经 OS 文件选择器选定、显式授权的文件/目录绝对路径（= AgentContext.allowed_paths）。
    logo_path/qr_path/store_photo_path/reference_image_paths/mask_path 若指向 uploads 沙箱外的绝对路径，
    必须落在这个集合里才会读取，否则越界拒绝——防 Agent 工具的模型入参把任意本机文件读出来发给外部生图 API。
    调用方不传（默认 None）＝沙箱外一律不读（安全默认）。

    edit_type：U5(E3d)改图侧专用，仅在 refine_from 有值(改图轮)时生效——"text_fix"(改文字/字错)
    →路由 Seedream；"content"(改内容)→路由 GPT edits(高保真)；不传则从 prompt 文本推断。
    对纯生成(refine_from 为空)无影响，不碰 U2 的生成路由。

    print_mode：owner §3-4 窄例外，默认 False(现状不变，二维码原图交给模型融合)。True 时若提供了
    qr_path，成图落盘后会额外贴一个程序生成、保证能扫的真二维码(见 _overlay_print_qr)。
    """
    from services.ai.providers.openai_image import OpenAIImageProvider
    from services.ai.factory import ProviderFactory

    # U2・自动路由：调用方没手选模型(image_model 为空)时，按内容启发式自动选；默认落 Seedream——
    # 下一批(E2)要砍掉前端模型选择器，请求不传模型名时绝不能落到 gpt-image-2(大陆握美国 relay 长连接
    # 约 60s 被掐断=图丢+白扣钱，2026-07-03 实测)。调用方显式传了 image_model 一律尊重(向后兼容手选)。
    _explicit_image_model_choice = (image_model or "").strip()
    image_model = _route_image_model(image_prompt or prompt, poster_text, image_model)
    if refine_from:
        # U5・改图侧独立路由(不影响上面刚算出的 U2 生成路由值)：按"改文字/改内容"重新选模型。
        image_model = _route_edit_model(prompt, _explicit_image_model_choice, edit_type)
    # E2-1b・易拉宝 2:5/横幅 5:2 是 Seedream 专属尺寸——不管上面路由算出什么，强制切回 Seedream。
    image_model = _force_seedream_for_ratio(image_model, ratio)

    # 生图 BYOK：门店配了自带生图模型 → 用门店的 key/base_url（自担成本）；否则回退平台默认。
    api_key, image_base_url, image_model_cfg = ProviderFactory.get_image_config_for_store(store)
    # 模型选择：调用方选了火山 Seedream 且门店没 BYOK 覆盖 → 切到火山方舟（复用内置 ARK key，与视频同平台同 key）。
    # ⚠️ 判据必须是「门店有没有 BYOK 生图」，不能用 `not image_model_cfg`：内置默认 IMAGE_MODEL_NAME=gpt-image-2
    #    会让 image_model_cfg 恒非空，导致火山分支永远进不去、选火山被错路由到 gpt-image-2（真机日志实锤）。
    _store_byok_image = bool(getattr(store, "byok_image_enabled", False) and getattr(store, "byok_image_api_key_enc", None))
    if image_model and "seedream" in image_model.lower() and not _store_byok_image:
        import os as _os_sd
        from config import settings as _s_sd
        if _os_sd.environ.get("DESKTOP_LOCAL") == "1" and getattr(_s_sd, "ark_api_key", ""):
            api_key = _s_sd.ark_api_key
            image_base_url = _ARK_BASE_URL
            image_model_cfg = image_model   # 选的 seedream id（带日期）;build_image_provider 按 ark base_url 路由到 SeedreamImageProvider
    if not api_key:
        import os
        if os.environ.get("DESKTOP_LOCAL") == "1":  # 桌面纯 BYOK：没有"平台默认"，别误导老板留空
            raise ValueError("生图模型未配置：请在「模型设置」里填你自己的生图模型 Key（桌面版用你自己的 key，没有平台默认）")
        raise ValueError("生图模型未配置：请在「模型设置」里填生图模型的 Key（或留空用平台默认）")

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
        # U5・preserve list 拼回：调用方(如 studio_edit)目前没有 poster_text 入口，没显式传时
        # 从被改的原图承接上一轮的硬文字要素(店名/日期/价格/联系方式)，让下面的"扩写统一层"
        # 每轮改图都重新拼回 prompt，防止改着改着把这些字漂移/画丢。显式传了就以调用方为准。
        if not poster_text and original.input_params:
            poster_text = original.input_params.get("poster_text") or None

    # image_prompt(扩写后/前端可改的真实送模型提示词)同样要查注入——只查 prompt 会被
    # "prompt 正常、image_prompt 改成越线内容"绕过（与上面 studio.py 的红线预检同一个漏洞）。
    injection_check = check_input_injection(prompt) or check_input_injection(image_prompt or "")
    if injection_check:
        raise AIServiceError(injection_check)
    await check_poster_quota(db, str(store.id))
    _allowed_resolved = _resolve_allowed_paths(allowed_paths)

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
        sp = _resolve_agent_selected_bytes(store_photo_path, _allowed_resolved, "门店底图")
        if sp is not None:
            base_image = sp
            logger.info("门店照优化底图: %s", store_photo_path)

    # 品牌资产：门店 Logo / 二维码。Logo 不再交模型渲染（会糊店名），改 PIL 像素级贴（见 _overlay_logo）。
    # 桌面版：老板经文件选择器选定的 logo/二维码常在 uploads 之外 → 只在其 ∈ 当场选定的 allowed_paths 时才读，
    # 越界（模型入参乱填的绝对路径）直接抛人话错误，不再来者不拒。
    logo_bytes = _resolve_agent_selected_bytes(logo_path, _allowed_resolved, "Logo 图片")
    qr_bytes = _resolve_agent_selected_bytes(qr_path, _allowed_resolved, "二维码图片")

    ref_bytes: list[bytes] = []
    if reference_image_paths:
        upload_dir = Path(settings.upload_dir)
        is_desktop = os.environ.get("DESKTOP_LOCAL") == "1"
        for ref_str in reference_image_paths:
            if ".." in ref_str:
                if not is_desktop:
                    raise ValueError("reference_image_path 必须在 uploads/ 目录内")
                continue
            rel = ref_str.removeprefix("/uploads/")
            ref_path = upload_dir / rel
            in_uploads = False
            try:
                in_uploads = ref_path.resolve().is_relative_to(upload_dir.resolve())
            except (OSError, ValueError):
                pass
            if in_uploads and ref_path.exists():
                ref_bytes.append(ref_path.read_bytes())
            elif is_desktop:
                # 沙箱外的参考图路径：必须 ∈ 老板当场选定的 allowed_paths，越界抛人话错误（不再来者不拒）。
                rb = _resolve_agent_selected_bytes(ref_str, _allowed_resolved, "参考图")
                if rb is not None:
                    ref_bytes.append(rb)

    # U5(E3d)・门店品牌包：自动附带门店后台配置的品牌参考图，保风格一致。这些路径来自门店设置
    # (受信任的运营配置，不是 Agent 工具的模型入参)，直接走 uploads 沙箱读取，不需要 allowed_paths
    # 校验；单张读取失败(文件被移走/损坏)静默跳过，不拖垮整次生成。
    for _bp in (getattr(store, "brand_reference_images", None) or []):
        _bb = _load_upload_bytes(_bp if isinstance(_bp, str) else None)
        if _bb is not None:
            ref_bytes.append(_bb)

    # 局部重绘:读 mask(同尺寸 alpha PNG,透明 alpha=0 处=要改);没有底图无从局部改 → 忽略 mask 走整图。
    # mask 目前只走 studio.py(人工画蒙版上传)、不经模型入参，但沙箱外绝对路径同样按 allowed_paths 校验，
    # 读取失败(含越界)一律降级为"忽略 mask、走整图改"而不是硬失败——mask 本就是可选的局部重绘增强。
    mask_bytes: bytes | None = None
    if mask_path and base_image is not None:
        try:
            mask_bytes = _resolve_agent_selected_bytes(mask_path, _allowed_resolved, "局部重绘蒙版")
        except AIServiceError:
            logger.warning("mask 路径越界或不在允许范围内，忽略 mask 走整图改: %s", mask_path)
            mask_bytes = None
        except Exception:
            logger.warning("读取 mask 失败,忽略 mask 走整图改", exc_info=True)

    # 输入图顺序：要保真的排前面（底图→二维码→Logo），风格参考随后（官方：靠前输入图保真更强）。
    # 二维码紧跟底图——它最需要原样复现才能扫得出，享受前排更强的保真。
    preserve_imgs: list[bytes] = []
    if base_image:
        preserve_imgs.append(base_image)
    if qr_bytes:
        preserve_imgs.append(qr_bytes)
    if logo_bytes:
        preserve_imgs.append(logo_bytes)  # owner 拍板：所有上传物料(含 logo)原样喂 GPT 融合，不再 PIL 贴
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
    else:
        # U1・单一choke point：不管调用方是 studio /expand 独立扩写、还是 ReAct 工具里编排大模型
        # 自己写的 image_prompt，两条路径都会走到这——扩写完硬文字要素(店名/日期/价格/联系方式)
        # 可能被模型悄悄丢/改写，代码 string-match 兜底补回(纯文本拼接，不是图片程序叠层)。
        _hard_values = collect_hard_text_values(poster_text)
        if _hard_values:
            core_prompt = ensure_hard_elements_preserved(core_prompt, _hard_values)
            # 补回后要让落库的 image_prompt 与真送模型的内容保持一致——否则审计"补回有没有
            # 生效"时会对不上（DB 里仍是补回前的原始扩写文本，但实际送模型的是补回后的版本）。
            image_prompt = core_prompt
    missing_elements = detect_missing_hard_elements(poster_text)
    full_prompt = build_poster_prompt(
        prompt=core_prompt,
        history_prompts=history_prompts,
        has_base_image=base_image is not None,
        ref_count=len(ref_bytes),
        add_store_info=add_store_info,
        store_name=store.name or "",
        city=store.city or "",
        no_text=no_text,
        has_logo=logo_bytes is not None,  # owner 拍板：logo 也喂 GPT 融合，prompt 声明让模型整合
        has_qr=qr_bytes is not None,
        brand_color=getattr(store, "brand_color", None) or None,  # U5・门店品牌包：品牌色写进提示
    )

    # 质量收敛到三档：去掉 auto(让模型自挑→成本不可控)；非法/空值一律按 medium
    quality = quality if quality in ("low", "medium", "high") else "medium"
    size = _get_api_size(ratio)
    logger.info("AI 生图: ratio=%s, count=%d, base=%s, refs=%d, conversation=%s",
                ratio, count, bool(base_image), len(ref_bytes), bool(conv_uuid))

    # 按 base_url 自动路由到对应生图 Provider（OpenAI 兼容 / 硅基流动 / 通义万相…，CC Switch 式口子）
    provider = ProviderFactory.build_image_provider(api_key, image_base_url, image_model_cfg)

    # 生成 conversation_id（如果是新对话；旧对话沿用已校验的 conv_uuid）
    conv_id = str(conv_uuid) if conv_uuid else str(uuid.uuid4())

    POSTERS_DIR.mkdir(parents=True, exist_ok=True)

    # ── U2・并行生成 N 张 + GPT 失败自动降级 Seedream(安全网) ──
    # 每张图的 provider 调用(含降级重试)在 _get_image_semaphore() 闸内并行跑(asyncio.gather)——
    # 这段只碰 provider/文件系统，不碰 db：AsyncSession 不允许被多个协程并发操作(SQLAlchemy 官方
    # 明文禁止，同 tests/test_agent_loop_db_concurrency_safety.py 揪出的那类竞态)。DB 写挪到 gather
    # 结束后逐张串行做，顺序=请求下标——与 asyncio.gather 按输入顺序回填结果的语义天然一致，
    # 不会因为各张实际完成时机不同而错位。
    semaphore = _get_image_semaphore()
    # ⚠️ 门店生图 BYOK 且【没填】byok_image_model 时（image_model_cfg 恒为 None）：
    # 绝不能把自动路由算出的具体模型 ID（如火山 Seedream 专属的 doubao-seedream-*）硬塞给
    # 门店自己的 endpoint——那是任意厂商的 API，收到这个 ID 大概率不认识直接报错；且这类失败
    # 不是 gpt-image 开头，降级安全网也救不了。这种情况必须让 model=None 传给 provider，
    # 沿用 U2 之前的行为：交给门店自己的 endpoint 用它自身默认值。只有【非 BYOK（内置 key）】
    # 路径才吃自动路由的具体模型串（image_model_cfg 为 None 时兜底 image_model）。
    routed_model = image_model_cfg if _store_byok_image else (image_model_cfg or image_model)
    # U4・OCR 只在有硬文字要素时才查(装饰字/花体不查，不会被误杀)；一次性算好，每张图复用。
    _hard_values_for_qc = collect_hard_text_values(poster_text)
    # U4・"仍抽风:如实告知用户"——收集质检拒绝原因，供整批全废时拼进人话报错(而不是甩一句"生成失败"了事)。
    quality_rejection_notes: list[str] = []
    # U5・改图循环增强：这轮是否是"改图"(refine_from 有值)、以及推断出的改图类型——只在改内容
    # (非 text_fix)且真调用 GPT 系列模型时才会给 input_fidelity="high"(openai_image.py 内部会再按
    # 模型是不是 gpt-image-2 做一次防呆过滤，双保险)。
    _is_edit_round = bool(refine_from)
    _resolved_edit_type = _resolve_edit_type(prompt, edit_type) if _is_edit_round else None

    async def _produce_single_attempt(i: int) -> dict | None:
        rand = uuid.uuid4().hex[:4]
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        sid = str(store.id).replace("-", "")[:8]
        filename = f"ai_{sid}_{ts}_{rand}_{i}.png"
        output_path = POSTERS_DIR / filename
        actual_model = routed_model
        model_switched = False

        # U5・input_fidelity 只在"改内容"这轮、且真路由到 GPT 系列模型时才给 high——openai_image.py
        # 内部还会再按模型是不是 gpt-image-2 过滤一次(gpt-image-2 恒高保真、API 不接受该参数)，
        # 这里传了也不会打挂当前唯一在用的 gpt-image-2 请求。
        _input_fidelity = (
            "high" if (_is_edit_round and _resolved_edit_type == "content"
                       and str(actual_model or "").startswith("gpt-image"))
            else None
        )
        try:
            # 经全局并发闸：超出 poster_max_concurrency 的请求在此排队，护住每分钟出图限额(IPM)
            async with semaphore:
                image_bytes = await provider.generate_image(
                    prompt=full_prompt,
                    model=actual_model,
                    size=size,
                    quality=quality,
                    image=input_images if input_images else None,
                    mask=mask_bytes,  # 局部重绘:同尺寸 alpha mask(透明处=要改);None=整图改
                    input_fidelity=_input_fidelity,
                )
        except Exception:
            logger.warning("第 %d 张用 %s 生成失败", i + 1, actual_model, exc_info=True)
            # 安全网：只有路由到 GPT 的才降级(治大陆连 gpt-image-2 长连接被掐的坑)——非 GPT 的失败
            # 如实报错，不装作有安全网。降级最多一跳，造不出 Seedream provider(非桌面/没配 ark key)
            # 也如实失败。非 429 异常本就立抛(现有 429 重试骨架)，这里只在"确实失败"后重试一次。
            fallback = (
                _build_seedream_fallback_provider()
                if str(actual_model or "").startswith("gpt-image") else None
            )
            if fallback is None:
                return None
            try:
                async with semaphore:
                    image_bytes = await fallback.generate_image(
                        prompt=full_prompt,
                        model=_AUTO_ROUTE_SEEDREAM_MODEL,
                        size=size,
                        quality=quality,
                        image=input_images if input_images else None,
                        mask=mask_bytes,
                    )
                model_switched = True
                actual_model = _AUTO_ROUTE_SEEDREAM_MODEL
                logger.info("第 %d 张 GPT 失败，已自动降级 Seedream 重试成功", i + 1)
            except Exception:
                logger.warning("第 %d 张降级 Seedream 仍失败，放弃", i + 1, exc_info=True)
                return None

        try:
            # owner 拍板：不再 PIL 贴 logo——所有上传物料(含 logo)已原样进 input_images 喂 GPT 融合。
            # 保存图片（JPEG 格式，减小文件体积）；Pillow 解码+编码是同步 CPU，放线程池
            output_path_jpg = output_path.with_suffix(".jpg")
            await asyncio.to_thread(_save_png_as_jpeg, image_bytes, output_path_jpg)
            actual_width, actual_height = await asyncio.to_thread(_assert_saved_ratio, output_path_jpg, ratio)
        except Exception:
            logger.warning("第 %d 张落盘/比例校验失败", i + 1, exc_info=True)
            return None

        # U5・owner §3-4 窄例外：仅 print_mode=True 且确实提供了二维码物料时才叠层，默认路径
        # (print_mode=False，绝大多数场景)完全不碰这里——不影响宽高，不需要重新校验比例。
        if print_mode and qr_bytes:
            try:
                await asyncio.to_thread(_apply_print_qr_overlay, output_path_jpg, qr_bytes)
            except Exception:
                logger.warning("第 %d 张印刷二维码叠层失败，保留原图", i + 1, exc_info=True)

        return {
            "output_path_jpg": output_path_jpg,
            "width": actual_width,
            "height": actual_height,
            "model_used": actual_model,
            "model_switched": model_switched,
        }

    async def _generate_one(i: int) -> dict | None:
        """U4・质检 + 抽风自动重出(仅 1 次)：预筛/OCR 不过 → 重出这一张一次；重出后仍不过 →
        fresh 生成放弃这一张(如实计入拒绝原因，不拖累同批其它张，也不硬塞废图给用户)。

        U5 修复(review 发现)：改图轮(`_is_edit_round`)是另一回事——preserve-list 承接的硬要素
        本就可能和这次编辑诉求无关(比如"把背景换成蓝色"却承接了店名/电话)，编辑模型顺带把这些
        不相关的字画漂移，不该让用户一次简单改图连图都拿不到。所以改图轮"重出后仍只是 OCR 文字
        没对上"(`ocr_only`=True，画面本身已过预筍，不是黑图/纯色)时，尽力而为返回这张图 + 软性
        警告标记，不再抛 AIServiceError 硬失败；画面本身就坏了(ocr_only=False)仍按原逻辑放弃。
        fresh 生成路径完全不看 `_is_edit_round`，行为不变(仍会一路走到底部的诚实硬失败)。"""
        outcome = await _produce_single_attempt(i)
        if outcome is None:
            return None
        ok, reason, _ = await _quality_check_image(outcome["output_path_jpg"], _hard_values_for_qc)
        if ok:
            return outcome
        logger.warning("第 %d 张质检未过(%s)，自动重出这一张 1 次", i + 1, reason)
        quality_rejection_notes.append(reason)
        retry_outcome = await _produce_single_attempt(i)
        if retry_outcome is None:
            return None
        ok2, reason2, ocr_only2 = await _quality_check_image(retry_outcome["output_path_jpg"], _hard_values_for_qc)
        if ok2:
            retry_outcome["quality_retried"] = True
            return retry_outcome
        if _is_edit_round and ocr_only2:
            logger.warning(
                "第 %d 张(改图轮)重出后 OCR 仍未对上(%s)，按最佳成果返回并打软性警告标记，不硬失败",
                i + 1, reason2,
            )
            quality_rejection_notes.append(reason2)
            retry_outcome["quality_retried"] = True
            retry_outcome["text_quality_warning"] = True
            retry_outcome["text_quality_warning_message"] = "文字可能有点偏差，可以再改一版"
            return retry_outcome
        logger.warning("第 %d 张重出后质检仍未过(%s)，放弃这一张", i + 1, reason2)
        quality_rejection_notes.append(reason2)
        return None

    outcomes = await asyncio.gather(*(_generate_one(i) for i in range(count)))

    if not any(o is not None for o in outcomes):
        # U4・全废兜底：一整批全部被预筛/OCR 判废(或 API 全失败) → 自动补生成 1 轮(仅 1 次，
        # 复用同一条并行入口 `_generate_one`——路由/信号量/降级安全网都原样生效)。这一轮不再
        # 额外嵌套"全废再兜底"，避免无限重出/烧钱；仍全废就在下面走"图片生成失败"的诚实报错。
        logger.warning("整批 %d 张全部失败/未过质检，自动补生成 1 轮(仅 1 次)", count)
        outcomes = await asyncio.gather(*(_generate_one(i) for i in range(count)))

    results = []
    for outcome in outcomes:
        if outcome is None:
            results.append(None)
            continue

        output_path_jpg = outcome["output_path_jpg"]
        actual_width, actual_height = outcome["width"], outcome["height"]
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
                "width": actual_width,
                "height": actual_height,
                "actual_ratio": f"{actual_width}:{actual_height}",
                "model_switched": outcome["model_switched"],  # U2:这张是否触发了 GPT→Seedream 降级安全网
                "edit_type": _resolved_edit_type,     # U5:这轮改图判定的类型(非改图轮恒 None)
                "print_mode": print_mode,              # U5:这张是否叠了印刷级真二维码
                # U5 修复:改图轮 OCR 重出后仍未对上时的软性警告(见 _generate_one)；非改图轮/未触发恒 False。
                "text_quality_warning": outcome.get("text_quality_warning", False),
                "text_quality_warning_message": outcome.get("text_quality_warning_message"),
            },
            prompt_used=full_prompt,
            result=poster_url,
            # 实际用的模型(火山 Seedream / gpt-image-2 / 门店 BYOK / 降级后的 Seedream)——按这张图
            # 真实用掉的模型记账，不是批次统一路由值(降级只发生在个别张失败时，各张可能不同)。
            model_used=f"ai:{outcome['model_used'] or 'gpt-image-2'}",
            tokens_used=0,
            conversation_id=uuid.UUID(conv_id),
        )
        db.add(generation)
        # 串行：同一个 AsyncSession 不允许被多个协程并发操作，DB 写必须逐张做(已在 gather 之外)。
        await db.flush()

        results.append({
            "generation_id": generation.id,
            "poster_url": poster_url,
            "width": actual_width,
            "height": actual_height,
            "ratio": ratio,
            "created_at": created_at,
            "model_switched": outcome["model_switched"],  # U2:前端可据此提示"这张用了备用模型"
            "quality_retried": outcome.get("quality_retried", False),  # U4:这张是否因质检抽风重出过
            # U5 修复:改图轮 OCR 抽风重出仍未过时按最佳成果放行的软性提示(不硬失败)，供前端展示。
            "text_quality_warning": outcome.get("text_quality_warning", False),
            "text_quality_warning_message": outcome.get("text_quality_warning_message"),
        })

        logger.info("AI 生图完成: %s (模型=%s%s)", poster_url, outcome["model_used"],
                    "·已降级" if outcome["model_switched"] else "")

    await db.commit()

    valid_results = [r for r in results if r is not None]

    if not valid_results:
        # AIServiceError 而非 RuntimeError：后者落到通用兜底处理器变成无差别 500，
        # 这句友好提示到不了用户。
        # U4・"仍抽风:如实告知用户"——有质检拒绝原因就带出来，让用户知道是"文字没出准"而不是
        # 笼统的"生成失败"，并给出可行动的建议；纯 API 失败(没有质检拒绝记录)沿用原提示。
        if quality_rejection_notes:
            unique_notes = "；".join(dict.fromkeys(quality_rejection_notes))
            raise AIServiceError(
                f"生成的图片文字没有对上（{unique_notes}），自动重试后还是不行——"
                "要不要换个说法再试一次，或者这几个字你自己手动改一下？"
            )
        raise AIServiceError("图片生成失败，请稍后重试")

    # 按实际成功生成的张数计入海报额度（独立池，不挤占文案次数）
    await increment_poster_usage(db, str(store.id), count=len(valid_results))

    return {
        "images": valid_results,
        "model_used": f"ai:{routed_model or 'gpt-image-2'}",
        "count": len(valid_results),
        "conversation_id": conv_id,
        "logo_applied": logo_bytes is not None,
        # U1・"缺就问不瞎编"：调用方声明要用但没填值的硬要素(见 detect_missing_hard_elements)，
        # 不阻断本次生成——studio 直连路径把它交给前端做缺项提示；ReAct 路径在调这里之前
        # 已经因为同样的检查直接问老板了(见 tools.py make_poster/generate_image)，这里恒为空。
        "missing_elements": missing_elements,
        # U4・质检诚实信号：这批里有几张因预筛/OCR 抽风重出过(即使最终成功了也带出来，
        # 供上层将来想做"这张用了重出"提示用；不阻断、不改变现有 images 结构)。
        "quality_retried_count": sum(1 for r in valid_results if r.get("quality_retried")),
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
    """获取对话详情（所有 generation 记录）。非法 conversation_id 返回 None（端点转 404，不 500）。"""
    try:
        conv_uuid = uuid.UUID(conversation_id)
    except (ValueError, TypeError):
        return None
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.type == "poster",
            Generation.conversation_id == conv_uuid,
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
        {"value": "2:5", "label": "2:5 易拉宝", "desc": "门口易拉宝/竖长条展架"},
        {"value": "5:2", "label": "5:2 横幅", "desc": "店内横幅/长条广告位"},
    ]
