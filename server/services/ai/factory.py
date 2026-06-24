import logging

from config import settings
from services.ai.base import TextProvider, ImageProvider

logger = logging.getLogger(__name__)


class ProviderFactory:
    _text_registry: dict[str, type[TextProvider]] = {}
    _text_cache: dict[str, TextProvider] = {}
    _image_registry: dict[str, type[ImageProvider]] = {}
    _image_cache: dict[str, ImageProvider] = {}

    @classmethod
    def register_text(cls, name: str, provider_cls: type[TextProvider]) -> None:
        cls._text_registry[name] = provider_cls

    @classmethod
    def get_text_provider(cls) -> TextProvider:
        name = settings.text_model_provider
        return cls._get_or_create_text_provider(name)

    @classmethod
    def get_text_provider_for_store(cls, store) -> TextProvider:
        """按门店路由文本生成 provider。

        BYOK 门店（byok_enabled + 有密文 key）→ 用门店自带 key/base_url/model 构造临时 provider
        （DeepSeekProvider 本质是通用 OpenAI 兼容 provider，可接 MiMo / deepseek-v4-pro / 任意兼容模型）；
        token 成本与并发由门店自担。否则 → 走平台默认单例（行为不变）。
        BYOK provider 不入单例缓存（各店 key 不同）；解密失败安全回退平台默认、不阻断生成。

        **桌面盒子（DESKTOP_LOCAL=1）= 纯 BYOK**：拿不到可用的门店自带 key 时，
        友好 503、绝不回退平台 key（与 get_image_config_for_store 同款守卫——
        把"不回退平台 key"从部署约定升级为代码不变量，纵使盒子里误带了平台 key 也不会被静默用上）。
        """
        enc = getattr(store, "byok_api_key_enc", None) if store is not None else None
        if store is not None and getattr(store, "byok_enabled", False) and enc:
            from core.crypto import try_decrypt
            key = try_decrypt(enc)
            if key:
                from services.ai.providers.deepseek import DeepSeekProvider
                return DeepSeekProvider(
                    api_key=key,
                    base_url=getattr(store, "byok_base_url", None) or None,
                    default_model=getattr(store, "byok_model", None) or None,
                    timeout=300.0,  # 兼容 reasoning 模型（如 MiMo v2.5）较慢的首字延迟
                )
            logger.warning("BYOK key 解密失败 store_id=%s", getattr(store, "id", None))
        elif store is not None and getattr(store, "byok_enabled", False):
            logger.warning("门店启用 BYOK 但未配置 key store_id=%s", getattr(store, "id", None))
        # 桌面盒子：门店 BYOK（上面已处理）优先；否则用【内置 bundle key】（全内置·用户零配置，owner 2026-06-24
        # 拍板，推翻"纯 BYOK 绝不内置平台 key"铁律）。内置 key 由 backend.js 经 .env.bundled.local 注入进程 env。
        # 内置 key 未配（测试/未注入）→ 仍友好报错、绝不静默落到无关平台 key（保留旧守卫作不变量）。
        import os
        if os.environ.get("DESKTOP_LOCAL") == "1":
            if settings.deepseek_api_key:
                return cls.get_text_provider()  # 内置文字/看图大脑（默认 MiMo v2.5）
            from core.exceptions import AIProviderError
            raise AIProviderError(
                message="还没配置文字模型 Key（内置 key 未注入、也未填自带 key），请检查安装或在「模型设置」里填写",
                status_code=503,
            )
        return cls.get_text_provider()

    @classmethod
    def get_orchestration_provider(cls) -> TextProvider:
        """编排大脑 provider（Agent 规划/选工具用，可与内容生成 provider 不同）。

        默认跟随生成 provider；要切 GLM-4.6 时注册 GLM provider 并设
        settings.orchestration_model_provider 即可，无需改这里。
        """
        return cls._get_or_create_text_provider(settings.effective_orchestration_provider)

    @classmethod
    def _get_or_create_text_provider(cls, name: str) -> TextProvider:
        if name in cls._text_cache:
            return cls._text_cache[name]

        provider_cls = cls._text_registry.get(name)
        if provider_cls is None:
            raise ValueError(f"未注册的文本模型 Provider: {name}")

        instance = provider_cls()

        cls._text_cache[name] = instance
        return instance

    @classmethod
    def resolve_provider(cls, model: str | None = None) -> TextProvider:
        """根据模型 ID 解析 provider。当前只支持 deepseek。"""
        if not model:
            return cls.get_text_provider()
        return cls.get_text_provider()

    @classmethod
    async def generate_with_fallback(cls, request) -> tuple:
        """生成文本。"""
        provider = cls.get_text_provider()
        response = await provider.generate(request)
        return response, False

    @classmethod
    async def generate_stream_with_fallback(
        cls, request, model: str | None = None, usage_sink: dict | None = None, store=None
    ):
        """流式生成文本。BYOK 门店走门店自带 provider（key/base_url/model 自担成本），
        否则按 model 路由到平台默认 provider。

        usage_sink: 透传给 provider，生成结束后写入本次 token 用量。
        """
        if store is not None and getattr(store, "byok_enabled", False):
            provider = cls.get_text_provider_for_store(store)
        else:
            provider = cls.resolve_provider(model)
        async for token in provider.generate_stream(request, usage_sink=usage_sink):
            yield token, False

    @classmethod
    def register_image(cls, provider_name: str, provider_cls: type[ImageProvider]) -> None:
        cls._image_registry[provider_name] = provider_cls

    @classmethod
    def get_image_provider(cls, provider_name: str, **kwargs) -> ImageProvider:
        cache_key = provider_name
        if cache_key in cls._image_cache:
            return cls._image_cache[cache_key]

        provider_cls = cls._image_registry.get(provider_name)
        if provider_cls is None:
            raise ValueError(f"未注册的图片模型 Provider: {provider_name}")

        instance = provider_cls(**kwargs)
        cls._image_cache[cache_key] = instance
        return instance

    @classmethod
    def get_image_config_for_store(cls, store) -> tuple[str, str, str | None]:
        """按门店取生图配置 (api_key, base_url, model)。
        门店配了生图 BYOK（byok_image_enabled + 密文 key）→ 用门店自带（自担成本）。
        **桌面盒子（DESKTOP_LOCAL=1）= 纯 BYOK**：没配就返回空 key（逼老板去「模型设置」填自己的），
        绝不回退用平台 key——盒子内不内置任何平台 key（与云端 web 版相反，web 才回退平台默认垫付）。
        gpt-image-2 仍保留为可选模型接口（老板自带 OpenAI key 时可选它）。
        model 为 None 时由 provider 用默认(gpt-image-2)。解密失败安全降级、不阻断。"""
        import os
        from config import settings
        enc = getattr(store, "byok_image_api_key_enc", None) if store is not None else None
        if store is not None and getattr(store, "byok_image_enabled", False) and enc:
            from core.crypto import try_decrypt
            key = try_decrypt(enc)
            if key:
                return (
                    key,
                    getattr(store, "byok_image_base_url", None) or settings.openai_base_url,
                    getattr(store, "byok_image_model", None) or None,
                )
            logger.warning("生图 BYOK key 解密失败 store_id=%s", getattr(store, "id", None))
        # 桌面盒子：门店 BYOK（上面）优先；否则用【内置 bundle 生图 key】（零配置·全内置）。
        # 内置生图 key/base_url 经 .env.bundled.local 注入到 openai_api_key/openai_base_url（默认走 Seedream/火山方舟，
        # build_image_provider 按 base_url 路由）；GPT Image-2 海外走美国机 relay（base_url 指向 relay，见专题 D.3）。
        # 内置 key 未配（测试/未注入）→ 维持空 key（不动无关平台 key，逼填 BYOK），保留旧守卫作不变量。
        if os.environ.get("DESKTOP_LOCAL") == "1":
            if settings.openai_api_key:
                return (settings.openai_api_key, settings.openai_base_url, settings.image_model_name or None)
            return ("", settings.openai_base_url, None)
        return (settings.openai_api_key, settings.openai_base_url, None)

    @classmethod
    def build_image_provider(cls, api_key: str, base_url: str | None, model: str | None = None):
        """按 base_url 自动路由到对应生图 Provider（CC Switch 式"口子"，新增厂商不必改调用方）。
        - openai_compatible（gpt-image-2 / 火山方舟Seedream / 智谱CogView / 阶跃Step / 百度千帆）→ OpenAIImageProvider
        - siliconflow（image_size/batch_size，images[].url）→ SiliconFlowImageProvider
        - dashscope（通义万相，异步建任务→轮询）→ DashScopeImageProvider
        - minimax / tencent_hunyuan（原生，适配器待写）→ 清晰报错，引导改用已支持的。"""
        from services.ai.providers.image_catalog import resolve_image_kind
        kind = resolve_image_kind(base_url)
        if kind == "siliconflow":
            from services.ai.providers.siliconflow_image import SiliconFlowImageProvider
            return SiliconFlowImageProvider(api_key=api_key, base_url=base_url)
        if kind == "dashscope":
            from services.ai.providers.dashscope_image import DashScopeImageProvider
            return DashScopeImageProvider(api_key=api_key, base_url=base_url)
        if kind in ("minimax", "tencent_hunyuan"):
            raise ValueError(
                f"生图供应商「{kind}」适配器尚未实现，请改用硅基流动 / 通义万相 / OpenAI 兼容(火山·智谱·阶跃·百度)")
        from services.ai.providers.openai_image import OpenAIImageProvider
        return OpenAIImageProvider(api_key=api_key, base_url=base_url or "https://api.openai.com/v1")
