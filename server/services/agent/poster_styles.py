"""海报风格预设库（借鉴 Fooocus/SDXL 风格预设的做法：风格 = 一段丰富的视觉提示词片段）。

关键链路（解决"点了风格模型收不到=死模板库"）：
  老板点风格 → make_poster 的 style 参数 → resolve_style_prompt 查到这段提示词 → 拼进图像提示词 → 模型收到 → 出对味的图。

每个风格的 prompt 片段按文生图提示词结构组织（色调/光线/材质/质感/构图关键词），对国内模型（Kolors/通义万相等）也有效。
风格要么不给、要给就给足够多样——这里 10 种覆盖台球房常见场景；老板也可"自己说"传任意 style 字符串（原样拼入）。
**单一来源**：前端风格卡片、Agent 的 AskUserQuestion 选项都应来自这份目录（label+desc）。
"""

# key: 稳定标识；label: 给老板看的名字；desc: 一句话说明（UI/选项卡用）；prompt: 喂给模型的丰富视觉片段
POSTER_STYLES: list[dict] = [
    {"key": "warm", "label": "暖色温馨", "desc": "情侣/朋友局，温暖有约会感",
     "prompt": "暖色调海报，橙红与暖黄渐变背景，柔和温暖的光线，温馨惬意氛围，胶片质感，简洁留白构图，高级感"},
    {"key": "neon", "label": "动感霓虹", "desc": "年轻夜场，潮酷吸睛",
     "prompt": "霓虹灯光效，赛博朋克夜店风，紫蓝粉高饱和强对比，发光线条与光晕，暗色背景，潮流动感，时尚酷炫"},
    {"key": "minimal", "label": "简约高级", "desc": "干净留白，质感门店",
     "prompt": "极简主义海报，大量留白，黑白灰低饱和高级灰，干净利落的排版，几何构图，高端质感，性冷淡风"},
    {"key": "festive", "label": "节日喜庆", "desc": "春节/中秋等节日营销",
     "prompt": "节日喜庆氛围，红金主色调，灯笼烟花祥云等节日元素，金色光泽，热闹喜气，对称大气构图"},
    {"key": "luxury", "label": "高端轻奢", "desc": "充值/会员/高端局",
     "prompt": "高端轻奢风，深色背景配香槟金点缀，磨砂金属质感，柔和打光，精致细节，优雅留白，质感拉满"},
    {"key": "sporty", "label": "活力运动", "desc": "比赛/约球/年轻人",
     "prompt": "活力运动风，明快撞色，速度感动感线条，强对比高饱和，年轻有冲击力，斜切动态构图"},
    {"key": "fresh", "label": "清新ins", "desc": "女生友好/闺蜜局/出片",
     "prompt": "清新ins风，低饱和马卡龙配色，柔和自然光，小清新治愈感，简洁留白，文艺氛围，适合拍照出片"},
    {"key": "retro", "label": "复古港风", "desc": "怀旧/夜场/氛围感",
     "prompt": "复古港风，80年代霓虹与暖调灯光，怀旧胶片颗粒质感，港式招牌字与霓虹招牌，浓郁氛围感"},
    {"key": "guochao", "label": "新中式国潮", "desc": "国风/有格调",
     "prompt": "新中式国潮风，墨色与朱红主色，水墨笔触结合现代几何，传统纹样点缀，大气醒目，有文化质感"},
    {"key": "tech", "label": "科技未来", "desc": "电竞/科技感",
     "prompt": "科技未来感，深蓝黑科技背景，发光网格与粒子光效，金属冷色质感，立体空间感，电竞炫酷"},
]

_BY_KEY = {s["key"]: s for s in POSTER_STYLES}
_BY_LABEL = {s["label"]: s for s in POSTER_STYLES}


def resolve_style_prompt(style: str | None) -> str | None:
    """把老板选的风格（key 或中文 label，甚至带点变体）解析成丰富的提示词片段；解析不到返回 None。
    解析不到时调用方应把原始 style 字符串原样拼入（支持老板"自己说"任意风格）。"""
    if not style:
        return None
    s = style.strip()
    if s in _BY_KEY:
        return _BY_KEY[s]["prompt"]
    if s in _BY_LABEL:
        return _BY_LABEL[s]["prompt"]
    # 容错：label 是输入的子串或反之（如"暖色温馨风"/"暖色"）
    for label, item in _BY_LABEL.items():
        if label in s or s in label:
            return item["prompt"]
    return None


def style_options() -> list[dict]:
    """给 Agent 的 AskUserQuestion / 前端风格卡片用的选项（label + desc）。"""
    return [{"label": s["label"], "description": s["desc"]} for s in POSTER_STYLES]


def style_labels_hint() -> str:
    """给工具描述里列可选风格用的一行文本。"""
    return " / ".join(s["label"] for s in POSTER_STYLES)
