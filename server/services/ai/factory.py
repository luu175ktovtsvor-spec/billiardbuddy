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
        cls, request, model: str | None = None, usage_sink: dict | None = None
    ):
        """流式生成文本。根据 model 参数路由到不同 provider。

        usage_sink: 透传给 provider，生成结束后写入本次 token 用量。
        """
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
