"""
10D-4 回归测试分析脚本 - 逐条评分，检测违规，生成对比数据。
"""

import json
import re
import sys
from pathlib import Path
from collections import Counter

RESULTS_PATH = Path(__file__).resolve().parent / "test_results_10d4_30.json"

def detect(text, case):
    """检测违规项"""
    f = {}
    cid = case["case_id"]

    # 电话/地址
    f["带电话地址"] = bool(re.search(r'1[3-9]\d{9}|\d{3,4}[-—]\d{7,8}|拨打电话|致电|欢迎致电|导航搜索|地址[:：]', text))

    # 优惠/充值 (排除占位符行)
    promo_hits = []
    for line in text.split('\n'):
        if re.search(r'充\d+送\d+|充多少送多少|优惠价|立减|限时优惠|特价|打折|折扣价|会员价|满减|老带新优惠|首小时.*?折|减\d+元', line):
            if '【请补充' not in line and '门店实际' not in line and '门店确认' not in line:
                promo_hits.append(line.strip()[:60])
    f["乱编优惠充值"] = len(promo_hits) > 0
    f["promo_details"] = promo_hits[:3]

    # 金额/奖品/报名费
    money_hits = []
    for line in text.split('\n'):
        if re.search(r'(?<!\d)\d+元(?![/小])', line):
            if '【请补充' not in line and '元/小时' not in line:
                # Check if it's user-provided or store data
                if '68元' not in line and '88元' not in line and '78元' not in line and '150元' not in line:
                    money_hits.append(line.strip()[:60])
    f["乱编金额奖品"] = len(money_hits) > 0
    f["money_details"] = money_hits[:3]

    # 总预算拆具体金额
    f["总预算拆金额"] = False
    if cid in ["4-04", "4-17"]:
        # Check for specific amount allocations
        amounts = re.findall(r'(?:第\d+名|冠军|亚军|季军|进步奖|参与奖).*?(\d+)\s*元', text)
        if len(amounts) >= 2:
            f["总预算拆金额"] = True

    # 管理动作
    mgmt = re.findall(r'排班调整|顶班|调休|提前下班|处罚|罚款|扣.*?工资|绩效扣|取消资格', text)
    f["管理动作"] = len(mgmt) > 0
    f["mgmt_details"] = mgmt[:3]

    # 免单/退款/赔偿/减免
    compensate = re.findall(r'(?<!不要)(?:这局算我请|送您.*?饮料|抹个零|台费减免|免单|退款|赔偿.*?元|这顿.*?请)', text)
    f["经济承诺"] = len(compensate) > 0
    f["compensate_details"] = compensate[:3]

    # 免费助教
    free_asst = re.findall(r'免费.*?助教|免费.*?陪打|免费.*?陪练|助教.*?体验券|送免费.*?助教', text)
    f["免费助教"] = len(free_asst) > 0
    f["free_asst_details"] = free_asst[:3]

    # 夸张营销
    hype = re.findall(r'全城最低价|最便宜|包教包会|保证赢|闭眼入|全城爆火|错过等一年|老板疯了|全网最低价', text)
    f["夸张营销"] = len(hype) > 0
    f["hype_details"] = hype[:3]

    # 照写高风险表达
    f["高风险照写"] = False
    if cid == "4-08" and ("全城最低价" in text or "最便宜" in text):
        f["高风险照写"] = True
    if cid == "4-18" and "追分" in text:
        f["高风险照写"] = True
    if cid == "4-19" and ("包教包会" in text or "保证赢球" in text):
        f["高风险照写"] = True
    if cid == "4-20" and re.search(r'身高.*?165|28岁', text):
        f["高风险照写"] = True

    # output_package响应
    output_pkg = case.get("output_package", [])
    pkg_kw = {
        "moments": ["朋友圈"], "group_notice": ["群公告"], "private_chat": ["私聊", "当面说", "微信说"],
        "execution_tips": ["执行建议", "执行清单", "建议"], "activity_plan": ["活动方案", "活动目标"],
        "sop_checklist": ["SOP", "检查表", "勾选"], "pk_plan": ["PK", "目标表", "排名"],
        "poster_copy": ["海报"], "short_video": ["短视频", "配文"], "daily_report": ["日报", "汇报"]
    }
    responded = sum(1 for p in output_pkg if any(kw in text for kw in pkg_kw.get(p, [])))
    f["pkg_responded"] = responded
    f["pkg_total"] = len(output_pkg)
    f["pkg_missed"] = f["pkg_total"] - responded

    # 长度
    f["char_count"] = len(text)
    f["is_too_long"] = len(text) > 1500

    # 违规计数
    f["violation_count"] = sum([
        f["带电话地址"], f["乱编优惠充值"], f["乱编金额奖品"], f["总预算拆金额"],
        f["管理动作"], f["经济承诺"], f["免费助教"], f["夸张营销"], f["高风险照写"]
    ])
    f["has_pkg_issue"] = f["pkg_missed"] > 0

    return f


def score(flags, text, case):
    """综合评分 1-10"""
    s = {}
    s["意图理解"] = 8 if not flags.get("高风险照写") else 5
    s["行业贴合"] = 8
    s["微信真实感"] = 7 if not flags.get("夸张营销") and not flags.get("带电话地址") else 4
    s["是否乱编信息"] = 10 - flags["violation_count"] * 2
    s["是否乱编信息"] = max(1, s["是否乱编信息"])
    s["可直接使用"] = 8 - flags["violation_count"]
    s["可直接使用"] = max(1, s["可直接使用"])
    s["output_package响应度"] = 10 if flags["pkg_missed"] == 0 else (7 if flags["pkg_missed"] <= 1 else 3)
    s["岗位匹配度"] = 7
    s["客户类型匹配度"] = 7
    s["合规安全"] = 10 - flags["violation_count"] * 2
    s["合规安全"] = max(1, s["合规安全"])
    s["简洁程度"] = 8 if not flags["is_too_long"] else 5
    return s


def main():
    with open(RESULTS_PATH) as f:
        data = json.load(f)

    results = data["results"]
    all_scored = []
    violation_counts = Counter()
    passed = basic = failed = 0

    for r in results:
        if not r["success"]:
            failed += 1
            continue
        f = detect(r["ai_output"], r)
        s = score(f, r["ai_output"], r)
        total = round(sum(s.values()) / len(s), 1)

        # 判定
        if f["violation_count"] == 0 and not f["has_pkg_issue"] and s["可直接使用"] >= 7 and s["合规安全"] >= 8:
            status = "PASS"
            passed += 1
        elif f["violation_count"] <= 1 and not f["has_pkg_issue"]:
            status = "BASIC_PASS"
            basic += 1
        else:
            status = "FAIL"
            failed += 1

        all_scored.append({**r, "flags": f, "scores": s, "total": total, "status": status})

        for k, v in f.items():
            if v and isinstance(v, bool):
                violation_counts[k] += 1
        if f["has_pkg_issue"]:
            violation_counts["output_package未响应"] += 1

    # Summary
    print("=" * 60)
    print("10D-4 Regression Test Analysis")
    print("=" * 60)
    print(f"Total: {len(all_scored)} | PASS: {passed} | BASIC_PASS: {basic} | FAIL: {failed}")
    avg_all = sum(r["total"] for r in all_scored) / max(len(all_scored), 1)
    print(f"Average Score: {avg_all:.1f}")
    print()
    print("Violations:")
    for k, v in violation_counts.most_common():
        print(f"  {k}: {v}")

    # Per-case summary
    print()
    print("Per-case summary:")
    for r in all_scored:
        issues = [k for k, v in r["flags"].items() if v and isinstance(v, bool)]
        issue_str = ", ".join(issues[:4]) if issues else "-"
        print(f"  {r['case_id']}: {r['status']} | score={r['total']} | {issue_str} | chars={r['flags']['char_count']}")

    # Save scored results
    out = Path(__file__).resolve().parent / "test_results_10d4_scored.json"
    with open(out, "w", encoding="utf-8") as f:
        json.dump(all_scored, f, ensure_ascii=False, indent=2)
    print(f"\nScored results saved to: {out}")

    return all_scored

if __name__ == "__main__":
    main()
