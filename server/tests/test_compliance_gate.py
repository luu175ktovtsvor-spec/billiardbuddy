"""业务铁律代码闸（绝对化广告词）测试。

两个必须同时成立：
- 抓得住：违广告法的绝对化词被确定性替换（不靠模型自觉）。
- 不误伤：内部内容的真实卖点/口语（美女助教/追分/正常送台费）一个字都不动。
  （项目踩过"消毒一刀切"的坑，这条比"抓得住"更不能破。）
"""
from core.security_guard import filter_compliance, scan_compliance, filter_output_leak


def test_replaces_absolute_ad_terms():
    assert filter_compliance("本店全城最低价，速来") == "本店实惠价格，速来"
    assert filter_compliance("充值终身免费畅打") == "充值长期优惠畅打"
    assert "最低" not in filter_compliance("全网最低的台费")
    assert "永久免费" not in filter_compliance("会员永久免费")


def test_longest_match_first_no_leftover():
    # "全城最低价" 应整体换掉，不留"优惠价"以外的残词
    out = filter_compliance("打出全城最低价的口号")
    assert "最低" not in out and "全城最低" not in out


def test_does_not_overfire_on_internal_content():
    # 这些是行业真实卖点/口语，绝不能被动（渠道相关词不在代码闸里）
    samples = [
        "安排个美女助教陪练，气质好",
        "两位客人你情我愿追分较劲，帮着把金额控住",
        "充1000送200台费，小比例赠送",
        "学生放学后周末来打球有优惠",
        "今晚朋友圈：周末双人优惠场，速来",
    ]
    for s in samples:
        assert filter_compliance(s) == s, f"误伤了内部内容: {s}"


def test_scan_reports_hits_without_changing():
    hits = scan_compliance("全城最低价 + 终身免费")
    assert "全城最低价" in hits and "终身免费" in hits


def test_empty_and_clean():
    assert filter_compliance("") == ""
    assert filter_compliance("正常的周末活动文案，无违规词") == "正常的周末活动文案，无违规词"
    assert scan_compliance("正常文案") == []


def test_filter_output_leak_now_also_applies_compliance():
    # 正常(无泄露)文本走 filter_output_leak 也会套上铁律闸
    assert filter_output_leak("我们全城最低价") == "我们实惠价格"
    # 既防泄露又过铁律：含泄露行被删 + 绝对化词被换
    out = filter_output_leak("我是一个AI大模型\n本店全城最低价优惠")
    assert "AI大模型" not in out
    assert "全城最低" not in out and "实惠" in out
