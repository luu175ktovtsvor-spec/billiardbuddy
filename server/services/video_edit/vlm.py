"""视觉理解(VLM)轻客户端 —— 让大脑"看懂"视频帧,给氛围 Planner 挑高光用。

**上游可切(落地文档 §6"网关上游可切"设计),env VLM_PROVIDER 选:**
- `doubao`(默认·主用):火山豆包视觉 `doubao-seed-1-6-250615`。**生产经网关**(gateway/app.ts 的
  `/v1/ark/chat/completions`)反代,真 ARK key 全在服务器,客户端只带可吊销的 app 令牌
  (`QF_GATEWAY_URL`/`QF_GATEWAY_TOKEN`)。⚠️模型要在方舟控制台开通+受限 key 授权。
- `zhipu`(兜底):智谱 `glm-4.6v-flash`,零成本但**免费档限流狠**(实测密集调 429 锁死),量小不收编,
  继续直连(`ZHIPU_API_KEY`)。

owner 2026-07-01 拍板:VLM 一律走云端 API(店主机弱扛不住本地 7B)。
⚠️ `QF_GATEWAY_URL`/`QF_GATEWAY_TOKEN` 没配时,退到 `ARK_API_KEY`/`VLM_API_KEY` 直连火山——这是
**dev-only 开发机后门**(联调图快),生产 / 客户盒子必须配网关,不能把真 ARK key 打进客户端。

铁律(实测踩坑):
- 图片必须 **base64 直传**,别喂外网 URL(智谱国内服务器拉不动海外图床报 1210;统一 base64 最稳)。
- 免费档限流狠 → 多帧拼一张网格图一次问(score_frames_grid)省请求数;失败/限流→优雅降级启发式,管线不崩。
"""
from __future__ import annotations

import base64
import json
import logging
import os
import re
import threading
import time
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# ── VLM 上游(可切换)——落地"网关上游可切"设计 ─────────────────────────────
# 默认走【火山豆包视觉】,生产经网关(藏 key);智谱免费档留兜底(零成本但限流狠,量小不收编)。
# env VLM_PROVIDER 切换。
_PROVIDERS = {
    "doubao": {
        "gateway": True,   # 生产走网关(真 key 全在服务器)
        "dev_endpoint": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",  # dev-only 直连后门
        "model": os.environ.get("VLM_MODEL_DOUBAO", "doubao-seed-1-6-250615"),
        "dev_key_envs": ("ARK_API_KEY", "VLM_API_KEY"),
    },
    "zhipu": {
        "gateway": False,  # 免费兜底档,量小不值得收编,继续直连
        "dev_endpoint": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": os.environ.get("VLM_MODEL_ZHIPU", "glm-4.6v-flash"),
        "dev_key_envs": ("ZHIPU_API_KEY", "VLM_API_KEY"),
    },
}

# 网关地址/令牌(生产形态):真 ARK key 在服务器 gw.env,客户端只带这个可吊销的 app 令牌。
_GATEWAY_URL = os.environ.get("QF_GATEWAY_URL", "").rstrip("/")   # 如 http://<网关IP>/gw/v1
_GATEWAY_TOKEN = os.environ.get("QF_GATEWAY_TOKEN", "")
_GATEWAY_PATH = "/ark/chat/completions"   # gateway/app.ts 的火山豆包视觉/文本通道


def _provider() -> dict:
    return _PROVIDERS.get(os.environ.get("VLM_PROVIDER", "doubao"), _PROVIDERS["doubao"])


def _resolve_endpoint() -> tuple[str, str] | None:
    """算这次请求打哪个 url、带哪个 token;没配(网关没配、dev key 也没)→ None,调用方降级启发式。

    生产:走网关(`QF_GATEWAY_URL`+`QF_GATEWAY_TOKEN`),真 ARK key 全在服务器。
    dev-only 后门:开发机联调图快,设了 `ARK_API_KEY`/`VLM_API_KEY` 就直连火山(生产/客户盒子别这么配)。
    """
    p = _provider()
    if p.get("gateway") and _GATEWAY_URL and _GATEWAY_TOKEN:
        return _GATEWAY_URL + _GATEWAY_PATH, _GATEWAY_TOKEN
    for env in p["dev_key_envs"]:
        v = os.environ.get(env)
        if v:
            return p["dev_endpoint"], v
    return None

# 免费档有速率限制(实测密集调会 429)。串行节流 + 429 指数退避重试。
_MIN_INTERVAL = float(os.environ.get("VLM_MIN_INTERVAL", "1.3"))  # 两次请求最小间隔(秒)
_MAX_RETRIES = int(os.environ.get("VLM_MAX_RETRIES", "4"))
_throttle_lock = threading.Lock()
_last_call_ts = [0.0]


def _throttle() -> None:
    """串行节流:保证两次请求间隔 ≥ _MIN_INTERVAL,避开免费档 429。"""
    with _throttle_lock:
        wait = _MIN_INTERVAL - (time.monotonic() - _last_call_ts[0])
        if wait > 0:
            time.sleep(wait)
        _last_call_ts[0] = time.monotonic()

# 给一帧图打分的指令:强制吐 JSON,便于确定性解析。领域无关——适配任意视频(旅游/美食/宠物/产品/人物…)。
# E5③新增 shot_size/camera_move/mood 三字段(理解层元数据升级):给 E5②叙事分组当依据
# (景别/运镜决定镜头怎么组接、情绪决定叙事节奏),下游 planners/ambient.py 透传、_norm_score 缺省兜底。
_SCORE_PROMPT = (
    "你在帮用户从视频里挑最适合发短视频(抖音/小红书)的高光画面。看这一帧,直接只回一个 JSON,不要思考过程、不要```包裹:\n"
    '{"subject":"画面主体一句话(如 人物特写/美食/风景/宠物/产品…)","quality":0到10整数分,'
    '"usable":true或false,"reason":"12字内理由",'
    '"shot_size":"景别(远景/中景/近景/特写之一)","camera_move":"运镜(推/拉/摇/移/固定之一)",'
    '"mood":"这一帧的情绪短词(如欢快/平静/紧张/温馨)"}\n'
    "参考:主体清晰好看/构图舒服/有信息量=高分;糊、动作中途、杂乱、过曝、空洞=低分且 usable=false。"
)


def vlm_available() -> bool:
    """有没有配 VLM 通道(网关或 dev key 直连)——没有则 Planner 走启发式。"""
    return _resolve_endpoint() is not None


def _b64_data_uri(image_path: str) -> str:
    raw = Path(image_path).read_bytes()
    return "data:image/jpeg;base64," + base64.b64encode(raw).decode()


def _parse_json_loose(text: str) -> dict | None:
    """从模型回复里抠出 JSON(容忍前后废话/```json 包裹)。"""
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


_GRID_PROMPT = (
    "下面是 {n} 张视频画面拼成的网格,每张左上角有红色编号(1 到 {n})。你在帮用户挑最适合发短视频(抖音/小红书)的高光画面。"
    "逐张判断,直接只回一个 JSON 数组(长度正好 {n},不要思考过程、不要```包裹):\n"
    '[{{"index":1,"subject":"画面主体一句话(如 人物特写/美食/风景/宠物/产品…)","quality":0到10整数,"usable":true或false,"reason":"12字内",'
    '"shot_size":"景别(远景/中景/近景/特写之一)","camera_move":"运镜(推/拉/摇/移/固定之一)","mood":"情绪短词(如欢快/平静/紧张/温馨)"}}, ...]\n'
    "参考:主体清晰好看/构图舒服/有信息量=高分;糊、动作中途、杂乱、过曝、空洞=低分且 usable=false。"
)


def _norm_score(data: dict) -> dict:
    """把 VLM 回复归一成统一形状。E5③:shot_size/camera_move/mood 缺失/空 → 安全默认
    (未知/固定/平静),不因为 VLM 漏答这三个新字段就让整条打分链路报错。"""
    try:
        q = float(data.get("quality", 5))
    except (TypeError, ValueError):
        q = 5.0
    return {
        "subject": str(data.get("subject") or "未知"),
        "quality": max(0.0, min(10.0, q)),
        "usable": bool(data.get("usable", True)),
        "reason": str(data.get("reason") or "").strip(),
        "shot_size": str(data.get("shot_size") or "").strip() or "未知",
        "camera_move": str(data.get("camera_move") or "").strip() or "固定",
        "mood": str(data.get("mood") or "").strip() or "平静",
    }


_CLASSIFY_PROMPT = (
    "看这些视频画面,判断内容类型。只回一个 JSON,不要思考过程、不要```包裹:\n"
    '{"is_billiards": true或false, "scene": "门店环境|助教展示|人气氛围|口播讲解|通用"}\n'
    "is_billiards:画面里有台球桌/球杆/台球厅场景就 true,否则 false。\n"
    "scene(仅台球时有意义):门店环境=装修/球台/空间空镜B-roll;助教展示=以年轻女性颜值/打球英姿为主;"
    "人气氛围=多人打球、热闹满台;口播讲解=有人对着镜头说话讲解;非台球一律填 通用。"
)


def classify_content(image_paths: list[str], *, timeout: float = 60.0) -> dict:
    """看几帧代表画面,判断 {is_billiards, scene}。这是"通用 vs 台球加持"分支的开关。

    没 key / 失败 → {is_billiards: False, scene: 通用}(优雅降级到通用,不崩)。
    """
    resolved = _resolve_endpoint()
    if not resolved or not image_paths:
        return {"is_billiards": False, "scene": "通用"}
    url, token = resolved
    try:
        grid = _compose_grid_datauri(image_paths[:8])
    except Exception:  # noqa: BLE001
        return {"is_billiards": False, "scene": "通用"}
    payload = {
        "model": _provider()["model"],
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": _CLASSIFY_PROMPT},
            {"type": "image_url", "image_url": {"url": grid}},
        ]}],
        "temperature": 0.1, "max_tokens": 200,
    }
    content = _post_with_retry(url, token, payload, timeout)
    data = _parse_json_loose(content or "") or {}
    scene = str(data.get("scene") or "通用")
    is_bil = bool(data.get("is_billiards"))
    return {"is_billiards": is_bil, "scene": scene if is_bil else "通用"}


def score_frames_grid(image_paths: list[str], *, timeout: float = 90.0) -> list[dict] | None:
    """把多张帧拼成一张网格图,一次请求给全部打分(省请求数、躲免费档限流)。

    返回与 image_paths 等长的打分列表;整批失败(没key/网络/格式)则 None → 调用方对整批走启发式。
    """
    resolved = _resolve_endpoint()
    if not resolved or not image_paths:
        return None
    url, token = resolved
    n = len(image_paths)
    try:
        grid_uri = _compose_grid_datauri(image_paths)
    except Exception as e:  # noqa: BLE001
        logger.warning("拼网格失败,降级:%s", e)
        return None

    payload = {
        "model": _provider()["model"],
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": _GRID_PROMPT.format(n=n)},
            {"type": "image_url", "image_url": {"url": grid_uri}},
        ]}],
        "temperature": 0.2,
        "max_tokens": 1200,
    }
    content = _post_with_retry(url, token, payload, timeout)
    if content is None:
        return None
    arr = _parse_json_array_loose(content)
    if not isinstance(arr, list) or not arr:
        logger.warning("VLM 网格回复非数组,降级:%r", (content or "")[:120])
        return None
    # 按 index 回填(缺的补 None 让调用方走启发式)
    by_idx: dict[int, dict] = {}
    for item in arr:
        if isinstance(item, dict):
            try:
                by_idx[int(item.get("index", 0))] = _norm_score(item)
            except (TypeError, ValueError):
                pass
    out: list[dict] = []
    for i in range(n):
        out.append(by_idx.get(i + 1) or {"subject": "未知", "quality": 5.0, "usable": True, "reason": "VLM漏评",
                                          "shot_size": "未知", "camera_move": "固定", "mood": "平静"})
    return out


def _compose_grid_datauri(image_paths: list[str], *, cols: int = 4, cell: tuple[int, int] = (220, 390)) -> str:
    """PIL 拼网格 + 红色编号,返回 base64 data URI。"""
    import base64 as _b64
    import io
    from math import ceil

    from PIL import Image, ImageDraw

    cw, ch = cell
    rows = ceil(len(image_paths) / cols)
    canvas = Image.new("RGB", (cols * cw, rows * ch), (10, 10, 10))
    draw = ImageDraw.Draw(canvas)
    for i, p in enumerate(image_paths):
        im = Image.open(p).convert("RGB").resize((cw, ch))
        x, y = (i % cols) * cw, (i // cols) * ch
        canvas.paste(im, (x, y))
        # 红底白字编号,左上角
        draw.rectangle([x, y, x + 34, y + 26], fill=(220, 30, 30))
        draw.text((x + 8, y + 4), str(i + 1), fill=(255, 255, 255))
    buf = io.BytesIO()
    canvas.save(buf, format="JPEG", quality=80)
    return "data:image/jpeg;base64," + _b64.b64encode(buf.getvalue()).decode()


def _parse_json_array_loose(text: str) -> list | None:
    if not text:
        return None
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _post_with_retry(url: str, token: str, payload: dict, timeout: float) -> str | None:
    """带节流 + 429/5xx 退避的 POST(url/token 由 _resolve_endpoint 给,网关或 dev 直连都走这一条),
    返回 message content 文本;失败 None。"""
    from services.ai.providers._net import bypass_proxy_for
    direct = bypass_proxy_for(url)
    for attempt in range(_MAX_RETRIES):
        _throttle()
        try:
            r = httpx.post(url, headers={"Authorization": f"Bearer {token}"},
                           json=payload, timeout=timeout, trust_env=not direct)
            if r.status_code == 429 or r.status_code >= 500:
                back = 2.0 * (2 ** attempt)
                logger.warning("VLM %s,第%d次退避 %.0fs", r.status_code, attempt + 1, back)
                time.sleep(back)
                continue
            r.raise_for_status()
            return r.json()["choices"][0]["message"]["content"]
        except Exception as e:  # noqa: BLE001
            logger.warning("VLM 请求失败(降级):%s", e)
            return None
    logger.warning("VLM 多次 429/5xx 仍失败,降级")
    return None


def score_frame(image_path: str, *, timeout: float = 30.0) -> dict | None:
    """给一帧图打分。返回 {subject, quality(0-10), usable(bool), reason}；不可用则 None。

    None = 没配通道(网关/dev key 都没)或调用失败 → 调用方(Planner)应退回启发式,别把 None 当"差帧"。
    """
    resolved = _resolve_endpoint()
    if not resolved:
        return None
    url, token = resolved
    payload = {
        "model": _provider()["model"],
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": _SCORE_PROMPT},
                {"type": "image_url", "image_url": {"url": _b64_data_uri(image_path)}},
            ],
        }],
        "temperature": 0.2,
        "max_tokens": 512,
    }
    content = _post_with_retry(url, token, payload, timeout)
    if content is None:
        return None
    data = _parse_json_loose(content)
    if not isinstance(data, dict):
        logger.warning("VLM 回复非 JSON,降级:%r", content[:120])
        return None
    return _norm_score(data)
