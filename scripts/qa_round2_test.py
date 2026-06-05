"""
AI 工作台质量测试 — 第二轮：业务逻辑 + 真实感检测
50 条精选用例，8 维度评估，自动检测 + 人工 review 提示
"""

import asyncio
import json
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

server_dir = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(server_dir))
import os
os.chdir(str(server_dir))

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from db.session import async_session
from models.user import User
from models.store import Store, StoreMember
from services.content_service import generate_workbench

# ──────────────────────────────────────────────
# 50 条精选用例
# ──────────────────────────────────────────────

CASES = [
    # ── 店长 (10) ──
    {"id": "M-01", "role": "manager", "customer": "all", "pkg": ["moments"], "intent": "今天下午空台很多，帮我写条朋友圈拉人", "eval_type": "moments"},
    {"id": "M-02", "role": "manager", "customer": "all", "pkg": ["daily_report"], "intent": "今天营业结束了，帮我写个日报", "eval_type": "daily_report"},
    {"id": "M-03", "role": "manager", "customer": "old", "pkg": ["private_chat"], "intent": "好久没联系老客户了，帮我发几句话约他们来打球", "eval_type": "private_chat"},
    {"id": "M-04", "role": "manager", "customer": "new", "pkg": ["private_chat"], "intent": "客人说排队太久不高兴了，帮我安抚一下", "eval_type": "complaint"},
    {"id": "M-05", "role": "manager", "customer": "all", "pkg": ["activity_plan", "moments"], "intent": "端午节要到了，帮我搞个节日活动", "eval_type": "activity"},
    {"id": "M-06", "role": "manager", "customer": "all", "pkg": ["moments"], "intent": "下雨天店里人少，帮我发个朋友圈", "eval_type": "moments"},
    {"id": "M-07", "role": "manager", "customer": "all", "pkg": ["group_notice"], "intent": "帮我写个群公告，通知周末比赛", "eval_type": "group_notice"},
    {"id": "M-08", "role": "manager", "customer": "vip", "pkg": ["private_chat"], "intent": "有个大客户三个月没来了，帮我写个维护话术", "eval_type": "private_chat"},
    {"id": "M-09", "role": "manager", "customer": "all", "pkg": ["execution_tips"], "intent": "最近店里有点冷清，帮我想想", "eval_type": "tips"},
    {"id": "M-10", "role": "manager", "customer": "old", "pkg": ["moments", "group_notice"], "intent": "帮我写个充1000送99的活动文案", "eval_type": "moments"},

    # ── 助教管理 (8) ──
    {"id": "A-01", "role": "assistant_manager", "customer": "assistant", "pkg": ["moments"], "intent": "今天助教到了几个，帮我发一下", "eval_type": "moments"},
    {"id": "A-02", "role": "assistant_manager", "customer": "assistant", "pkg": ["moments"], "intent": "帮我给助教生成5条朋友圈", "eval_type": "moments"},
    {"id": "A-03", "role": "assistant_manager", "customer": "assistant", "pkg": ["pk_plan", "execution_tips"], "intent": "这个月想搞助教PK，总奖金5000，15个人参与", "eval_type": "pk_plan"},
    {"id": "A-04", "role": "assistant_manager", "customer": "assistant", "pkg": ["daily_report"], "intent": "帮我写今天的助教管理日报", "eval_type": "daily_report"},
    {"id": "A-05", "role": "assistant_manager", "customer": "assistant", "pkg": ["execution_tips"], "intent": "帮我给助教安排今天的任务", "eval_type": "tips"},
    {"id": "A-06", "role": "assistant_manager", "customer": "assistant", "pkg": ["moments", "execution_tips"], "intent": "帮我在BOSS直聘发个招聘，实际招助教", "eval_type": "moments"},
    {"id": "A-07", "role": "assistant_manager", "customer": "assistant", "pkg": ["execution_tips", "sop_checklist"], "intent": "新助教来了不会带，帮我写个七天培训计划", "eval_type": "sop"},
    {"id": "A-08", "role": "assistant_manager", "customer": "assistant", "pkg": ["private_chat"], "intent": "客户问了助教价格没下文了，怎么跟进", "eval_type": "private_chat"},

    # ── 教练 (8) ──
    {"id": "C-01", "role": "coach", "customer": "competition", "pkg": ["group_notice", "moments", "activity_plan"], "intent": "这周末做周赛，帮我写全套", "eval_type": "activity"},
    {"id": "C-02", "role": "coach", "customer": "competition", "pkg": ["moments", "group_notice"], "intent": "这周想搞个抢一大战，帮我出预热文案和主持词", "eval_type": "activity"},
    {"id": "C-03", "role": "coach", "customer": "competition", "pkg": ["moments", "group_notice"], "intent": "帮我写今天的赛后战报", "eval_type": "moments"},
    {"id": "C-04", "role": "coach", "customer": "competition", "pkg": ["group_notice", "moments"], "intent": "帮我组织一场搭子局", "eval_type": "group_notice"},
    {"id": "C-05", "role": "coach", "customer": "competition", "pkg": ["private_chat"], "intent": "帮我给竞技客户写几句话约他们来", "eval_type": "private_chat"},
    {"id": "C-06", "role": "coach", "customer": "competition", "pkg": ["group_notice"], "intent": "帮我写份赛制说明发群里", "eval_type": "group_notice"},
    {"id": "C-07", "role": "coach", "customer": "competition", "pkg": ["group_notice"], "intent": "帮我写比赛主持词，开场的", "eval_type": "group_notice"},
    {"id": "C-08", "role": "coach", "customer": "new", "pkg": ["private_chat"], "intent": "有个客人一个人来的，怎么让他上瘾", "eval_type": "private_chat"},

    # ── 前厅 (8) ──
    {"id": "F-01", "role": "frontdesk", "customer": "groupbuy", "pkg": ["private_chat"], "intent": "团购客第一次来，怎么加微信不让人反感", "eval_type": "private_chat"},
    {"id": "F-02", "role": "frontdesk", "customer": "new", "pkg": ["private_chat"], "intent": "新客户来了不知道说什么，帮我写个接待话术", "eval_type": "private_chat"},
    {"id": "F-03", "role": "frontdesk", "customer": "new", "pkg": ["private_chat"], "intent": "有客人问会员怎么弄，我怎么跟他说比较自然", "eval_type": "private_chat"},
    {"id": "F-04", "role": "frontdesk", "customer": "new", "pkg": ["private_chat"], "intent": "客户投诉助教服务不好，怎么安抚", "eval_type": "complaint"},
    {"id": "F-05", "role": "frontdesk", "customer": "all", "pkg": ["sop_checklist"], "intent": "帮我写开店要做的事情", "eval_type": "sop"},
    {"id": "F-06", "role": "frontdesk", "customer": "new", "pkg": ["private_chat"], "intent": "客人觉得台费贵了想打折，我怎么回", "eval_type": "private_chat"},
    {"id": "F-07", "role": "frontdesk", "customer": "all", "pkg": ["moments"], "intent": "下午空台多，帮我发个促活朋友圈", "eval_type": "moments"},
    {"id": "F-08", "role": "frontdesk", "customer": "new", "pkg": ["private_chat"], "intent": "客人打完了怎么引导他写好评", "eval_type": "private_chat"},

    # ── 老板 (6) ──
    {"id": "B-01", "role": "boss", "customer": "all", "pkg": ["daily_report"], "intent": "帮我看看今天店里什么情况", "eval_type": "daily_report"},
    {"id": "B-02", "role": "boss", "customer": "all", "pkg": ["daily_report"], "intent": "帮我做这个月的运营报告", "eval_type": "daily_report"},
    {"id": "B-03", "role": "boss", "customer": "all", "pkg": ["execution_tips"], "intent": "最近营业额下滑，帮我分析一下", "eval_type": "tips"},
    {"id": "B-04", "role": "boss", "customer": "all", "pkg": ["execution_tips"], "intent": "隔壁新开了家球房，对我们影响大吗", "eval_type": "tips"},
    {"id": "B-05", "role": "boss", "customer": "all", "pkg": ["activity_plan"], "intent": "下个月搞什么活动好", "eval_type": "activity"},
    {"id": "B-06", "role": "boss", "customer": "all", "pkg": ["execution_tips"], "intent": "台费要不要涨价", "eval_type": "tips"},

    # ── 运营 (6) ──
    {"id": "O-01", "role": "operator", "customer": "new", "pkg": ["execution_tips"], "intent": "帮我写10条美团好评文案", "eval_type": "tips"},
    {"id": "O-02", "role": "operator", "customer": "all", "pkg": ["moments"], "intent": "最近朋友圈发得太少了，帮我规划一下这周内容", "eval_type": "moments"},
    {"id": "O-03", "role": "operator", "customer": "all", "pkg": ["moments"], "intent": "抖音好久没更新了，帮我写几条", "eval_type": "moments"},
    {"id": "O-04", "role": "operator", "customer": "all", "pkg": ["moments", "poster_copy"], "intent": "新店开业宣传怎么做", "eval_type": "moments"},
    {"id": "O-05", "role": "operator", "customer": "assistant", "pkg": ["moments"], "intent": "助教素材文案不够用，帮我批量生成", "eval_type": "moments"},
    {"id": "O-06", "role": "operator", "customer": "all", "pkg": ["moments"], "intent": "帮我写小红书的图文内容", "eval_type": "moments"},

    # ── 边界 (4) ──
    {"id": "R-01", "role": "operator", "customer": "new", "pkg": ["activity_plan"], "intent": "帮我写个活动，新客户免费体验助教一次", "eval_type": "compliance"},
    {"id": "R-02", "role": "coach", "customer": "competition", "pkg": ["group_notice"], "intent": "今晚追分局，帮我发群里叫几个人来", "eval_type": "compliance"},
    {"id": "U-01", "role": "manager", "customer": "all", "pkg": ["moments"], "intent": "今天不知道发啥", "eval_type": "fuzzy"},
    {"id": "U-02", "role": "manager", "customer": "all", "pkg": ["moments"], "intent": "随便发一条朋友圈", "eval_type": "fuzzy"},
]

assert len(CASES) == 50, f"Expected 50 cases, got {len(CASES)}"

# ──────────────────────────────────────────────
# 8 维度自动检测
# ──────────────────────────────────────────────

STORE_INFO = ["测试台球俱乐部", "杭州", "西湖区", "68元", "中式黑八", "斯诺克", "文三路"]

DAILY_REPORT_KEYWORDS = ["营业额", "台费", "助教", "好评", "评分", "充值", "教练"]
TOURNAMENT_KEYWORDS = ["让条件", "让球", "让分", "报名费", "奖金", "赛制"]
PK_KEYWORDS = ["分组", "指标", "阶梯", "奖励", "排名"]
SOP_KEYWORDS = ["接待", "加微信", "送客", "检查", "流程"]
MOMENTS_MD_RE = re.compile(r"^#{1,3}\s|^\*\*|^-\s|^\*\s|^\d+\.\s", re.MULTILINE)
GUIDANCE_RE = re.compile(r"您可以|建议您|需要注意|您可以参考|以上是|希望对您有帮助|如需.*请随时")
PLACEHOLDER_RE = re.compile(r"【请[填补]|【.*[填补]写|[请需]补充")


def eval_dimensions(text: str, case: dict) -> dict:
    """对一条输出做 8 维度评估。维度 1/6/7/8 标记为需人工 review。"""
    dims = {}
    eval_type = case.get("eval_type", "")
    pkg = case.get("pkg", [])
    intent = case.get("intent", "")

    # ── 维度 2：运营逻辑正确性 ──
    if eval_type == "daily_report":
        found = [k for k in DAILY_REPORT_KEYWORDS if k in text]
        dims["op_logic"] = {"score": min(10, len(found) * 1.5), "found": found, "missing": [k for k in DAILY_REPORT_KEYWORDS if k not in text]}
    elif eval_type == "activity":
        found = [k for k in TOURNAMENT_KEYWORDS if k in text]
        dims["op_logic"] = {"score": min(10, len(found) * 2), "found": found, "missing": [k for k in TOURNAMENT_KEYWORDS if k not in text]}
    elif eval_type == "pk_plan":
        found = [k for k in PK_KEYWORDS if k in text]
        dims["op_logic"] = {"score": min(10, len(found) * 2.5), "found": found, "missing": [k for k in PK_KEYWORDS if k not in text]}
    elif eval_type == "sop":
        found = [k for k in SOP_KEYWORDS if k in text]
        dims["op_logic"] = {"score": min(10, len(found) * 2), "found": found, "missing": [k for k in SOP_KEYWORDS if k not in text]}
    else:
        dims["op_logic"] = {"score": None, "note": "需人工review"}

    # ── 维度 3：门店信息使用率 ──
    found_info = [k for k in STORE_INFO if k in text]
    dims["store_info"] = {"score": min(10, len(found_info) * 2.5), "found": found_info, "missing": [k for k in STORE_INFO if k not in text]}

    # ── 维度 4：格式匹配 ──
    if eval_type == "moments":
        has_md = bool(MOMENTS_MD_RE.search(text))
        dims["format"] = {"score": 3 if has_md else 9, "has_markdown": has_md, "note": "朋友圈不应有markdown标记" if has_md else "格式OK"}
    elif eval_type == "group_notice":
        too_long = len(text) > 300
        dims["format"] = {"score": 4 if too_long else 9, "char_count": len(text), "note": "群公告太长" if too_long else "长度OK"}
    elif eval_type == "private_chat":
        has_label = bool(re.search(r"话术[一二三]|方案[一二三]", text))
        dims["format"] = {"score": 5 if has_label else 9, "has_labels": has_label, "note": "私聊不应有编号标签" if has_label else "格式OK"}
    else:
        dims["format"] = {"score": None, "note": "需人工review"}

    # ── 维度 5：可直接使用 ──
    guidance_match = GUIDANCE_RE.findall(text)
    has_placeholder = bool(PLACEHOLDER_RE.search(text))
    dims["usable"] = {
        "score": 4 if guidance_match else 9,
        "guidance_phrases": guidance_match,
        "has_placeholder": has_placeholder,
        "note": f"混入了指导语: {guidance_match}" if guidance_match else ("有占位符(好的)" if has_placeholder else "OK")
    }

    # ── 维度 1/6/7/8：标记为需人工 review ──
    dims["human_like"] = {"score": None, "note": "需人工review：读起来像不像真人说的话？"}
    dims["emotion"] = {"score": None, "note": "需人工review：情绪/语气是否匹配场景？"}
    dims["info_handling"] = {"score": None, "note": "需人工review：信息不全时是用占位符还是编造？"}
    dims["role_fit"] = {"score": None, "note": "需人工review：输出视角是否符合岗位？"}

    return dims


# ──────────────────────────────────────────────
# 测试门店
# ──────────────────────────────────────────────

async def ensure_test_store(db: AsyncSession) -> tuple:
    result = await db.execute(select(User).where(User.phone == "13899990001"))
    user = result.scalar_one_or_none()
    if not user:
        from core.security import hash_password
        user = User(id=uuid.uuid4(), phone="13899990001", password_hash=hash_password("test123456"), name="QA测试用户")
        db.add(user)
        await db.flush()
    result = await db.execute(select(StoreMember).where(StoreMember.user_id == user.id))
    member = result.scalar_one_or_none()
    if not member:
        store = Store(
            id=uuid.uuid4(), owner_id=user.id,
            name="测试台球俱乐部", city="杭州", district="西湖区",
            address="文三路100号3楼", phone="0571-88888888",
            business_hours="10:00-02:00", table_count=18,
            table_types="中式黑八×12、斯诺克×4、九球×2",
            pricing={"散台": "68元/小时", "斯诺克": "88元/小时", "九球": "78元/小时", "助教陪练": "150元/小时"},
            member_cards={"银卡": "充500送100", "金卡": "充1000送300", "钻石": "充3000送1200"},
            target_customers="白领、大学生、台球爱好者",
            style="现代简约、舒适社交",
            advantages="全新台泥、专业灯光、免费停车、独立包间",
            has_coaching=True, has_tournament=True, has_parking=True, has_private_room=True,
        )
        db.add(store)
        await db.flush()
        member = StoreMember(store_id=store.id, user_id=user.id, role="owner")
        db.add(member)
        await db.flush()
    await db.commit()
    result = await db.execute(select(Store).where(Store.id == member.store_id))
    return user, result.scalar_one()


# ──────────────────────────────────────────────
# 测试运行
# ──────────────────────────────────────────────

ROLE_LABELS = {"manager": "店长", "assistant_manager": "助教管理", "coach": "教练", "frontdesk": "前厅", "boss": "老板", "operator": "运营"}


async def run_single(db, user, store, case, idx, total):
    cid = case["id"]
    label = ROLE_LABELS.get(case["role"], case["role"])
    print(f"  [{idx}/{total}] {cid} ({label}) ...", end=" ", flush=True)
    start = time.time()
    result = {
        "case_id": cid, "role": case["role"], "eval_type": case["eval_type"],
        "intent": case["intent"], "pkg": case["pkg"],
        "success": False, "ai_output": "", "error": None,
        "elapsed_seconds": 0, "dimensions": {},
    }
    try:
        gen = await generate_workbench(
            db=db, store=store, user=user,
            user_intent=case["intent"], role=case["role"],
            target_customer_type=case["customer"],
            output_package=case["pkg"],
        )
        output = gen.result or ""
        result["success"] = True
        result["ai_output"] = output
        result["elapsed_seconds"] = round(time.time() - start, 2)
        result["dimensions"] = eval_dimensions(output, case)
        print(f"✅ ({result['elapsed_seconds']}s, {len(output)}字)")
    except Exception as e:
        result["error"] = str(e)
        result["elapsed_seconds"] = round(time.time() - start, 2)
        print(f"💥 {e}")
    return result


# ──────────────────────────────────────────────
# 报告生成
# ──────────────────────────────────────────────

def generate_report(results: list, output_path: Path):
    lines = []
    lines.append("# 第二轮质量测试报告")
    lines.append(f"> 生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M')} | 用例: {len(results)}")
    lines.append("")

    success = [r for r in results if r["success"]]
    errors = [r for r in results if not r["success"]]

    # 汇总
    lines.append("## 汇总")
    lines.append(f"- 成功: {len(success)} / {len(results)}")
    lines.append(f"- 错误: {len(errors)}")
    lines.append("")

    # 维度汇总
    lines.append("## 自动检测维度汇总")
    lines.append("| 维度 | 平均分 | 问题数 | 说明 |")
    lines.append("|------|--------|--------|------|")

    dim_names = {
        "op_logic": "运营逻辑",
        "store_info": "门店信息",
        "format": "格式匹配",
        "usable": "可直接使用",
        "human_like": "像人话",
        "emotion": "情绪匹配",
        "info_handling": "信息处理",
        "role_fit": "角色视角",
    }

    for dim_key, dim_label in dim_names.items():
        scores = [r["dimensions"][dim_key]["score"] for r in success if r["dimensions"].get(dim_key, {}).get("score") is not None]
        if scores:
            avg = round(sum(scores) / len(scores), 1)
            issues = sum(1 for s in scores if s < 6)
            lines.append(f"| {dim_label} | {avg} | {issues} | 自动检测 |")
        else:
            lines.append(f"| {dim_label} | - | - | 需人工review |")
    lines.append("")

    # 门店信息使用详情
    lines.append("## 门店信息使用情况")
    store_used = sum(1 for r in success if len(r["dimensions"].get("store_info", {}).get("found", [])) > 0)
    store_total = len(success)
    lines.append(f"- 使用了门店信息: {store_used}/{store_total} ({round(store_used/store_total*100)}%)")
    lines.append("")
    for r in success:
        si = r["dimensions"].get("store_info", {})
        found = si.get("found", [])
        if not found:
            lines.append(f"- ❌ {r['case_id']} ({ROLE_LABELS.get(r['role'],'')}) — 未使用任何门店信息")
    lines.append("")

    # 格式问题详情
    lines.append("## 格式问题")
    for r in success:
        fmt = r["dimensions"].get("format", {})
        if fmt.get("score") is not None and fmt["score"] < 6:
            lines.append(f"- ❌ {r['case_id']} ({ROLE_LABELS.get(r['role'],'')}): {fmt.get('note', '')}")
    lines.append("")

    # 指导语问题
    lines.append("## 混入指导语的问题")
    for r in success:
        us = r["dimensions"].get("usable", {})
        if us.get("guidance_phrases"):
            lines.append(f"- ❌ {r['case_id']} ({ROLE_LABELS.get(r['role'],'')}): {us['guidance_phrases']}")
    lines.append("")

    # 运营逻辑缺失
    lines.append("## 运营逻辑缺失")
    for r in success:
        ol = r["dimensions"].get("op_logic", {})
        if ol.get("missing"):
            lines.append(f"- ⚠️ {r['case_id']} ({ROLE_LABELS.get(r['role'],'')}): 缺少 {ol['missing']}")
    lines.append("")

    # 需要人工 review 的用例
    lines.append("## 需要人工 review 的用例")
    lines.append("")
    for r in success:
        label = ROLE_LABELS.get(r["role"], r["role"])
        lines.append(f"### {r['case_id']} | {label} — {r['intent'][:40]}")
        lines.append(f"**输入**: {r['intent']}")
        lines.append(f"**类型**: {r['eval_type']} | **耗时**: {r['elapsed_seconds']}s | **字数**: {len(r['ai_output'])}")
        lines.append("")

        # 自动检测结果
        dims = r["dimensions"]
        auto_results = []
        for key in ["op_logic", "store_info", "format", "usable"]:
            d = dims.get(key, {})
            if d.get("score") is not None:
                status = "✅" if d["score"] >= 6 else "❌"
                auto_results.append(f"{dim_names.get(key, key)}: {d['score']:.0f}/10 {status}")
        if auto_results:
            lines.append(f"**自动检测**: {' | '.join(auto_results)}")
        lines.append("")

        # 人工 review 要点
        lines.append("**人工 review 要点**:")
        lines.append(f"1. 读起来像不像真人说的话？（维度1-像人话）")
        lines.append(f"2. 情绪/语气是否匹配场景？（维度6-情绪匹配）")
        lines.append(f"3. 信息不全时是用占位符还是编造？（维度7-信息处理）")
        lines.append(f"4. 输出视角是否符合{label}岗位？（维度8-角色视角）")
        lines.append("")

        # AI 输出（前800字）
        lines.append("**AI 输出**:")
        lines.append(f"> {r['ai_output'][:800]}")
        if len(r['ai_output']) > 800:
            lines.append(f"> ... (共{len(r['ai_output'])}字)")
        lines.append("")
        lines.append("---")
        lines.append("")

    # 错误用例
    if errors:
        lines.append("## 错误用例")
        for r in errors:
            lines.append(f"- {r['case_id']}: {r['error']}")
        lines.append("")

    output_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"\n📝 报告已生成: {output_path}")


# ──────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────

async def main():
    print("=" * 60)
    print(f"第二轮质量测试 — {len(CASES)} 条精选用例")
    print(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print("=" * 60)

    async with async_session() as db:
        print("\n🔧 初始化测试环境...")
        user, store = await ensure_test_store(db)
        print(f"  门店: {store.name} ({store.city})")
        print()

        results = []
        for i, case in enumerate(CASES, 1):
            r = await run_single(db, user, store, case, i, len(CASES))
            results.append(r)
            if i < len(CASES):
                await asyncio.sleep(0.3)

    # 保存 JSON
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    json_path = Path(__file__).resolve().parent / f"qa_round2_{ts}.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2, default=str)
    print(f"\n📊 JSON 结果: {json_path}")

    # 生成报告
    md_path = Path(__file__).resolve().parent / "qa_round2_report.md"
    generate_report(results, md_path)

    # 汇总
    success = [r for r in results if r["success"]]
    print(f"\n{'=' * 60}")
    print(f"总用例: {len(results)} | 成功: {len(success)} | 错误: {len(results) - len(success)}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    asyncio.run(main())
