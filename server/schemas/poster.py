import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ImageGenerateRequest(BaseModel):
    """AI 生图请求。"""
    prompt: str = Field(..., min_length=2, max_length=1000, description="用户描述")
    image_model: str = Field(default="gpt-image-2", description="AI 生图模型 ID")
    ratio: str = Field(default="3:4", description="图片比例：3:4 / 1:1 / 9:16 / 16:9")
    images: list[str] | None = Field(default=None, description="已上传图片路径列表（直接传给生图模型）")
    reference_image_paths: list[str] | None = Field(default=None, description="参考图本地路径列表（兼容旧接口）")
    count: int = Field(default=1, ge=1, le=4, description="生成数量，1-4")
    refine_from: str | None = Field(default=None, description="基于某张已生成图片进行调整，传入 generation_id")
    add_store_info: bool = Field(default=False, description="是否在 prompt 中注入门店信息")
    no_text: bool = Field(default=False, description="是否禁止 AI 生成文字")
    conversation_id: str | None = Field(default=None, description="对话 ID，用于多轮对话")
    quality: str = Field(default="auto", description="图片质量：low(草稿) / medium(标准) / high(高清) / auto(自动)")


class GeneratedImage(BaseModel):
    """单张生成结果。"""
    generation_id: uuid.UUID
    poster_url: str
    created_at: datetime


class ImageGenerateResponse(BaseModel):
    """AI 生图响应。"""
    images: list[GeneratedImage]
    model_used: str
    count: int
    conversation_id: str | None = None


class PosterConversationItem(BaseModel):
    """对话列表项。"""
    id: str
    title: str
    message_count: int
    thumbnail_url: str | None
    created_at: datetime
    updated_at: datetime


class PosterConversationDetail(BaseModel):
    """对话详情。"""
    id: str
    title: str
    created_at: datetime
    updated_at: datetime
    messages: list[GeneratedImage]
