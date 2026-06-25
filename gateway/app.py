"""球房 AI 网关阀门(lean FastAPI)——国内机当总闸。

路由:
- MiMo 对话  /v1/chat/completions   → 直连小米(国内→国内,快;含流式透传)
- GPT 生图   /v1/images/generations → 转发美国机 /relay(OpenAI 出口)
- Seedance   /v1/video/generations  → 留接口位(等火山方舟 key)

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
            "img_conc": IMG_CONC, "video_conc": VIDEO_CONC},
            "quota": {"chat": Q_CHAT, "img": Q_IMG, "video": Q_VIDEO}}


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
