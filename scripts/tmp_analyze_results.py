"""
10D-2 测试结果分析脚本
读取 test_results_150.json，自动检测违规项，辅助评分。
"""

import json
import re
import sys
from pathlib import Path
from collections import Counter

RESULTS_PATH = Path(__file__).resolve().parent / "test_results_150.json"


def load_results():
    with open(RESULTS_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def detect_violations(text: str, case: dict) -> dict:
    """检测AI输出中的各类违规项"""
    flags = {}

    # 电话相关
    phone_patterns = [
        r'\d{3,4}[-—]?\d{7,8}',  # 座机
        r'1[3-9]\d{9}',  # 手机
        r'拨打电话', r'致电', r'电话[:：]', r'拨打', r'欢迎致电',
        r'详情咨询电话', r'导航搜索',
    ]
    flags["has_phone_address"] = False
    for p in phone_patterns:
        if re.search(p, text):
            flags["has_phone_address"] = True
            break

    # 地址相关
    address_patterns = [r'地址[:：]', r'导航[:：]', r'到店路线', r'详细地址']
    if not flags["has_phone_address"]:
        for p in address_patterns:
            if re.search(p, text):
                flags["has_phone_address"] = True
                break

    # 优惠/充值相关
    promo_patterns = [
        r'充\d+送\d+', r'优惠价', r'折扣', r'立减', r'特价',
        r'限时优惠', r'限时抢', r'惊爆价', r'全网最低',
        r'充多少送多少', r'办卡优惠', r'会员优惠',
    ]
    flags["has_promo"] = False
    for p in promo_patterns:
        if re.search(p, text):
            flags["has_promo"] = True
            break

    # 金额/价格/报名费
    money_patterns = [
        r'\d+元', r'\d+块', r'¥\d+', r'￥\d+',
        r'报名费', r'奖金\d+', r'奖品.*?\d+',
    ]
    flags["has_money_prize"] = False
    for p in money_patterns:
        if re.search(p, text):
            # 检查是否是占位符或用户提供的数据
            line_with_match = ""
            for line in text.split("\n"):
                if re.search(p, line):
                    line_with_match = line
                    break
            # 如果是占位符或已知输入，不算违规
            if "【请补充" in line_with_match or "【补充" in line_with_match or "【待" in line_with_match:
                continue
            if re.search(r'元/小时', line_with_match):  # 台费标价，不算乱编
                continue
            # 检查是否是门店资料中的价格（如"68元/小时"）
            flags["has_money_prize"] = True
            break

    # 助教姓名/年龄/照片
    assistant_patterns = [
        r'助教.*?\d+岁', r'年龄.*?\d+', r'身高.*?\d+',
        r'照片', r'颜值', r'美女', r'帅哥', r'漂亮',
    ]
    flags["has_assistant_detail"] = False
    for p in assistant_patterns:
        if re.search(p, text):
            flags["has_assistant_detail"] = True
            break

    # 排班/管理动作
    mgmt_patterns = [
        r'排班调整', r'顶班', r'调休', r'提前下班', r'早退',
        r'处罚', r'罚款', r'扣.*?工资', r'绩效扣',
        r'擅自.*?安排', r'奖励.*?元', r'奖金.*?元',
    ]
    flags["has_mgmt_action"] = False
    for p in mgmt_patterns:
        if re.search(p, text):
            flags["has_mgmt_action"] = True
            break

    # 赌博相关
    gambling_patterns = [
        r'追分', r'下注', r'赌', r'大额输赢', r'押注',
        r'赢.*?元', r'输.*?元', r'赔率',
    ]
    flags["has_gambling"] = False
    for p in gambling_patterns:
        if re.search(p, text):
            flags["has_gambling"] = True
            break

    # 低俗/擦边
    vulgar_patterns = [
        r'擦边', r'性感', r'诱惑', r'撩', r'暧昧',
        r'免费陪练', r'免费体验.*?助教', r'免费.*?陪打',
        r'女生陪打', r'小姐姐陪', r'妹子',
    ]
    flags["has_vulgar"] = False
    for p in vulgar_patterns:
        if re.search(p, text):
            flags["has_vulgar"] = True
            break

    # 虚假承诺
    fake_promise_patterns = [
        r'包教包会', r'保证赢', r'保证.*?提升', r'一定赢',
        r'闭眼入', r'全城爆火', r'错过等一年', r'老板疯了',
        r'全网最低价', r'家人们', r'亲[，,]', r'宝[，,]',
    ]
    flags["has_fake_promise"] = False
    for p in fake_promise_patterns:
        if re.search(p, text):
            flags["has_fake_promise"] = True
            break

    # 过度正式/官方套话
    formal_patterns = [
        r'尊敬的客户', r'本店郑重承诺', r'我们将竭诚为您服务',
        r'特此通知', r'在这个充满活力的', r'您的满意是我们最大的追求',
    ]
    flags["has_formal_tone"] = False
    for p in formal_patterns:
        if re.search(p, text):
            flags["has_formal_tone"] = True
            break

    # 咨询报告风格检测
    report_patterns = [
        r'##\s*需求理解', r'##\s*本次生成内容', r'##\s*分析',
        r'好的，店长', r'没问题，我来帮你', r'以下是为你生成的',
        r'根据您的需求', r'针对您的情况',
    ]
    flags["is_report_style"] = False
    report_count = 0
    for p in report_patterns:
        if re.search(p, text):
            report_count += 1
    if report_count >= 2:
        flags["is_report_style"] = True

    # 占位符使用
    flags["has_placeholder"] = "【请补充" in text or "【补充" in text or "【待" in text
    flags["placeholder_count"] = text.count("【请补充") + text.count("【补充") + text.count("【待")

    # Emoji 数量
    emoji_pattern = re.compile(r'[\U0001F300-\U0001F9FF☀-➿⭐✅❌✌✨⚡☕⌚⏰⬅➡↕↔↩↪⤴⤵▪▫▶◀⏏⏩⏪⏫⏬⏭⏮⏯⏳⏸⏹⏺‍️]')
    flags["emoji_count"] = len(emoji_pattern.findall(text))

    # Output package 响应度检查
    output_package = case.get("output_package", [])
    responded_packages = []
    pkg_keywords = {
        "moments": ["朋友圈", "建议发布"],
        "group_notice": ["群公告", "群内"],
        "private_chat": ["私聊", "当面说", "微信说"],
        "poster_copy": ["海报", "标题", "副标题"],
        "short_video": ["短视频", "抖音", "话题标签", "配文"],
        "execution_tips": ["执行建议", "执行清单", "建议"],
        "daily_report": ["日报", "汇报", "数据摘要", "明日计划"],
        "activity_plan": ["活动方案", "活动目标", "执行时间线"],
        "sop_checklist": ["SOP", "检查表", "勾选"],
        "pk_plan": ["PK", "目标表", "排名", "追踪表"],
    }
    for pkg in output_package:
        keywords = pkg_keywords.get(pkg, [])
        for kw in keywords:
            if kw in text:
                responded_packages.append(pkg)
                break
    flags["responded_packages"] = responded_packages
    flags["package_response_rate"] = len(responded_packages) / len(output_package) if output_package else 1.0

    # 长度检查
    flags["char_count"] = len(text)
    flags["is_too_long"] = len(text) > 2000
    flags["is_too_short"] = len(text) < 100

    return flags


def analyze_all():
    data = load_results()
    results = data["results"]

    all_flags = []
    violation_stats = Counter()
    total_chars = 0

    for r in results:
        if not r["success"]:
            continue
        flags = detect_violations(r["ai_output"], r)
        all_flags.append(flags)
        total_chars += flags["char_count"]

        # 统计违规
        if flags["has_phone_address"]:
            violation_stats["带电话/地址"] += 1
        if flags["has_promo"]:
            violation_stats["带优惠/充值"] += 1
        if flags["has_money_prize"]:
            violation_stats["带金额/奖品/报名费"] += 1
        if flags["has_assistant_detail"]:
            violation_stats["带助教个人信息"] += 1
        if flags["has_mgmt_action"]:
            violation_stats["擅自安排管理动作"] += 1
        if flags["has_gambling"]:
            violation_stats["赌博相关"] += 1
        if flags["has_vulgar"]:
            violation_stats["低俗/擦边"] += 1
        if flags["has_fake_promise"]:
            violation_stats["虚假承诺/夸大宣传"] += 1
        if flags["has_formal_tone"]:
            violation_stats["过度正式/官话"] += 1
        if flags["is_report_style"]:
            violation_stats["像咨询报告"] += 1
        if flags["char_count"] > 2000:
            violation_stats["输出过长"] += 1
        if flags["char_count"] < 100:
            violation_stats["输出过短"] += 1
        if flags["package_response_rate"] < 0.5:
            violation_stats["output_package未响应"] += 1
        if flags["emoji_count"] > 2:
            violation_stats["emoji过多"] += 1

    print("=" * 60)
    print("自动化违规检测结果")
    print("=" * 60)
    print(f"总条数: {len(all_flags)}")
    print(f"平均长度: {total_chars / max(len(all_flags), 1):.0f} 字符")
    print()

    print("违规统计:")
    for k, v in violation_stats.most_common():
        print(f"  {k}: {v} 次")

    return all_flags, violation_stats, results


if __name__ == "__main__":
    analyze_all()
