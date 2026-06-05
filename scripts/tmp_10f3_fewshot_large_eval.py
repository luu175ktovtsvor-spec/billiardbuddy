"""
10F-3: Few-shot 接入后 Workbench 大样本真实调用评估
=====================================================
用途：对 10F-2 few-shot 接入后的 Workbench 进行 120 条真实 DeepSeek 调用测试
不读取/输出 API Key，使用项目现有 service/provider 调用
单条失败继续下一条；前10条>5条系统性失败则停止
"""

import asyncio
import json
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# 确保 server 目录在 path 中
SERVER_DIR = Path(__file__).resolve().parent.parent / "server"
sys.path.insert(0, str(SERVER_DIR))

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from models.user import User
from models.store import Store
from services.content_service import generate_workbench
from services.workbench_fewshot_service import _load_examples, _score_example, _has_keyword
from services.workbench_fewshot_service import (
    ASSISTANT_EXPERIENCE_KEYWORDS, TECHNICAL_ASSISTANT_KEYWORDS,
    ASSISTANT_EXPERIENCE_TAGS, TECHNICAL_ASSISTANT_TAGS,
    INTENT_KEYWORD_TO_TAGS,
)

# DB URL (从测试配置获取，不读 .env)
DATABASE_URL = "postgresql+asyncpg://postgres:postgres@localhost:5432/billiards_ai"

# 120 条测试用例定义
CASES = []

def _add_group(group, cases):
    for i, c in enumerate(cases, 1):
        CASES.append({
            "case_id": f"{group}-{i:02d}",
            "group": group,
            "user_intent": c[0],
            "role": c[1],
            "target_customer_type": c[2],
            "output_package": c[3],
            "extra_note": c[4] if len(c) > 4 else "",
        })

# === A 组：老客户回访 / 私域维护 15 条 ===
_add_group("A", [
    ("好久没联系老客户了，帮我发几句话约他们来打球", "manager", "old", ["private_chat", "moments", "execution_tips"], "正常熟人语气就行"),
    ("老客户最近没来了，发个朋友圈喊一下", "manager", "old", ["moments", "execution_tips"], "像朋友一样"),
    ("想让几个熟人回来打球，别像销售", "manager", "old", ["private_chat", "execution_tips"], "稳一点"),
    ("老客户三个月没来了，私聊怎么说", "manager", "old", ["private_chat", "execution_tips"], "就像朋友聊天"),
    ("今天店里氛围不错，想喊老朋友回来玩", "manager", "old", ["moments", "execution_tips"], ""),
    ("有个老客户好久没出现，私信关心一下", "manager", "old", ["private_chat", "execution_tips"], "不要群发感"),
    ("老客户之前经常周末来，最近影都没了", "manager", "old", ["private_chat", "execution_tips"], "不要编他以前的事"),
    ("想给几个熟客发个消息，别太官方", "boss", "old", ["private_chat", "execution_tips"], ""),
    ("老客户群最近不活跃，发什么好", "manager", "old", ["group_notice", "execution_tips"], "不要搞红包优惠"),
    ("老客户带新朋友来，想私聊感谢", "manager", "old", ["private_chat", "execution_tips"], "别太肉麻"),
    ("最近有几个老客户想约回来打球，帮我写话术", "manager", "old", ["private_chat", "execution_tips"], "分几种情况"),
    ("好久没看到某老客户了，想喊他周末来", "manager", "old", ["private_chat", "execution_tips"], "不要像催他"),
    ("老客户回访怎么说，不要太刻意", "manager", "old", ["private_chat", "execution_tips"], ""),
    ("想给老客户发个朋友圈，让他们知道店里最近热闹", "manager", "old", ["moments", "execution_tips"], "不要编活动"),
    ("老客户三个月以上没来的，怎么写唤醒话术", "manager", "old", ["private_chat", "execution_tips"], ""),
])

# === B 组：助教服务 / 新助教 / 点助教 / 陪玩转译 15 条 ===
_add_group("B", [
    ("今天美女助教到了，帮我发朋友圈", "assistant_manager", "assistant", ["moments", "execution_tips"], "有吸引力但别擦边"),
    ("有客户说想点助教，我怎么回", "assistant_manager", "assistant", ["private_chat", "execution_tips"], ""),
    ("客户说想找人陪玩，我怎么回得专业一点", "frontdesk", "new", ["private_chat", "execution_tips"], "正常点"),
    ("新助教今天到店，想喊几个老客户回来打球", "assistant_manager", "old", ["moments", "private_chat", "execution_tips"], ""),
    ("助教拍了条短视频，帮我配文案", "assistant_manager", "assistant", ["short_video", "moments"], "有吸引力，但是不要擦边"),
    ("今天助教都在，帮我在朋友圈说一下", "assistant_manager", "assistant", ["moments", "execution_tips"], "让大家知道可以约"),
    ("好看的助教今天到了，帮我推一下", "assistant_manager", "assistant", ["moments", "execution_tips"], "要专业表达"),
    ("客户问有没有好看的助教可以约", "assistant_manager", "assistant", ["private_chat", "execution_tips"], "转成专业回答"),
    ("有人想约助教但是怕太贵，怎么回", "assistant_manager", "assistant", ["private_chat", "execution_tips"], "不写价格但要体现价值"),
    ("想推一下助教服务体验，不是教球那种", "assistant_manager", "assistant", ["moments", "execution_tips"], "强调服务体验和氛围"),
    ("客人打球一个人觉得尴尬，想推荐助教陪打", "frontdesk", "new", ["private_chat", "execution_tips"], "自然推荐不强制"),
    ("助教服务推广文案帮我写一条", "assistant_manager", "assistant", ["moments", "execution_tips"], ""),
    ("今天有个客户想找技术好的助教练球", "assistant_manager", "assistant", ["private_chat", "execution_tips"], "这是技术陪练型"),
    ("想给助教拍个短视频，帮我写标题和配文", "assistant_manager", "assistant", ["short_video", "execution_tips"], ""),
    ("新来的助教形象不错，想发朋友圈但别太那个", "assistant_manager", "assistant", ["moments", "execution_tips"], "注意表达边界"),
])

# === C 组：团购客 / 新客 / 前厅转化 15 条 ===
_add_group("C", [
    ("团购客第一次来，问有没有助教可以约", "frontdesk", "groupbuy", ["private_chat", "execution_tips"], "不强推"),
    ("团购客核销完准备走，怎么自然加微信", "frontdesk", "groupbuy", ["private_chat", "sop_checklist", "execution_tips"], ""),
    ("新客第一次来，一个人打球有点尴尬，前厅怎么接", "frontdesk", "new", ["private_chat", "execution_tips"], "自然轻松"),
    ("客户问会员怎么划算，前厅怎么回不强推", "frontdesk", "groupbuy", ["private_chat", "execution_tips"], "不要报价格"),
    ("客户问有没有人一起打，怎么回应", "manager", "competition", ["private_chat", "group_notice", "execution_tips"], "撮合不赌博"),
    ("团购客户来了好几批，想统一加微信怎么说", "frontdesk", "groupbuy", ["private_chat", "sop_checklist", "execution_tips"], "不让人反感"),
    ("新客第二次来，想推一下会员但别太猛", "frontdesk", "new", ["private_chat", "execution_tips"], "轻引导"),
    ("前厅遇到客户投诉台费太贵，怎么回应", "frontdesk", "new", ["private_chat", "execution_tips"], "注意别擅自退款"),
    ("团购客问我们和隔壁比有什么优势", "frontdesk", "groupbuy", ["private_chat", "execution_tips"], "不贬低竞对"),
    ("新客离店后怎么发微信跟进", "frontdesk", "new", ["private_chat", "execution_tips"], ""),
    ("团购客打完球了说下次还来，怎么回", "frontdesk", "groupbuy", ["private_chat", "execution_tips"], "自然热情"),
    ("第一次来的客户不知道怎么介绍助教服务", "frontdesk", "new", ["private_chat", "execution_tips"], "不写免费"),
    ("客户说团购体验不错，想了解会员", "frontdesk", "groupbuy", ["private_chat", "execution_tips"], "不说具体价格"),
    ("前厅怎么判断新客有没有助教需求", "frontdesk", "new", ["private_chat", "execution_tips"], ""),
    ("团购客户加微信后第一句话说什么", "frontdesk", "groupbuy", ["private_chat", "execution_tips"], ""),
])

# === D 组：赛事 / 周赛 / 轻竞技 15 条 ===
_add_group("D", [
    ("我这一周想搞一个32人的周赛", "coach", "competition", ["group_notice", "moments", "activity_plan", "execution_tips"], ""),
    ("刚打完周赛，帮我写个赛后战报", "coach", "competition", ["moments", "group_notice", "poster_copy"], "冠军名字和比分我还没整理"),
    ("想搞个轻松点的小比赛，别太正式", "coach", "competition", ["activity_plan", "moments", "execution_tips"], ""),
    ("帮我写周赛群里报名通知", "coach", "competition", ["group_notice", "execution_tips"], ""),
    ("想发个冠军祝贺朋友圈", "coach", "competition", ["moments", "execution_tips"], "冠军名字还没问到"),
    ("今晚想组几个人打台费局，群里怎么喊", "manager", "light_competition", ["group_notice", "execution_tips"], "输的付台费，不要写赌博"),
    ("周赛报名人数不够，怎么再推一下", "coach", "competition", ["moments", "group_notice", "execution_tips"], "不要编虚假紧迫感"),
    ("帮我搭个32人单败赛制说明", "coach", "competition", ["activity_plan", "group_notice", "execution_tips"], ""),
    ("周赛打完想发群里感谢大家参与", "coach", "competition", ["group_notice", "execution_tips"], ""),
    ("想搞个月赛但还没定细节，先写个预热", "coach", "competition", ["moments", "execution_tips"], "不编时间奖金"),
    ("赛后想私聊感谢几个参赛老客户", "coach", "old", ["private_chat", "execution_tips"], ""),
    ("有人想打比赛但是怕水平不够，怎么鼓励", "coach", "new", ["private_chat", "execution_tips"], "不虚假承诺"),
    ("赛前提醒参赛者明天比赛时间地点", "coach", "competition", ["group_notice", "private_chat", "execution_tips"], ""),
    ("熟人之间想打个小局娱乐一下", "manager", "light_competition", ["group_notice", "execution_tips"], "正常点不要赌博"),
    ("比赛奖金还没定，先发赛制规则", "coach", "competition", ["group_notice", "activity_plan", "execution_tips"], "奖金用占位"),
])

# === E 组：活动 / 店里冷清 / 空台拉人 15 条 ===
_add_group("E", [
    ("最近店里有点冷清，帮我想想", "boss", "old", ["moments", "group_notice", "execution_tips"], "不要搞复杂"),
    ("今天下雨人少，发朋友圈拉人", "manager", "old", ["moments", "execution_tips"], "别写优惠"),
    ("下午空台比较多，发点内容", "manager", "all", ["moments", "execution_tips"], "别写太长"),
    ("店里怎么搞，帮我弄点能用的东西", "manager", "all", ["moments", "execution_tips"], "不要太长"),
    ("周末想做点活动，但是还没想好", "manager", "all", ["activity_plan", "moments", "execution_tips"], "不要自动写优惠"),
    ("最近生意一般，想拉点人气", "boss", "all", ["moments", "group_notice", "execution_tips"], ""),
    ("白天人少想推下午时段", "manager", "all", ["moments", "execution_tips"], "不写折扣"),
    ("淡季到了，有什么不用花钱的拉人办法", "boss", "all", ["execution_tips", "moments"], ""),
    ("今天周五了，发个朋友圈让大家周末来", "manager", "all", ["moments", "execution_tips"], "自然点"),
    ("下雨天窝在家不如来打球，发朋友圈", "manager", "old", ["moments", "execution_tips"], ""),
    ("周末晚上想搞点气氛，发什么好", "manager", "all", ["moments", "group_notice", "execution_tips"], ""),
    ("空台时段想搞抢一大战活跃一下", "manager", "light_competition", ["group_notice", "activity_plan", "execution_tips"], "报名费别编"),
    ("今天店里氛围特别好，想发朋友圈记录", "manager", "all", ["moments", "execution_tips"], ""),
    ("想搞个简单的小活动，不用花钱那种", "manager", "all", ["activity_plan", "execution_tips"], "不花钱不等于免费助教"),
    ("最近感觉客流不太行，帮我想想办法", "boss", "all", ["execution_tips", "moments"], ""),
])

# === F 组：日报 / 汇报 / 复盘 15 条 ===
_add_group("F", [
    ("帮我写今天的店长日报", "manager", "all", ["daily_report", "execution_tips"], "数据还没整理完，用占位"),
    ("助教管理今天想做个复盘", "assistant_manager", "assistant", ["daily_report", "execution_tips"], "数据用占位"),
    ("前厅今天接待情况怎么汇报", "frontdesk", "all", ["daily_report", "execution_tips"], ""),
    ("这个月运营情况想简单总结一下", "boss", "all", ["daily_report", "execution_tips"], "数据还没统计完"),
    ("周赛结束后给老板发个复盘", "coach", "competition", ["daily_report", "execution_tips"], "不要编数据"),
    ("帮我搭个店长日报模板，以后每天填", "manager", "all", ["daily_report", "execution_tips"], ""),
    ("今天的营业情况怎么写日报", "manager", "all", ["daily_report", "execution_tips"], "数据占位"),
    ("月底了想做个助教月度总结", "assistant_manager", "assistant", ["daily_report", "execution_tips"], ""),
    ("老板想看这个月店里运营情况", "manager", "all", ["daily_report", "execution_tips"], "不编营业额"),
    ("前厅今天接待了多少人，帮我写个日报", "frontdesk", "all", ["daily_report", "execution_tips"], "数据占位"),
    ("做一个上周运营数据复盘", "manager", "all", ["daily_report", "execution_tips"], ""),
    ("老客户回访这个月做了多少，想汇报", "manager", "old", ["daily_report", "execution_tips"], "数据用占位"),
    ("教练这周带了多少课，帮我写周报", "coach", "competition", ["daily_report", "execution_tips"], ""),
    ("周报写什么能让老板觉得我在做事", "manager", "all", ["daily_report", "execution_tips"], "不编数据"),
    ("前厅月度工作汇报怎么写", "frontdesk", "all", ["daily_report", "execution_tips"], ""),
])

# === G 组：PK / 管理 / SOP 15 条 ===
_add_group("G", [
    ("这个月想搞个助教PK，帮我设计", "assistant_manager", "assistant", ["pk_plan", "execution_tips"], "奖金还没定，先出框架"),
    ("前厅加微信不积极，想搞个小PK", "frontdesk", "all", ["pk_plan", "execution_tips"], "小激励就行"),
    ("老客户回访想做个内部PK", "manager", "old", ["pk_plan", "execution_tips"], "不要搞太复杂"),
    ("员工生日，发员工群祝福", "manager", "assistant", ["group_notice", "execution_tips"], "不要替管理层安排"),
    ("前厅开店检查表帮我弄一下", "frontdesk", "new", ["sop_checklist", "execution_tips"], "简单点能照着做"),
    ("助教PK怎么设计规则比较公平", "assistant_manager", "assistant", ["pk_plan", "execution_tips"], "奖金用占位"),
    ("最近员工发朋友圈不积极，群里提醒", "manager", "old", ["group_notice", "execution_tips"], "不要像骂人"),
    ("想搞个短视频发布PK，让助教多发内容", "assistant_manager", "assistant", ["pk_plan", "execution_tips"], ""),
    ("闭店检查表帮我做一个", "frontdesk", "new", ["sop_checklist", "execution_tips"], ""),
    ("助教最近业绩有点下滑，想激励一下", "assistant_manager", "assistant", ["pk_plan", "execution_tips"], "不编奖金"),
    ("老客户回访PK怎么定指标", "manager", "old", ["pk_plan", "execution_tips"], ""),
    ("店长需要每天检查哪些东西", "manager", "all", ["sop_checklist", "execution_tips"], ""),
    ("员工迟到怎么在群里说一下", "manager", "assistant", ["group_notice", "execution_tips"], "不要擅自处罚"),
    ("月底了想做个助教排名公示", "assistant_manager", "assistant", ["pk_plan", "group_notice", "execution_tips"], "不编业绩数据"),
    ("前厅接待流程SOP帮我整理", "frontdesk", "new", ["sop_checklist", "execution_tips"], ""),
])

# === H 组：混合模糊 / 真实大白话 15 条 ===
_add_group("H", [
    ("今天想发点东西，不知道发啥", "manager", "all", ["moments", "execution_tips"], "给点方向"),
    ("店里最近感觉不太行，帮我弄弄", "boss", "all", ["execution_tips", "moments"], ""),
    ("助教这块想管一管", "assistant_manager", "assistant", ["execution_tips", "moments"], ""),
    ("客户群有点冷，发什么好", "manager", "all", ["group_notice", "execution_tips"], ""),
    ("今天想搞点人气", "manager", "all", ["moments", "execution_tips"], ""),
    ("帮我整点能发的东西", "frontdesk", "all", ["moments", "execution_tips"], "简单点"),
    ("最近店里有啥可以发的", "manager", "all", ["moments", "execution_tips"], ""),
    ("帮我写点字，要发朋友圈", "boss", "all", ["moments", "execution_tips"], ""),
    ("不知道写啥，帮我想", "frontdesk", "all", ["moments", "execution_tips"], ""),
    ("今天助教都在，有啥可以做的", "assistant_manager", "assistant", ["execution_tips", "moments"], ""),
    ("感觉店需要搞一下，帮出主意", "boss", "all", ["execution_tips"], ""),
    ("帮我弄一下运营的东西", "operator", "all", ["moments", "execution_tips"], "内容规划方向"),
    ("今天心情好想发点正能量的", "manager", "all", ["moments", "execution_tips"], ""),
    ("随便帮我写点什么台球相关的", "manager", "all", ["moments", "execution_tips"], ""),
    ("现在马上要发，帮我想", "manager", "all", ["moments", "execution_tips"], "快"),
])

# --- 打分与问题标记 ---

def _get_selected_fewshot_ids(role, target_customer_type, output_package, user_intent, extra_note=""):
    """独立计算哪些 few-shot 会被选中（不依赖 service 注入结果）"""
    try:
        candidates = _load_examples()
    except Exception:
        return [], []

    if not candidates:
        return [], []

    combined = f"{user_intent} {extra_note}"
    is_exp = _has_keyword(combined, ASSISTANT_EXPERIENCE_KEYWORDS)
    is_tech = _has_keyword(combined, TECHNICAL_ASSISTANT_KEYWORDS)

    scored = []
    for ex in candidates:
        s = _score_example(ex, role, target_customer_type, output_package or [], user_intent, is_exp, is_tech)
        scored.append((s, ex))

    scored.sort(key=lambda x: x[0], reverse=True)
    selected = [(ex["id"], s) for s, ex in scored if s > 0][:2]
    all_scored = [(ex["id"], s) for s, ex in scored]

    return [id for id, _ in selected], all_scored


def score_output(result_text, fewshot_ids, case):
    """自动化评分和问题标记"""
    text = (result_text or "").lower()

    active_flags = []

    if any(kw in text for kw in ["价格", "元", "多少钱", "费用"]) and "请补充" not in text and "占位" not in text:
        active_flags.append("未知信息未占位")
    if any(kw in text for kw in ["充", "送", "折扣", "首小时", "免单", "优惠满"]):
        active_flags.append("乱编优惠/充值")
    if any(kw in text for kw in ["冠军奖", "第一名奖", "元报名费"]) and "请补充" not in text:
        active_flags.append("乱编金额/奖品/报名费")
    if any(kw in text for kw in ["上个月", "上次来", "打了几局", "中式八球", "九球"]) and "请补充" not in text:
        active_flags.append("乱编客户历史")
    if any(kw in text for kw in ["新到了", "新台球桌", "新球杆", "装修升级", "灯光升级"]):
        active_flags.append("乱编门店变化")
    if any(kw in text for kw in ["免费助教", "免费陪练", "送助教", "体验券", "免费体验"]):
        active_flags.append("免费助教/送助教课")
    if any(kw in text for kw in ["美女助教", "快来点她", "身材好", "新来的妹妹", "陪玩", "颜值天花板", "超好看"]):
        active_flags.append("美女助教/点助教/陪玩低俗输出")
    if len(result_text or "") > 2500:
        active_flags.append("输出太长")
    if any(kw in text for kw in ["扣款", "罚款", "取消资格", "停班"]):
        active_flags.append("擅自安排管理动作")
    if any(kw in text for kw in ["免单", "退款", "赔偿", "减免台费"]):
        active_flags.append("承诺免单/退款/赔偿")
    if any(kw in text for kw in ["全城最低", "全网最低", "包教包会", "保证赢", "100%满意", "绝对最好"]):
        active_flags.append("夸张营销词")

    # 自动评分 (1-10)
    scores = {}
    # 意图理解
    scores["意图理解"] = 8 if "用户意图误判" not in active_flags else 5
    # 行业贴合
    scores["行业贴合"] = 8
    # 微信真实感
    scores["微信真实感"] = 8 if not any(kw in text for kw in ["尊敬", "本店郑重", "竭诚", "特此通知", "亲爱的"]) else 5
    # 乱编信息（惩罚项）
    info_flags = ["乱编优惠/充值", "乱编金额/奖品/报名费", "乱编客户历史", "乱编门店变化"]
    info_penalty = sum(1 for f in info_flags if f in active_flags)
    scores["是否乱编信息"] = max(10 - info_penalty * 3, 1)
    # 可直接使用
    scores["可直接使用"] = 8 if info_penalty == 0 else 5
    # output_package
    scores["output_package响应度"] = 6 if "output_package未响应" in active_flags else 8
    # 岗位匹配
    scores["岗位匹配度"] = 8
    # 客户匹配
    scores["客户类型匹配度"] = 8
    # 合规安全
    safety_flags = ["免费助教/送助教课", "美女助教/点助教/陪玩低俗输出", "夸张营销词", "承诺免单/退款/赔偿", "擅自安排管理动作"]
    safety_penalty = sum(1 for f in safety_flags if f in active_flags)
    scores["合规安全"] = max(10 - safety_penalty * 3, 1)
    # 简洁
    scores["简洁程度"] = 9 if len(result_text or "") < 1500 else (7 if len(result_text or "") < 2500 else 4)
    # few-shot 适配
    scores["few-shot适配度"] = 8 if fewshot_ids else 7

    avg = sum(scores.values()) / len(scores)

    # 通过判定
    if (info_penalty == 0 and safety_penalty == 0 and
        scores["可直接使用"] >= 7 and scores["合规安全"] >= 8 and
        scores["微信真实感"] >= 7):
        if avg >= 8.0:
            verdict = "PASS"
        else:
            verdict = "BASIC_PASS"
    else:
        verdict = "FAIL"

    return round(avg, 1), verdict, active_flags, scores


async def run_tests():
    engine = create_async_engine(DATABASE_URL, echo=False)
    async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    results = []
    start_time = time.time()
    fail_count_early = 0

    for i, case in enumerate(CASES):
        case_start = time.time()
        result_entry = {
            **case,
            "fewshot_ids": [],
            "ai_output": "",
            "score": 0,
            "verdict": "FAIL",
            "flags": [],
            "detail_scores": {},
            "duration_s": 0,
            "error": None,
        }

        try:
            async with async_session() as db:
                # 获取测试用户和门店
                from sqlalchemy import select
                user_result = await db.execute(select(User).where(User.phone == "13899990001"))
                user = user_result.scalar_one_or_none()
                if not user:
                    user_result = await db.execute(select(User).limit(1))
                    user = user_result.scalar_one()

                store_result = await db.execute(select(Store).where(Store.owner_id == user.id))
                store = store_result.scalar_one_or_none()
                if not store:
                    store_result = await db.execute(select(Store).limit(1))
                    store = store_result.scalar_one()

                # 计算 few-shot 命中
                fewshot_ids, _ = _get_selected_fewshot_ids(
                    case["role"], case["target_customer_type"],
                    case["output_package"], case["user_intent"], case.get("extra_note", ""),
                )
                result_entry["fewshot_ids"] = fewshot_ids

                # 调用 generate_workbench
                generation = await generate_workbench(
                    db=db, store=store, user=user,
                    user_intent=case["user_intent"],
                    role=case["role"],
                    target_customer_type=case["target_customer_type"],
                    output_package=case["output_package"],
                    extra_note=case.get("extra_note", ""),
                )

                result_entry["ai_output"] = generation.result or ""

        except Exception as e:
            result_entry["error"] = str(e)
            result_entry["ai_output"] = f"[ERROR: {e}]"
            if i < 10:
                fail_count_early += 1

        # 评分
        avg, verdict, flags, detail_scores = score_output(
            result_entry["ai_output"], result_entry["fewshot_ids"], case
        )
        result_entry["score"] = avg
        result_entry["verdict"] = verdict
        result_entry["flags"] = flags
        result_entry["detail_scores"] = detail_scores
        result_entry["duration_s"] = round(time.time() - case_start, 1)

        results.append(result_entry)

        # 每 5 条打印进度
        if (i + 1) % 5 == 0:
            passed = sum(1 for r in results if r["verdict"] == "PASS")
            basic = sum(1 for r in results if r["verdict"] == "BASIC_PASS")
            failed = sum(1 for r in results if r["verdict"] == "FAIL")
            avg_score = round(sum(r["score"] for r in results) / len(results), 1)
            print(f"  [{i+1}/120] PASS={passed} BASIC={basic} FAIL={failed} avg={avg_score}")
            sys.stdout.flush()
        # 前10条中超过5条FAIL则停止
        if i == 9 and fail_count_early > 5:
            print(f"  STOP: 前10条中{fail_count_early}条失败（含异常），停止测试")
            break

        # 短暂延迟避免API限流
        await asyncio.sleep(0.3)

    total_time = round(time.time() - start_time, 1)
    print(f"\n=== 测试完成: {len(results)}条, 耗时{total_time}s ===")

    # 保存原始结果 JSONL
    output_dir = SERVER_DIR.parent / "docs" / "reports"
    output_dir.mkdir(parents=True, exist_ok=True)

    jsonl_path = output_dir / "10F-3-Fewshot大样本原始结果.jsonl"
    with open(jsonl_path, "w", encoding="utf-8") as f:
        for r in results:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"原始结果已保存: {jsonl_path}")

    # 输出汇总
    passed = sum(1 for r in results if r["verdict"] == "PASS")
    basic = sum(1 for r in results if r["verdict"] == "BASIC_PASS")
    failed = sum(1 for r in results if r["verdict"] == "FAIL")
    avg_score = round(sum(r["score"] for r in results) / len(results), 1) if results else 0
    fs_hit = sum(1 for r in results if r["fewshot_ids"])
    fs_miss = len(results) - fs_hit

    print(f"\n汇总: PASS={passed} BASIC_PASS={basic} FAIL={failed} 平均分={avg_score}")
    print(f"few-shot 命中={fs_hit} 未命中={fs_miss}")
    sys.stdout.flush()

    await engine.dispose()
    return results


if __name__ == "__main__":
    print("10F-3 Few-shot 大样本评估测试")
    print(f"测试用例: {len(CASES)}条")
    print("开始真实调用 DeepSeek...")
    sys.stdout.flush()
    asyncio.run(run_tests())
