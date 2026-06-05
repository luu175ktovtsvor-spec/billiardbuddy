from services.ai.base import TextProvider, TextRequest, TextResponse, ImageProvider
from services.ai.factory import ProviderFactory
from services.ai.providers.deepseek import DeepSeekProvider
from services.ai.providers.mock import MockTextProvider
from services.ai.providers.bailian import BailianProvider
from services.ai.providers.aliyun_image import AliyunImageProvider
from services.ai.providers.openai_image import OpenAIImageProvider

ProviderFactory.register_text("deepseek", DeepSeekProvider)
ProviderFactory.register_text("mock", MockTextProvider)
ProviderFactory.register_text("bailian", BailianProvider)
ProviderFactory.register_image("aliyun", AliyunImageProvider)
ProviderFactory.register_image("openai", OpenAIImageProvider)

__all__ = ["TextProvider", "TextRequest", "TextResponse", "ImageProvider", "ProviderFactory"]
