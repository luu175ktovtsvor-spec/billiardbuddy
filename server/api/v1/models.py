"""可用模型列表 API"""

from fastapi import APIRouter, Depends
from api.deps import get_current_user

router = APIRouter(tags=["模型"])

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
        "id": "mimo-v2.5",
        "name": "Mimo V2.5",
        "provider": "mimo",
        "provider_name": "小米 Mimo",
        "description": "小米大模型，推理能力强",
        "best_for": "复杂分析、长内容生成",
        "is_default": False,
    },
]


@router.get("/text-models")
async def list_text_models(_user=Depends(get_current_user)):
    """返回可用的文本生成模型列表。"""
    return {"models": TEXT_MODELS}
