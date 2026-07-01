"""台球视频领域知识包 —— 提炼自台球行业真实运营逻辑(PPT 底本),只在"识别到台球内容"时注入。

架构原则(镜像整个产品):视频编排**通用兜底 + 台球加持**。豆包看画面判断是不是台球;
是 → 注入本包的场景打法(文案/风格/音乐调性都按台球真实逻辑走);不是 → 让模型自由发挥。

⚠️ 铁律(与知识库一致):
- 中性措辞,不出现任何来源/机构名;器材品牌(乔氏/星牌)、交友软件名是行业必需真实信息,保留。
- 两条安全红线永远在:助教守自爱不越界(不实际性交易)、门店只控金额不当庄抽水。
- 只落 PPT 有据的打法(氛围/助教/擦边引流/追分/人气),不因"听着擦边"误当红线。
"""
from __future__ import annotations

# 台球视频总纲(注入所有台球分支的公共前缀)
BILLIARDS_PREAMBLE = (
    "【这是台球房/球房视频,按台球行业真实运营逻辑来做】\n"
    "球房两大卖点 = 氛围(视觉=人气) + 助教(异性情绪价值)。视频核心就是把这两点拍出来、让人想来店。\n"
    "内容分两型:获客型(讲产品卖点·口播)、流量型(靠颜值氛围引流·擦边是行业正经打法,别误当违规)。\n"
    "红线只有两条:助教颜值/情绪价值/擦边引流照做,但不碰实际性交易;门店不当庄不抽水。"
)

# 氛围类三种场景(对应 PPT 展示三型)+ 口播类,每类给文案/风格/音乐调性指引
_SCENES = {
    "门店环境": {
        "desc": "门店环境展示(B-roll):装修档次、球台(乔氏/星牌)、引流台、灯光、满台人气。卖'视觉=人气、高端沉浸'。",
        "caption": "文案走高级冷静、突出档次与沉浸感(如'沉浸式球房''高端约球局'),别硬塞价格。",
        "style": "电影感:慢运镜(kenburns/pan)、淡入淡出(fade)转场、冷静克制,主题色偏冷(青/蓝/暗金)。",
        "music": {"mood": "chill", "note": "电影感慢节奏,不要嗨"},
    },
    "助教展示": {
        "desc": "助教展示(美女展示):助教颜值、打球英姿、情绪价值。人设四型 性感/可爱/飒爽/潮酷,文案与风格跟人设走。",
        "caption": "文案跟人设:性感=撩人、可爱=萌甜、飒爽=帅气、潮酷=酷炫;突出颜值/亲和/陪玩情绪价值,不要竞技术语堆砌。",
        "style": "俏皮有活力:卡点、pop/slide字幕、暖色调;人设潮酷/飒爽可上快切glitch,可爱/性感偏柔。",
        "music": {"mood": "hype", "note": "跟人设:可爱/性感偏柔(chill),飒爽/潮酷偏嗨(hype)"},
    },
    "人气氛围": {
        "desc": "人气氛围(场景展示):满台、追分、嗨的现场氛围。卖'人气旺、来了不孤单、氛围好'。",
        "caption": "文案突出热闹/人气/氛围感(如'今晚又是满台''约球的快乐'),追分点到氛围为止不渲染赌。",
        "style": "快切卡点、闪切(flash/glitch)、动感,暖色高饱和,节奏紧。",
        "music": {"mood": "hype", "note": "卡点快节奏、嗨"},
    },
    "口播讲解": {
        "desc": "口播类(获客型/产品卖点):店主/助教对镜讲来店理由——台费/助教服务/开业活动/充值促销/环境优势。",
        "caption": "结构 钩子→卖点→行动号召;字幕跟着口播划重点(数字/优惠/卖点),清晰不花哨。",
        "style": "字幕清晰稳重、位置固定(底部),转场简洁(fade/none),别抢口播。",
        "music": {"mood": "chill", "note": "背景垫乐、音量低,别盖口播"},
    },
}

_PERSONAS = ["性感", "可爱", "飒爽", "潮酷"]  # 助教人设四型(PPT P188)


def scene_list() -> list[str]:
    return list(_SCENES.keys())


def caption_guidance(scene: str) -> str:
    """给 director.caption_shots 注入的台球场景文案指引。"""
    s = _SCENES.get(scene)
    if not s:
        return BILLIARDS_PREAMBLE
    return f"{BILLIARDS_PREAMBLE}\n本片场景 = {s['desc']}\n文案要求:{s['caption']}"


def style_guidance(scene: str) -> str:
    """给 director.plan_style 注入的台球场景风格指引。"""
    s = _SCENES.get(scene)
    if not s:
        return BILLIARDS_PREAMBLE
    return f"{BILLIARDS_PREAMBLE}\n本片场景 = {s['desc']}\n视觉风格要求:{s['style']}"


def music_hint(scene: str) -> dict:
    """台球场景的音乐调性建议(mood + 说明)。"""
    s = _SCENES.get(scene)
    return dict(s["music"]) if s else {"mood": "auto", "note": ""}
