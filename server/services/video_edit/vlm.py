"""视觉理解(VLM)轻客户端 —— 让大脑"看懂"视频帧,给氛围 Planner 挑高光用。

**上游可切(落地文档 §6"网关上游可切"设计),env VLM_PROVIDER 选:**
- `doubao`(默认·主用):火山豆包视觉 `doubao-seed-1-6-250615`。项目已内置 ARK key(Seedance 同一把),
  付费基建、限流正常、便宜(一次任务几厘)。⚠️模型要在方舟控制台开通+受限 key 授权(同 Seedance)。
- `zhipu`(兜底):智谱 `glm-4.6v-flash`,零成本但**免费档限流狠**(实测密集调 429 锁死),只当兜底。

owner 2026-07-01 拍板:VLM 一律走云端 API(店主机弱扛不住本地 7B)。
⚠️ 切片阶段直连(key 走 env)。正式版收进网关(gateway/app.py 藏 key + 转发,店主 app 只带令牌)。

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
# 默认走【火山豆包视觉】(项目已内置 ARK key·付费基建·限流正常);
# 智谱免费档留兜底(零成本但限流狠)。env VLM_PROVIDER 切换。
_PROVIDERS = {
    "doubao": {
        "endpoint": "https://ark.cn-beijing.volces.com/api/v3/chat/completions",
        "model": os.environ.get("VLM_MODEL_DOUBAO", "doubao-seed-1-6-250615"),
        "key_envs": ("ARK_API_KEY", "VLM_API_KEY"),
    },
    "zhipu": {
        "endpoint": "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        "model": os.environ.get("VLM_MODEL_ZHIPU", "glm-4.6v-flash"),
        "key_envs": ("ZHIPU_API_KEY", "VLM_API_KEY"),
    },
}


def _provider() -> dict:
    return _PROVIDERS.get(os.environ.get("VLM_PROVIDER", "doubao"), _PROVIDERS["doubao"])

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
_SCORE_PROMPT = (
    "你在帮用户从视频里挑最适合发短视频(抖音/小红书)的高光画面。看这一帧,直接只回一个 JSON,不要思考过程、不要```包裹:\n"
    '{"subject":"画面主体一句话(如 人物特写/美食/风景/宠物/产品…)","quality":0到10整数分,'
    '"usable":true或false,"reason":"12字内理由"}\n'
    "参考:主体清晰好看/构图舒服/有信息量=高分;糊、动作中途、杂乱、过曝、空洞=低分且 usable=false。"
)


def vlm_available() -> bool:
    """有没有配 VLM key(没有则 Planner 走启发式)。"""
    return bool(_api_key())


def _api_key() -> str | None:
    for env in _provider()["key_envs"]:
        v = os.environ.get(env)
        if v:
            return v
    return None


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
    '[{{"index":1,"subject":"画面主体一句话(如 人物特写/美食/风景/宠物/产品…)","quality":0到10整数,"usable":true或false,"reason":"12字内"}}, ...]\n'
    "参考:主体清晰好看/构图舒服/有信息量=高分;糊、动作中途、杂乱、过曝、空洞=低分且 usable=false。"
)


def _norm_score(data: dict) -> dict:
    try:
        q = float(data.get("quality", 5))
    except (TypeError, ValueError):
        q = 5.0
    return {
        "subject": str(data.get("subject") or "未知"),
        "quality": max(0.0, min(10.0, q)),
        "usable": bool(data.get("usable", True)),
        "reason": str(data.get("reason") or "").strip(),
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
    key = _api_key()
    if not key or not image_paths:
        return {"is_billiards": False, "scene": "通用"}
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
    content = _post_with_retry(payload, key, timeout)
    data = _parse_json_loose(content or "") or {}
    scene = str(data.get("scene") or "通用")
    is_bil = bool(data.get("is_billiards"))
    return {"is_billiards": is_bil, "scene": scene if is_bil else "通用"}


def score_frames_grid(image_paths: list[str], *, timeout: float = 90.0) -> list[dict] | None:
    """把多张帧拼成一张网格图,一次请求给全部打分(省请求数、躲免费档限流)。

    返回与 image_paths 等长的打分列表;整批失败(没key/网络/格式)则 None → 调用方对整批走启发式。
    """
    key = _api_key()
    if not key or not image_paths:
        return None
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
    content = _post_with_retry(payload, key, timeout)
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
        out.append(by_idx.get(i + 1) or {"subject": "未知", "quality": 5.0, "usable": True, "reason": "VLM漏评"})
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


def _post_with_retry(payload: dict, key: str, timeout: float) -> str | None:
    """带节流 + 429/5xx 退避的 POST,返回 message content 文本;失败 None。"""
    for attempt in range(_MAX_RETRIES):
        _throttle()
        try:
            r = httpx.post(_provider()["endpoint"], headers={"Authorization": f"Bearer {key}"},
                           json=payload, timeout=timeout)
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

    None = 没 key 或调用失败 → 调用方(Planner)应退回启发式,别把 None 当"差帧"。
    """
    key = _api_key()
    if not key:
        return None
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
    content = None
    for attempt in range(_MAX_RETRIES):
        _throttle()
        try:
            r = httpx.post(_provider()["endpoint"], headers={"Authorization": f"Bearer {key}"},
                           json=payload, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                back = 2.0 * (2 ** attempt)  # 2s,4s,8s,16s
                logger.warning("VLM %s,第%d次退避 %.0fs", r.status_code, attempt + 1, back)
                time.sleep(back)
                continue
            r.raise_for_status()
            content = r.json()["choices"][0]["message"]["content"]
            break
        except Exception as e:  # noqa: BLE001 —— 网络/超时/格式全兜底降级
            logger.warning("VLM score_frame 失败(降级启发式):%s", e)
            return None
    if content is None:
        logger.warning("VLM 多次 429/5xx 仍失败,降级启发式")
        return None

    data = _parse_json_loose(content)
    if not isinstance(data, dict):
        logger.warning("VLM 回复非 JSON,降级:%r", content[:120])
        return None
    # 规整字段
    try:
        q = float(data.get("quality", 5))
    except (TypeError, ValueError):
        q = 5.0
    return {
        "subject": str(data.get("subject") or "未知"),
        "quality": max(0.0, min(10.0, q)),
        "usable": bool(data.get("usable", True)),
        "reason": str(data.get("reason") or "").strip(),
    }
