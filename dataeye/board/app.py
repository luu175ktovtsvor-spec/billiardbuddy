"""dataeye 看板 — 只读后台（盯盘版）。

登录后(nginx Basic Auth over HTTPS 保护)在任意设备浏览器里查看汇聚上来的数据:
总览(今日/本周/累计 + 好评率 + 30 天趋势 + 健康) / 生成记录 / 对话轨迹 / 成本 / 事件。
监听 127.0.0.1:9200,由 nginx 的 `location /board/` 反代 + basic auth 挡在前面。纯只读,绝不改动数据。

设计约束(别破坏):单文件、零依赖(只 fastapi+asyncpg)、无构建、离线可跑、不引 CDN/JS 图表库——
趋势图用手绘内联 SVG。时间统一按北京时间(UTC+8)展示与切日;库里存 UTC,用 `AT TIME ZONE 'Asia/Shanghai'` 切北京日。
"""
from __future__ import annotations

import os
from datetime import datetime, timezone, timedelta

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


# ---------- HTML 骨架 + 样式(CSS 变量 → 自动暗色) ----------
_CSS = """
:root{
 --bg:#f4f6f8;--fg:#1b2230;--muted:#6b7280;--card:#fff;--border:#e2e7ec;
 --head:#178a5a;--head-fg:#fff;--navhov:rgba(255,255,255,.18);
 --th:#fafbfc;--th-fg:#475467;--rowline:#eef1f4;
 --accent:#178a5a;--accent2:#3b82f6;--good-bg:#e6f4ec;--good:#0f6b45;
 --bad-bg:#fbeae8;--bad:#c8443c;--up:#0f8a52;--down:#c8443c;--track:#eef1f4;
}
@media (prefers-color-scheme:dark){
 :root{
  --bg:#0f1512;--fg:#e7ece9;--muted:#8a9a92;--card:#161e1a;--border:#28352e;
  --head:#0d3f28;--head-fg:#eafaf1;--navhov:rgba(255,255,255,.14);
  --th:#1a241f;--th-fg:#9fb3a8;--rowline:#222e28;
  --accent:#2fd39e;--accent2:#6aa1ff;--good-bg:rgba(47,211,158,.14);--good:#5fe3c5;
  --bad-bg:rgba(224,114,90,.16);--bad:#e0725a;--up:#5fe3c5;--down:#e0725a;--track:#222e28;
 }
}
*{box-sizing:border-box}
body{margin:0;font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;
 background:var(--bg);color:var(--fg);line-height:1.5;-webkit-font-smoothing:antialiased}
header{background:var(--head);color:var(--head-fg);padding:13px 22px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
header b{font-size:17px;font-weight:700}
nav a{color:var(--head-fg);opacity:.9;text-decoration:none;font-size:14px;padding:5px 10px;border-radius:7px}
nav a:hover,nav a.on{background:var(--navhov);opacity:1}
.asof{margin-left:auto;font-size:12px;opacity:.85;white-space:nowrap}
.wrap{max-width:1120px;margin:0 auto;padding:20px 22px}
h2{font-size:15px;margin:26px 0 10px;color:var(--muted);font-weight:650;letter-spacing:.02em}
h2:first-child{margin-top:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:12px;margin-bottom:6px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:13px 15px}
.card .n{font-size:25px;font-weight:750;font-variant-numeric:tabular-nums;line-height:1.15}
.card .l{font-size:12.5px;color:var(--muted);margin-top:3px}
.card .d{font-size:12px;font-weight:650;margin-top:4px;font-variant-numeric:tabular-nums}
.d.up{color:var(--up)}.d.down{color:var(--down)}.d.flat{color:var(--muted)}
.card.hl{border-color:color-mix(in srgb,var(--accent) 45%,var(--border))}
.card .n.warn{color:var(--bad)}
.chartbox{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin-bottom:6px}
.chartbox .ct{font-size:12.5px;color:var(--muted);margin-bottom:8px;display:flex;justify-content:space-between}
.chartbox .ct b{color:var(--fg);font-weight:650}
svg.chart{display:block;width:100%}
svg.chart rect{transition:opacity .1s}svg.chart rect:hover{opacity:.72}
.charts2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:680px){.charts2{grid-template-columns:1fr}}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:12px}
table{width:100%;min-width:520px;border-collapse:collapse;background:var(--card);border:1px solid var(--border);border-radius:12px;overflow:hidden;font-size:13px}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--rowline);vertical-align:top}
th{background:var(--th);font-weight:650;color:var(--th-fg);white-space:nowrap}
tr:last-child td{border-bottom:0}
td.num,.num{text-align:right;font-variant-numeric:tabular-nums}
.snip{max-width:420px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}
.good{background:var(--good-bg);color:var(--good)}.bad{background:var(--bad-bg);color:var(--bad)}
.empty{background:var(--card);border:1px dashed var(--border);border-radius:12px;padding:28px;text-align:center;color:var(--muted)}
.foot{color:var(--muted);font-size:12px;margin-top:26px}
"""

_PAGES = [("/board/", "总览"), ("/board/generations", "生成记录"),
          ("/board/transcripts", "对话轨迹"), ("/board/cost", "成本"),
          ("/board/events", "事件")]


def _shell(active: str, body: str) -> str:
    nav = "".join(
        f'<a class="{"on" if p == active else ""}" href="{p}">{name}</a>'
        for p, name in _PAGES
    )
    now = datetime.now(CST).strftime("%m-%d %H:%M")
    return f"""<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>dataeye 看板</title><style>{_CSS}</style></head><body>
<header><b>📊 dataeye 数据看板</b><nav>{nav}</nav><span class="asof">刷新于 {now} · 每 2 分钟自动刷新</span></header>
<div class="wrap">{body}<p class="foot">只读 · 数据在大陆 · 北京时间 · 趋势按北京日实时现算</p></div></body></html>"""


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
    return f'<div class="scroll"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>'


def _card(n, label, delta: str = "", warn: bool = False, hl: bool = False) -> str:
    nc = " warn" if warn else ""
    return (f'<div class="card{" hl" if hl else ""}"><div class="n{nc}">{n}</div>'
            f'<div class="l">{label}</div>{delta}</div>')


def _delta(cur: int, prev: int) -> str:
    """今日 vs 昨日 的涨跌小字。"""
    if prev == 0:
        return f'<div class="d flat">昨日 0</div>' if cur == 0 else f'<div class="d up">▲ 新增</div>'
    diff = cur - prev
    if diff == 0:
        return '<div class="d flat">= 与昨日持平</div>'
    pct = round(diff / prev * 100)
    cls, arrow = ("up", "▲") if diff > 0 else ("down", "▼")
    return f'<div class="d {cls}">{arrow} {abs(diff):,} ({abs(pct)}% vs 昨日)</div>'


def _bars(points: list[tuple], color: str = "var(--accent)", h: int = 60) -> str:
    """手绘内联 SVG 柱状图(无 JS)。points=[(label, value), ...]。"""
    if not points:
        return '<div class="empty" style="padding:16px">暂无数据</div>'
    vals = [max(0, int(v or 0)) for _, v in points]
    mx = max(vals) or 1
    n = len(points)
    w = 640.0
    bw = w / n
    pad = 3.0
    bars = ""
    for i, (lb, v) in enumerate(points):
        v = max(0, int(v or 0))
        bh = (v / mx) * (h - 10)
        x = i * bw
        bars += (f'<rect x="{x + pad / 2:.1f}" y="{h - bh:.1f}" width="{max(0.6, bw - pad):.1f}" '
                 f'height="{bh:.1f}" rx="1.5" fill="{color}">'
                 f'<title>{_esc(lb)}: {v:,}</title></rect>')
    return (f'<svg class="chart" viewBox="0 0 {w:.0f} {h}" height="{h}" '
            f'preserveAspectRatio="none" role="img">{bars}</svg>')


# 北京日 SQL 片段:把 UTC 的 created_at 切成北京日
_BJ_DAY = "(created_at AT TIME ZONE 'Asia/Shanghai')::date"
_GOOD = "effect_rating IN ('good','up','positive','好评','1')"
_BAD = "effect_rating IN ('bad','down','negative','差评','0','-1')"
_RATED = "effect_rating IS NOT NULL AND effect_rating <> ''"


# ---------- 页面 ----------
@app.get("/board/", response_class=HTMLResponse)
@app.get("/board", response_class=HTMLResponse)
async def overview():
    p = await pool()
    async with p.acquire() as c:
        async def q1(sql: str, *a):
            try:
                return await c.fetchval(sql, *a) or 0
            except Exception:
                return 0

        # 今日 / 昨日 / 本周 / 累计（生成条数 + token）
        g_today = await q1(f"SELECT count(*) FROM generations WHERE {_BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date")
        g_yest = await q1(f"SELECT count(*) FROM generations WHERE {_BJ_DAY}=((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)")
        g_week = await q1(f"SELECT count(*) FROM generations WHERE {_BJ_DAY}>=date_trunc('week',(now() AT TIME ZONE 'Asia/Shanghai'))::date")
        g_all = await q1("SELECT count(*) FROM generations")
        tok_today = await q1(f"SELECT coalesce(sum(tokens_used),0) FROM generations WHERE {_BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date")
        tok_yest = await q1(f"SELECT coalesce(sum(tokens_used),0) FROM generations WHERE {_BJ_DAY}=((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)")
        tok_all = await q1("SELECT coalesce(sum(tokens_used),0) FROM generations")
        # 规模
        machines = await q1("SELECT count(DISTINCT machine_id) FROM raw_inbox")
        m_active7 = await q1(f"SELECT count(DISTINCT machine_id) FROM generations WHERE {_BJ_DAY}>=((now() AT TIME ZONE 'Asia/Shanghai')::date - 6)")
        n_stores = await q1("SELECT count(*) FROM stores")
        n_trans = await q1("SELECT count(*) FROM transcripts")
        # 好评率
        good = await q1(f"SELECT count(*) FROM generations WHERE {_GOOD}")
        bad = await q1(f"SELECT count(*) FROM generations WHERE {_BAD}")
        rated = await q1(f"SELECT count(*) FROM generations WHERE {_RATED}")
        # 今日健康（报错/崩溃/合规命中）
        err_today = await q1(f"SELECT count(*) FROM events WHERE {_BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date AND (event ILIKE '%error%' OR event ILIKE '%crash%' OR event ILIKE '%fail%')")
        comp_today = await q1(f"SELECT count(*) FROM events WHERE {_BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date AND event ILIKE '%compliance%'")

        # 近 30 天趋势（生成条数 / token）—— 直接按北京日现算，补齐无数据的日子为 0
        async def daily(expr: str):
            try:
                rows = await c.fetch(
                    f"SELECT {_BJ_DAY} AS d, {expr} AS v FROM generations "
                    f"WHERE created_at >= now() - interval '30 days' GROUP BY d ORDER BY d")
                return {r["d"]: (r["v"] or 0) for r in rows}
            except Exception:
                return {}
        gen_by_day = await daily("count(*)")
        tok_by_day = await daily("coalesce(sum(tokens_used),0)")

    today_bj = datetime.now(CST).date()
    days = [today_bj - timedelta(days=i) for i in range(29, -1, -1)]
    gen_pts = [(d.strftime("%m-%d"), gen_by_day.get(d, 0)) for d in days]
    tok_pts = [(d.strftime("%m-%d"), tok_by_day.get(d, 0)) for d in days]

    rate = round(good / rated * 100) if rated else None
    rate_txt = f"{rate}%" if rate is not None else "—"

    today_cards = (
        _card(f"{g_today:,}", "今日生成", _delta(g_today, g_yest), hl=True)
        + _card(f"{tok_today:,}", "今日 token", _delta(tok_today, tok_yest))
        + _card(f"{g_week:,}", "本周生成")
        + _card(f"{m_active7:,}", "近 7 天活跃机器")
        + _card(rate_txt, f"好评率（{good:,}好/{bad:,}差）", hl=(rate is not None and rate < 60))
    )
    health_cards = (
        _card(f"{err_today:,}", "今日报错/崩溃", warn=(err_today > 0), hl=True)
        + _card(f"{comp_today:,}", "今日合规命中", warn=(comp_today > 0))
        + _card(f"{machines:,}", "累计机器")
        + _card(f"{n_stores:,}", "门店数")
        + _card(f"{g_all:,}", "累计生成")
        + _card(f"{tok_all:,}", "累计 token")
        + _card(f"{n_trans:,}", "对话轨迹")
    )
    tmax = max((v for _, v in tok_pts), default=0)
    gmax = max((v for _, v in gen_pts), default=0)
    charts = (
        '<div class="charts2">'
        f'<div class="chartbox"><div class="ct"><b>近 30 天 · 每日生成条数</b><span>峰值 {gmax:,}</span></div>{_bars(gen_pts, "var(--accent)")}</div>'
        f'<div class="chartbox"><div class="ct"><b>近 30 天 · 每日 token</b><span>峰值 {tmax:,}</span></div>{_bars(tok_pts, "var(--accent2)")}</div>'
        '</div>'
    )
    body = (f'<h2>今日盯盘</h2><div class="cards">{today_cards}</div>'
            f'<h2>趋势</h2>{charts}'
            f'<h2>健康 · 规模</h2><div class="cards">{health_cards}</div>')
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
        pill = '<span class="pill good">好</span>' if rt in ("good", "up", "positive", "好评", "1") else (
            '<span class="pill bad">差</span>' if rt in ("bad", "down", "negative", "差评", "0", "-1") else "—")
        trs.append((_cst(r["created_at"]), _esc(r["machine_id"])[:10], _esc(r["type"]),
                    _esc(r["model_used"]), f'<span class=num>{r["tokens_used"] or 0}</span>',
                    pill, f'<div class="snip">{_esc(r["prompt"])}</div>'))
    body = "<h2>生成记录（最近 200）</h2>" + _table(
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
    body = "<h2>对话轨迹（最近 200）</h2>" + _table(
        ["时间", "机器", "会话", "轮数", "摘要"], trs)
    return _shell("/board/transcripts", body)


@app.get("/board/cost", response_class=HTMLResponse)
async def cost():
    p = await pool()
    async with p.acquire() as c:
        rows = await c.fetch(
            f"SELECT machine_id, {_BJ_DAY} AS d, count(*) AS n, "
            "coalesce(sum(tokens_used),0) AS tok FROM generations "
            f"WHERE created_at IS NOT NULL GROUP BY machine_id, {_BJ_DAY} ORDER BY d DESC, tok DESC LIMIT 200")
    trs = [(str(r["d"]), _esc(r["machine_id"])[:12],
            f'<span class=num>{r["n"]:,}</span>', f'<span class=num>{r["tok"]:,}</span>') for r in rows]
    body = "<h2>成本 · 按机器 / 北京日</h2>" + _table(["日期", "机器", "生成条数", "token"], trs)
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
