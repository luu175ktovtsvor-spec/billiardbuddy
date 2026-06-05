import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ImageGenerateRequest(BaseModel):
    """AI 生图请求。"""
    prompt: str = Field(..., min_length=2, max_length=1000, description="用户描述")
    image_model: str = Field(default="wanx2.7-pro", description="AI 生图模型 ID")
    ratio: str = Field(default="3:4", description="图片比例：3:4 / 1:1 / 9:16 / 16:9")
    reference_image_paths: list[str] | None = Field(default=None, description="参考图本地路径列表（上传后返回的 path）")
    count: int = Field(default=2, ge=1, le=4, description="生成数量，1-4")
    refine_from: str | None = Field(default=None, description="基于某张已生成图片进行调整，传入 generation_id")


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