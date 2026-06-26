"""国内主流文生图模型接入目录（CC Switch 式 BYOK 的"口子"）+ 按 base_url 路由。

2026-06-19 逐项查证官方文档得出：国内生图分两大阵营，**不是"接口一样只换 key"**——
- **openai_compatible**：标准 `POST {base_url}/images/generations`（及 images.edit 传图编辑），Bearer，
  body 用 model/prompt/size，响应 data[].url 或 b64_json。base_url+key+model 三件套即切换，复用 `OpenAIImageProvider`。
  精选覆盖：火山方舟·即梦Seedream、智谱CogView-4、OpenAI gpt-image-2（海外降级）。
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

# CC Switch 式精选目录（少而精·主流强）：前端据此渲染"选供应商"卡片、预填 base_url；老板填 key + 选 model 即可。
# 与前端 web/src/components/byok-config-sheet.tsx 的 IMAGE_PRESETS 严格一致（前后端必须同步）。
#
# 每个 model 标 `supports_edit`（=图生图/能叠 Logo/二维码）；供应商级 `supports_edit` = 该家是否有任一可叠图模型。
# 叠 Logo/二维码 → 选 supports_edit=True 的模型（硅基 Qwen-Image-Edit-2509 / 火山 Seedream）。
IMAGE_PROVIDER_CATALOG: list[dict] = [
    {
        "name": "硅基流动 SiliconFlow", "kind": "siliconflow",
        "base_url": "https://api.siliconflow.cn/v1",
        "models": [
            # Qwen-Image-Edit-2509：图像编辑模型，支持最多 3 张参考图（image/image2/image3），叠 Logo/二维码首选
            {"id": "Qwen/Qwen-Image-Edit-2509", "supports_edit": True,
             "note": "图像编辑·支持多参考图（最多3张）·叠 Logo/二维码首选"},
            # Qwen-Image：阿里通义·当前主流文生图（开源权重·硅基托管），纯文生图首选
            {"id": "Qwen/Qwen-Image", "supports_edit": False, "note": "通义·当前主流文生图·纯文生图首选"},
            # Kolors：较早的综合文生图，轻量备选，也能走单张 image+image_size 做图生图
            {"id": "Kwai-Kolors/Kolors", "supports_edit": True, "note": "较早·轻量备选·单张参考图（image+image_size）"},
        ],
        "response": "url(1h)", "recommended": True, "supports_edit": True,
        "note": "一个 key 多模型；叠 Logo/二维码选 Qwen-Image-Edit；按量充值无订阅、新人送额度。最省事、首选。",
    },
    {
        "name": "火山方舟·即梦 Seedream", "kind": "openai_compatible",
        "base_url": "https://ark.cn-beijing.volces.com/api/v3",
        "models": [
            {"id": "doubao-seedream-4-0", "supports_edit": True,
             "note": "字节·强·OpenAI兼容·支持传图编辑（images.edit 多图）·能叠 Logo/二维码"},
        ],
        "response": "url/b64", "supports_edit": True,
        "note": "字节·强·OpenAI 兼容·支持传图编辑；约0.2元/张。",
    },
    {
        "name": "通义万相（阿里）", "kind": "dashscope",
        "base_url": "https://dashscope.aliyuncs.com/api/v1",
        "models": [
            # 万相本 provider 只接文生图端点；编辑/参考图在另一组 native 端点、优先级低，本轮不接 → supports_edit=False
            # 旧版 wanx2.1-t2i-turbo 已下（型号过时），统一用当前版 wan2.6-t2i。
            {"id": "wan2.6-t2i", "supports_edit": False, "note": "阿里通义·当前版文生图·更强"},
        ],
        "response": "url(24h)", "supports_edit": False,
        "note": "阿里主流·强文生图；原生异步1-2分钟；叠 Logo/二维码暂走硅基 Qwen-Image-Edit 或火山 Seedream。",
    },
    {
        "name": "智谱 CogView-4", "kind": "openai_compatible",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "models": [
            {"id": "cogview-4", "supports_edit": False, "note": "主流·便宜（约0.06元/张）·OpenAI兼容·纯文生图"},
        ],
        "response": "url", "supports_edit": False,
        "note": "主流·便宜（约0.06元/张）·OpenAI 兼容；纯文生图，不做叠图。",
    },
    {
        # 海外·降级：大陆通常调不通，仅老板自带 OpenAI key 且能直连时可选，弱化在末尾。
        "name": "OpenAI gpt-image-2（海外·降级）", "kind": "openai_compatible",
        "base_url": "https://api.openai.com/v1",
        "models": [
            {"id": "gpt-image-2", "supports_edit": True, "note": "海外·强·支持 images.edit 叠图（大陆多调不通）"},
        ],
        "response": "b64", "overseas": True, "supports_edit": True,
        "note": "海外，大陆调不通；仅老板自带 OpenAI key 且能直连时可选。",
    },
    # —— 原生，适配器待写（先登记，不进主选；build_image_provider 暂不路由，调用会给清晰提示）——
    # TODO 腾讯混元生图：kind=tencent_hunyuan，原生腾讯云签名鉴权 + 异步 SubmitJob/QueryJob，适配成本最高，待写。
    # TODO MiniMax：kind=minimax，base_url=https://api.minimaxi.com/v1，原生 /v1/image_generation（下划线）、
    #      aspect_ratio、data.image_base64、Bearer，适配器待写。
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


def _catalog_entry_for_base_url(base_url: str | None):
    """据 base_url 找目录里对应的供应商条目（按 host 前缀宽松匹配）。找不到→None（=未知供应商，不拦）。"""
    u = (base_url or "").strip().rstrip("/").lower()
    if not u:
        return None
    for entry in IMAGE_PROVIDER_CATALOG:
        cat = str(entry.get("base_url") or "").rstrip("/").lower()
        if cat and (u == cat or u.startswith(cat) or cat.startswith(u)):
            return entry
    return None


def validate_image_model(base_url: str | None, model: str | None) -> dict:
    """温和校验：填的生图 model 是否属于所选 base_url 那家供应商（按 IMAGE_PROVIDER_CATALOG）。

    返回 {ok, level, message, provider, known_models}：
    - 供应商不在目录里（自定义端点）→ ok=True、level="unknown"（不拦，老板自己填的端点我们不认得很正常）；
    - model 在该家目录里 → ok=True、level="match"；
    - model 不在 → ok=False、level="mismatch"，给一句『模型名跟所选供应商对不上，确认下？』并列出该家有哪些模型。
    纯查目录、不触网；前端也可直接用目录数据自行校验，这个端点是给"填了自定义端点"时兜底。"""
    model = (model or "").strip()
    entry = _catalog_entry_for_base_url(base_url)
    if entry is None:
        return {"ok": True, "level": "unknown", "message": "", "provider": "", "known_models": []}
    known = [str(m.get("id")) for m in (entry.get("models") or []) if m.get("id")]
    pname = str(entry.get("name") or "")
    if not model:
        return {"ok": True, "level": "unknown", "message": "", "provider": pname, "known_models": known}
    if model in known:
        return {"ok": True, "level": "match", "message": "", "provider": pname, "known_models": known}
    hint = ("这个模型名跟所选供应商「" + pname + "」对不上，确认下？"
            + ("该供应商常用模型：" + "、".join(known) + "。" if known else ""))
    return {"ok": False, "level": "mismatch", "message": hint, "provider": pname, "known_models": known}


async def fetch_image_bytes(url: str) -> bytes:
    """把生图返回的图片 URL 即时下载成 bytes（国内端点 url 多为 1-24h 短期有效，必须立刻取回落盘）。"""
    from services.ai.providers._net import bypass_proxy_for
    timeout = httpx.Timeout(settings.openai_image_timeout, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout, trust_env=not bypass_proxy_for(url)) as hc:
        r = await hc.get(url)
        r.raise_for_status()
        return r.content
