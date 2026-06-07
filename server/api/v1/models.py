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
]


@router.get("/text-models")
async def list_text_models(_user=Depends(get_current_user)):
    """返回可用的文本生成模型列表。"""
    return {"models": TEXT_MODELS}
