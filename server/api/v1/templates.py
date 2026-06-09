from fastapi import APIRouter, Query
from services.ai.prompt_engine import get_prompt_engine

router = APIRouter()
prompt_engine = get_prompt_engine()


@router.get("")
async def list_templates(category: str | None = Query(None)):
    """获取模板列表。"""
    templates = []
    for key, template in prompt_engine._templates.items():
        if key.startswith("templates."):
            if category and template.get("category") != category:
                continue
            templates.append({
                "key": key,
                "name": template.get("name", ""),
                "category": template.get("category", ""),
                "templates": template.get("templates", []),
            })
    return templates
