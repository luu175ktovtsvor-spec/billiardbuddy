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
    count: int = Field(default=1, ge=1, le=1, description="生图一次只出 1 张（已禁用批量，护住 OpenAI 每分钟出图限额）")
    refine_from: str | None = Field(default=None, description="基于某张已生成图片进行调整，传入 generation_id")
    add_store_info: bool = Field(default=False, description="是否在 prompt 中注入门店信息")
    no_text: bool = Field(default=False, description="是否禁止 AI 生成文字")
    conversation_id: str | None = Field(default=None, description="对话 ID，用于多轮对话")
    quality: str = Field(default="auto", description="图片质量：low(草稿) / medium(标准) / high(高清) / auto(自动)")
    # ── 生图重构（新增，全部可选，向后兼容）──
    image_prompt: str | None = Field(default=None, description="已扩写的最终提示词（前端可改后回传）；为空则用 prompt 原文")
    poster_text: dict | None = Field(default=None, description="要写在图上的结构化文字 {title, lines[], contact}")
    background_mode: str = Field(default="ai_generate", description="背景来源：ai_generate / store_photo")
    store_photo_path: str | None = Field(default=None, description="门店照优化模式的底图路径")
    logo_path: str | None = Field(default=None, description="手动上传的 Logo 路径")
    qr_path: str | None = Field(default=None, description="手动上传的二维码路径")


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


class PromptExpandRequest(BaseModel):
    """提示词扩写请求（POST /posters/expand）。"""
    description: str = Field(..., min_length=1, max_length=1000, description="用户大白话描述")
    poster_text: dict | None = Field(default=None, description="要写在图上的结构化文字")
    background_mode: str = Field(default="ai_generate", description="ai_generate / store_photo")
    has_logo: bool = Field(default=False, description="是否会带 Logo")
    has_qr: bool = Field(default=False, description="是否会带二维码")
    ratio: str = Field(default="3:4", description="图片比例")


class PromptExpandResponse(BaseModel):
    """提示词扩写响应。"""
    image_prompt: str
    needs: list[str] = []
