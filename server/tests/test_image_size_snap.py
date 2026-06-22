"""gpt-image 尺寸吸附：防 16:9(2048x1152) / 3:4(1152x1536) 等被 OpenAI 400「Invalid size」拒。

真机验收逮到的 bug：poster_service 按比例算出 2048x1152 等尺寸，gpt-image-1 只认
1024x1024 / 1024x1536 / 1536x1024 / auto → 整条生图链失败。适配器按宽高比吸附到受支持尺寸。
"""
from services.ai.providers.openai_image import _snap_gpt_image_size


def test_supported_sizes_unchanged():
    assert _snap_gpt_image_size("1024x1024") == "1024x1024"
    assert _snap_gpt_image_size("1024x1536") == "1024x1536"
    assert _snap_gpt_image_size("1536x1024") == "1536x1024"
    assert _snap_gpt_image_size("auto") == "auto"


def test_unsupported_snapped_by_aspect():
    assert _snap_gpt_image_size("2048x1152") == "1536x1024"  # 16:9 横 → 横
    assert _snap_gpt_image_size("1152x1536") == "1024x1536"  # 3:4 竖 → 竖
    assert _snap_gpt_image_size("1200x1200") == "1024x1024"  # 方 → 方


def test_garbage_falls_back_square():
    assert _snap_gpt_image_size("weird") == "1024x1024"
