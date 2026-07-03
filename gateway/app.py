"""球房 AI 网关阀门(lean FastAPI)——国内机当总闸。

路由:
- MiMo 对话     /v1/chat/completions            → 直连小米(国内→国内,快;含流式透传)
- GPT 生图      /v1/images/generations|edits     → 转发美国机 /relay(OpenAI 出口)
- Seedance 视频 /v1/contents/generations/tasks(+轮询) → 直连火山方舟(国内→国内,异步任务)
- 火山豆包视觉/文本 /v1/ark/chat/completions      → 直连火山方舟(视频剪辑台"看懂画面"+"配文案/编排风格"用,
                                                     与 vlm.py/director.py 配对)
- 火山 Seedream 生图 /v1/ark/images/generations   → 直连火山方舟(原生 JSON 端点,非 OpenAI multipart edits)
- 高德地图      /v1/amap/{path}                  → 直连高德(桌面 Agent 内置工具:天气/周边地点/地理编码/
                                                     路线规划,与 amap_tools.py 配对,只读查询无并发阀门)

三层阀门:
  ① 每家真实限流:MiMo 令牌桶(账号 100 RPM 留余量)、生图 IPM 令牌桶 + 并发信号量、视频并发信号量(个人户 3)
  ② 每用户每日配额(防一个人烧光/挤垮所有人)
  ③ 满了排队(最多等 GW_QUEUE_MAX_WAIT 秒),超时拒(背压),绝不硬撞 provider

用量全记 SQLite(谁/哪个模型/成功失败/耗时/什么时候)。Key 只从环境读、不进代码。
"""
import asyncio
import json
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

CFG = {
    "mimo_key": os.environ["GW_MIMO_KEY"],
    "mimo_base": os.environ.get("GW_MIMO_BASE", "https://api.xiaomimimo.com/v1").rstrip("/"),
    "relay_base": os.environ["GW_RELAY_BASE"].rstrip("/"),   # 美国出口(/relay/openai/v1)
    "relay_token": os.environ["GW_RELAY_TOKEN"],
    "admin_token": os.environ.get("GW_ADMIN_TOKEN", "change-me"),
    "db": os.environ.get("GW_DB", "/opt/qfgw/usage.db"),
    # Seedance 视频(火山方舟,国内→国内直连,异步:提交→轮询)。key 只从 gw.env 读、不进库。
    "ark_key": os.environ.get("GW_ARK_KEY", ""),
    "ark_base": os.environ.get("GW_ARK_BASE", "https://ark.cn-beijing.volces.com/api/v3").rstrip("/"),
    # 高德地图 Web 服务 API(桌面 Agent 内置工具:天气/周边地点/地理编码/路线规划,国内→国内直连)。
    "amap_key": os.environ.get("GW_AMAP_KEY", ""),
    "amap_base": os.environ.get("GW_AMAP_BASE", "https://restapi.amap.com").rstrip("/"),
}
APP_TOKENS = json.loads(os.environ.get("GW_APP_TOKENS", "{}"))  # {app令牌: 用户标识}

# 真实上限(已查证):MiMo 账号 100 RPM、OpenAI 图 IPM 按 tier、视频个人并发 3
MIMO_RPM = int(os.environ.get("GW_MIMO_RPM", "90"))      # 100 留余量
IMG_IPM = int(os.environ.get("GW_IMG_IPM", "18"))        # 按账号 tier,留余量
IMG_CONC = int(os.environ.get("GW_IMG_CONC", "12"))      # 在途并发(单张 30-60s 会堆)
VIDEO_CONC = int(os.environ.get("GW_VIDEO_CONC", "3"))   # 火山个人户硬上限
Q_CHAT = int(os.environ.get("GW_Q_CHAT", "300"))         # 每人每日对话上限
Q_IMG = int(os.environ.get("GW_Q_IMG", "20"))
Q_VIDEO = int(os.environ.get("GW_Q_VIDEO", "5"))
QUEUE_MAX_WAIT = float(os.environ.get("GW_QUEUE_MAX_WAIT", "60"))  # 排队最多等;超时=背压拒
VIDEO_TIMEOUT = float(os.environ.get("GW_VIDEO_TIMEOUT", "1800"))  # 视频轮询上限(实测出片 3.5~13.5 分钟,留 30 分钟)

# 火山豆包视觉/文本(VLM 打分 + 导演配文案/编排风格,视频剪辑台一条流水线内多次调用,量比对话小、比生图大)
ARK_CHAT_RPM = int(os.environ.get("GW_ARK_CHAT_RPM", "30"))
Q_ARK_CHAT = int(os.environ.get("GW_Q_ARK_CHAT", "500"))     # 每人每日调用次数上限(打分是逐帧/逐网格调,给宽松点)
# 火山 Seedream 生图(原生端点,预留通道;真实限流 500 IPM/账号,自己收紧留余量)
ARK_IMG_IPM = int(os.environ.get("GW_ARK_IMG_IPM", "20"))
ARK_IMG_CONC = int(os.environ.get("GW_ARK_IMG_CONC", "6"))
Q_ARK_IMG = int(os.environ.get("GW_Q_ARK_IMG", "20"))

# 高德地图(纯查询·官方个人认证限流很宽松,天气 200QPS/300000次天·这里只是防单用户/单店把配额刷爆)
Q_AMAP = int(os.environ.get("GW_Q_AMAP", "300"))          # 每人每日调用次数上限

CST = timezone(timedelta(hours=8))


class TokenBucket:
    """每分钟 rpm 个令牌;acquire 等到有令牌,排队超过 max_wait 抛 429(背压)。"""

    def __init__(self, rpm: int):
        self.capacity = float(rpm)
        self.tokens = float(rpm)
        self.rate = rpm / 60.0
        self.ts = time.monotonic()
        self.lock = asyncio.Lock()

    async def acquire(self, max_wait: float):
        deadline = time.monotonic() + max_wait
        while True:
            async with self.lock:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.ts) * self.rate)
                self.ts = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                need = (1 - self.tokens) / self.rate
            if time.monotonic() + need > deadline:
                raise HTTPException(429, "现在用的人多,稍等一下再发(已在排队保护)")
            await asyncio.sleep(min(need, 0.5))


mimo_bucket = TokenBucket(MIMO_RPM)
img_bucket = TokenBucket(IMG_IPM)
img_sem = asyncio.Semaphore(IMG_CONC)
video_sem = asyncio.Semaphore(VIDEO_CONC)
ark_chat_bucket = TokenBucket(ARK_CHAT_RPM)
ark_img_bucket = TokenBucket(ARK_IMG_IPM)
ark_img_sem = asyncio.Semaphore(ARK_IMG_CONC)


def _db():
    c = sqlite3.connect(CFG["db"], timeout=10)
    c.execute("PRAGMA journal_mode=WAL")
    return c


def init_db():
    os.makedirs(os.path.dirname(CFG["db"]) or ".", exist_ok=True)
    c = _db()
    c.execute(
        "CREATE TABLE IF NOT EXISTS usage("
        "id INTEGER PRIMARY KEY, ts TEXT, day TEXT, user TEXT, model TEXT, "
        "ok INTEGER, status INTEGER, ms INTEGER, note TEXT)"
    )
    c.commit()
    c.close()


def _today():
    return datetime.now(CST).strftime("%Y-%m-%d")


def used_today(user: str, kind: str) -> int:
    c = _db()
    n = c.execute(
        "SELECT COUNT(*) FROM usage WHERE day=? AND user=? AND model=? AND ok=1",
        (_today(), user, kind),
    ).fetchone()[0]
    c.close()
    return n


def log(user: str, model: str, ok: bool, status: int, ms: int, note: str = ""):
    c = _db()
    c.execute(
        "INSERT INTO usage(ts,day,user,model,ok,status,ms,note) VALUES(?,?,?,?,?,?,?,?)",
        (datetime.now(CST).isoformat(timespec="seconds"), _today(), user, model, int(ok), status, ms, note),
    )
    c.commit()
    c.close()


def auth(authorization: str) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "缺少 app 令牌")
    user = APP_TOKENS.get(authorization[7:].strip())
    if not user:
        raise HTTPException(401, "app 令牌无效")
    return user


def quota_check(user: str, kind: str, limit: int):
    if used_today(user, kind) >= limit:
        raise HTTPException(429, f"今天「{kind}」额度用完了(每天 {limit} 次),明天再来或找管理员加")


init_db()
app = FastAPI(title="球房AI网关阀门")


@app.get("/healthz")
async def health():
    return {"ok": True, "limits": {"mimo_rpm": MIMO_RPM, "img_ipm": IMG_IPM,
            "img_conc": IMG_CONC, "video_conc": VIDEO_CONC,
            "ark_chat_rpm": ARK_CHAT_RPM, "ark_img_ipm": ARK_IMG_IPM, "ark_img_conc": ARK_IMG_CONC},
            "quota": {"chat": Q_CHAT, "img": Q_IMG, "video": Q_VIDEO,
                      "ark_chat": Q_ARK_CHAT, "ark_img": Q_ARK_IMG}}


@app.get("/admin/usage")
async def admin_usage(token: str, n: int = 50):
    if token != CFG["admin_token"]:
        raise HTTPException(403, "无权")
    c = _db()
    cols = ["ts", "user", "model", "ok", "status", "ms", "note"]
    rows = c.execute(f"SELECT {','.join(cols)} FROM usage ORDER BY id DESC LIMIT ?", (n,)).fetchall()
    today_stat = c.execute(
        "SELECT model, COUNT(*), SUM(ok) FROM usage WHERE day=? GROUP BY model", (_today(),)
    ).fetchall()
    c.close()
    return {"today": _today(),
            "today_by_model": [{"model": m, "total": t, "ok": s} for m, t, s in today_stat],
            "recent": [dict(zip(cols, r)) for r in rows]}


@app.post("/v1/chat/completions")
async def chat(request: Request, authorization: str = Header(None)):
    user = auth(authorization)
    quota_check(user, "mimo", Q_CHAT)
    await mimo_bucket.acquire(QUEUE_MAX_WAIT)        # ① 限流 ③ 排队
    body = await request.body()
    t0 = time.monotonic()
    cli = httpx.AsyncClient(timeout=httpx.Timeout(120.0, read=120.0))
    req = cli.build_request(
        "POST", CFG["mimo_base"] + "/chat/completions", content=body,
        # Accept-Encoding: identity → 上游不压缩,raw 透传不乱码(流式/非流式都对)
        headers={"Authorization": f"Bearer {CFG['mimo_key']}", "Content-Type": "application/json",
                 "Accept-Encoding": "identity"},
    )
    r = await cli.send(req, stream=True)
    resp_headers = {}
    if "content-encoding" in r.headers:              # 上游万一仍压缩,把编码头透传给客户端
        resp_headers["content-encoding"] = r.headers["content-encoding"]

    async def body_iter():
        ok = r.status_code < 400
        try:
            async for chunk in r.aiter_raw():
                yield chunk
        finally:
            await r.aclose()
            await cli.aclose()
            log(user, "mimo", ok, r.status_code, int((time.monotonic() - t0) * 1000))

    return StreamingResponse(body_iter(), status_code=r.status_code,
                             media_type=r.headers.get("content-type", "application/json"),
                             headers=resp_headers)


@app.post("/v1/images/generations")
async def images(request: Request, authorization: str = Header(None)):
    user = auth(authorization)
    quota_check(user, "img", Q_IMG)
    await img_bucket.acquire(QUEUE_MAX_WAIT)         # ① IPM 限流 ③ 排队
    async with img_sem:                              # ① 在途并发
        body = await request.body()
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(900.0, read=900.0)) as cli:
                r = await cli.post(
                    CFG["relay_base"] + "/images/generations", content=body,
                    headers={"Authorization": f"Bearer {CFG['relay_token']}", "Content-Type": "application/json"},
                )
            ms = int((time.monotonic() - t0) * 1000)
            log(user, "img", r.status_code < 400, r.status_code, ms)
            ct = r.headers.get("content-type", "")
            if ct.startswith("application/json"):
                return JSONResponse(status_code=r.status_code, content=r.json())
            return JSONResponse(status_code=r.status_code, content={"raw": r.text[:500]})
        except Exception as e:
            log(user, "img", False, 599, int((time.monotonic() - t0) * 1000), str(e)[:120])
            raise HTTPException(502, f"生图上游出错:{str(e)[:120]}")


@app.post("/v1/images/edits")
async def images_edits(request: Request, authorization: str = Header(None)):
    # 图生图(multipart 传图):保留原始 Content-Type(含 boundary)透传,转发美国 relay 的 /images/edits。
    user = auth(authorization)
    quota_check(user, "img", Q_IMG)
    await img_bucket.acquire(QUEUE_MAX_WAIT)
    async with img_sem:
        body = await request.body()
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(900.0, read=900.0)) as cli:
                r = await cli.post(
                    CFG["relay_base"] + "/images/edits", content=body,
                    headers={"Authorization": f"Bearer {CFG['relay_token']}",
                             "Content-Type": request.headers.get("content-type", "application/octet-stream")},
                )
            ms = int((time.monotonic() - t0) * 1000)
            log(user, "img", r.status_code < 400, r.status_code, ms)
            ct = r.headers.get("content-type", "")
            if ct.startswith("application/json"):
                return JSONResponse(status_code=r.status_code, content=r.json())
            return JSONResponse(status_code=r.status_code, content={"raw": r.text[:500]})
        except Exception as e:
            log(user, "img", False, 599, int((time.monotonic() - t0) * 1000), str(e)[:120])
            raise HTTPException(502, f"图生图上游出错:{str(e)[:120]}")


@app.post("/v1/video/generations")
async def video(request: Request, authorization: str = Header(None)):
    """Seedance 视频:客户端传 ARK 格式 body(model/content/ratio/duration…),网关注入真 key、
    提交异步任务→轮询出片→回 {video_url}。video_sem 卡死并发(火山个人户 3),配额按 user 计。"""
    user = auth(authorization)
    quota_check(user, "video", Q_VIDEO)
    if not CFG["ark_key"]:
        raise HTTPException(503, "视频功能未配置(缺 GW_ARK_KEY)")
    body = await request.body()
    ark_h = {"Authorization": f"Bearer {CFG['ark_key']}", "Content-Type": "application/json"}
    tasks_url = CFG["ark_base"] + "/contents/generations/tasks"
    async with video_sem:                            # ① 视频并发(个人户 3)③ 满了在此排队
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=60.0)) as cli:
                sub = await cli.post(tasks_url, content=body, headers=ark_h)   # 提交异步任务
                if sub.status_code >= 400:
                    log(user, "video", False, sub.status_code, int((time.monotonic() - t0) * 1000), sub.text[:120])
                    ct = sub.headers.get("content-type", "")
                    return JSONResponse(status_code=sub.status_code,
                                        content=sub.json() if ct.startswith("application/json") else {"raw": sub.text[:500]})
                task_id = (sub.json() or {}).get("id")
                if not task_id:
                    log(user, "video", False, 502, int((time.monotonic() - t0) * 1000), "no task_id")
                    raise HTTPException(502, "视频上游未返回任务号")
                deadline = time.monotonic() + VIDEO_TIMEOUT                    # 轮询直到出片(背压由 video_sem 兜)
                while time.monotonic() < deadline:
                    await asyncio.sleep(8)
                    g = await cli.get(f"{tasks_url}/{task_id}", headers=ark_h)
                    j = g.json() or {}
                    st = str(j.get("status") or "").lower()
                    if st == "succeeded":
                        url = (j.get("content") or {}).get("video_url") or j.get("video_url")
                        log(user, "video", True, 200, int((time.monotonic() - t0) * 1000), f"task={task_id}")
                        return {"video_url": url, "task_id": task_id}
                    if st in ("failed", "expired", "cancelled", "canceled"):
                        log(user, "video", False, 502, int((time.monotonic() - t0) * 1000), f"{st}")
                        raise HTTPException(502, f"视频生成失败:{st}")
                log(user, "video", False, 504, int((time.monotonic() - t0) * 1000), "poll timeout")
                raise HTTPException(504, "视频生成超时")
        except HTTPException:
            raise
        except Exception as e:
            log(user, "video", False, 599, int((time.monotonic() - t0) * 1000), str(e)[:120])
            raise HTTPException(502, f"视频上游出错:{str(e)[:120]}")


# ── Seedance 视频·透传代理(客户端 ark_video.py 自己 submit+轮询,每次短请求避开 nginx 长连接超时;
#    真 ARK key 只在网关 gw.env、客户端只带 app 令牌。这是收编视频 key 的正式通道,优于上面"一次全包"那条)──
@app.post("/v1/contents/generations/tasks")
async def video_submit(request: Request, authorization: str = Header(None)):
    """提交 Seedance 任务:auth 令牌 + 配额 + 注入真 ARK key 转火山,原样回任务号。"""
    user = auth(authorization)
    quota_check(user, "video", Q_VIDEO)
    if not CFG["ark_key"]:
        raise HTTPException(503, "视频功能未配置(缺 GW_ARK_KEY)")
    body = await request.body()
    ark_h = {"Authorization": f"Bearer {CFG['ark_key']}", "Content-Type": "application/json"}
    url = CFG["ark_base"] + "/contents/generations/tasks"
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=60.0)) as cli:
            r = await cli.post(url, content=body, headers=ark_h)
        log(user, "video", r.status_code < 400, r.status_code, int((time.monotonic() - t0) * 1000), "submit")
        ct = r.headers.get("content-type", "")
        if ct.startswith("application/json"):
            return JSONResponse(status_code=r.status_code, content=r.json())
        return JSONResponse(status_code=r.status_code, content={"raw": r.text[:500]})
    except Exception as e:
        log(user, "video", False, 599, int((time.monotonic() - t0) * 1000), str(e)[:120])
        raise HTTPException(502, f"视频提交出错:{str(e)[:120]}")


@app.get("/v1/contents/generations/tasks/{task_id}")
async def video_poll(task_id: str, authorization: str = Header(None)):
    """轮询 Seedance 任务:auth 令牌 + 注入真 ARK key 转火山,原样回(status / content.video_url)。
    出片的 video_url 是火山短期签名直链,客户端直接下载,不经网关、也不含 key。"""
    user = auth(authorization)
    if not CFG["ark_key"]:
        raise HTTPException(503, "视频功能未配置(缺 GW_ARK_KEY)")
    ark_h = {"Authorization": f"Bearer {CFG['ark_key']}"}
    url = CFG["ark_base"] + f"/contents/generations/tasks/{task_id}"
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=60.0)) as cli:
            r = await cli.get(url, headers=ark_h)
        ct = r.headers.get("content-type", "")
        if ct.startswith("application/json"):
            return JSONResponse(status_code=r.status_code, content=r.json())
        return JSONResponse(status_code=r.status_code, content={"raw": r.text[:500]})
    except Exception as e:
        raise HTTPException(502, f"视频轮询出错:{str(e)[:120]}")


# ── 火山豆包视觉/文本(收编 vlm.py + director.py 的直连)────────────────────
# 视频剪辑台"看懂画面"(VLM 打分/分类)+ "配文案/编排风格"(AI 导演)都调这一条,与 Seedance
# 共用同一把 GW_ARK_KEY(同账号)。非流式:调用方是一次性请求(不是对话主链路),等整包回即可。
@app.post("/v1/ark/chat/completions")
async def ark_chat(request: Request, authorization: str = Header(None)):
    user = auth(authorization)
    quota_check(user, "ark_chat", Q_ARK_CHAT)
    if not CFG["ark_key"]:
        raise HTTPException(503, "视觉/文案功能未配置(缺 GW_ARK_KEY)")
    await ark_chat_bucket.acquire(QUEUE_MAX_WAIT)     # ① 限流 ③ 排队
    body = await request.body()
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(120.0, read=120.0)) as cli:
            r = await cli.post(
                CFG["ark_base"] + "/chat/completions", content=body,
                headers={"Authorization": f"Bearer {CFG['ark_key']}", "Content-Type": "application/json"},
            )
        ms = int((time.monotonic() - t0) * 1000)
        log(user, "ark_chat", r.status_code < 400, r.status_code, ms)
        ct = r.headers.get("content-type", "")
        if ct.startswith("application/json"):
            return JSONResponse(status_code=r.status_code, content=r.json())
        return JSONResponse(status_code=r.status_code, content={"raw": r.text[:500]})
    except Exception as e:
        log(user, "ark_chat", False, 599, int((time.monotonic() - t0) * 1000), str(e)[:120])
        raise HTTPException(502, f"视觉/文案上游出错:{str(e)[:120]}")


# ── 火山方舟·Seedream 生图(原生 JSON /images/generations,非 OpenAI multipart edits)──
# 预留通道:与 GPT 生图(/v1/images/generations,转发美国 relay)路径不同、互不影响。
# 客户端接入待办(见部署清单文档「遗留风险清单」):poster_service.py 目前桌面盒子内置 Seedream 仍直连火山,
# 未接这条网关通道。
@app.post("/v1/ark/images/generations")
async def ark_images(request: Request, authorization: str = Header(None)):
    user = auth(authorization)
    quota_check(user, "ark_img", Q_ARK_IMG)
    if not CFG["ark_key"]:
        raise HTTPException(503, "生图功能未配置(缺 GW_ARK_KEY)")
    await ark_img_bucket.acquire(QUEUE_MAX_WAIT)      # ① IPM 限流 ③ 排队
    async with ark_img_sem:                           # ① 在途并发
        body = await request.body()
        t0 = time.monotonic()
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(300.0, read=300.0)) as cli:
                r = await cli.post(
                    CFG["ark_base"] + "/images/generations", content=body,
                    headers={"Authorization": f"Bearer {CFG['ark_key']}", "Content-Type": "application/json"},
                )
            ms = int((time.monotonic() - t0) * 1000)
            log(user, "ark_img", r.status_code < 400, r.status_code, ms)
            ct = r.headers.get("content-type", "")
            if ct.startswith("application/json"):
                return JSONResponse(status_code=r.status_code, content=r.json())
            return JSONResponse(status_code=r.status_code, content={"raw": r.text[:500]})
        except Exception as e:
            log(user, "ark_img", False, 599, int((time.monotonic() - t0) * 1000), str(e)[:120])
            raise HTTPException(502, f"生图上游出错:{str(e)[:120]}")


# ── 高德地图 Web 服务 API(桌面 Agent 内置工具:天气/周边地点/地理编码/路线规划)──────
# 一条通用 {path:path} 转发路由覆盖全部子端点(v3/weather/weatherInfo、v3/place/around|text、
# v3/geocode/geo|regeo、v3/direction/driving|walking|transit/integrated),客户端
# (server/services/agent/amap_tools.py)只传业务 query 参数、不带 key,真高德 key 只在这里注入。
@app.get("/v1/amap/{path:path}")
async def amap_proxy(path: str, request: Request, authorization: str = Header(None)):
    user = auth(authorization)
    quota_check(user, "amap", Q_AMAP)
    if not CFG["amap_key"]:
        raise HTTPException(503, "地图功能未配置(缺 GW_AMAP_KEY)")
    params = dict(request.query_params)
    params["key"] = CFG["amap_key"]
    url = f"{CFG['amap_base']}/{path}"
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0, read=15.0)) as cli:
            r = await cli.get(url, params=params)
        ms = int((time.monotonic() - t0) * 1000)
        log(user, "amap", r.status_code < 400, r.status_code, ms)
        ct = r.headers.get("content-type", "")
        if ct.startswith("application/json"):
            return JSONResponse(status_code=r.status_code, content=r.json())
        return JSONResponse(status_code=r.status_code, content={"raw": r.text[:500]})
    except Exception as e:
        log(user, "amap", False, 599, int((time.monotonic() - t0) * 1000), str(e)[:120])
        raise HTTPException(502, f"地图上游出错:{str(e)[:120]}")
