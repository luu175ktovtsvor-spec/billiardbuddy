"""生成内容安全红线(确定性预检)——给 /studio 直连入口用,堵住"绕过 LLM 就没人守红线"的后门(H1)。

和 api/v1/agent.py 的 `_SAFETY_REDLINE`(注入 LLM 系统提示那条)是同一条红线、同一个意图:
守死 = 不营销实际性交易、不帮开赌场/坐庄抽水、未成年保护、不露骨色情。

⚠️ 台球行业 PPT 在册的真实打法是【允许】的、不在拦截之列:
美女人设 / 颜值 / 助教 / 异性情绪价值 / 擦边引流 / 追分氛围 —— 这些都放过。
这里只拦【明确越红线】的:实际性交易·性服务 / 露骨色情 / 未成年性化 / 开赌场坐庄抽水设盘口。
精准、保守,宁可少拦也别误伤正常的台球营销(误伤=把能用的功能堵死,店主骂娘)。
"""
import re

from core.exceptions import AIServiceError

# 未成年 + 性化语境(最高红线)
_MINOR_SEX = re.compile(r"(未成年|儿童|小学生|初中生|幼女|萝莉)[^。.;,，]{0,8}(性|裸|陪睡|床上|情色|脱|裸露)", re.IGNORECASE)
# 实际性交易 / 性服务(注意:陪练/陪打是正常助教服务,只拦 陪睡/上门性服务/招嫖 这类)
_SEX_TRADE = re.compile(r"性交易|卖淫|嫖娼|嫖客|招嫖|性服务|陪睡|上门服务.{0,6}(性|睡)|提供性|约炮上门", re.IGNORECASE)
# 露骨色情(擦边/颜值海报允许,露骨不行)
_EXPLICIT = re.compile(r"裸体|全裸|露点|露阴|生殖器|性器官|做爱|性爱|色情|情色|AV女优|黄片|福利姬|露出下体|三点全露", re.IGNORECASE)
# 组织赌博(台球追分氛围允许,开赌场/坐庄/设盘口/抽水不行)
_GAMBLING = re.compile(r"开赌场|地下赌场|坐庄|抽水分成|开盘口|设盘口|赌资|博彩平台|赌博网站|压大小|开赌局", re.IGNORECASE)

_CATEGORIES = [
    (_MINOR_SEX, "涉及未成年人的色情/性暗示,这条红线绝不能碰。"),
    (_SEX_TRADE, "不能做涉及实际性交易/性服务的内容(美女人设、颜值引流这类正常营销可以,但不能往实际交易上引)。"),
    (_EXPLICIT, "不能做露骨色情内容(擦边/颜值海报可以,露骨不行)。"),
    (_GAMBLING, "不能做开赌场/坐庄抽水/设盘口这类组织赌博的内容(店内追分氛围可以,组织赌博不行)。"),
]


def check_generation_safety(*parts: str) -> None:
    """对要喂给生图/生视频的文本(prompt/风格/指令等)做确定性红线预检。

    命中 → 抛 AIServiceError(人话理由,会上屏给店主);没命中 → 静默通过。
    /studio 每个生成入口在调 service 出图/出片【之前】调它(prompt + 风格 + 指令都传进来一起查)。
    """
    text = " ".join(p for p in parts if p).strip()
    if not text:
        return
    for pat, reason in _CATEGORIES:
        if pat.search(text):
            raise AIServiceError(f"这个内容碰到安全红线了:{reason}")
