# -*- coding: utf-8 -*-
"""协议输出 + patchright 浏览器底座(抖音/快手/视频号/小红书 worker 共用)。

【JSON-line 协议】(与 desktop/src/publish.js 约定,勿改):
  每行一个 JSON 打到 stdout,Electron 主进程逐行 parse。
    {"type":"qrcode","dataUrl":"data:image/png;base64,..."}
    {"type":"status","status":"waiting|scanned|success|expired|error","msg":"..."}
    {"type":"progress","stage":"upload|fill|publish","pct":0-100,"msg":"..."}
    {"type":"result","ok":true|false,"url":"...","error":"..."}
  非 JSON 行(日志)主进程会忽略,所以调试日志一律走 stderr,不污染 stdout。

【patchright 反检测最佳实践】(来自 patchright 官方 PyPI 文档,2026-06 实测 v1.60.1):
  launch_persistent_context(user_data_dir=..., channel="chrome",
                            headless=False, no_viewport=True)
  - 持久上下文(非临时):cookie/指纹稳定,像真人常用浏览器
  - channel="chrome":用真 Google Chrome,比 bundled chromium 更不易被识别
  - headless=False:必须有头(无头易被风控)
  - no_viewport=True:用窗口真实尺寸,不强设 viewport
  - 不要 add_init_script / 注入 stealth.min.js / 改 user_agent ——
    patchright 已在底层打补丁,再注入反而会暴露(官方明确反对)。
"""

# 让 str|None 之类的新式注解在 Python 3.9 也不报错(注解变惰性字符串)。
# 主进程用系统 python3,版本可能是 3.9,必须兼容。
from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path


# ── 协议输出 ──────────────────────────────────────────────────────────────
def emit(type_: str, **kw):
    """打一行协议 JSON 到 stdout(立即 flush,主进程才能实时收到)。"""
    line = json.dumps({"type": type_, **kw}, ensure_ascii=False)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def log(*args):
    """调试日志走 stderr,绝不污染 stdout 的协议流。"""
    print(*args, file=sys.stderr, flush=True)


def emit_qrcode(data_url: str):
    emit("qrcode", dataUrl=data_url)


def emit_status(status: str, msg: str = ""):
    """status ∈ waiting|scanned|success|expired|error"""
    emit("status", status=status, msg=msg)


def emit_progress(stage: str, pct: int, msg: str = ""):
    """stage ∈ upload|fill|publish ; pct ∈ 0..100"""
    emit("progress", stage=stage, pct=int(pct), msg=msg)


def emit_result(ok: bool, url: str = "", error: str = ""):
    payload = {"ok": bool(ok)}
    if url:
        payload["url"] = url
    if error:
        payload["error"] = error
    emit("result", **payload)


# ── 会话目录 / 浏览器路径 ─────────────────────────────────────────────────
def session_dir() -> Path:
    """cookie/storage_state 存放目录。

    主进程通过环境变量 SAU_SESSION_DIR 传入;本地手测时默认落 ~/.billiards-desktop/sessions。
    """
    d = os.environ.get("SAU_SESSION_DIR") or os.path.join(
        os.path.expanduser("~"), ".billiards-desktop", "sessions"
    )
    p = Path(d)
    p.mkdir(parents=True, exist_ok=True)
    return p


def storage_state_path(platform: str) -> Path:
    """各平台一份 storage_state,如 douyin.json。"""
    return session_dir() / f"{platform}.json"


def user_data_dir(platform: str) -> Path:
    """持久上下文的用户数据目录(放浏览器 profile,与 storage_state 分开)。"""
    d = session_dir() / f"{platform}_userdata"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _resolve_channel() -> str | None:
    """优先用真 Google Chrome(patchright 推荐);允许用环境变量覆盖。

    返回 None 表示退回 patchright bundled chromium(channel 不传)。
    """
    forced = os.environ.get("SAU_BROWSER_CHANNEL")
    if forced:
        return None if forced.lower() in ("", "chromium", "none") else forced

    # macOS / Windows / Linux 上常见的 Chrome 安装位置探测
    candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",  # macOS
        "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",  # Windows
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        "/usr/bin/google-chrome",  # Linux
        "/usr/bin/google-chrome-stable",
    ]
    for c in candidates:
        if os.path.exists(c):
            return "chrome"
    return None  # 没装 Chrome → 用 bundled chromium


# ── patchright 持久上下文 ────────────────────────────────────────────────
@asynccontextmanager
async def persistent_context(platform: str, headless: bool | None = None):
    """开一个 patchright 持久上下文(按官方反检测最佳实践配置)。

    用法:
        async with persistent_context("douyin") as (context, page):
            await page.goto(...)

    headless 默认 False(有头);可经环境变量 SAU_HEADLESS=1 强制无头(仅给 CI/无显示器自检用,
    生产真发布必须有头)。
    """
    # 延迟导入:让 cli.py 在缺依赖时也能打印友好报错,而不是 import 期就崩
    from patchright.async_api import async_playwright

    if headless is None:
        headless = os.environ.get("SAU_HEADLESS", "0") == "1"

    channel = _resolve_channel()
    udir = str(user_data_dir(platform))

    kwargs = dict(
        user_data_dir=udir,
        headless=headless,
        no_viewport=True,
    )
    if channel:
        kwargs["channel"] = channel

    log(f"[base] launch persistent_context channel={channel or 'chromium(bundled)'} headless={headless}")

    async with async_playwright() as pw:
        context = await pw.chromium.launch_persistent_context(**kwargs)
        # 授予定位权限(抖音填地理位置时会要),失败不阻断
        try:
            await context.grant_permissions(["geolocation"])
        except Exception:
            pass
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            yield context, page
        finally:
            try:
                await context.close()
            except Exception:
                pass
