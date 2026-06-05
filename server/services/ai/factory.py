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
        if name in cls._text_cache:
            return cls._text_cache[name]

        provider_cls = cls._text_registry.get(name)
        if provider_cls is None:
            raise ValueError(f"未注册的文本模型 Provider: {name}")

        instance = provider_cls()
        cls._text_cache[name] = instance
        return instance

    @classmethod
    def get_bailian_provider(cls, model: str = "qwen-plus") -> TextProvider:
        """获取百炼 Provider 实例（用于 Fallback 或指定模型路由）。"""
        cache_key = f"bailian:{model}"
        if cache_key in cls._text_cache:
            return cls._text_cache[cache_key]

        from services.ai.providers.bailian import BailianProvider

        api_key = settings.bailian_api_key
        if not api_key:
            raise ValueError("百炼 API Key 未配置 (BAILIAN_API_KEY)")

        instance = BailianProvider(api_key=api_key, model=model)
        cls._text_cache[cache_key] = instance
        return instance

    @classmethod
    def resolve_provider(cls, model: str | None = None) -> TextProvider:
        """根据模型 ID 解析应该使用哪个 provider。

        - qwen/kimi/glm/minimax/mimo → 百炼
        - deepseek → DeepSeek
        - 未指定 → 默认 provider
        """
        if not model:
            return cls.get_text_provider()

        bailian_prefixes = ["qwen", "kimi", "glm", "minimax", "mimo"]
        if any(model.startswith(p) for p in bailian_prefixes):
            return cls.get_bailian_provider(model)

        return cls.get_text_provider()

    @classmethod
    async def generate_with_fallback(cls, request) -> tuple:
        """带 Fallback 的生成：主模型失败时自动降级到百炼 Qwen。

        返回 (response, fallback_used: bool)
        """
        primary = cls.get_text_provider()
        try:
            response = await primary.generate(request)
            return response, False
        except Exception as e:
            logger.warning("主模型生成失败，尝试 Fallback 到百炼: %s", e)
            if settings.bailian_api_key:
                try:
                    fallback = cls.get_bailian_provider("qwen-plus")
                    response = await fallback.generate(request)
                    return response, True
                except Exception as fallback_err:
                    logger.error("Fallback 也失败: %s", fallback_err)
                    raise e from e
            raise

    @classmethod
    async def generate_stream_with_fallback(cls, request, model: str | None = None):
        """带 Fallback 的流式生成。model 参数用于指定模型 ID。"""
        primary = cls.resolve_provider(model)
        try:
            async for token in primary.generate_stream(request):
                yield token, False
        except Exception as e:
            logger.warning("主模型流式生成失败，尝试 Fallback: %s", e)
            if settings.bailian_api_key:
                try:
                    fallback = cls.get_bailian_provider("qwen-plus")
                    async for token in fallback.generate_stream(request):
                        yield token, True
                except Exception as fallback_err:
                    logger.error("Fallback 流式也失败: %s", fallback_err)
                    raise

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
