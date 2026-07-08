import { SQL } from 'bun'

const DEFAULT_DSN = 'postgresql://dataeye:dataeye@127.0.0.1/dataeye'
const CST_OFFSET_MS = 8 * 60 * 60 * 1000
const BJ_DAY = "(created_at AT TIME ZONE 'Asia/Shanghai')::date"
const GOOD = "effect_rating IN ('good','up','positive','好评','1')"
const BAD = "effect_rating IN ('bad','down','negative','差评','0','-1')"
const RATED = "effect_rating IS NOT NULL AND effect_rating <> ''"

export interface BoardDb {
  fetchValue(sql: string): Promise<unknown>
  fetchRows<T extends Record<string, any> = Record<string, any>>(sql: string): Promise<T[]>
  close?(): Promise<void>
}

export interface BoardDeps {
  db?: BoardDb
  env?: Record<string, string | undefined>
  now?: () => Date
}

class BunSqlBoardDb implements BoardDb {
  private readonly sql: any

  constructor(dsn: string) {
    this.sql = new SQL(dsn)
  }

  async fetchValue(query: string): Promise<unknown> {
    const rows = await this.fetchRows(query)
    const first = rows[0]
    return first ? Object.values(first)[0] : null
  }

  async fetchRows<T extends Record<string, any> = Record<string, any>>(query: string): Promise<T[]> {
    return await this.sql.unsafe(query)
  }

  async close(): Promise<void> {
    await this.sql.close?.()
  }
}

const CSS = `
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
`

const PAGES = [
  ['/board/', '总览'],
  ['/board/generations', '生成记录'],
  ['/board/transcripts', '对话轨迹'],
  ['/board/cost', '成本'],
  ['/board/events', '事件'],
] as const

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  })
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return Response.json(body, init)
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function shiftToCst(date: Date): Date {
  return new Date(date.getTime() + CST_OFFSET_MS)
}

function cstDateKey(date: Date): string {
  return shiftToCst(date).toISOString().slice(0, 10)
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.trim().includes('T') ? value.trim() : value.trim().replace(' ', 'T')
  const withZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(normalized) ? normalized : `${normalized}Z`
  const parsed = new Date(withZone)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function formatCst(value: unknown): string {
  const parsed = parseDateValue(value)
  if (!parsed) return '—'
  const shifted = shiftToCst(parsed)
  return [
    shifted.getUTCFullYear(),
    '-',
    pad2(shifted.getUTCMonth() + 1),
    '-',
    pad2(shifted.getUTCDate()),
    ' ',
    pad2(shifted.getUTCHours()),
    ':',
    pad2(shifted.getUTCMinutes()),
  ].join('')
}

function dayKey(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10)
  if (typeof value === 'string') return value.slice(0, 10)
  return String(value ?? '')
}

function fmtInt(value: unknown): string {
  const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
  return Number.isFinite(n) ? Math.trunc(n).toLocaleString('en-US') : '0'
}

function intValue(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shell(active: string, body: string, now = new Date()): string {
  const nav = PAGES
    .map(([path, name]) => `<a class="${path === active ? 'on' : ''}" href="${path}">${name}</a>`)
    .join('')
  const cst = shiftToCst(now)
  const refreshed = `${pad2(cst.getUTCMonth() + 1)}-${pad2(cst.getUTCDate())} ${pad2(cst.getUTCHours())}:${pad2(cst.getUTCMinutes())}`
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>dataeye 看板</title><style>${CSS}</style></head><body>
<header><b>dataeye 数据看板</b><nav>${nav}</nav><span class="asof">刷新于 ${refreshed} · 每 2 分钟自动刷新</span></header>
<div class="wrap">${body}<p class="foot">只读 · 数据在大陆 · 北京时间 · 趋势按北京日实时现算</p></div></body></html>`
}

function table(cols: string[], rows: Array<Array<string | number>>): string {
  if (rows.length === 0) {
    return '<div class="empty">还没有数据 —— 等客户端上线后,数据会自动汇聚到这里。</div>'
  }
  const head = cols.map(col => `<th>${col}</th>`).join('')
  const body = rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')
  return `<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`
}

function card(n: string, label: string, delta = '', opts: { warn?: boolean; hl?: boolean } = {}): string {
  const warn = opts.warn ? ' warn' : ''
  const hl = opts.hl ? ' hl' : ''
  return `<div class="card${hl}"><div class="n${warn}">${n}</div><div class="l">${label}</div>${delta}</div>`
}

function delta(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? '<div class="d flat">昨日 0</div>' : '<div class="d up">▲ 新增</div>'
  const diff = cur - prev
  if (diff === 0) return '<div class="d flat">= 与昨日持平</div>'
  const pct = Math.round(diff / prev * 100)
  const cls = diff > 0 ? 'up' : 'down'
  const arrow = diff > 0 ? '▲' : '▼'
  return `<div class="d ${cls}">${arrow} ${fmtInt(Math.abs(diff))} (${Math.abs(pct)}% vs 昨日)</div>`
}

function bars(points: Array<[string, number]>, color = 'var(--accent)', h = 60): string {
  if (points.length === 0) return '<div class="empty" style="padding:16px">暂无数据</div>'
  const vals = points.map(([, value]) => Math.max(0, intValue(value)))
  const max = Math.max(...vals, 1)
  const width = 640
  const barWidth = width / points.length
  const pad = 3
  const rects = points.map(([label, value], i) => {
    const v = Math.max(0, intValue(value))
    const barHeight = v / max * (h - 10)
    const x = i * barWidth
    return `<rect x="${(x + pad / 2).toFixed(1)}" y="${(h - barHeight).toFixed(1)}" width="${Math.max(0.6, barWidth - pad).toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.5" fill="${color}"><title>${esc(label)}: ${fmtInt(v)}</title></rect>`
  }).join('')
  return `<svg class="chart" viewBox="0 0 ${width} ${h}" height="${h}" preserveAspectRatio="none" role="img">${rects}</svg>`
}

async function q1(db: BoardDb, sql: string): Promise<number> {
  try {
    return intValue(await db.fetchValue(sql))
  } catch {
    return 0
  }
}

async function daily(db: BoardDb, expr: string): Promise<Record<string, number>> {
  try {
    const rows = await db.fetchRows<{ d: unknown; v: unknown }>(
      `SELECT ${BJ_DAY} AS d, ${expr} AS v FROM generations WHERE created_at >= now() - interval '30 days' GROUP BY d ORDER BY d`,
    )
    const out: Record<string, number> = {}
    for (const row of rows) out[dayKey(row.d)] = intValue(row.v)
    return out
  } catch {
    return {}
  }
}

async function overview(db: BoardDb, now: Date): Promise<Response> {
  const gToday = await q1(db, `SELECT count(*) FROM generations WHERE ${BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date`)
  const gYest = await q1(db, `SELECT count(*) FROM generations WHERE ${BJ_DAY}=((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)`)
  const gWeek = await q1(db, `SELECT count(*) FROM generations WHERE ${BJ_DAY}>=date_trunc('week',(now() AT TIME ZONE 'Asia/Shanghai'))::date`)
  const gAll = await q1(db, 'SELECT count(*) FROM generations')
  const tokToday = await q1(db, `SELECT coalesce(sum(tokens_used),0) FROM generations WHERE ${BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date`)
  const tokYest = await q1(db, `SELECT coalesce(sum(tokens_used),0) FROM generations WHERE ${BJ_DAY}=((now() AT TIME ZONE 'Asia/Shanghai')::date - 1)`)
  const tokAll = await q1(db, 'SELECT coalesce(sum(tokens_used),0) FROM generations')
  const machines = await q1(db, 'SELECT count(DISTINCT machine_id) FROM raw_inbox')
  const active7 = await q1(db, `SELECT count(DISTINCT machine_id) FROM generations WHERE ${BJ_DAY}>=((now() AT TIME ZONE 'Asia/Shanghai')::date - 6)`)
  const stores = await q1(db, 'SELECT count(*) FROM stores')
  const transcripts = await q1(db, 'SELECT count(*) FROM transcripts')
  const good = await q1(db, `SELECT count(*) FROM generations WHERE ${GOOD}`)
  const bad = await q1(db, `SELECT count(*) FROM generations WHERE ${BAD}`)
  const rated = await q1(db, `SELECT count(*) FROM generations WHERE ${RATED}`)
  const errToday = await q1(db, `SELECT count(*) FROM events WHERE ${BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date AND (event ILIKE '%error%' OR event ILIKE '%crash%' OR event ILIKE '%fail%')`)
  const compToday = await q1(db, `SELECT count(*) FROM events WHERE ${BJ_DAY}=(now() AT TIME ZONE 'Asia/Shanghai')::date AND event ILIKE '%compliance%'`)

  const genByDay = await daily(db, 'count(*)')
  const tokByDay = await daily(db, 'coalesce(sum(tokens_used),0)')
  const today = new Date(`${cstDateKey(now)}T00:00:00Z`)
  const days = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today)
    d.setUTCDate(today.getUTCDate() - (29 - i))
    return d.toISOString().slice(0, 10)
  })
  const genPts: Array<[string, number]> = days.map(day => [day.slice(5), genByDay[day] ?? 0])
  const tokPts: Array<[string, number]> = days.map(day => [day.slice(5), tokByDay[day] ?? 0])
  const rate = rated ? Math.round(good / rated * 100) : null
  const rateTxt = rate === null ? '—' : `${rate}%`

  const todayCards = [
    card(fmtInt(gToday), '今日生成', delta(gToday, gYest), { hl: true }),
    card(fmtInt(tokToday), '今日 token', delta(tokToday, tokYest)),
    card(fmtInt(gWeek), '本周生成'),
    card(fmtInt(active7), '近 7 天活跃机器'),
    card(rateTxt, `好评率（${fmtInt(good)}好/${fmtInt(bad)}差）`, '', { hl: rate !== null && rate < 60 }),
  ].join('')
  const healthCards = [
    card(fmtInt(errToday), '今日报错/崩溃', '', { warn: errToday > 0, hl: true }),
    card(fmtInt(compToday), '今日合规命中', '', { warn: compToday > 0 }),
    card(fmtInt(machines), '累计机器'),
    card(fmtInt(stores), '门店数'),
    card(fmtInt(gAll), '累计生成'),
    card(fmtInt(tokAll), '累计 token'),
    card(fmtInt(transcripts), '对话轨迹'),
  ].join('')
  const genMax = Math.max(...genPts.map(([, value]) => value), 0)
  const tokMax = Math.max(...tokPts.map(([, value]) => value), 0)
  const charts = `<div class="charts2"><div class="chartbox"><div class="ct"><b>近 30 天 · 每日生成条数</b><span>峰值 ${fmtInt(genMax)}</span></div>${bars(genPts, 'var(--accent)')}</div><div class="chartbox"><div class="ct"><b>近 30 天 · 每日 token</b><span>峰值 ${fmtInt(tokMax)}</span></div>${bars(tokPts, 'var(--accent2)')}</div></div>`
  const body = `<h2>今日盯盘</h2><div class="cards">${todayCards}</div><h2>趋势</h2>${charts}<h2>健康 · 规模</h2><div class="cards">${healthCards}</div>`
  return htmlResponse(shell('/board/', body, now))
}

async function generations(db: BoardDb, now: Date): Promise<Response> {
  const rows = await db.fetchRows<{
    created_at: unknown
    machine_id: unknown
    type: unknown
    model_used: unknown
    tokens_used: unknown
    effect_rating: unknown
    prompt: unknown
  }>("SELECT created_at, machine_id, store_id, type, model_used, tokens_used, effect_rating, left(coalesce(prompt_used,''),80) AS prompt FROM generations ORDER BY created_at DESC NULLS LAST LIMIT 200")
  const trs = rows.map(row => {
    const rating = String(row.effect_rating ?? '')
    const pill = ['good', 'up', 'positive', '好评', '1'].includes(rating)
      ? '<span class="pill good">好</span>'
      : ['bad', 'down', 'negative', '差评', '0', '-1'].includes(rating)
        ? '<span class="pill bad">差</span>'
        : '—'
    return [
      formatCst(row.created_at),
      esc(row.machine_id).slice(0, 10),
      esc(row.type),
      esc(row.model_used),
      `<span class=num>${fmtInt(row.tokens_used)}</span>`,
      pill,
      `<div class="snip">${esc(row.prompt)}</div>`,
    ]
  })
  return htmlResponse(shell('/board/generations', '<h2>生成记录（最近 200）</h2>' + table(['时间', '机器', '类型', '模型', 'token', '评价', '提示词'], trs), now))
}

async function transcripts(db: BoardDb, now: Date): Promise<Response> {
  const rows = await db.fetchRows<{ created_at: unknown; machine_id: unknown; conversation_id: unknown; turns: unknown; summary: unknown }>("SELECT created_at, machine_id, conversation_id, turns, left(coalesce(summary,''),100) AS summary FROM transcripts ORDER BY created_at DESC NULLS LAST LIMIT 200")
  const trs = rows.map(row => [
    formatCst(row.created_at),
    esc(row.machine_id).slice(0, 10),
    esc(row.conversation_id).slice(0, 16),
    `<span class=num>${fmtInt(row.turns)}</span>`,
    `<div class="snip">${esc(row.summary)}</div>`,
  ])
  return htmlResponse(shell('/board/transcripts', '<h2>对话轨迹（最近 200）</h2>' + table(['时间', '机器', '会话', '轮数', '摘要'], trs), now))
}

async function cost(db: BoardDb, now: Date): Promise<Response> {
  const rows = await db.fetchRows<{ machine_id: unknown; d: unknown; n: unknown; tok: unknown }>(`SELECT machine_id, ${BJ_DAY} AS d, count(*) AS n, coalesce(sum(tokens_used),0) AS tok FROM generations WHERE created_at IS NOT NULL GROUP BY machine_id, ${BJ_DAY} ORDER BY d DESC, tok DESC LIMIT 200`)
  const trs = rows.map(row => [
    dayKey(row.d),
    esc(row.machine_id).slice(0, 12),
    `<span class=num>${fmtInt(row.n)}</span>`,
    `<span class=num>${fmtInt(row.tok)}</span>`,
  ])
  return htmlResponse(shell('/board/cost', '<h2>成本 · 按机器 / 北京日</h2>' + table(['日期', '机器', '生成条数', 'token'], trs), now))
}

async function events(db: BoardDb, now: Date): Promise<Response> {
  const byType = await db.fetchRows<{ event: unknown; n: unknown }>('SELECT event, count(*) AS n FROM events GROUP BY event ORDER BY n DESC LIMIT 40')
  const recent = await db.fetchRows<{ created_at: unknown; machine_id: unknown; event: unknown }>('SELECT created_at, machine_id, event FROM events ORDER BY created_at DESC NULLS LAST LIMIT 100')
  const t1 = table(['事件', '次数'], byType.map(row => [esc(row.event), `<span class=num>${fmtInt(row.n)}</span>`]))
  const t2 = table(['时间', '机器', '事件'], recent.map(row => [formatCst(row.created_at), esc(row.machine_id).slice(0, 10), esc(row.event)]))
  return htmlResponse(shell('/board/events', `<h2>事件 · 按类型</h2>${t1}<h2>最近事件</h2>${t2}`, now))
}

export function createBoardFetch(deps: BoardDeps = {}) {
  const env = deps.env ?? process.env
  const db = deps.db ?? new BunSqlBoardDb(env.PGDSN ?? DEFAULT_DSN)
  const now = deps.now ?? (() => new Date())

  return async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method !== 'GET') return jsonResponse({ detail: 'not found' }, { status: 404 })
    try {
      if (url.pathname === '/board' || url.pathname === '/board/') return await overview(db, now())
      if (url.pathname === '/board/generations') return await generations(db, now())
      if (url.pathname === '/board/transcripts') return await transcripts(db, now())
      if (url.pathname === '/board/cost') return await cost(db, now())
      if (url.pathname === '/board/events') return await events(db, now())
      if (url.pathname === '/board/healthz') {
        await db.fetchValue('SELECT 1')
        return jsonResponse({ ok: true })
      }
      return jsonResponse({ detail: 'not found' }, { status: 404 })
    } catch (err) {
      if (url.pathname === '/board/healthz') return jsonResponse({ ok: false, err: String(err instanceof Error ? err.message : err).slice(0, 200) })
      console.error('[dataeye board] request failed', err)
      return jsonResponse({ detail: 'internal server error' }, { status: 500 })
    }
  }
}

function parseArgs(argv: string[]) {
  let host = '127.0.0.1'
  let port = 9200
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host') host = argv[++i] ?? host
    else if (argv[i] === '--port') {
      const parsed = Number(argv[++i])
      if (Number.isFinite(parsed) && parsed > 0) port = parsed
    }
  }
  return { host, port }
}

export function startBoardServer(opts: { host?: string; port?: number } = {}) {
  return Bun.serve({
    hostname: opts.host ?? '127.0.0.1',
    port: opts.port ?? 9200,
    fetch: createBoardFetch(),
  })
}

if (import.meta.main) {
  const { host, port } = parseArgs(process.argv.slice(2))
  const server = startBoardServer({ host, port })
  console.log(`[dataeye-board] listening on http://${host}:${server.port}`)
}
