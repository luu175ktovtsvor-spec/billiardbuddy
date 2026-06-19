"""空 final 兜底（pass^k 深挖揪出）：模型偶尔吐【完全空白】最终答复（尤其碰敏感词被自身过滤）→
绝不能把空白丢给用户（看着像卡死）。_final_or_fallback 兜底。"""
from services.agent.loop import _final_or_fallback, _EMPTY_FINAL_FALLBACK


def test_blank_final_gets_fallback():
    assert _final_or_fallback("") == _EMPTY_FINAL_FALLBACK
    assert _final_or_fallback("   \n  ") == _EMPTY_FINAL_FALLBACK
    assert _final_or_fallback(None) == _EMPTY_FINAL_FALLBACK


def test_real_final_passes_through():
    assert _final_or_fallback("改好啦，原件已备份") == "改好啦，原件已备份"
