"""可用模型列表 API"""

from fastapi import APIRouter, Depends
from api.deps import get_current_user

router = APIRouter(tags=["模型"])

# 文本模型列表
TEXT_MODELS = [
    {
        "id": "deepseek-v4-flash",
        "name": "DeepSeek V4 Flash",
        "provider": "deepseek",
        "provider_name": "DeepSeek",
        "description": "快速响应，性价比高",
        "best_for": "日常文案、话术、日报生成",
        "is_default": True,
    },
    {
        "id": "deepseek-v4-pro",
        "name": "DeepSeek V4 Pro",
        "provider": "deepseek",
        "provider_name": "DeepSeek",
        "description": "更强推理能力",
        "best_for": "复杂活动策划、经营分析",
        "is_default": False,
    },
    {
        "id": "qwen3.7-max",
        "name": "千问 3.7 Max",
        "provider": "bailian",
        "provider_name": "阿里云百炼",
        "description": "千问最强模型",
        "best_for": "复杂文案、长内容生成",
        "is_default": False,
    },
    {
        "id": "qwen3.7-plus",
        "name": "千问 3.7 Plus",
        "provider": "bailian",
        "provider_name": "阿里云百炼",
        "description": "平衡性能与速度",
        "best_for": "通用文案生成",
        "is_default": False,
    },
    {
        "id": "qwen3.6-flash",
        "name": "千问 3.6 Flash",
        "provider": "bailian",
        "provider_name": "阿里云百炼",
        "description": "最快速度",
        "best_for": "快速生成、批量任务",
        "is_default": False,
    },
    {
        "id": "kimi-k2.6",
        "name": "Kimi K2.6",
        "provider": "bailian",
        "provider_name": "阿里云百炼",
        "description": "Kimi 模型",
        "best_for": "长文本理解、中文优化",
        "is_default": False,
    },
    {
        "id": "glm-5.1",
        "name": "GLM 5.1",
        "provider": "bailian",
        "provider_name": "阿里云百炼",
        "description": "智谱模型",
        "best_for": "中文对话、知识问答",
        "is_default": False,
    },
]


@router.get("/text-models")
async def list_text_models(_user=Depends(get_current_user)):
    """返回可用的文本生成模型列表。"""
    return {"models": TEXT_MODELS}
