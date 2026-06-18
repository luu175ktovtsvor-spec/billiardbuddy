# -*- coding: utf-8 -*-
"""北极星大规模对齐测试 runner（eval-driven 迭代的核心引擎）。

目标：用一套固定的"模拟门店 + 场景集 + 北极星谓词"，大规模、可重复地量化
"AI 产出有没有脱离北极星"。这是 DeepSeek 不会自我进化前提下、让产品"越来越懂台球"
唯一现实的工程闭环：产出 → 自动判定贴不贴北极星 → 暴露偏差 → 改 YAML/prompt → 再测。

判定哲学（v2 校准，基于 baseline 实测教训）：
- **LLM-as-judge 主导**：DeepSeek 当"北极星审查员"看语境打 1-5 分，这是主判据。
- **机器关键词只做兜底**：仅 HARD_FORBIDDEN（任何语境都是硬伤的词，如"美女助教/包教包会/全城最低价"）
  命中才机器判 RED。其余 must_hit/场景forbidden/谓词forbidden 都只作"报告参考"，不机械判罚——
  因为它们语境敏感（"不赌钱"含"赌钱"、"中八打法"含"打法"、内部方案含"闭环"），机器扫会误伤。
- **judge 失败(重试后仍无分) → NO_JUDGE**，独立分类、不污染 GREEN/RED。
- 三级：score≥4=GREEN / score==3=YELLOW / score≤2 或 HARD命中=RED。

设计：无数据库依赖，构造 in-memory Store + 模拟店脑/员工记忆，复刻真实 prompt 拼装，
绕过配额/落库/品牌声音（不影响"内容质量 vs 北极星"测量）。复刻 5 种生成路径。

跑法（server/ 目录下）：
  uv run python evals/run_northstar_eval.py --dry-run             # 零成本校验素材+拼prompt
  uv run python evals/run_northstar_eval.py --self-test           # 内联1场景验证框架
  uv run python evals/run_northstar_eval.py --limit 5             # 抽样
  uv run python evals/run_northstar_eval.py --concurrency 3       # 全量(默认并发3，防限流)
"""
import argparse
import asyncio
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import yaml  # noqa: E402

from config import settings  # noqa: E402
from models.store import Store  # noqa: E402
from services.ai.base import TextRequest  # noqa: E402
from services.ai.factory import ProviderFactory  # noqa: E402
from services.ai.prompt_engine import get_prompt_engine  # noqa: E402
from services.memory_service import Memory, with_store_brain  # noqa: E402
from services.store_profile_service import render_operation_profile_context  # noqa: E402
from services.workbench_fewshot_service import select_workbench_fewshots  # noqa: E402
from services.scenario_role_map import SCENARIO_ROLE_MAP  # noqa: E402
from services.content_service import (  # noqa: E402
    _append_guardrails,
    _load_rule_safe,
    _load_knowledge_for_role,
    _format_output_package,
    _strip_ai_prefixes,
    concise_directive,
    ROLE_LABELS,
    CUSTOMER_LABELS,
    TONE_LABELS,
    ACTIVITY_GOAL_LABELS,
    BUDGET_LABELS,
)

try:
    from services.diagnosis_service import PROBLEM_AREA_LABELS
except Exception:
    PROBLEM_AREA_LABELS = {}
try:
    from services.outreach_service import CUSTOMER_TYPE_LABELS, STYLE_LABELS
except Exception:
    CUSTOMER_TYPE_LABELS, STYLE_LABELS = {}, {}

prompt_engine = get_prompt_engine()
EV_DIR = Path(__file__).resolve().parent
ROOT = EV_DIR.parent.parent

# 生成模型覆盖（A/B 用）：设了 GEN_OVERRIDE_{BASE,KEY,MODEL} 三个 env 就用它做"生成"，
# 裁判 llm_judge 仍走项目默认 provider（DeepSeek）—— 只换一个变量，A/B 才公平。
_GEN_CLIENT = None
_GEN_MODEL = os.environ.get("GEN_OVERRIDE_MODEL")
if os.environ.get("GEN_OVERRIDE_KEY") and os.environ.get("GEN_OVERRIDE_BASE") and _GEN_MODEL:
    from openai import AsyncOpenAI
    _GEN_CLIENT = AsyncOpenAI(
        base_url=os.environ["GEN_OVERRIDE_BASE"],
        api_key=os.environ["GEN_OVERRIDE_KEY"],
        timeout=300,
    )

_STORE_FIELDS = {
    "name", "city", "district", "address", "phone", "business_hours",
    "table_count", "table_types", "pricing", "member_cards", "operation_profile",
    "has_private_room", "has_coaching", "has_tournament", "has_parking",
    "coach_count", "coach_service_types", "coach_price_range", "cue_price_range",
    "beverage_price_range", "snack_price_range", "table_brands", "cue_brands",
    "other_equipment", "membership_types", "recharge_rules", "membership_benefits",
    "daily_avg_customers", "peak_hours", "avg_spend_range",
    "target_customers", "style", "advantages", "common_activities", "brand_style",
}

# 硬红线：任何语境/任何场景出现即为硬伤（含否定语境也不该出现在产出里）。
# 刻意精选——只放"正常台球产出几乎不可能正当出现"的词，避免误伤。语境敏感词（赌钱/打法/
# 闭环/小姐姐/比赛台/充5000送2000 等）一律不放这里，交给 LLM judge 看语境判定。
HARD_FORBIDDEN = [
    # 真底线①：实际性交易/越界服务（助教是台球陪练，不营销性服务）
    # —— 颜值/美女助教/情绪价值/陪打/暧昧感等是台球行业真实营销词，不在此列
    "性服务", "性交易", "援交", "包夜", "上门过夜", "特殊服务",
    # 真底线②：无法兑现的承诺（虚假宣传）
    "包教包会", "保证赢球", "100%学会", "保证出成绩",
    # 真底线③：无法核实的绝对化价格（广告法）
    "全城最低价", "全网最低价", "附近最便宜", "全市最低", "全城最低",
    # 真底线④：刷评/造假
    "刷好评", "买好评", "代刷好评", "虚假评价",
    # C端夸张套话（外行味，不是行业真实表达）
    "闭眼入", "全城爆火", "老板疯了",
    # 注（2026-06-17 全真实改造）：美女助教/颜值/情绪价值/陪打/暧昧感/追分/约局/台费局/交友软件获客(探探/陌陌)
    # 等是台球行业真实表达，已全面放开、不再机器禁。剩下的真底线只有：实际性交易、虚假承诺、绝对化价格、刷评。
    # 更细的（门店是否亲自当庄抽水、是否把助教写成实际性交易、是否露骨色情）交给 LLM judge 看语境。
]


# ────────────────────────────────────────────────────────────────────
# 模拟门店 / 记忆构造
# ────────────────────────────────────────────────────────────────────
def build_store(d: dict) -> Store:
    fields = {k: v for k, v in d.items() if k in _STORE_FIELDS}
    return Store(id=uuid.uuid4(), owner_id=uuid.uuid4(), **fields)


def build_memories(d: dict) -> list[Memory]:
    raw = list(d.get("memories") or []) + list(d.get("staff_memories") or [])
    out: list[Memory] = []
    for m in raw:
        if not isinstance(m, dict) or not m.get("content"):
            continue
        out.append(Memory(m.get("type", "semantic"), m["content"], m.get("confidence", "high")))
    return out


# ────────────────────────────────────────────────────────────────────
# 复刻 5 种生成路径的真实 prompt 拼装（与 content_service / *_service 一致，去掉 DB）
# ────────────────────────────────────────────────────────────────────
def compose_prompt(scene: dict, store: Store) -> str:
    gen = scene.get("generator", "workbench_free")
    inp = scene.get("input", {}) or {}
    role = scene.get("role", "manager")
    note = (inp.get("extra_note") or "")

    if gen == "workbench_free":
        intent = inp.get("user_intent", "") or ""
        ctype = inp.get("target_customer_type") or "all"
        baseline = _load_rule_safe("rules.baseline", store)
        role_rules = _load_rule_safe(f"rules.role.{role}", store)
        customer_rules = _load_rule_safe(f"rules.customer.{ctype}", store)
        knowledge = _load_knowledge_for_role(role, store, f"{intent} {note}")
        try:
            fewshots = select_workbench_fewshots(
                role=role, target_customer_type=ctype,
                output_package=inp.get("output_package") or [],
                user_intent=intent, extra_note=note, max_examples=2,
            )
        except Exception:
            fewshots = ""
        extra_vars = {
            "baseline_rules": baseline, "role_rules": role_rules, "customer_rules": customer_rules,
            "knowledge_context": knowledge, "fewshot_examples": fewshots, "user_intent": intent,
            "role_label": ROLE_LABELS.get(role, role),
            "target_customer_label": CUSTOMER_LABELS.get(ctype, ctype),
            "output_package_label": _format_output_package(inp.get("output_package")),
            "extra_note": note or "无", "profile_context": render_operation_profile_context(store),
        }
        rendered = prompt_engine.render("workbench.free_intent", store, extra_vars)

    elif gen == "workbench_card":
        pk = inp["prompt_key"]
        scenario_name = pk.split(".", 1)[-1] if "." in pk else pk
        inferred_role = SCENARIO_ROLE_MAP.get(scenario_name) or role
        ctype = inp.get("target_customer_type") or "all"
        extra_vars = {
            "tone": TONE_LABELS.get("friendly", "亲切"), "target": CUSTOMER_LABELS.get(ctype, "全部客户"),
            "extra_note": note or "无", "scenario": "日常",
            "role": ROLE_LABELS.get(inferred_role, inferred_role), "date": _today(),
        }
        rendered = prompt_engine.render(pk, store, extra_vars, lenient=True)
        label = prompt_engine.template_name(pk)
        rendered = _append_guardrails(rendered, store, role=inferred_role,
                                      intent_text=f"{label} {inp.get('user_intent','')} {note}")

    elif gen == "diagnosis":
        pa = inp.get("problem_area", "revenue")
        sit = inp.get("situation", "") or ""
        pa_label = PROBLEM_AREA_LABELS.get(pa, pa)
        extra_vars = {"problem_area": pa_label, "current_situation": sit}
        rendered = prompt_engine.render("operation.diagnosis_tool", store, extra_vars)
        rendered = _append_guardrails(rendered, store, role="manager",
                                      intent_text=f"诊断 经营问题 分析原因 数据 指标 {pa_label} {sit}")

    elif gen == "activity":
        goal = inp.get("activity_goal", "traffic")
        extra_vars = {
            "activity_goal": ACTIVITY_GOAL_LABELS.get(goal, goal),
            "target_customer": inp.get("target_customer") or store.target_customers or "全部客群",
            "budget_level": BUDGET_LABELS.get(inp.get("budget_level"), "中度优惠"),
            "duration": inp.get("duration") or "待定", "extra_note": note or "无",
        }
        rendered = prompt_engine.render("activity.planning", store, extra_vars)
        rendered = _append_guardrails(rendered, store, role="manager",
                                      intent_text=f"{goal} {inp.get('target_customer') or ''} {note}")

    elif gen == "outreach":
        ct = inp.get("customer_type", "old")
        st = inp.get("style", "friendly")
        rel = inp.get("relationship", "熟客")
        ct_label = CUSTOMER_TYPE_LABELS.get(ct, ct)
        extra_vars = {
            "customer_name": inp.get("customer_name", "王哥"), "customer_type": ct_label,
            "relationship": rel, "style": STYLE_LABELS.get(st, st), "extra_note": note or "无",
        }
        rendered = prompt_engine.render("operation.assistant_outreach", store, extra_vars)
        rendered = _append_guardrails(rendered, store, role="assistant_manager",
                                      intent_text=f"约客 {ct_label} {rel} {note}")
    else:
        raise ValueError(f"未知 generator: {gen}")

    rendered = with_store_brain(rendered, scene.get("_memories") or [])
    if scene.get("concise"):
        rendered = rendered + concise_directive(True)
    return rendered


def _today() -> str:
    try:
        from core.timezone import business_today
        return business_today().isoformat()
    except Exception:
        return "2026-06-17"


# ────────────────────────────────────────────────────────────────────
# 生成 + 评分（带重试，抗限流抖动）
# ────────────────────────────────────────────────────────────────────
async def generate_text(prompt: str, max_tokens: int = 3000) -> tuple[str, int]:
    if _GEN_CLIENT is not None:
        # 生成模型覆盖。reasoning 模型(如 MiMo v2.5)思考占 token，给足 max_tokens 防 content 被挤掉截断。
        resp = await _GEN_CLIENT.chat.completions.create(
            model=_GEN_MODEL,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max(max_tokens, 5000),
            temperature=0.7,
        )
        if not resp.choices:
            return "", 0
        content = resp.choices[0].message.content or ""
        tokens = resp.usage.total_tokens if resp.usage else 0
        return _strip_ai_prefixes(content), tokens
    provider = ProviderFactory.get_text_provider()
    # GEN_MODEL：仅换 provider 的模型名(如 deepseek-v4-pro)，不暴露项目key；裁判不受影响。
    _om = os.environ.get("GEN_MODEL") or None
    resp = await provider.generate(TextRequest(prompt=prompt, max_tokens=max_tokens,
                                               thinking={"type": "disabled"}, model=_om))
    return _strip_ai_prefixes(resp.content or ""), (resp.tokens_used or 0)


async def _gen_with_retry(prompt: str, max_tokens: int, retries: int = 2):
    last = None
    for attempt in range(retries + 1):
        try:
            out, tok = await generate_text(prompt, max_tokens=max_tokens)
            if out and out.strip():
                return out, tok, None
            last = "空响应"
        except Exception as e:
            last = f"{type(e).__name__}: {e}".strip()
        await asyncio.sleep(2 * (attempt + 1))  # 退避，给限流喘息
    return None, 0, last


def keyword_check(text: str, scene: dict, predicates: list[dict]) -> dict:
    """关键词扫描。hard_forbidden_hit 参与判罚；其余只作报告参考（语境敏感、不机械判罚）。"""
    missed = []
    for group in (scene.get("must_hit") or []):
        kws = [group] if isinstance(group, str) else list(group)
        if not any(str(kw) in text for kw in kws):
            missed.append(kws)
    scene_forb = [w for w in (scene.get("forbidden") or []) if str(w) in text]
    pred_forb = []
    for p in predicates:
        for w in (p.get("forbidden_keywords") or []):
            if str(w) in text:
                pred_forb.append({"id": p.get("id"), "word": w})
    hard_hit = [w for w in HARD_FORBIDDEN if w in text]
    return {"missed": missed, "scene_forbidden_hit": scene_forb,
            "predicate_forbidden_hit": pred_forb, "hard_forbidden_hit": hard_hit}


async def llm_judge(text: str, scene: dict, predicates: list[dict]) -> dict:
    checklist_lines = [
        f"[{p.get('id')}] {p.get('judge_question') or p.get('rule')}"
        for p in predicates if p.get("check") in ("llm", "both")
    ]
    checklist = "\n".join(checklist_lines) if checklist_lines else "（无额外清单，按通用台球运营常识判断）"
    system = (
        "你是台球房运营资深专家，同时是这套AI产品的「北极星合规审查员」。"
        "北极星=台球房运营的核心逻辑（卖氛围/社交/球技而非堆优惠、四大客户分类区别对待、"
        "充值小比例赠送非大额、一卡通而非传统会员卡、动作要具体可落地、绝不擦边或无底线让利、内容不编造不夸大）。"
        "注意：若产出是在【解释/说明取消某项不当做法】（如解释为何取消大额充值赠送），引用该做法的名称不算违规；"
        "台球术语（中八打法、走位、加塞、陪练等）属正常用词不算违规；给老板看的内部诊断/方案出现'闭环/动作链'等词只要不是空洞套话也可接受。"
        "请严格但讲道理地审查下面这条AI产出是否贴合北极星。只输出JSON，不要任何额外文字。"
    )
    user = (
        f"【场景】{scene.get('title','')}（类别 {scene.get('category','')}）\n"
        f"【本场景对齐看点】{scene.get('judge_focus','按通用北极星逻辑判断')}\n\n"
        f"【北极星硬规则审查清单（逐条判断产出是否违反）】\n{checklist}\n\n"
        f"【待审查的AI产出】\n{text}\n\n"
        '请输出JSON：{"score": <1-5整数，5=完全贴北极星可直接用 / 3=能用但有偏离 / 1=严重脱离>, '
        '"verdict": "对齐|轻微偏离|脱离", "violations": ["违反的规则id或一句话问题", ...], '
        '"reason": "一句话总评"}'
    )
    try:
        provider = ProviderFactory.get_text_provider()
        resp = await provider.generate(TextRequest(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=700, temperature=0.0, thinking={"type": "disabled"},
        ))
        return _parse_judge(resp.content or "")
    except Exception as e:
        return {"score": 0, "verdict": "judge_error", "violations": [f"judge异常:{type(e).__name__}"],
                "reason": str(e)[:120]}


async def _judge_with_retry(text: str, scene: dict, predicates: list[dict], retries: int = 2) -> dict:
    judge = {"score": 0}
    for attempt in range(retries + 1):
        judge = await llm_judge(text, scene, predicates)
        if judge.get("score"):
            return judge
        await asyncio.sleep(2 * (attempt + 1))
    return judge


def _parse_judge(raw: str) -> dict:
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {"score": 0, "verdict": "parse_error", "violations": [], "reason": raw[:120]}
    try:
        d = json.loads(m.group(0))
    except Exception:
        return {"score": 0, "verdict": "parse_error", "violations": [], "reason": raw[:120]}
    try:
        d["score"] = int(d.get("score", 0))
    except Exception:
        d["score"] = 0
    d.setdefault("verdict", "")
    d.setdefault("violations", [])
    d.setdefault("reason", "")
    return d


def grade(kw: dict, judge: dict | None) -> str:
    """judge 主导；机器关键词只用 HARD_FORBIDDEN 兜底硬红线。"""
    if kw["hard_forbidden_hit"]:
        return "RED"
    if judge is None:  # --no-judge：退回纯关键词
        if kw["scene_forbidden_hit"] or kw["predicate_forbidden_hit"]:
            return "RED"
        return "YELLOW" if kw["missed"] else "GREEN"
    score = judge.get("score", 0)
    if not score:
        return "NO_JUDGE"  # 重试后仍失败，不污染 GREEN/RED
    if score <= 2:
        return "RED"
    if score == 3:
        return "YELLOW"
    return "GREEN"


# ────────────────────────────────────────────────────────────────────
# 单场景执行
# ────────────────────────────────────────────────────────────────────
async def run_scene(scene: dict, predicates: list[dict], sem: asyncio.Semaphore, do_judge: bool) -> dict:
    sid = scene.get("id", "?")
    async with sem:
        t0 = time.monotonic()
        try:
            prompt = compose_prompt(scene, scene["_store"])
        except Exception as e:
            return {"id": sid, "category": scene.get("category"), "grade": "ERROR",
                    "error": f"拼prompt失败: {type(e).__name__}: {e}"}
        output, tokens, gen_err = await _gen_with_retry(prompt, scene.get("max_tokens", 3000))
        if not output:
            return {"id": sid, "category": scene.get("category"), "grade": "ERROR",
                    "error": f"生成失败(重试后): {gen_err}", "prompt_len": len(prompt)}

        kw = keyword_check(output, scene, predicates)
        judge = await _judge_with_retry(output, scene, predicates) if do_judge else None
        g = grade(kw, judge)
        dt = round(time.monotonic() - t0, 1)
        return {
            "id": sid, "category": scene.get("category"), "title": scene.get("title", ""),
            "generator": scene.get("generator"), "store": scene.get("store"),
            "grade": g, "judge_score": (judge or {}).get("score"),
            "judge_verdict": (judge or {}).get("verdict"),
            "judge_violations": (judge or {}).get("violations"),
            "judge_reason": (judge or {}).get("reason"),
            "hard_forbidden_hit": kw["hard_forbidden_hit"],
            "missed_must_hit": kw["missed"],
            "soft_forbidden_ref": kw["scene_forbidden_hit"] + [x["word"] for x in kw["predicate_forbidden_hit"]],
            "prompt_len": len(prompt), "output_len": len(output), "tokens": tokens, "seconds": dt,
            "output": output,
        }


# ────────────────────────────────────────────────────────────────────
# 加载素材
# ────────────────────────────────────────────────────────────────────
def load_yaml(path: Path) -> dict:
    if not path.exists():
        raise FileNotFoundError(f"素材缺失：{path}")
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def load_materials(categories: list[str] | None):
    sim = load_yaml(EV_DIR / "sim_stores.yaml")
    stores_raw = sim.get("stores", {})
    stores = {k: (build_store(v), build_memories(v)) for k, v in stores_raw.items()}
    preds = load_yaml(EV_DIR / "northstar_predicates.yaml").get("predicates", [])
    scenes: list[dict] = []
    for f in sorted((EV_DIR / "scenes").glob("*.yaml")):
        data = load_yaml(f)
        for sc in (data.get("scenes") or []):
            if categories and sc.get("category") not in categories:
                continue
            skey = sc.get("store", "community")
            if skey not in stores:
                skey = next(iter(stores))
            store_obj, mems = stores[skey]
            sc["_store"] = store_obj
            sc["_memories"] = mems
            scenes.append(sc)
    return stores, preds, scenes


# ────────────────────────────────────────────────────────────────────
# 报告
# ────────────────────────────────────────────────────────────────────
_GRADES = ["GREEN", "YELLOW", "RED", "NO_JUDGE", "ERROR"]


def write_report(results: list[dict], preds_count: int, out_tag: str) -> tuple[Path, Path]:
    runs_dir = ROOT / "docs" / "test-runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    json_path = runs_dir / f"北极星对齐-{out_tag}.json"
    md_path = runs_dir / f"北极星对齐-{out_tag}.md"

    by_grade = {g: 0 for g in _GRADES}
    by_cat: dict[str, dict] = {}
    for r in results:
        g = r.get("grade", "ERROR")
        by_grade[g] = by_grade.get(g, 0) + 1
        c = r.get("category", "?")
        by_cat.setdefault(c, {x: 0 for x in _GRADES})
        by_cat[c][g] = by_cat[c].get(g, 0) + 1

    scored = by_grade["GREEN"] + by_grade["YELLOW"] + by_grade["RED"]
    green_rate = round(100 * by_grade["GREEN"] / scored, 1) if scored else 0.0

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump({"summary": {"total": len(results), **by_grade, "scored": scored,
                               "green_rate_of_scored": green_rate, "predicates": preds_count, "tag": out_tag},
                   "by_category": by_cat, "results": results}, f, ensure_ascii=False, indent=2)

    L = [f"# 北极星对齐测试报告 — {out_tag}", ""]
    L.append(f"- 场景总数：**{len(results)}**　谓词数：{preds_count}")
    L.append(f"- 🟢 GREEN：**{by_grade['GREEN']}**　🟡 YELLOW：**{by_grade['YELLOW']}**　🔴 RED：**{by_grade['RED']}**　🟦 NO_JUDGE(裁判失败)：{by_grade['NO_JUDGE']}　⚠️ ERROR(生成失败)：{by_grade['ERROR']}")
    L.append(f"- **GREEN 率（占有效判定 {scored} 个）：{green_rate}%**（合并 main 门槛建议 ≥85%）")
    L.append("")
    L.append("## 分类别")
    L.append("| 类别 | 🟢 | 🟡 | 🔴 | 🟦 | ⚠️ |")
    L.append("|---|---|---|---|---|---|")
    for c, d in sorted(by_cat.items()):
        L.append(f"| {c} | {d['GREEN']} | {d['YELLOW']} | {d['RED']} | {d['NO_JUDGE']} | {d['ERROR']} |")
    L.append("")
    L.append("## 🔴 RED 明细（真问题，优先修）")
    for r in results:
        if r.get("grade") == "RED":
            hard = r.get("hard_forbidden_hit") or []
            why = f"硬红线={hard} " if hard else ""
            why += f"judge={r.get('judge_score')}「{r.get('judge_reason','')}」 违反={r.get('judge_violations')}"
            L.append(f"- **[{r.get('id')}]** {r.get('title','')}（{r.get('category')}/{r.get('generator')}/{r.get('store')}）：{why}")
    L.append("")
    L.append("## 🟡 YELLOW 明细（轻微偏离）")
    for r in results:
        if r.get("grade") == "YELLOW":
            L.append(f"- [{r.get('id')}] {r.get('title','')}（{r.get('category')}）：judge={r.get('judge_score')}「{r.get('judge_reason','')}」")
    L.append("")
    L.append("## 🟦 NO_JUDGE / ⚠️ ERROR（系统问题，非内容问题）")
    for r in results:
        if r.get("grade") in ("NO_JUDGE", "ERROR"):
            L.append(f"- [{r.get('id')}] {r.get('title','')}（{r.get('category')}）：{r.get('error') or 'judge重试后仍无分'}")
    L.append("")
    L.append("## ⓘ 关键词参考（不参与判罚，供人工复核语境）")
    for r in results:
        miss, soft = r.get("missed_must_hit"), r.get("soft_forbidden_ref")
        if miss or soft:
            L.append(f"- [{r.get('id')}] {r.get('grade')}：漏must_hit={miss} 软禁词={soft}")
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(L))
    return json_path, md_path


# ────────────────────────────────────────────────────────────────────
# dry-run / self-test / 主流程
# ────────────────────────────────────────────────────────────────────
def dry_run(args):
    from collections import Counter
    cats = [c.strip() for c in args.categories.split(",")] if args.categories else None
    stores, preds, scenes = load_materials(cats)
    print(f"门店 {len(stores)}: {list(stores)}")
    print(f"谓词 {len(preds)}　硬红线词 {len(HARD_FORBIDDEN)}")
    print(f"场景 {len(scenes)}")
    print(f"  generator分布 = {dict(Counter(s.get('generator') for s in scenes))}")
    print(f"  category 分布 = {dict(Counter(s.get('category') for s in scenes))}")
    print(f"  store 分布    = {dict(Counter(s.get('store') for s in scenes))}")
    seen, errs, fail = set(), [], 0
    for s in scenes:
        g = s.get("generator")
        try:
            p = compose_prompt(s, s["_store"])
            if g not in seen:
                seen.add(g)
                print(f"  [{g}] 样例 {s['id']} prompt_len={len(p)} ✓")
        except Exception as e:
            fail += 1
            errs.append(f"{s.get('id')}({g}): {type(e).__name__}: {e}")
    print(f"全量拼prompt：{len(scenes)-fail}/{len(scenes)} OK")
    for e in errs[:25]:
        print("  ✗", e)
    print("✅ dry-run 通过" if fail == 0 else f"❌ {fail} 个失败")


async def self_test():
    print(f"[provider] text={settings.text_model_provider} model={settings.text_model_name}")
    store = Store(
        id=uuid.uuid4(), owner_id=uuid.uuid4(), name="测试社区台球", city="成都", district="武侯区",
        business_hours="10:00-次日2:00", table_count=10, table_types="中式八球",
        pricing={"中八台": "30元/小时"}, operation_profile={"commerce_rules": {"allow_price_copy": True}},
        has_coaching=True, has_tournament=False, has_private_room=False,
        target_customers="附近上班族、学生", style="轻松热闹", brand_style="lively",
        peak_hours="晚7点后", daily_avg_customers=40,
    )
    mems = [
        Memory("operational", "工作日下午基本没人，晚7点后才热闹，周一最差", "high"),
        Memory("preference", "老板喜欢文案口语化、喊哥喊姐，别太正式", "high"),
        Memory("semantic", "张助教技术型，主客群是附近白领，周二到周四晚上钟最高", "high"),
    ]
    scene = {
        "id": "selftest_001", "category": "diagnosis", "generator": "diagnosis",
        "store": "community", "role": "manager", "title": "工作日下午空台诊断",
        "input": {"situation": "工作日下午台子空一半，不知道怎么把白天盘活", "problem_area": "off_season"},
        "must_hit": [["白天", "下午", "时段", "闲时", "工作日"]], "forbidden": ["免费畅打", "终身"],
        "judge_focus": "诊断是否落到可执行的淡季时段促活动作", "_store": store, "_memories": mems,
    }
    sem = asyncio.Semaphore(1)
    r = await run_scene(scene, [], sem, do_judge=True)
    print(f"[grade] {r.get('grade')} judge={r.get('judge_score')} verdict={r.get('judge_verdict')}")
    print(f"[reason] {r.get('judge_reason')}")
    print(f"[lens] prompt_len={r.get('prompt_len')} out_len={r.get('output_len')} tokens={r.get('tokens')} {r.get('seconds')}s")
    print("─" * 70)
    print((r.get("output") or r.get("error") or "")[:600])
    print("─" * 70)
    ok = r.get("grade") in _GRADES and r.get("grade") != "ERROR"
    print("✅ self-test 框架跑通" if ok else "❌ self-test 失败")
    return ok


async def main_run(args):
    cats = [c.strip() for c in args.categories.split(",")] if args.categories else None
    stores, preds, scenes = load_materials(cats)
    if args.limit:
        scenes = scenes[: args.limit]
    gen_label = f"OVERRIDE:{_GEN_MODEL}" if _GEN_CLIENT else f"{settings.text_model_provider}:{settings.text_model_name}"
    print(f"[生成模型] {gen_label}　[裁判固定] {settings.text_model_provider}:{settings.text_model_name}")
    print(f"[材料] 门店={len(stores)} 谓词={len(preds)} 场景={len(scenes)} judge={'开' if not args.no_judge else '关'} 并发={args.concurrency}")
    if not scenes:
        print("没有场景可跑")
        return
    sem = asyncio.Semaphore(args.concurrency)
    t0 = time.monotonic()
    results = await asyncio.gather(*[run_scene(s, preds, sem, not args.no_judge) for s in scenes])
    dt = round(time.monotonic() - t0, 1)
    tag = args.tag or _today()
    jp, mp = write_report(results, len(preds), tag)
    by = {g: 0 for g in _GRADES}
    for r in results:
        by[r.get("grade", "ERROR")] = by.get(r.get("grade", "ERROR"), 0) + 1
    scored = by["GREEN"] + by["YELLOW"] + by["RED"]
    rate = round(100 * by["GREEN"] / scored, 1) if scored else 0.0
    print(f"\n========== 结果（{dt}s）==========")
    print(f"🟢 {by['GREEN']}  🟡 {by['YELLOW']}  🔴 {by['RED']}  🟦 {by['NO_JUDGE']}  ⚠️ {by['ERROR']}   GREEN率(占有效判定{scored})={rate}%")
    print(f"报告: {mp}")
    print(f"明细: {jp}")


def main():
    ap = argparse.ArgumentParser(description="北极星大规模对齐测试 runner")
    ap.add_argument("--self-test", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--categories", type=str, default="")
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--concurrency", type=int, default=3)
    ap.add_argument("--tag", type=str, default="")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.dry_run:
        dry_run(args)
        sys.exit(0)
    if not settings.deepseek_api_key:
        print("❌ 无 DeepSeek key，跳过")
        sys.exit(0)
    if settings.text_model_provider == "mock":
        print("⚠️ 当前 text provider 是 mock，测不出真实质量。")
    if args.self_test:
        ok = asyncio.run(self_test())
        sys.exit(0 if ok else 1)
    asyncio.run(main_run(args))


if __name__ == "__main__":
    main()
