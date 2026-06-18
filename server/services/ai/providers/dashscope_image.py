"""通义万相（阿里云百炼 DashScope）文生图 Provider —— 原生**异步**（建任务→轮询）。

查证(2026-06-19, help.aliyun.com)：文生图**无 OpenAI 兼容端点**，必须两步：
1. 提交：`POST {base_url}/services/aigc/text2image/image-synthesis`
   headers：`Authorization: Bearer` + `X-DashScope-Async: enable`
   body：`{"model","input":{"prompt"},"parameters":{"size":"1024*1024","n":1}}`（size 用星号 `*`）
   → `{"output":{"task_id","task_status"}}`
2. 轮询：`GET {base_url}/tasks/{task_id}` 直到 `task_status=SUCCEEDED` → `output.results:[{"url"}]`（url 24h）→ 即时下载。
"""
import asyncio
import logging

import httpx

from config import settings
from services.ai.base import ImageProvider
from services.ai.providers.image_catalog import fetch_image_bytes

logger = logging.getLogger(__name__)

_DEFAULT_BASE = "https://dashscope.aliyuncs.com/api/v1"
_POLL_INTERVAL = 5.0  # 秒（官方建议约 10s，取 5s 更跟手）


class DashScopeImageProvider(ImageProvider):
    name = "dashscope"
    supported_models = ["wan2.6-t2i", "wanx2.1-t2i-turbo", "wanx2.1-t2i-plus"]

    def __init__(self, api_key: str, base_url: str = _DEFAULT_BASE):
        self._api_key = api_key
        self._base_url = (base_url or _DEFAULT_BASE).rstrip("/")

    def _headers(self, *, async_submit: bool = False) -> dict:
        h = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        if async_submit:
            h["X-DashScope-Async"] = "enable"  # 文生图必须异步提交
        return h

    async def generate_image(
        self,
        prompt: str,
        model: str = "wanx2.1-t2i-turbo",
        size: str = "1024*1024",
        quality: str = "medium",   # 万相不收 quality，忽略（保持 ImageProvider 统一签名）
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        task_id = await self._submit(prompt, model or "wanx2.1-t2i-turbo", size)
        url = await self._poll(task_id)
        return await fetch_image_bytes(url)

    async def _submit(self, prompt: str, model: str, size: str) -> str:
        body = {
            "model": model,
            "input": {"prompt": prompt},
            "parameters": {"size": size.replace("x", "*"), "n": 1},  # 万相用星号 *
        }
        timeout = httpx.Timeout(60.0, connect=30.0)
        async with httpx.AsyncClient(timeout=timeout) as hc:
            r = await hc.post(
                f"{self._base_url}/services/aigc/text2image/image-synthesis",
                headers=self._headers(async_submit=True), json=body,
            )
            r.raise_for_status()
            out = (r.json() or {}).get("output") or {}
        task_id = out.get("task_id")
        if not task_id:
            raise RuntimeError(f"通义万相提交任务未拿到 task_id：{str(out)[:200]}")
        return task_id

    async def _poll(self, task_id: str) -> str:
        deadline = float(settings.openai_image_timeout)
        waited = 0.0
        timeout = httpx.Timeout(60.0, connect=30.0)
        while True:
            async with httpx.AsyncClient(timeout=timeout) as hc:
                r = await hc.get(f"{self._base_url}/tasks/{task_id}", headers=self._headers())
                r.raise_for_status()
                out = (r.json() or {}).get("output") or {}
            status = out.get("task_status")
            if status == "SUCCEEDED":
                for it in (out.get("results") or []):
                    if isinstance(it, dict) and it.get("url"):
                        return it["url"]
                raise RuntimeError("通义万相任务成功但响应里无图片 url")
            if status in ("FAILED", "CANCELED", "UNKNOWN"):
                raise RuntimeError(f"通义万相任务失败：{status} {out.get('message', '')}")
            if waited >= deadline:
                raise RuntimeError(f"通义万相任务轮询超时（>{deadline}s）")
            await asyncio.sleep(_POLL_INTERVAL)
            waited += _POLL_INTERVAL
