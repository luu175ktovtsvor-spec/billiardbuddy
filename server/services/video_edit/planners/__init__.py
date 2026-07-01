"""剪辑 Planner 层 —— "出方案"这一步的两条干净分裂管线(口播 / 氛围)。

下面共享同一份时间轴文档 + 原子操作 + 预览 + 渲染;只在"怎么挑段/怎么排布"这层分叉。
- ambient:  切镜头/切窗 → VLM 挑高光 → 卡点排布(氛围/摆拍/无口播,如颜值集锦)→ V2 模板出片
- speech:   whisper 转录 → 按说的话挑段 → 自动配字幕(获客型/产品卖点)→ render_timeline 保原声出片
"""
from .ambient import plan_ambient
from .speech import plan_speech

__all__ = ["plan_ambient", "plan_speech"]
