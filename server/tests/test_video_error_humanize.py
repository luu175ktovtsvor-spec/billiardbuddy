"""真人脸视频限制 → 大白话翻译(P1b)。老板对着助教美图点"做成视频"会撞,别甩英文报错。"""
from services.video_service import _humanize_video_error


def test_real_person_error_humanized():
    raw = '视频生成提交失败(400):{"error":{"code":"InputImageSensitiveContentDetected.PrivacyInformation","message":"The request failed because the input image may contain real person."}}'
    out = _humanize_video_error(raw)
    assert out is not None
    assert "真人脸" in out and "建议" in out
    assert "InputImage" not in out  # 不暴露原始英文


def test_unknown_error_passes_through():
    assert _humanize_video_error("某种网络超时 ECONNRESET") is None  # 认不出→None(原样抛)
    assert _humanize_video_error("") is None
