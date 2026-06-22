"""本地图像处理工具（桌面全本地版专属，DESKTOP_LOCAL=1 才注册）。

把"像图片编辑器那样在本机改图"的通用能力给 Agent——老板说「把这张图压缩一下 / 裁成方形 /
加个水印 / 转成 jpg / 缩小点」就能干。配的护栏与本地文件工具(local_tools)完全一致：
- **范围锁**：复用 local_tools 的 `_resolve` 沙箱——只动「内容库」+ 老板当场选定的图片。
- **改前备份**：覆盖原图前复用 `_backup` 把原件存到 .backups/，可回滚。
- **审批闸**：requires_approval=True + approval_class="file"——跟写类文件工具一档，循环里不直接落盘，
  先把"要怎么改"弹给老板，确认后才写。

⚠️ 云端 web 版（PostgreSQL，多租户）绝不注册——本机改图只在老板自己机器上的本地后端有意义。
Pillow(PIL) 项目已装（海报贴 logo 用），这里只是把它的能力暴露给 Agent。
"""
import io
import logging
import os
from pathlib import Path

from services.agent.local_tools import _backup, _library_root, _resolve
from services.agent.registry import Tool, default_registry

logger = logging.getLogger(__name__)

# 支持的输出格式 → Pillow 保存用的 format 名。png/jpg/jpeg/webp 互转。
_FORMAT_MAP = {
    "png": "PNG",
    "jpg": "JPEG",
    "jpeg": "JPEG",
    "webp": "WEBP",
}
# 哪些操作会改像素/格式（需要走"读图→改→写盘"）。供描述与校验用。
_OPERATIONS = {"crop", "resize", "watermark", "compress", "convert", "rotate"}

# 找一个能渲染中文的字体给水印用（macOS 自带）；都找不到退回 PIL 内置位图字体（只画英文/数字）。
_CJK_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
    "C:/Windows/Fonts/msyh.ttc",      # 微软雅黑
    "C:/Windows/Fonts/simhei.ttf",    # 黑体
]


def _load_font(size: int):
    """按字号加载一个能渲染中文的 TrueType 字体；找不到任何系统字体则退回 PIL 内置默认字体
    （内置字体不支持中文、字号也固定，水印只能是英文/数字——届时在结果里提示老板）。"""
    from PIL import ImageFont
    for fp in _CJK_FONT_CANDIDATES:
        if Path(fp).exists():
            try:
                return ImageFont.truetype(fp, size), True
            except OSError:
                continue
    return ImageFont.load_default(), False


def _open_image(path: Path):
    """打开图片为 PIL Image。非图片/损坏 → 抛 ValueError（人话），由 handler 兜成友好文本。"""
    from PIL import Image, UnidentifiedImageError
    try:
        return Image.open(path)
    except UnidentifiedImageError:
        raise ValueError(f"「{path.name}」不是能识别的图片格式，没法处理。")
    except OSError as e:
        raise ValueError(f"打开图片失败：{e}")


def _out_path(src: Path, args: dict, ctx, default_suffix: str | None = None) -> tuple[Path, bool]:
    """算输出路径 + 是否覆盖原图。
    - 给了 output_path → 用它（同样进沙箱校验）；
    - 没给 → 覆盖原图（覆盖前会备份）。
    convert 默认换扩展名（default_suffix），但显式 output_path 优先。
    返回 (输出 Path, 是否覆盖原图)。"""
    raw_out = (args.get("output_path") or "").strip()
    if raw_out:
        out = _resolve(raw_out, ctx)
        return out, (out.resolve() == src.resolve())
    if default_suffix and src.suffix.lower() != default_suffix:
        return src.with_suffix(default_suffix), False
    return src, True


def _save_image(img, out: Path, *, overwrite_src: bool, src: Path,
                quality: int | None = None) -> str | None:
    """把处理后的 Image 存到 out。覆盖原图前先备份（复用 local_tools._backup）。
    JPEG/WEBP 不支持透明通道 → 自动转 RGB（防"cannot write mode RGBA as JPEG"）。
    返回备份路径（没备份则 None）。"""
    fmt = _FORMAT_MAP.get(out.suffix.lower().lstrip("."))
    if fmt is None:
        # 没指定/不认识扩展名 → 跟源图格式走（保持原样最不意外）
        fmt = _FORMAT_MAP.get(src.suffix.lower().lstrip("."), "PNG")
    save_img = img
    if fmt in ("JPEG", "WEBP") and img.mode in ("RGBA", "P", "LA"):
        save_img = img.convert("RGB")
    backup = _backup(out) if (overwrite_src or out.exists()) else None
    out.parent.mkdir(parents=True, exist_ok=True)
    save_kwargs: dict = {}
    if fmt == "JPEG":
        save_kwargs = {"quality": quality if quality is not None else 85, "optimize": True}
    elif fmt == "WEBP":
        save_kwargs = {"quality": quality if quality is not None else 80}
    elif fmt == "PNG":
        save_kwargs = {"optimize": True}
    save_img.save(out, fmt, **save_kwargs)
    return backup


def _coerce_int(val, default: int | None = None) -> int | None:
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


# ────────────────────────────── 各操作（纯像素处理，输入已是打开的 Image） ──────────────────────────────

def _op_crop(img, args: dict):
    """裁剪。给 left/top/right/bottom 像素框，或 shape="square" 居中裁成正方形。"""
    from PIL import Image  # noqa: F401
    shape = (args.get("shape") or "").strip().lower()
    w, h = img.size
    if shape == "square":
        side = min(w, h)
        left = (w - side) // 2
        top = (h - side) // 2
        return img.crop((left, top, left + side, top + side)), f"居中裁成正方形 {side}×{side}"
    left = _coerce_int(args.get("left"), 0)
    top = _coerce_int(args.get("top"), 0)
    right = _coerce_int(args.get("right"), w)
    bottom = _coerce_int(args.get("bottom"), h)
    # 夹到图内、保证 right>left/bottom>top
    left = max(0, min(left, w - 1))
    top = max(0, min(top, h - 1))
    right = max(left + 1, min(right, w))
    bottom = max(top + 1, min(bottom, h))
    return img.crop((left, top, right, bottom)), f"裁剪到 ({left},{top})-({right},{bottom})，新尺寸 {right-left}×{bottom-top}"


def _op_resize(img, args: dict):
    """缩放/改尺寸。给 width 和/或 height（只给一边按比例算另一边）；或 scale 按倍数缩放。"""
    from PIL import Image
    w, h = img.size
    scale = args.get("scale")
    if scale is not None:
        try:
            f = float(scale)
        except (TypeError, ValueError):
            f = None
        if f and f > 0:
            nw, nh = max(1, int(w * f)), max(1, int(h * f))
            return img.resize((nw, nh), Image.LANCZOS), f"按 {f} 倍缩放到 {nw}×{nh}"
    tw = _coerce_int(args.get("width"))
    th = _coerce_int(args.get("height"))
    if tw and not th:
        th = max(1, round(h * tw / w))
    elif th and not tw:
        tw = max(1, round(w * th / h))
    if not tw or not th:
        raise ValueError("缩放要给目标尺寸：width 和/或 height（只给一边会按比例算另一边），或 scale 倍数。")
    tw, th = max(1, tw), max(1, th)
    return img.resize((tw, th), Image.LANCZOS), f"缩放到 {tw}×{th}"


def _op_rotate(img, args: dict):
    """旋转。给 angle（度，逆时针为正；常用 90/180/270）。expand=True 让画布跟着转后的图变大不裁角。"""
    angle = _coerce_int(args.get("angle"))
    if angle is None:
        try:
            angle = float(args.get("angle"))
        except (TypeError, ValueError):
            raise ValueError("旋转要给 angle（角度，如 90 / 180 / -90）。")
    rotated = img.rotate(-angle, expand=True)  # PIL 正角度=逆时针；老板直觉"顺时针90"→传 90 转顺时针
    return rotated, f"旋转 {angle}°"


def _op_watermark(img, args: dict):
    """加文字水印。text 必填；position 角落(右下/左下/右上/左上/居中，默认右下)；
    opacity 0-100(默认 60)；可选 font_size(默认按图宽算)。"""
    from PIL import Image, ImageDraw
    text = (args.get("text") or "").strip()
    if not text:
        raise ValueError("加水印要给 text（水印文字）。")
    base = img.convert("RGBA")
    w, h = base.size
    font_size = _coerce_int(args.get("font_size")) or max(16, int(w * 0.05))
    font, cjk_ok = _load_font(font_size)
    try:
        opacity = int(args.get("opacity"))
    except (TypeError, ValueError):
        opacity = 60
    opacity = max(5, min(opacity, 100))
    alpha = int(opacity / 100 * 255)

    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    # 量文字框（Pillow>=8 用 textbbox；老 API 没有则退回 font.getsize）
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except (AttributeError, TypeError):
        tw, th = draw.textsize(text, font=font)
    margin = max(8, int(w * 0.02))
    pos = (args.get("position") or "right-bottom").strip().lower()
    pos_map = {
        "right-bottom": (w - tw - margin, h - th - margin),
        "右下": (w - tw - margin, h - th - margin),
        "left-bottom": (margin, h - th - margin),
        "左下": (margin, h - th - margin),
        "right-top": (w - tw - margin, margin),
        "右上": (w - tw - margin, margin),
        "left-top": (margin, margin),
        "左上": (margin, margin),
        "center": ((w - tw) // 2, (h - th) // 2),
        "居中": ((w - tw) // 2, (h - th) // 2),
    }
    xy = pos_map.get(pos, pos_map["right-bottom"])
    # 半透明白字 + 黑色描边，亮底暗底都看得清
    draw.text(xy, text, font=font, fill=(255, 255, 255, alpha),
              stroke_width=max(1, font_size // 20), stroke_fill=(0, 0, 0, alpha))
    merged = Image.alpha_composite(base, overlay)
    note = f"加水印「{text}」（{pos}，透明度 {opacity}%）"
    if not cjk_ok and any(ord(c) > 127 for c in text):
        note += "（注：没找到系统中文字体，中文可能显示为方块——可改用英文/数字水印）"
    return merged, note


def _op_compress(img, args: dict):
    """压缩减体积：主要靠降质量(quality，仅 jpg/webp 有效)。png 走 optimize。
    不改尺寸；要减体积更狠可配合 resize。"""
    # 压缩本身在 _save_image 里靠 quality 实现，这里只透传 quality、不动像素。
    q = _coerce_int(args.get("quality"), 70)
    q = max(10, min(q, 95))
    return img, f"压缩（质量 {q}）", q


def _op_convert(img, args: dict):
    """格式转换：实际由输出路径的扩展名决定（_out_path 已把扩展名换好）。这里不改像素。"""
    return img, "格式转换"


# ────────────────────────────── 工具入口（沙箱解析 + 分派 + 落盘备份） ──────────────────────────────

async def edit_image(args: dict, ctx) -> str:
    """在老板本机处理一张图片（裁剪/缩放/加水印/压缩/转格式/旋转）。沙箱内、改前备份、走审批闸。
    args:
      path（必填）：要处理的图片（内容库内文件名/相对路径，或老板当场选定图片的完整路径）。
      operation（必填）：crop|resize|watermark|compress|convert|rotate。
      output_path（可选）：另存到哪（不给＝覆盖原图，覆盖前自动备份）。
      —— 各操作参数见下方各 _op_*。
    任何处理失败只返回友好中文文本，不抛异常拖垮 Agent 循环。"""
    raw_path = (args.get("path") or "").strip()
    if not raw_path:
        return "请给 path（要处理哪张图片）。"
    operation = (args.get("operation") or "").strip().lower()
    if operation not in _OPERATIONS:
        return (f"不认识的操作「{operation or '(空)'}」。支持："
                "crop(裁剪) / resize(缩放) / watermark(加水印) / compress(压缩) / convert(转格式) / rotate(旋转)。")
    try:
        src = _resolve(raw_path, ctx)
    except ValueError as e:
        return f"处理不了这张图：{e}（沙箱外的图片需要老板开「完全访问模式」或先用文件选择器选定）"
    if not src.exists():
        return f"图片不存在：{raw_path}"
    if src.is_dir():
        return f"「{src.name}」是文件夹，不是图片。"

    try:
        img = _open_image(src)
    except ValueError as e:
        return str(e)

    quality: int | None = None
    try:
        if operation == "crop":
            out_img, note = _op_crop(img, args)
        elif operation == "resize":
            out_img, note = _op_resize(img, args)
        elif operation == "rotate":
            out_img, note = _op_rotate(img, args)
        elif operation == "watermark":
            out_img, note = _op_watermark(img, args)
        elif operation == "compress":
            out_img, note, quality = _op_compress(img, args)
        else:  # convert
            out_img, note = _op_convert(img, args)
    except ValueError as e:
        return f"处理失败：{e}"
    except Exception as e:  # noqa: BLE001 — 像素处理兜底，绝不让 Agent 循环崩
        logger.warning("edit_image 处理失败 op=%s", operation, exc_info=True)
        return f"处理这张图时出错了（{type(e).__name__}）：{e}"

    # convert 的目标格式：优先 format 参数；没给则看 output_path 的扩展名；都没有就报错。
    default_suffix = None
    if operation == "convert":
        fmt = (args.get("format") or "").strip().lower().lstrip(".")
        out_ext = Path((args.get("output_path") or "").strip()).suffix.lower().lstrip(".")
        target = fmt if fmt in _FORMAT_MAP else (out_ext if out_ext in _FORMAT_MAP else None)
        if target is None:
            return "转格式要给 format：png / jpg / jpeg / webp（或在 output_path 写成目标扩展名）。"
        default_suffix = "." + ("jpg" if target == "jpeg" else target)

    try:
        out, overwrite = _out_path(src, args, ctx, default_suffix=default_suffix)
    except ValueError as e:
        return f"输出路径不行：{e}（另存的位置也要在沙箱内）"

    try:
        backup = _save_image(out_img, out, overwrite_src=overwrite, src=src, quality=quality)
    except Exception as e:  # noqa: BLE001
        logger.warning("edit_image 保存失败", exc_info=True)
        return f"图片处理好了但保存失败（{type(e).__name__}）：{e}"

    try:
        size_kb = out.stat().st_size / 1024
        size_str = f"，{size_kb:.0f} KB"
    except OSError:
        size_str = ""
    where = "已覆盖原图" if overwrite else f"已另存为 {out.name}"
    msg = f"图片处理完成：{note}。{where}（{out.name}{size_str}）。"
    if backup:
        msg += " 原件已备份到 .backups，可回滚。"
    return msg


# ────────────────────────────── 审批预览（确认前给老板看"会对哪张图做什么"） ──────────────────────────────

def preview_edit_image(args: dict, ctx) -> str:
    """改图前的人话预览：哪张图、做什么、存哪（是否覆盖）。读不到图也绝不抛错。"""
    name = Path(args.get("path", "?") or "?").name
    operation = (args.get("operation") or "?").strip().lower()
    op_cn = {
        "crop": "裁剪", "resize": "缩放/改尺寸", "watermark": "加文字水印",
        "compress": "压缩(减体积)", "convert": "转格式", "rotate": "旋转",
    }.get(operation, operation)
    detail = ""
    if operation == "crop":
        detail = "（居中裁成正方形）" if (args.get("shape") or "").lower() == "square" else \
                 f"（{args.get('left','?')},{args.get('top','?')} 到 {args.get('right','?')},{args.get('bottom','?')}）"
    elif operation == "resize":
        if args.get("scale"):
            detail = f"（按 {args.get('scale')} 倍）"
        else:
            detail = f"（到 {args.get('width','自动')}×{args.get('height','自动')}）"
    elif operation == "rotate":
        detail = f"（{args.get('angle','?')}°）"
    elif operation == "watermark":
        detail = f"（文字「{(args.get('text') or '').strip()}」，位置 {args.get('position','右下')}）"
    elif operation == "compress":
        detail = f"（质量 {args.get('quality', 70)}）"
    elif operation == "convert":
        detail = f"（转成 {args.get('format') or Path(args.get('output_path','') or '').suffix.lstrip('.') or '?'}）"
    out_raw = (args.get("output_path") or "").strip()
    where = f"另存为《{Path(out_raw).name}》" if out_raw else "覆盖原图（改前自动备份、可回滚）"
    return f"将对图片《{name}》做【{op_cn}】{detail}，{where}。"


# ────────────────────────────── 工具定义 + 注册 ──────────────────────────────

_IMAGE_TOOLS = [
    Tool(
        name="edit_image",
        description="在老板本机【处理一张图片】（裁剪 / 缩放改尺寸 / 加文字水印 / 压缩减体积 / 转格式 / 旋转）。"
                    "老板说『把这张图压缩一下 / 裁成方形 / 加个水印 / 转成 jpg / 缩小点 / 转个方向』时用。"
                    "先确保图片在内容库里、或老板已用文件选择器选定。改前自动备份原件、可回滚；"
                    "不给 output_path＝覆盖原图（已备份），给了＝另存。一次只做一种 operation。"
                    "操作参数："
                    "crop→shape='square'居中裁方 或 left/top/right/bottom 像素框；"
                    "resize→width/height(只给一边按比例算另一边) 或 scale 倍数；"
                    "watermark→text(必填)+position(右下/左下/右上/左上/居中)+opacity(0-100)；"
                    "compress→quality(10-95,越低越小)；convert→format(png/jpg/webp)；rotate→angle(度,如90)。",
        parameters={"type": "object", "properties": {
            "path": {"type": "string", "description": "要处理的图片（内容库内文件名/相对路径，或老板选定图片的完整路径）"},
            "operation": {"type": "string", "enum": ["crop", "resize", "watermark", "compress", "convert", "rotate"],
                          "description": "要做的处理"},
            "output_path": {"type": "string", "description": "另存到哪（可选，不给=覆盖原图，覆盖前自动备份）"},
            "shape": {"type": "string", "description": "crop 用：square=居中裁成正方形"},
            "left": {"type": "integer", "description": "crop 用：裁剪框左边像素"},
            "top": {"type": "integer", "description": "crop 用：裁剪框上边像素"},
            "right": {"type": "integer", "description": "crop 用：裁剪框右边像素"},
            "bottom": {"type": "integer", "description": "crop 用：裁剪框下边像素"},
            "width": {"type": "integer", "description": "resize 用：目标宽（只给宽则按比例算高）"},
            "height": {"type": "integer", "description": "resize 用：目标高（只给高则按比例算宽）"},
            "scale": {"type": "number", "description": "resize 用：按倍数缩放，如 0.5 缩一半、2 放大一倍"},
            "angle": {"type": "number", "description": "rotate 用：旋转角度（度），如 90 / 180 / -90"},
            "text": {"type": "string", "description": "watermark 用：水印文字"},
            "position": {"type": "string", "description": "watermark 用：右下/左下/右上/左上/居中（默认右下）"},
            "opacity": {"type": "integer", "description": "watermark 用：透明度 0-100（默认 60）"},
            "font_size": {"type": "integer", "description": "watermark 用：字号（可选，默认按图宽算）"},
            "quality": {"type": "integer", "description": "compress 用：质量 10-95（越低体积越小，仅 jpg/webp 有效）"},
            "format": {"type": "string", "enum": ["png", "jpg", "jpeg", "webp"], "description": "convert 用：转成什么格式"},
        }, "required": ["path", "operation"]},
        handler=edit_image,
        requires_approval=True,
        approval_class="file",
        preview=preview_edit_image,
    ),
]


def register_image_tools(registry=None) -> int:
    """把本地图像处理工具注册进注册表。仅桌面本地模式调用。返回注册数（已存在的跳过，幂等）。"""
    reg = registry or default_registry
    for t in _IMAGE_TOOLS:
        if reg.get(t.name) is None:
            reg.register(t)
    return len(_IMAGE_TOOLS)


# 仅桌面全本地模式自动注册（云端 web 版不设 DESKTOP_LOCAL → 拿不到本机改图工具）
if os.environ.get("DESKTOP_LOCAL") == "1":
    register_image_tools()
    logger.info("已注册 %d 个本地图像处理工具（桌面全本地模式）", len(_IMAGE_TOOLS))
