"""报表编排服务。

纯逻辑（预填 / 环比 / 累计 / 排名）+ DB 编排（generate_report，见文件下方）。
纯逻辑部分不碰 DB，便于单测（对齐 test_dashboard_recommendations 风格）。
"""
import json
import logging
from datetime import datetime

from sqlalchemy import select

from core.timezone import business_now
from models.generation import Generation
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import run_generation
from services.memory_service import _json_call, format_memories_for_prompt, load_store_memory
from services.report_schema import get_report_schema

logger = logging.getLogger(__name__)

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def build_prefill(schema: dict, store, now: datetime) -> dict:
    """按 schema.prefill 自动带出固定信息（门店名 / 日期 / 星期）。"""
    out: dict = {}
    for key in schema.get("prefill", []):
        if key == "store_name":
            out["store_name"] = getattr(store, "name", "") or ""
        elif key == "date":
            out["date"] = now.strftime("%Y-%m-%d")
        elif key == "weekday":
            out["weekday"] = _WEEKDAYS[now.weekday()]
    return out


def compute_deltas(current: dict, last: dict | None, fields: list[str]) -> dict:
    """对 fields 算环比（相对上次提交）。无上次或不可比则跳过。"""
    if not last:
        return {}
    out: dict = {}
    for f in fields:
        cur, prev = current.get(f), last.get(f)
        if isinstance(cur, (int, float)) and isinstance(prev, (int, float)) and prev:
            pct = round((cur - prev) / prev * 100, 1)
            out[f] = {"pct": pct, "dir": "up" if pct >= 0 else "down", "prev": prev}
    return out


def compute_cumulative(submissions: list[dict], fields: list[str]) -> dict:
    """把多份提交在 fields 上求和（教练个人日报的"本月累计"）。"""
    out = {f: 0 for f in fields}
    for s in submissions:
        for f in fields:
            v = s.get(f)
            if isinstance(v, (int, float)):
                out[f] += v
    return out


def rank_roster(rows: list[dict], by: str) -> list[dict]:
    """按 by 字段降序排名，原地写入 rank（助教管理花名册排名页）。"""
    ranked = sorted(rows, key=lambda r: r.get(by) or 0, reverse=True)
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    return ranked


def narrative_payload(
    shape: str, data: dict, deltas: dict,
    cumulative: dict | None = None, ranked_rows: list | None = None,
) -> dict:
    """组装喂给 AI 的数字 JSON：环比恒带；personal 带本月累计；roster 带已排名 rows。

    显式传累计/排名（不依赖 dict 共享引用），保证 prompt 真拿到这些数据。
    """
    payload: dict = {**data, "环比": deltas}
    if shape == "personal" and cumulative is not None:
        payload["本月累计"] = cumulative
    if shape == "roster" and ranked_rows is not None:
        payload["rows"] = ranked_rows
    return payload


def field_labels(schema: dict) -> dict:
    """{字段key: 中文label}（flat/personal 的 groups + roster 的 columns）。"""
    out: dict = {}
    for g in schema.get("groups", []):
        for f in g.get("fields", []):
            out[f["key"]] = f.get("label", f["key"])
    for c in schema.get("columns", []):
        out[c["key"]] = c.get("label", c["key"])
    return out


def relabel_payload(payload: dict, labels: dict) -> dict:
    """把喂 AI 的 JSON 里英文 key 换成中文 label，避免 AI 按 key 名瞎翻（如 coach_*→教练）。"""
    out: dict = {}
    for k, v in payload.items():
        if k in ("环比", "本月累计") and isinstance(v, dict):
            out[k] = {labels.get(fk, fk): fv for fk, fv in v.items()}
        elif k == "rows" and isinstance(v, list):
            out["助教明细"] = [{labels.get(fk, fk): fv for fk, fv in r.items()} for r in v]
        else:
            out[labels.get(k, k)] = v
    return out


def _date_label(date_str: str) -> str:
    """'2026-06-13' → '2026-06-13（周六）'，让 AI 知道环比对比的是哪天、不瞎猜日子。"""
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d")
        return f"{date_str}（{_WEEKDAYS[d.weekday()]}）"
    except (ValueError, TypeError):
        return date_str


# ─── DB 编排（走 run_generation：配额 + 注入检查 + 落库 + 计费）───


async def load_last_submission(db, store_id, sub_type: str, today: str) -> dict | None:
    """取这家店上一份"前一天(非今天)"的同类型日报 input_params（供环比）。

    排除今天的重复提交——环比应对比前一天，而不是当天早些时候的那份。
    """
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.type == "report",
            Generation.sub_type == sub_type,
            Generation.is_deleted == False,  # noqa: E712
        )
        .order_by(Generation.created_at.desc())
        .limit(10)
    )
    rows = (await db.execute(stmt)).scalars().all()
    for r in rows:
        d = str((r.input_params or {}).get("date", ""))
        if r.input_params and d and d != today:
            return r.input_params
    return None


async def _month_submissions(db, store_id, sub_type: str, now: datetime) -> list[dict]:
    """本月"前几天"每天最新一份的 input_params（供累计）。

    按 input_params['date'] 过滤（避开时区双基准坑）；**同一天去重只留最新、排除今天**，
    这样累计 = 各前一天最新值 + 今天当前这份，不会因当天重复提交而重复计数。
    """
    ym = now.strftime("%Y-%m")
    today = now.strftime("%Y-%m-%d")
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.type == "report",
            Generation.sub_type == sub_type,
            Generation.is_deleted == False,  # noqa: E712
        )
        .order_by(Generation.created_at.desc())
        .limit(60)
    )
    rows = (await db.execute(stmt)).scalars().all()
    seen: set = set()
    out: list[dict] = []
    for r in rows:
        d = str((r.input_params or {}).get("date", ""))
        if d.startswith(ym) and d != today and d not in seen:
            seen.add(d)
            out.append(r.input_params)
    return out


async def generate_report(db, store, user, report_type: str, data: dict, note: str = "") -> Generation:
    """编排：预填 → 环比 →（按形态补累计/排名）→ 渲染叙事 prompt → run_generation。

    返回 Generation：result=叙事文本，input_params=结构化数据（含预填、环比、形态附加）。
    """
    schema = get_report_schema(report_type)
    now = business_now()
    prefill = build_prefill(schema, store, now)
    last = await load_last_submission(db, store.id, report_type, now.strftime("%Y-%m-%d"))
    deltas = compute_deltas(data, last, schema.get("narrative", {}).get("delta_fields", []))

    full_data: dict = {**prefill, **data, "_deltas": deltas}
    cumulative: dict | None = None
    ranked_rows: list | None = None
    if schema["shape"] == "personal":
        month_rows = await _month_submissions(db, store.id, report_type, now)
        cumulative = compute_cumulative(month_rows + [data], schema.get("cumulative_fields", []))
        full_data["_cumulative"] = cumulative
    elif schema["shape"] == "roster":
        ranked_rows = rank_roster(list(data.get("rows", [])), schema.get("rank_by", ""))
        full_data["rows"] = ranked_rows

    payload = narrative_payload(schema["shape"], data, deltas, cumulative, ranked_rows)
    payload = relabel_payload(payload, field_labels(schema))  # 喂中文 label，免 AI 把 coach_* 瞎翻成"教练"
    if deltas and last and last.get("date"):
        payload["环比对比的上一份日报日期"] = _date_label(str(last["date"]))  # 让 AI 说准对比的是哪天
    prompt = get_prompt_engine().render(
        schema["narrative"]["prompt_key"],
        store,
        {
            "numbers_json": json.dumps(payload, ensure_ascii=False),
            "note": note or "（无）",
            "store_name": prefill.get("store_name", ""),
            "date": prefill.get("date", ""),
        },
        lenient=True,
    )

    # 店脑：把这家店的长期记忆拼到 prompt 末尾 → 日报也"懂这家店"。
    # 与 stream.py 同款机制；放末尾靠近因效应让背景知识生效；fail-safe，失败跳过不影响生成。
    # 数字是今天的事实、店脑是背景，二者不冲突。
    try:
        brain_text = format_memories_for_prompt(await load_store_memory(db, store.id))
        if brain_text:
            prompt = f"{prompt}\n\n{brain_text}"
    except Exception:
        logger.warning("报表注入店脑失败，跳过", exc_info=True)

    return await run_generation(
        db, store, user,
        prompt=prompt,
        gen_type="report",
        sub_type=report_type,
        input_params=full_data,
        user_input=note,
    )


async def extract_report_data(report_type: str, text: str) -> dict:
    """从一句话自然语言抽取该表字段值（flat/personal）。返回 {key: number}，只保留已知数值字段。

    花名册(roster)要逐人列，不适合"说一句话"，直接返回 {}。
    走 DeepSeek JSON 模式（复用店脑的 _json_call），属输入辅助、不计配额。
    """
    schema = get_report_schema(report_type)
    if schema["shape"] == "roster":
        return {}
    fields = [
        (f["key"], f["label"], f.get("unit", ""))
        for g in schema.get("groups", [])
        for f in g["fields"]
    ]
    field_desc = "\n".join(f"- {k}（{label}{unit}）" for k, label, unit in fields)
    system = (
        "你是台球房日报数字抽取器。用户会用一句话口语汇报今天的经营数据，"
        "请抽取下列字段的数值，输出 JSON（键用字段英文 key，值是数字）。"
        "用户没提到的字段一律不要出现在结果里。只输出 JSON，不要解释。\n\n字段：\n"
        + field_desc
    )
    raw = await _json_call(system, (text or "").strip())
    known = {k for k, _, _ in fields}
    return {
        k: v for k, v in raw.items()
        if k in known and isinstance(v, (int, float)) and not isinstance(v, bool)
    }
