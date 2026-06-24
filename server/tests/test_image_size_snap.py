"""gpt-image 尺寸吸附：防 16:9(2048x1152) / 3:4(1152x1536) 等被 OpenAI 400「Invalid size」拒。

- gpt-image-1：只认 1024x1024 / 1024x1536 / 1536x1024 / auto → 按比例吸附到这三档。
- gpt-image-2（默认·专题D 海外生图）：约束宽很多（比例 1:3~3:1、总像素区间、16 整除、最大边 3840），
  尽量【保住请求比例】而非一律压成 1024 三档。
"""
from services.ai.providers.openai_image import (
    _snap_gpt_image_size, _snap_gpt_image1_size, _snap_gpt_image2_size,
)


# ---------- gpt-image-1：三档吸附（旧行为，显式传 model 才走它）----------

def test_gpt_image1_supported_unchanged():
    assert _snap_gpt_image1_size("1024x1024") == "1024x1024"
    assert _snap_gpt_image1_size("1024x1536") == "1024x1536"
    assert _snap_gpt_image1_size("1536x1024") == "1536x1024"
    assert _snap_gpt_image1_size("auto") == "auto"


def test_gpt_image1_snapped_by_aspect():
    assert _snap_gpt_image1_size("2048x1152") == "1536x1024"  # 16:9 横 → 横
    assert _snap_gpt_image1_size("1152x1536") == "1024x1536"  # 3:4 竖 → 竖
    assert _snap_gpt_image1_size("1200x1200") == "1024x1024"  # 方 → 方


def test_dispatch_by_model_keeps_image1_buckets():
    assert _snap_gpt_image_size("2048x1152", "gpt-image-1") == "1536x1024"


# ---------- gpt-image-2：保比例、只钳进官方约束 ----------

def test_gpt_image2_keeps_aspect_ratio():
    # 16:9 不再被压成 1536x1024，而是保住比例（2048/1152 都是 16 整除、在像素区间内 → 原样）
    assert _snap_gpt_image_size("2048x1152") == "2048x1152"
    # 1080 非 16 整除 → 吸附到最近 16 倍数 1088（仍近 16:9、合法）
    assert _snap_gpt_image2_size("1920x1080") == "1920x1088"


def test_gpt_image2_presets_pass_through():
    for s in ("1024x1024", "1024x1536", "1536x1024", "auto"):
        assert _snap_gpt_image2_size(s) == s


def test_gpt_image2_clamps_extreme_ratio():
    out = _snap_gpt_image2_size("4000x100")  # 远超 3:1
    w, h = (int(x) for x in out.split("x"))
    assert 1 / 3 - 0.05 <= w / h <= 3 + 0.05         # 比例被钳回 ~3:1
    assert w % 16 == 0 and h % 16 == 0


def test_gpt_image2_clamps_max_pixels():
    out = _snap_gpt_image2_size("8000x8000")          # 6400 万像素 → 超 829 万上限
    w, h = (int(x) for x in out.split("x"))
    assert w * h <= 8_294_400 + 16 * 16               # 钳到上限内（容一点 16 取整误差）
    assert max(w, h) <= 3840


def test_gpt_image2_garbage_falls_back_square():
    assert _snap_gpt_image2_size("weird") == "1024x1024"
