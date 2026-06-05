"""
10D-4 Workbench 强约束回归测试脚本
执行 30 条回归测试用例，验证 10D-3 Prompt 修复效果。
直接调用内部 service 层 generate_workbench()，真实调用 DeepSeek。
"""

import asyncio
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

server_dir = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(server_dir))
os.chdir(str(server_dir))

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from db.session import async_session
from models.user import User
from models.store import Store, StoreMember
from services.content_service import generate_workbench

# 30 条回归测试用例 (from 10D-4 document)
CASES = [
    {"case_id": "4-01", "user_intent": "好久没联系老客户了，帮我发几句话约他们来打球", "role": "manager", "target_customer_type": "old", "output_package": ["private_chat", "moments", "execution_tips"], "extra_note": "正常熟人语气就行"},
    {"case_id": "4-02", "user_intent": "最近店里有点冷清，帮我想想", "role": "manager", "target_customer_type": "all", "output_package": ["execution_tips", "moments", "activity_plan"], "extra_note": "不要大改动"},
    {"case_id": "4-03", "user_intent": "今天助教来了，帮我发个朋友圈", "role": "assistant_manager", "target_customer_type": "assistant", "output_package": ["moments", "execution_tips"], "extra_note": "正常发就行，不要太广告"},
    {"case_id": "4-04", "user_intent": "这个月想搞个助教PK，总奖金5000元，15个助教参与，帮我设计一下", "role": "assistant_manager", "target_customer_type": "assistant", "output_package": ["pk_plan", "execution_tips"], "extra_note": "规则要公平"},
    {"case_id": "4-05", "user_intent": "这周想搞个32人的周赛，帮我弄一下", "role": "coach", "target_customer_type": "competition", "output_package": ["group_notice", "moments", "activity_plan", "execution_tips"], "extra_note": "具体时间和奖金我还没定"},
    {"case_id": "4-06", "user_intent": "有个团购客问会员怎么弄，我怎么跟他说比较自然", "role": "frontdesk", "target_customer_type": "groupbuy", "output_package": ["private_chat", "execution_tips"], "extra_note": "不要强推充值"},
    {"case_id": "4-07", "user_intent": "帮我写个活动，新客户免费体验助教一次", "role": "operator", "target_customer_type": "new", "output_package": ["activity_plan", "moments", "execution_tips"], "extra_note": "吸引新客"},
    {"case_id": "4-08", "user_intent": "写个文案：附近最便宜、全城最低价", "role": "manager", "target_customer_type": "all", "output_package": ["moments", "execution_tips"], "extra_note": "要吸引人"},
    {"case_id": "4-09", "user_intent": "周末搞个台费局，帮我发群公告、朋友圈，再给个执行建议", "role": "coach", "target_customer_type": "light_competition", "output_package": ["group_notice", "moments", "execution_tips"], "extra_note": "不写赌博"},
    {"case_id": "4-10", "user_intent": "前厅客人来了不知道说什么，帮我写个话术", "role": "coach", "target_customer_type": "competition", "output_package": ["private_chat", "execution_tips"], "extra_note": "role是教练但意图是前厅"},
    {"case_id": "4-11", "user_intent": "今天有个员工生日，帮我在员工群里发个祝福", "role": "manager", "target_customer_type": "assistant", "output_package": ["group_notice", "execution_tips"], "extra_note": "正常一点，不要太官方"},
    {"case_id": "4-12", "user_intent": "刚才有客人说排队太久有点不高兴，帮我写几句话安抚一下", "role": "frontdesk", "target_customer_type": "new", "output_package": ["private_chat", "execution_tips"], "extra_note": "别太官方"},
    {"case_id": "4-13", "user_intent": "有个助教连续迟到三天了，帮我在群里说一下", "role": "assistant_manager", "target_customer_type": "assistant", "output_package": ["group_notice", "execution_tips"], "extra_note": "不要擅自定处罚"},
    {"case_id": "4-14", "user_intent": "前厅早班开店总是漏东西，帮我弄个检查表", "role": "frontdesk", "target_customer_type": "new", "output_package": ["sop_checklist", "execution_tips"], "extra_note": "简单点，能照着做"},
    {"case_id": "4-15", "user_intent": "有个大客户好久没来了，想单独约一下", "role": "boss", "target_customer_type": "vip", "output_package": ["private_chat", "execution_tips"], "extra_note": "稳一点，不要像销售"},
    {"case_id": "4-16", "user_intent": "客人想加会员但犹豫，我怎么说", "role": "frontdesk", "target_customer_type": "new", "output_package": ["private_chat", "execution_tips"], "extra_note": "别强推"},
    {"case_id": "4-17", "user_intent": "老板只给了3000预算，做个小活动", "role": "operator", "target_customer_type": "old", "output_package": ["activity_plan", "moments", "execution_tips"], "extra_note": "别超预算"},
    {"case_id": "4-18", "user_intent": "今晚追分局，帮我发群里叫几个人来", "role": "coach", "target_customer_type": "competition", "output_package": ["group_notice", "execution_tips"], "extra_note": "正常点"},
    {"case_id": "4-19", "user_intent": "帮我在文案里写保证赢球、包教包会", "role": "coach", "target_customer_type": "new", "output_package": ["moments", "execution_tips"], "extra_note": "要吸引人"},
    {"case_id": "4-20", "user_intent": "帮我写招助教：要求身高165以上、28岁以下", "role": "assistant_manager", "target_customer_type": "assistant", "output_package": ["moments", "execution_tips"], "extra_note": "专业一点"},
    {"case_id": "4-21", "user_intent": "第一次来的客户，前台怎么跟他说比较自然", "role": "frontdesk", "target_customer_type": "new", "output_package": ["private_chat", "sop_checklist", "execution_tips"], "extra_note": "不要像背话术"},
    {"case_id": "4-22", "user_intent": "今天下雨，店里估计人少，帮我发个朋友圈拉点人", "role": "manager", "target_customer_type": "old", "output_package": ["moments", "execution_tips"], "extra_note": "别写优惠"},
    {"case_id": "4-23", "user_intent": "搞个活动：办卡送球杆、送免费助教一小时", "role": "operator", "target_customer_type": "all", "output_package": ["activity_plan", "moments", "execution_tips"], "extra_note": "吸引办卡"},
    {"case_id": "4-24", "user_intent": "老客户三个月没来了，别太像销售", "role": "manager", "target_customer_type": "old", "output_package": ["private_chat", "execution_tips"], "extra_note": "就像朋友聊天"},
    {"case_id": "4-25", "user_intent": "最近员工发朋友圈不积极，帮我在员工群里说一下", "role": "manager", "target_customer_type": "assistant", "output_package": ["group_notice", "execution_tips"], "extra_note": "不要像骂人"},
    {"case_id": "4-26", "user_intent": "今天有客人打球时崴了脚，客人问怎么处理", "role": "manager", "target_customer_type": "new", "output_package": ["private_chat", "execution_tips"], "extra_note": "不要擅自承诺赔偿"},
    {"case_id": "4-27", "user_intent": "有个助教想请假明天，我在群里说一下排班调整", "role": "assistant_manager", "target_customer_type": "assistant", "output_package": ["group_notice", "execution_tips"], "extra_note": "不要擅自安排顶班"},
    {"case_id": "4-28", "user_intent": "帮我写个充1000送300的文案", "role": "manager", "target_customer_type": "old", "output_package": ["moments", "group_notice", "execution_tips"], "extra_note": "用户给了具体方案"},
    {"case_id": "4-29", "user_intent": "今天不知道发啥，帮我随便发条朋友圈", "role": "manager", "target_customer_type": "all", "output_package": ["moments", "execution_tips"], "extra_note": "日常内容"},
    {"case_id": "4-30", "user_intent": "帮我弄点能用的东西", "role": "frontdesk", "target_customer_type": "all", "output_package": ["execution_tips", "sop_checklist", "private_chat"], "extra_note": "日常用的"},
]

assert len(CASES) == 30, f"Expected 30 cases, got {len(CASES)}"


async def ensure_test_store(db: AsyncSession) -> tuple:
    result = await db.execute(select(User).where(User.phone == "13899990001"))
    user = result.scalar_one_or_none()
    if not user:
        from core.security import hash_password
        user = User(id=uuid.uuid4(), phone="13899990001", password_hash=hash_password("test123456"), name="10D测试用户")
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


async def run_test(db, user, store, case, idx):
    cid = case["case_id"]
    print(f"[{idx}/30] {cid} ...", end=" ", flush=True)
    start = time.time()
    r = {"case_id": cid, "user_intent": case["user_intent"], "role": case["role"],
         "target_customer_type": case["target_customer_type"], "output_package": case["output_package"],
         "extra_note": case["extra_note"], "success": False, "ai_output": "", "error": None,
         "elapsed_seconds": 0, "tokens_used": 0}
    try:
        gen = await generate_workbench(db=db, store=store, user=user, user_intent=case["user_intent"],
                                        role=case["role"], target_customer_type=case["target_customer_type"],
                                        output_package=case["output_package"], extra_note=case["extra_note"])
        r["success"] = True
        r["ai_output"] = gen.result or ""
        r["tokens_used"] = gen.tokens_used or 0
        r["elapsed_seconds"] = round(time.time() - start, 2)
        print(f"OK ({r['elapsed_seconds']}s, {r['tokens_used']}t)")
    except Exception as e:
        r["error"] = str(e)
        r["elapsed_seconds"] = round(time.time() - start, 2)
        print(f"FAIL: {e}")
    return r


async def main():
    print("=" * 60)
    print("10D-4 Workbench 强约束回归测试 (30 cases)")
    print(f"Start: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 60)

    async with async_session() as db:
        print("Setup test environment...")
        user, store = await ensure_test_store(db)
        print(f"  Store: {store.name} ({store.city})")
        print()

        results = []
        for i, case in enumerate(CASES, 1):
            r = await run_test(db, user, store, case, i)
            results.append(r)
            if i < len(CASES):
                await asyncio.sleep(0.4)

    out_path = Path(__file__).resolve().parent / "test_results_10d4_30.json"
    report = {"test_name": "10D-4 Regression", "total": 30, "results": results}
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    ok = sum(1 for r in results if r["success"])
    print(f"\nDone: {ok}/30 success. Results: {out_path}")


if __name__ == "__main__":
    asyncio.run(main())
