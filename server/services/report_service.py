"""报表编排服务。

纯逻辑（预填 / 环比 / 累计 / 排名）+ DB 编排（generate_report，见文件下方）。
纯逻辑部分不碰 DB，便于单测（对齐 test_dashboard_recommendations 风格）。
"""
import json
from datetime import datetime

from sqlalchemy import select

from core.timezone import business_now
from models.generation import Generation
from services.ai.prompt_engine import get_prompt_engine
from services.content_service import run_generation
from services.memory_service import _json_call
from services.report_schema import get_report_schema

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


# ─── DB 编排（走 run_generation：配额 + 注入检查 + 落库 + 计费）───


async def load_last_submission(db, store_id, sub_type: str) -> dict | None:
    """取这家店上一份同类型日报的 input_params（供环比）。带 is_deleted==False。"""
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.type == "report",
            Generation.sub_type == sub_type,
            Generation.is_deleted == False,  # noqa: E712
        )
        .order_by(Generation.created_at.desc())
        .limit(1)
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    return row.input_params if row else None


async def _month_submissions(db, store_id, sub_type: str, now: datetime) -> list[dict]:
    """本月该类型已提交的 input_params（按 input_params['date'] 过滤，避开时区双基准坑）。"""
    ym = now.strftime("%Y-%m")
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.type == "report",
            Generation.sub_type == sub_type,
            Generation.is_deleted == False,  # noqa: E712
        )
        .order_by(Generation.created_at.desc())
        .limit(40)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [
        r.input_params for r in rows
        if r.input_params and str(r.input_params.get("date", "")).startswith(ym)
    ]


async def generate_report(db, store, user, report_type: str, data: dict, note: str = "") -> Generation:
    """编排：预填 → 环比 →（按形态补累计/排名）→ 渲染叙事 prompt → run_generation。

    返回 Generation：result=叙事文本，input_params=结构化数据（含预填、环比、形态附加）。
    """
    schema = get_report_schema(report_type)
    now = business_now()
    prefill = build_prefill(schema, store, now)
    last = await load_last_submission(db, store.id, report_type)
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
