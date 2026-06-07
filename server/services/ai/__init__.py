from services.ai.base import TextProvider, TextRequest, TextResponse, ImageProvider
from services.ai.factory import ProviderFactory
from services.ai.providers.deepseek import DeepSeekProvider
from services.ai.providers.mock import MockTextProvider
from services.ai.providers.mimo import MimoProvider
from services.ai.providers.openai_image import OpenAIImageProvider

ProviderFactory.register_text("deepseek", DeepSeekProvider)
ProviderFactory.register_text("mimo", MimoProvider)
ProviderFactory.register_text("mock", MockTextProvider)
ProviderFactory.register_image("openai", OpenAIImageProvider)

__all__ = ["TextProvider", "TextRequest", "TextResponse", "ImageProvider", "ProviderFactory"]
