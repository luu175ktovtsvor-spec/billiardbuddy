"""dataeye 看板 — 只读后台。

登录后(nginx Basic Auth over HTTPS 保护)在任意设备浏览器里查看汇聚上来的数据:
总览 / 生成记录 / 对话轨迹 / 成本 / 事件。监听 127.0.0.1:9200,由 nginx 的
`location /board/` 反代 + basic auth 挡在前面。纯只读,绝不改动数据。

时间统一按北京时间(UTC+8)展示;库里存的是 UTC。
"""
from __future__ import annotations

import os
from datetime import timezone, timedelta

import asyncpg
from fastapi import FastAPI
from fastapi.responses import HTMLResponse

PGDSN = os.environ.get("PGDSN", "postgresql://dataeye:dataeye@127.0.0.1/dataeye")
CST = timezone(timedelta(hours=8))

app = FastAPI(title="dataeye-board")
_pool: asyncpg.Pool | None = None


async def pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        _pool = await asyncpg.create_pool(PGDSN, min_size=1, max_size=3)
    return _pool


# ---------- HTML 骨架 ----------
_CSS = """
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
 background:#f4f6f8;color:#1b2230;line-height:1.5}
header{background:#178a5a;color:#fff;padding:14px 22px;display:flex;align-items:center;gap:18px;flex-wrap:wrap}
header b{font-size:17px;font-weight:700}
nav a{color:#eafaf1;text-decoration:none;font-size:14px;margin-right:4px;padding:5px 10px;border-radius:7px}
nav a:hover,nav a.on{background:rgba(255,255,255,.18)}
.wrap{max-width:1100px;margin:0 auto;padding:22px}
h2{font-size:16px;margin:24px 0 10px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:8px}
.card{background:#fff;border:1px solid #e2e7ec;border-radius:12px;padding:14px 16px}
.card .n{font-size:26px;font-weight:750;font-variant-numeric:tabular-nums}
.card .l{font-size:12.5px;color:#6b7280;margin-top:2px}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e7ec;border-radius:12px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #eef1f4;vertical-align:top}
th{background:#fafbfc;font-weight:650;color:#475467;white-space:nowrap}
tr:last-child td{border-bottom:0}
td.num{text-align:right;font-variant-numeric:tabular-nums}
.snip{max-width:420px;color:#475467;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}
.good{background:#e6f4ec;color:#0f6b45}.bad{background:#fbeae8;color:#c8443c}
.empty{background:#fff;border:1px dashed #cdd5dd;border-radius:12px;padding:28px;text-align:center;color:#8a94a0}
.foot{color:#98a2b3;font-size:12px;margin-top:26px}
"""

_PAGES = [("/board/", "总览"), ("/board/generations", "生成记录"),
          ("/board/transcripts", "对话轨迹"), ("/board/cost", "成本"),
          ("/board/events", "事件")]


def _shell(active: str, body: str) -> str:
    nav = "".join(
        f'<a class="{"on" if p == active else ""}" href="{p}">{name}</a>'
        for p, name in _PAGES
    )
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dataeye 看板</title><style>{_CSS}</style></head><body>
<header><b>📊 dataeye 数据看板</b><nav>{nav}</nav></header>
<div class="wrap">{body}<p class="foot">只读 · 数据在大陆 · 时间为北京时间</p></div></body></html>"""


def _cst(dt) -> str:
    if dt is None:
        return "—"
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(CST).strftime("%Y-%m-%d %H:%M")


def _esc(v) -> str:
    s = "" if v is None else str(v)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _table(cols: list[str], rows: list[tuple]) -> str:
    if not rows:
        return '<div class="empty">还没有数据 —— 等客户端上线后,数据会自动汇聚到这里。</div>'
    head = "".join(f"<th>{c}</th>" for c in cols)
    body = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f"<table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table>"


# ---------- 页面 ----------
@app.get("/board/", response_class=HTMLResponse)
@app.get("/board", response_class=HTMLResponse)
async def overview():
    p = await pool()
    async with p.acquire() as c:
        stat = {}
        for k, q in {
            "机器数": "SELECT count(DISTINCT machine_id) FROM raw_inbox",
            "门店数": "SELECT count(*) FROM stores",
            "事件数": "SELECT count(*) FROM events",
            "生成记录": "SELECT count(*) FROM generations",
            "对话轨迹": "SELECT count(*) FROM transcripts",
            "总 token": "SELECT coalesce(sum(tokens_used),0) FROM generations",
        }.items():
            try:
                stat[k] = await c.fetchval(q) or 0
            except Exception:
                stat[k] = 0
        try:
            good = await c.fetchval("SELECT count(*) FROM generations WHERE effect_rating='good'") or 0
            bad = await c.fetchval("SELECT count(*) FROM generations WHERE effect_rating='bad'") or 0
        except Exception:
            good = bad = 0
    cards = "".join(f'<div class="card"><div class="n">{v:,}</div><div class="l">{k}</div></div>'
                    for k, v in stat.items())
    fb = f'<div class="card"><div class="n">👍{good:,} / 👎{bad:,}</div><div class="l">好评 / 差评</div></div>'
    body = f"<h2>总览</h2><div class=cards>{cards}{fb}</div>"
    return _shell("/board/", body)


@app.get("/board/generations", response_class=HTMLResponse)
async def generations():
    p = await pool()
    async with p.acquire() as c:
        rows = await c.fetch(
            "SELECT created_at, machine_id, store_id, type, model_used, tokens_used, "
            "effect_rating, left(coalesce(prompt_used,''),80) AS prompt "
            "FROM generations ORDER BY created_at DESC NULLS LAST LIMIT 200")
    trs = []
    for r in rows:
        rt = r["effect_rating"]
        pill = f'<span class="pill good">好</span>' if rt == "good" else (
            f'<span class="pill bad">差</span>' if rt == "bad" else "—")
        trs.append((_cst(r["created_at"]), _esc(r["machine_id"])[:10], _esc(r["type"]),
                    _esc(r["model_used"]), f'<span class=num>{r["tokens_used"] or 0}</span>',
                    pill, f'<div class="snip">{_esc(r["prompt"])}</div>'))
    body = f"<h2>生成记录(最近 200)</h2>" + _table(
        ["时间", "机器", "类型", "模型", "token", "评价", "提示词"], trs)
    return _shell("/board/generations", body)


@app.get("/board/transcripts", response_class=HTMLResponse)
async def transcripts():
    p = await pool()
    async with p.acquire() as c:
        rows = await c.fetch(
            "SELECT created_at, machine_id, conversation_id, turns, "
            "left(coalesce(summary,''),100) AS summary "
            "FROM transcripts ORDER BY created_at DESC NULLS LAST LIMIT 200")
    trs = [(_cst(r["created_at"]), _esc(r["machine_id"])[:10], _esc(r["conversation_id"])[:16],
            f'<span class=num>{r["turns"] or 0}</span>', f'<div class="snip">{_esc(r["summary"])}</div>')
           for r in rows]
    body = "<h2>对话轨迹(最近 200)</h2>" + _table(
        ["时间", "机器", "会话", "轮数", "摘要"], trs)
    return _shell("/board/transcripts", body)


@app.get("/board/cost", response_class=HTMLResponse)
async def cost():
    p = await pool()
    async with p.acquire() as c:
        rows = await c.fetch(
            "SELECT machine_id, date_trunc('day', created_at) AS d, count(*) AS n, "
            "coalesce(sum(tokens_used),0) AS tok FROM generations "
            "WHERE created_at IS NOT NULL GROUP BY machine_id, d ORDER BY d DESC, tok DESC LIMIT 200")
    trs = [(_cst(r["d"])[:10], _esc(r["machine_id"])[:12],
            f'<span class=num>{r["n"]:,}</span>', f'<span class=num>{r["tok"]:,}</span>') for r in rows]
    body = "<h2>成本 · 按机器 / 天</h2>" + _table(["日期", "机器", "生成条数", "token"], trs)
    return _shell("/board/cost", body)


@app.get("/board/events", response_class=HTMLResponse)
async def events():
    p = await pool()
    async with p.acquire() as c:
        by_type = await c.fetch(
            "SELECT event, count(*) AS n FROM events GROUP BY event ORDER BY n DESC LIMIT 40")
        recent = await c.fetch(
            "SELECT created_at, machine_id, event FROM events ORDER BY created_at DESC NULLS LAST LIMIT 100")
    t1 = _table(["事件", "次数"], [(_esc(r["event"]), f'<span class=num>{r["n"]:,}</span>') for r in by_type])
    t2 = _table(["时间", "机器", "事件"],
                [(_cst(r["created_at"]), _esc(r["machine_id"])[:10], _esc(r["event"])) for r in recent])
    body = f"<h2>事件 · 按类型</h2>{t1}<h2>最近事件</h2>{t2}"
    return _shell("/board/events", body)


@app.get("/board/healthz")
async def healthz():
    try:
        p = await pool()
        async with p.acquire() as c:
            await c.fetchval("SELECT 1")
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "err": str(e)[:200]}
