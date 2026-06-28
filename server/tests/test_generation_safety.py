"""阶段2 H1 安全红线预检:/studio 直连绕过 LLM,这道确定性预检必须拦住明确越红线的生成内容,
同时【放过】台球 PPT 在册的真实打法(美女/颜值/助教/擦边/追分),别误伤正常营销。
"""
import pytest

from core.exceptions import AIServiceError
from core.safety import check_generation_safety


# —— 必须放过(台球行业真实运营·PPT 允许)——
@pytest.mark.parametrize("ok", [
    "做一张 9:16 的台球周赛海报，适合发朋友圈",
    "美女助教颜值海报，擦边引流，朋友圈风格",
    "台球之夜，追分氛围，火热对战",
    "店里美女陪练，异性情绪价值，温馨灯光",
    "助教陪打教学，新手友好，9:16 竖版",
    "周末台球挑战赛，奖金丰厚，欢迎报名",
    "",
])
def test_legit_billiards_passes(ok):
    check_generation_safety(ok)  # 不抛 = 通过


# —— 必须拦(明确越红线)——
@pytest.mark.parametrize("bad", [
    "性交易上门服务海报",
    "招嫖信息配图",
    "助教提供性服务，陪睡套餐",
    "全裸美女露点海报",
    "色情情色内容",
    "未成年小学生擦边陪睡",
    "开赌场坐庄抽水分成宣传",
    "设盘口压大小赌博网站",
])
def test_redline_blocked(bad):
    with pytest.raises(AIServiceError):
        check_generation_safety(bad)


def test_checks_all_parts_joined():
    # prompt 干净但风格/指令里藏了红线 → 也要拦(多段一起查)
    with pytest.raises(AIServiceError):
        check_generation_safety("做个海报", "风格：清新", "再加上性交易上门服务")
