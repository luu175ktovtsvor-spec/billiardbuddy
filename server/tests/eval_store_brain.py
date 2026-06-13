# -*- coding: utf-8 -*-
"""店脑（AI 记忆中枢）验收套件 / golden eval。

这是"先测试再编码"的验收标准：店脑功能要对着这套测试写（红→绿）。

特点（区别于普通单测）：
- 调真实 DeepSeek（LLM 行为评估），慢且要 API key → **不随默认 pytest 跑**：
  文件名 eval_* 不被默认收集；显式运行：`pytest tests/eval_store_brain.py -s`
- 无 key 自动跳过（CI/他人不受阻）。
- 判分按上一轮实测的教训修正：
  ① 抽取不用粗子串匹配（避免"没有包厢"含"有包厢"式误杀）；
  ② **整合按"最终记忆对不对"判（无重复 + 改价生效），不强求 ADD/UPDATE 标签** →
     接口 consolidate_memories 直接返回整合后的列表。

被测接口（services/memory_service.py，待实现）：
  @dataclass Memory(type, content, confidence)
  async extract_memories(interaction_text) -> list[Memory]
  async consolidate_memories(existing, new) -> list[Memory]   # 返回整合后的最终列表
  format_memories_for_prompt(memories) -> str
"""
import asyncio
import pytest

from config import settings

pytestmark = pytest.mark.skipif(
    not settings.deepseek_api_key, reason="无 DeepSeek key，跳过店脑 LLM 评估"
)

from services.memory_service import (  # noqa: E402  (RED：尚未实现)
    Memory,
    extract_memories,
    consolidate_memories,
    format_memories_for_prompt,
)

VALID_TYPES = {"semantic", "preference", "operational", "episodic"}


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _joined(mems) -> str:
    return " | ".join(m.content for m in mems)


# ── 抽取：(名称, 输入, 必须捕获的关键值, 不得出现的"凭空捏造值") ──
# 捏造值都精挑过，确保不会是正确输出的子串（不重蹈上一轮误杀）
_EXTRACT = [
    ("多事实+否定+涨价",
     "我们店周末特别火工作日下午没人。我不爱搞活动平时就发朋友圈。我们没有包厢全是大厅。金腿台涨到68一小时了。",
     ["68"], ["2间", "3间", "8折"]),
    ("运营节奏",
     "工作日中午几个老客固定来，晚上7点后才热闹，周一全天最差。",
     ["7", "周一"], ["助教", "包厢", "团购"]),
    ("口吻偏好+客群",
     "写文案别太正式，我们都是喊哥喊姐那种。客人主要是附近上班的年轻人。",
     ["哥", "年轻"], ["老年", "老人", "高端商务"]),
    ("结构化事实",
     "我们有3个助教，初级88中级128。包厢2间，包厢台费100一小时。",
     ["3", "88", "128"], ["金腿", "斯诺克", "68"]),
    ("隐含·活动效果",
     "上次中秋搞的免费水加赛事那个活动，来的人比平时多一倍，老客都说好。",
     ["中秋", "赛事"], ["端午", "春节", "圣诞"]),
    ("噪声·只挑相关",
     "今天天气真好中午吃了个面。哦对我们最近想多搞点抖音。",
     ["抖音"], ["天气", "面条", "午饭"]),
]

# ── 整合：(名称, 已有, 新, 校验函数(最终列表)->bool, 失败说明) ──
def _topic(mems, *kw):
    return [m for m in mems if any(k in m.content for k in kw)]

_CONSOLIDATE = [
    ("改价：更新不重复",
     [("semantic", "金腿台费 60元/时")], [("semantic", "金腿台费 68元/时")],
     lambda r: len(_topic(r, "金腿")) == 1 and "68" in _joined(r) and "60" not in _joined(r),
     "应只剩一条金腿且为68、不留60"),
    ("矛盾：包厢拆了→覆盖",
     [("semantic", "有2间包厢")], [("semantic", "包厢拆了，现在全是大厅")],
     lambda r: "大厅" in _joined(r) and "2间" not in _joined(r),
     "应反映全大厅、不再留2间包厢"),
    ("换说法重复：不新增",
     [("semantic", "客群主要是附近上班族")], [("semantic", "客人大多是周边写字楼白领")],
     lambda r: len(_topic(r, "客", "上班", "白领", "写字楼")) == 1,
     "客群只应有一条，不重复"),
    ("无新意：不新增",
     [("operational", "周末火爆")], [("operational", "周末人很多")],
     lambda r: len(_topic(r, "周末")) == 1,
     "周末只应有一条"),
    ("不同台型：保留两条",
     [("semantic", "金腿台费 68元/时")], [("semantic", "银腿台费 45元/时")],
     lambda r: "金腿" in _joined(r) and "银腿" in _joined(r),
     "金腿银腿都应在（ADD 不混淆）"),
]

# ── 防幻觉：(名称, 输入, 不得出现) ──
_ABSTAIN = [
    ("只氛围", "周末来打球的人挺多氛围不错挺热闹。", ["元", "助教", "包厢", "会员"]),
    ("含糊", "最近生意一般吧。", ["%", "30", "因为价格", "活动"]),
]


def test_extraction_recall_and_no_hallucination():
    # LLM 行为评估是统计性的（非确定）：防幻觉=信任底线，必须 0；
    # 召回允许 6 条里抖动 ≤1（避免把单次 LLM 波动误判成回归）。
    recall_miss, halluc_fail = [], []
    for name, text, must, forbidden in _EXTRACT:
        mems = _run(extract_memories(text))
        blob = _joined(mems)
        miss = [m for m in must if m not in blob]
        halluc = [f for f in forbidden if f in blob]
        if halluc:
            halluc_fail.append(f"[{name}] 幻觉={halluc} | {blob[:100]}")
        if miss:
            recall_miss.append(f"[{name}] 漏抓={miss} | {blob[:100]}")
    assert not halluc_fail, "出现幻觉（信任底线，必须 0）:\n" + "\n".join(halluc_fail)
    assert len(recall_miss) <= 1, "召回漏太多（>1/6）:\n" + "\n".join(recall_miss)


def test_consolidation_outcomes():
    fails = []
    for name, ex, nw, check, why in _CONSOLIDATE:
        existing = [Memory(t, c, "high") for t, c in ex]
        new = [Memory(t, c, "high") for t, c in nw]
        result = _run(consolidate_memories(existing, new))
        if not check(result):
            fails.append(f"[{name}] {why} | 最终={_joined(result)}")
    assert not fails, "整合未达标:\n" + "\n".join(fails)


def test_abstention_no_fabrication():
    fails = []
    for name, text, forbidden in _ABSTAIN:
        mems = _run(extract_memories(text))
        blob = _joined(mems)
        halluc = [f for f in forbidden if f in blob]
        if halluc:
            fails.append(f"[{name}] 瞎编={halluc} | {blob[:120]}")
    assert not fails, "防幻觉未达标:\n" + "\n".join(fails)


def test_extraction_returns_valid_memory_objects():
    mems = _run(extract_memories("我们有3个助教，金腿台费68一小时。"))
    assert mems, "应抽出至少一条记忆"
    for m in mems:
        assert m.type in VALID_TYPES, f"非法类型 {m.type}"
        assert isinstance(m.content, str) and m.content.strip(), "content 不能空"


def test_format_memories_for_prompt_is_injectable_text():
    # 纯函数，不调 API
    text = format_memories_for_prompt([
        Memory("preference", "文案用熟人口吻、不用表情", "high"),
        Memory("semantic", "没有包厢，全是大厅", "high"),
    ])
    assert isinstance(text, str) and text.strip()
    assert "熟人口吻" in text and "大厅" in text
