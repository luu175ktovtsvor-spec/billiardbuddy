# -*- coding: utf-8 -*-
"""海报比例 → 像素尺寸的正确性（纯逻辑，进主套件）。

锁住两个不变量：
- 每个比例映射出的宽高真的对应它声称的比例（修复 3:4/9:16/16:9 全发错尺寸的 bug）。
- 宽高都是 16 的倍数（gpt-image-2 的尺寸约束）。

E2-1b 新增：易拉宝 2:5 / 横幅 5:2 是 Seedream 专属新挡，钉住三件事——
1. SIZE_MAP 里必须有它们自己的真实映射，不再静默回退 3:4（回退的话就是"标 2:5 实出 3:4"）。
2. 尺寸必须是查证过的 Seedream 合法尺寸：过 _SEEDREAM_MIN_PIXELS(3,686,400) 像素下限，
   喂进 _normalize_seedream_size 不会被二次缩放（否则可能因取整拉伸偏离声称比例）。
3. 不管上面路由算出什么模型，这两挡必须强制落 Seedream，绝不能送去 gpt-image-2。
"""
import pytest
from PIL import Image

from core.exceptions import AIServiceError
from services.ai.providers.seedream_image import _SEEDREAM_MIN_PIXELS, _normalize_seedream_size
from services.poster_service import (
    _AUTO_ROUTE_SEEDREAM_MODEL,
    SIZE_MAP,
    _assert_saved_ratio,
    _force_seedream_for_ratio,
    get_size_options,
)

# 声称的比例 → 期望宽高比（宽/高）
_EXPECTED_RATIO = {
    "3:4": 3 / 4,
    "1:1": 1.0,
    "9:16": 9 / 16,
    "16:9": 16 / 9,
    "2:5": 2 / 5,
    "5:2": 5 / 2,
}


def _wh(size: str) -> tuple[int, int]:
    w, h = size.lower().split("x")
    return int(w), int(h)


def test_each_ratio_maps_to_its_true_aspect():
    for ratio, expected in _EXPECTED_RATIO.items():
        w, h = _wh(SIZE_MAP[ratio])
        assert abs(w / h - expected) < 0.01, f"{ratio} 映射成 {SIZE_MAP[ratio]}（比例 {w/h:.4f}），应为 {expected:.4f}"


def test_dimensions_are_multiples_of_16():
    for ratio, size in SIZE_MAP.items():
        w, h = _wh(size)
        assert w % 16 == 0 and h % 16 == 0, f"{ratio}={size} 宽高必须是 16 的倍数"


def test_distinct_ratios_get_distinct_sizes():
    # 3:4 与 9:16 曾被错误地映射成同一个尺寸 → 选不同比例出同一张图
    assert SIZE_MAP["3:4"] != SIZE_MAP["9:16"]


def test_size_options_keys_all_have_mapping():
    for opt in get_size_options():
        assert opt["value"] in SIZE_MAP


def test_saved_image_ratio_validation_accepts_matching_file(tmp_path):
    p = tmp_path / "poster.jpg"
    Image.new("RGB", (1152, 2048), "white").save(p)
    assert _assert_saved_ratio(p, "9:16") == (1152, 2048)


def test_saved_image_ratio_validation_rejects_wrong_file(tmp_path):
    p = tmp_path / "poster.jpg"
    Image.new("RGB", (1024, 1024), "white").save(p)
    with pytest.raises(AIServiceError, match="图片比例校验失败"):
        _assert_saved_ratio(p, "9:16")


# ────────────────────── E2-1b：易拉宝 2:5 / 横幅 5:2（Seedream 专属新挡） ──────────────────────


def test_seedream_only_ratios_have_their_own_true_mapping_not_3_4_fallback():
    """核心正确性要求：2:5/5:2 必须在 SIZE_MAP 里有自己的映射，且真是声称的比例——
    不是"没登记、悄悄给了 3:4 的尺寸却打上 2:5 的标签"（E2-1 当初正是因为没做这步才不敢加前端挡）。"""
    for ratio, expected in {"2:5": 2 / 5, "5:2": 5 / 2}.items():
        assert ratio in SIZE_MAP, f"{ratio} 必须在 SIZE_MAP 里有专属映射"
        w, h = _wh(SIZE_MAP[ratio])
        assert abs(w / h - expected) < 0.01, f"{ratio} 映射成 {SIZE_MAP[ratio]}，比例 {w/h:.4f} 应为 {expected:.4f}"
        # 不能和 3:4 撞尺寸——真撞了就说明还是那个"实际出 3:4"的老 bug
        assert SIZE_MAP[ratio] != SIZE_MAP["3:4"]


def test_seedream_only_sizes_clear_the_seedream_pixel_floor_without_rescaling():
    """查证结论钉死：这两挡的像素总量已经过 Seedream 真机实测的下限(3,686,400px)，喂进
    provider 自己的 _normalize_seedream_size 时不会被二次放大——否则取整拉伸可能让最终
    送到 Seedream 的宽高比偏离声称的 2:5/5:2（尤其对这种细长比例，缩放引入的取整误差
    被放大得更明显）。"""
    for ratio in ("2:5", "5:2"):
        w, h = _wh(SIZE_MAP[ratio])
        assert w * h >= _SEEDREAM_MIN_PIXELS, f"{ratio}={SIZE_MAP[ratio]} 未过 Seedream 像素下限"
        # 已经达标 → normalize 函数应原样透传，不做任何缩放/取整改动
        assert _normalize_seedream_size(SIZE_MAP[ratio]) == SIZE_MAP[ratio]


def test_saved_image_ratio_validation_accepts_matching_2_5(tmp_path):
    p = tmp_path / "poster.jpg"
    w, h = _wh(SIZE_MAP["2:5"])
    Image.new("RGB", (w, h), "white").save(p)
    assert _assert_saved_ratio(p, "2:5") == (w, h)


def test_saved_image_ratio_validation_accepts_matching_5_2(tmp_path):
    p = tmp_path / "poster.jpg"
    w, h = _wh(SIZE_MAP["5:2"])
    Image.new("RGB", (w, h), "white").save(p)
    assert _assert_saved_ratio(p, "5:2") == (w, h)


def test_saved_image_ratio_validation_rejects_3_4_labeled_as_2_5(tmp_path):
    """证明不再静默回退 3:4：一张真 3:4 图，标成 "2:5" 必须被判定不符——这正是加新挡前的
    危险行为（未登记比例会拿 3:4 的期望值去校验，一张 3:4 图会被误判"通过"）。"""
    p = tmp_path / "poster.jpg"
    w, h = _wh(SIZE_MAP["3:4"])
    Image.new("RGB", (w, h), "white").save(p)
    with pytest.raises(AIServiceError, match="图片比例校验失败"):
        _assert_saved_ratio(p, "2:5")


def test_saved_image_ratio_validation_rejects_3_4_labeled_as_5_2(tmp_path):
    p = tmp_path / "poster.jpg"
    w, h = _wh(SIZE_MAP["3:4"])
    Image.new("RGB", (w, h), "white").save(p)
    with pytest.raises(AIServiceError, match="图片比例校验失败"):
        _assert_saved_ratio(p, "5:2")


def test_seedream_only_ratio_forces_seedream_even_if_routed_to_gpt():
    """gpt-image-2 出不了这么极端的长宽比——2:5/5:2 必须强制落 Seedream，不管内容启发式/
    改图路由/调用方显式选了什么模型。"""
    assert _force_seedream_for_ratio("gpt-image-2", "2:5") == _AUTO_ROUTE_SEEDREAM_MODEL
    assert _force_seedream_for_ratio("gpt-image-2", "5:2") == _AUTO_ROUTE_SEEDREAM_MODEL
    assert _force_seedream_for_ratio(None, "2:5") == _AUTO_ROUTE_SEEDREAM_MODEL
    assert _force_seedream_for_ratio("", "5:2") == _AUTO_ROUTE_SEEDREAM_MODEL


def test_seedream_only_ratio_leaves_already_seedream_model_untouched():
    assert _force_seedream_for_ratio("doubao-seedream-5-0-260128", "2:5") == "doubao-seedream-5-0-260128"


def test_normal_ratios_unaffected_by_seedream_only_forcing():
    """普通比例(3:4/1:1/9:16/16:9)不受这条新规则影响——GPT 该走还走，不该被误伤。"""
    assert _force_seedream_for_ratio("gpt-image-2", "3:4") == "gpt-image-2"
    assert _force_seedream_for_ratio(None, "16:9") is None


def test_size_options_includes_new_seedream_only_slots():
    values = {opt["value"] for opt in get_size_options()}
    assert {"2:5", "5:2"} <= values
