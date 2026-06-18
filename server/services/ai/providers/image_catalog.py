"""国内主流文生图模型接入目录（CC Switch 式 BYOK 的"口子"）+ 按 base_url 路由。

2026-06-19 逐项查证官方文档得出：国内生图分两大阵营，**不是"接口一样只换 key"**——
- **openai_compatible**：标准 `POST {base_url}/images/generations`，Bearer，body 用 model/prompt/size，
  响应 data[].url 或 b64_json。base_url+key+model 三件套即切换，复用 `OpenAIImageProvider`。
  覆盖：OpenAI gpt-image-2、火山方舟·即梦Seedream、智谱CogView、阶跃Step、百度千帆。
- **siliconflow**：OpenAI 风格端点，但字段是 `image_size`/`batch_size`、响应 `images[].url`(1h)，单列 provider。
  聚合平台——一个 key 切 model 即可调 Kolors/Qwen-Image/SD 等多家开源模型，最省事的"单 key 多模型"路径。
- **dashscope**（通义万相）：原生**异步**（建任务→轮询 task_id，1-2 分钟），size 用星号 `*`，url 24h，单列 provider。
- **tencent_hunyuan / minimax**：原生（腾讯云签名鉴权 / 下划线端点 `image_generation`），适配器待写——先登记不路由。

**计费**：国内生图全是**按张后付费、无包月订阅**（订阅/TPM 套餐是文本模型的，与生图无关）。各家 url 多为短期有效（1-24h），生成后必须立即下载落盘。

**怎么扩（口子）**：新增 OpenAI 兼容厂商 = 往 `IMAGE_PROVIDER_CATALOG` 加一条预设；新增原生厂商 = 写一个 `ImageProvider` 子类 + 在 `factory.build_image_provider` 的 kind 路由里登记。
"""
import logging

import httpx

from config import settings

logger = logging.getLogger(__name__)

# CC Switch 式预设目录：前端据此渲染"选供应商"卡片、预填 base_url；老板填 key + 选 model 即可。
IMAGE_PROVIDER_CATALOG: list[dict] = [
    {
        "name": "硅基流动 SiliconFlow", "kind": "siliconflow",
        "base_url": "https://api.siliconflow.cn/v1",
        "models": ["Kwai-Kolors/Kolors", "Qwen/Qwen-Image"], "response": "url(1h)",
        "recommended": True,
        "note": "聚合平台，一个 key 通吃多家开源模型（可图Kolors/Qwen-Image/SD）；按量充值无订阅、新人送14元。最省事。",
    },
    {
        "name": "火山方舟·即梦 Seedream", "kind": "openai_compatible",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "models": ["doubao-seedream-4-0", "doubao-seedream-5-0-lite"], "response": "url/b64",
        "note": "OpenAI 兼容、同步直返；约0.2-0.25元/张；同平台还能做视频(Seedance)。watermark 默认开。",
    },
    {
        "name": "智谱 CogView", "kind": "openai_compatible",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "models": ["cogview-4", "cogview-3-flash"], "response": "url",
        "note": "OpenAI 兼容；cogview-3-flash 免费、cogview-4 约0.06元/张；按量充值无订阅。",
    },
    {
        "name": "阶跃星辰 Step", "kind": "openai_compatible",
        "base_url": "https://api.stepfun.com/v1",
        "models": ["step-1x-medium"], "response": "url/b64",
        "note": "OpenAI 兼容（可直接用 OpenAI SDK images.generate）；按张。",
    },
    {
        "name": "百度千帆（文心）", "kind": "openai_compatible",
        "base_url": "https://qianfan.baidubce.com/v2",
        "models": ["irag-1.0"], "response": "url",
        "note": "OpenAI 兼容（V2 用 IAM Bearer Token）；文心系列每日有免费额度。",
    },
    {
        "name": "通义万相（阿里）", "kind": "dashscope",
        "base_url": "https://dashscope.aliyuncs.com/api/v1",
        "models": ["wan2.6-t2i", "wanx2.1-t2i-turbo", "wanx2.1-t2i-plus"], "response": "url(24h)",
        "note": "原生异步（建任务→轮询，1-2分钟）；size 用星号*；约0.14-0.2元/张、新人送50张/90天。",
    },
    {
        "name": "OpenAI gpt-image-2（海外）", "kind": "openai_compatible",
        "base_url": "https://api.openai.com/v1",
        "models": ["gpt-image-2"], "response": "b64",
        "note": "海外，大陆调不通；仅老板自带 OpenAI key 且能直连时可选。",
    },
    # —— 原生，适配器待写（先登记，build_image_provider 暂不路由，调用会给清晰提示）——
    {
        "name": "腾讯混元生图", "kind": "tencent_hunyuan", "base_url": "",
        "models": ["hunyuan-image"], "response": "task", "todo": True,
        "note": "原生：腾讯云签名鉴权 + 异步 SubmitJob/QueryJob；适配成本最高，适配器待写。",
    },
    {
        "name": "MiniMax", "kind": "minimax", "base_url": "https://api.minimaxi.com/v1",
        "models": ["image-01"], "response": "b64", "todo": True,
        "note": "原生：/v1/image_generation（下划线）、aspect_ratio、data.image_base64；Bearer；适配器待写。",
    },
]


def resolve_image_kind(base_url: str | None) -> str:
    """据 base_url 判定 provider 类型（路由用）。匹配不到 → 默认 openai_compatible（最通用）。
    这样 BYOK 不必新增 DB 字段存 kind——填了哪家的 base_url 就自动走对应适配器。"""
    u = (base_url or "").lower()
    if "siliconflow" in u:
        return "siliconflow"
    if "dashscope.aliyuncs" in u:
        return "dashscope"
    if "minimaxi" in u or "minimax" in u:
        return "minimax"
    if "hunyuan" in u or "tencentcloudapi" in u:
        return "tencent_hunyuan"
    return "openai_compatible"


async def fetch_image_bytes(url: str) -> bytes:
    """把生图返回的图片 URL 即时下载成 bytes（国内端点 url 多为 1-24h 短期有效，必须立刻取回落盘）。"""
    timeout = httpx.Timeout(settings.openai_image_timeout, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout) as hc:
        r = await hc.get(url)
        r.raise_for_status()
        return r.content
