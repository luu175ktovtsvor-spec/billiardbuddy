"""PySceneDetect 镜头切分(纯像素·无模型权重)。"""
from __future__ import annotations


def detect_scenes(video_path: str, *, threshold: float = 27.0) -> list[tuple[float, float]]:
    """返回镜头边界 [(start_s, end_s), ...]。单镜头无内切则返回 [(0, 时长)]。"""
    from scenedetect import detect, ContentDetector
    from scenedetect.frame_timecode import FrameTimecode  # noqa: F401

    scene_list = detect(video_path, ContentDetector(threshold=threshold))
    scenes = [(round(s.get_seconds(), 3), round(e.get_seconds(), 3)) for s, e in scene_list]
    if not scenes:
        # 单镜头(无切点):整段当一个场景
        from .ffbin import probe_video

        dur = probe_video(video_path)["duration_s"]
        scenes = [(0.0, dur)]
    return scenes
