"""视频自动剪辑核心包(纯逻辑·无 FastAPI 依赖·可单测)。

数据流:素材 → 感知(transcribe/scene_detect) → 表示(pack) → 决策(EDL) → 渲染(render) → 成片。
EDL 是大脑(LLM)与双手(ffmpeg)之间的唯一契约。16 条正确性铁律写死在 render.py。
"""
