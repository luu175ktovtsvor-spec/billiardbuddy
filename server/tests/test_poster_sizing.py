# -*- coding: utf-8 -*-
"""海报比例 → 像素尺寸的正确性（纯逻辑，进主套件）。

锁住两个不变量：
- 每个比例映射出的宽高真的对应它声称的比例（修复 3:4/9:16/16:9 全发错尺寸的 bug）。
- 宽高都是 16 的倍数（gpt-image-2 的尺寸约束）。
"""
from services.poster_service import SIZE_MAP, get_size_options

# 声称的比例 → 期望宽高比（宽/高）
_EXPECTED_RATIO = {
    "3:4": 3 / 4,
    "1:1": 1.0,
    "9:16": 9 / 16,
    "16:9": 16 / 9,
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
