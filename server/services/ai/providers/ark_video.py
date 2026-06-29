"""火山方舟（Volcengine Ark）Seedance 文生视频 / 图生视频 Provider —— 原生**异步**（建任务→轮询）。

查证(2026-06-25, blog.laozhang.ai 实操文 + 已用真 key 验通列表端点)：视频生成**无同步端点**，必两步：
1. 提交：`POST {base_url}/contents/generations/tasks`
   headers：`Authorization: Bearer`
   body：{
     "model": "doubao-seedance-...",
     "content": [{"type":"text","text": prompt},
                 {"type":"image_url","image_url":{"url": <url 或 base64 data-uri>},"role":"first_frame"}],  # 图生视频可选
     "ratio":"16:9", "resolution":"720p", "duration":5            # ← 分辨率/时长/比例是【独立字段】，不是 prompt 后缀
   }
   → `{"id": "<task_id>"}`
2. 轮询：`GET {base_url}/contents/generations/tasks/{id}` 直到 `status=succeeded` → `content.video_url`（短期有效，立即下载）
   状态枚举：queued / running / succeeded / failed / expired / cancelled

首帧图（图生视频）：`image_url` 收公网 URL 或 base64 data-uri（本机生成的图火山方舟拉不到 → 由 video_service 转 data-uri）。
与 dashscope_image.py(通义万相异步生图) 同构：提交拿 id → 轮询 status → 取 url。
"""
import asyncio
import logging

import httpx

from config import settings
from services.ai.providers._net import bypass_proxy_for

logger = logging.getLogger(__name__)

_DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3"
_POLL_INTERVAL = 8.0  # 秒（官方建议约 10s，取 8s 更跟手）
_FAILED_STATES = ("failed", "expired", "cancelled", "canceled")


class ArkVideoProvider:
    """火山方舟 Seedance 视频生成（异步：建任务→轮询）。返回成片的远端 URL（由调用方即时下载落盘）。"""

    name = "ark_video"

    def __init__(self, api_key: str, base_url: str = _DEFAULT_BASE):
        self._api_key = api_key
        self._base_url = (base_url or _DEFAULT_BASE).rstrip("/")

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}

    async def generate_video(
        self,
        prompt: str,
        model: str,
        *,
        ratio: str = "16:9",
        resolution: str | None = None,
        duration: int = 5,
        first_frame_url: str | None = None,
        last_frame_url: str | None = None,
        image_refs: list[dict] | None = None,
        generate_audio: bool = False,
        watermark: bool = False,
    ) -> str:
        """提交 + 轮询，返回成片远端 URL。first_frame_url/last_frame_url 已是可直接塞进 image_url 的值（http url 或 data-uri）。

        resolution：Seedance 2.0 用 ratio(可填 adaptive/16:9…)+duration 控画幅、**请求体里没有 resolution**
        （2026-06-25 用真 key 跑通官方 2.0 请求体确认）；老的 1.x 系列才用 resolution → 这里改成「给了才发、不给就省」，
        兼容两代、又不给 2.0 塞它不认的字段。watermark 默认 False（不打水印）。

        image_refs：多模态参考(主体一致性/锁人物),每项 {"url":..,"role":"reference"}。Seedance 支持最多 9 图,
        prompt 里用 @图片N 指派角色(由上层拼好);这里只按顺序塞进 content。"""
        task_id = await self._submit(prompt, model, ratio, resolution, duration,
                                     first_frame_url, last_frame_url, image_refs, generate_audio, watermark)
        return await self._poll(task_id)

    async def _submit(self, prompt, model, ratio, resolution, duration,
                      first_frame_url, last_frame_url, image_refs, generate_audio, watermark) -> str:
        content: list[dict] = [{"type": "text", "text": prompt}]
        if first_frame_url:  # 图生视频：把首帧图当 content 的一项（role=first_frame）
            content.append({"type": "image_url", "image_url": {"url": first_frame_url}, "role": "first_frame"})
        if last_frame_url:   # 首尾帧：尾帧承接
            content.append({"type": "image_url", "image_url": {"url": last_frame_url}, "role": "last_frame"})
        for ref in (image_refs or [])[:9]:  # 多图参考(主体一致/锁人物),最多 9 图
            url = ref.get("url") if isinstance(ref, dict) else ref
            role = (ref.get("role") if isinstance(ref, dict) else None) or "reference"
            if url:
                content.append({"type": "image_url", "image_url": {"url": url}, "role": role})
        body: dict = {
            "model": model,
            "content": content,
            "ratio": ratio,
            "duration": int(duration),
            "watermark": bool(watermark),
        }
        if resolution:  # 只有显式给了才发（2.0 不收 resolution，硬塞会出错；1.x 才用）
            body["resolution"] = resolution
        if generate_audio:
            body["generate_audio"] = True
        timeout = httpx.Timeout(60.0, connect=30.0)
        direct = bypass_proxy_for(self._base_url)
        async with httpx.AsyncClient(timeout=timeout, trust_env=not direct) as hc:
            r = await hc.post(
                f"{self._base_url}/contents/generations/tasks",
                headers=self._headers(), json=body,
            )
            if r.status_code >= 400:
                # 把网关/火山返回的 400 响应体带出来(不然只剩"400 Bad Request"没法查)。
                detail = (r.text or "")[:500]
                logger.warning("Seedance 视频提交 %s:%s", r.status_code, detail)
                raise RuntimeError(f"视频生成提交失败({r.status_code}):{detail}")
            out = r.json() or {}
        # 兼容 {"id":...} 与少数情况下包一层 {"data":{"id":...}}
        task_id = out.get("id") or (out.get("data") or {}).get("id")
        if not task_id:
            raise RuntimeError(f"火山方舟视频提交未拿到 task_id：{str(out)[:200]}")
        return task_id

    async def _poll(self, task_id: str) -> str:
        deadline = float(settings.video_timeout)
        waited = 0.0
        timeout = httpx.Timeout(60.0, connect=30.0)
        direct = bypass_proxy_for(self._base_url)
        while True:
            async with httpx.AsyncClient(timeout=timeout, trust_env=not direct) as hc:
                r = await hc.get(
                    f"{self._base_url}/contents/generations/tasks/{task_id}",
                    headers=self._headers(),
                )
                r.raise_for_status()
                out = r.json() or {}
            status = str(out.get("status") or "").lower()
            if status == "succeeded":
                raw_content = out.get("content")
                content = raw_content[0] if isinstance(raw_content, list) and raw_content else (raw_content or {})
                url = (content.get("video_url") if isinstance(content, dict) else None) or out.get("video_url")
                if url:
                    return url
                raise RuntimeError("火山方舟视频任务成功但响应里无 video_url")
            if status in _FAILED_STATES:
                err = out.get("error") or {}
                msg = err.get("message") if isinstance(err, dict) else ""
                raise RuntimeError(f"火山方舟视频任务失败：{status} {msg or out.get('message', '')}")
            if waited >= deadline:
                raise RuntimeError(f"火山方舟视频任务轮询超时（>{deadline}s）")
            await asyncio.sleep(_POLL_INTERVAL)
            waited += _POLL_INTERVAL


async def fetch_video_bytes(url: str) -> bytes:
    """把生成的视频 URL 即时下载成 bytes（火山方舟 url 短期有效，必须立刻取回落盘）。"""
    timeout = httpx.Timeout(settings.video_timeout, connect=30.0)
    direct = bypass_proxy_for(url)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=not direct) as hc:
        r = await hc.get(url)
        r.raise_for_status()
        return r.content
